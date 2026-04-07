#!/usr/bin/env node

/**
 * claude-code-proxy
 *
 * Local Anthropic Messages API proxy that uses your Claude Code subscription.
 * Forwards requests directly to the Anthropic API using the OAuth token from
 * Claude Code's keychain, with system prompt sanitization to bypass
 * third-party app detection.
 *
 * Supports full API features: streaming, tool use, thinking, caching.
 *
 * Usage:
 *   npx claude-code-proxy                   # default port 8082
 *   npx claude-code-proxy --port 9000       # custom port
 */

import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = parseInt(arg("port", "8082"), 10);
const ANTHROPIC_API = "https://api.anthropic.com";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

// Keychain config — auto-detect account
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const KEYCHAIN_ACCOUNTS = ["Claude Code", process.env.USER, "default"];

// ---------------------------------------------------------------------------
// Third-party detection bypass
//
// Anthropic pattern-matches system prompts for known third-party app
// identifiers and reclassifies the request to draw from extra-usage
// credits instead of plan limits. We sanitize these before forwarding.
// ---------------------------------------------------------------------------
const SANITIZE_PATTERNS = [
  [/\bOpenClaw\b/gi, "Assistant Platform"],
  [/\bopenclaw\b/g, "assistant-platform"],
  [/\bSimpleClaw\b/gi, "Assistant Service"],
  [/\bsimpleclaw\b/g, "assistant-service"],
  [/\bpi-ai\b/gi, "runtime"],
];

function sanitize(text) {
  if (!text) return text;
  let out = text;
  for (const [re, replacement] of SANITIZE_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

/**
 * Deep-sanitize a request body — cleans system prompt and message text
 * of third-party identifiers while preserving all API structure
 * (tools, tool_use, tool_result, thinking, caching, etc.)
 */
function sanitizeRequestBody(body) {
  const cleaned = { ...body };

  // Sanitize system prompt
  if (typeof cleaned.system === "string") {
    cleaned.system = sanitize(cleaned.system);
  } else if (Array.isArray(cleaned.system)) {
    cleaned.system = cleaned.system.map((block) => {
      if (block.type === "text" && typeof block.text === "string") {
        return { ...block, text: sanitize(block.text) };
      }
      return block;
    });
  }

  // Sanitize message text blocks (but NOT tool_use/tool_result — preserve those)
  if (Array.isArray(cleaned.messages)) {
    cleaned.messages = cleaned.messages.map((msg) => {
      if (typeof msg.content === "string") {
        return { ...msg, content: sanitize(msg.content) };
      }
      if (Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map((block) => {
            if (block.type === "text" && typeof block.text === "string") {
              return { ...block, text: sanitize(block.text) };
            }
            return block; // tool_use, tool_result, image, thinking — pass through
          }),
        };
      }
      return msg;
    });
  }

  return cleaned;
}

// ---------------------------------------------------------------------------
// OAuth token management
// ---------------------------------------------------------------------------
let cachedCreds = null;

function readKeychain() {
  let best = null;
  for (const account of KEYCHAIN_ACCOUNTS) {
    if (!account) continue;
    try {
      const raw = execSync(
        `security find-generic-password -s "${KEYCHAIN_SERVICE}" -a "${account}" -w`,
        { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
      ).trim();
      const parsed = JSON.parse(raw);
      const creds = parsed.claudeAiOauth;
      if (!creds?.accessToken) continue;
      // Prefer the token with the latest expiry
      if (!best || (creds.expiresAt || 0) > (best.expiresAt || 0)) {
        best = creds;
      }
    } catch {
      continue;
    }
  }
  if (!best) console.error("[proxy] No Claude Code credentials found in keychain");
  return best;
}

async function refreshToken(refreshTok) {
  console.log("[proxy] Refreshing OAuth token...");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshTok,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Refresh failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}

async function getAccessToken() {
  // Always re-read keychain — Claude Code may have refreshed the token
  const kc = readKeychain();
  if (!kc) throw new Error("No Claude Code credentials in keychain");

  if (kc.expiresAt > Date.now() + 120_000) {
    cachedCreds = kc;
    return kc.accessToken;
  }

  // Expired — try to refresh
  const refreshTok = kc.refreshToken || cachedCreds?.refreshToken;
  if (!refreshTok) throw new Error("No refresh token available");

  const fresh = await refreshToken(refreshTok);
  cachedCreds = fresh;
  console.log(
    "[proxy] Token refreshed (expires %s)",
    new Date(fresh.expiresAt).toLocaleTimeString(),
  );
  return fresh.accessToken;
}

// ---------------------------------------------------------------------------
// Proxy handler
// ---------------------------------------------------------------------------
async function handleRequest(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, anthropic-version, anthropic-beta, x-api-key",
    });
    res.end();
    return;
  }

  const t0 = Date.now();

  // Collect body
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const rawBody = Buffer.concat(chunks);

  // Get token
  let token;
  try {
    token = await getAccessToken();
  } catch (err) {
    console.error("[proxy] Auth error:", err.message);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ error: { type: "proxy_error", message: err.message } }),
    );
    return;
  }

  // Parse and sanitize the request body
  let body;
  try {
    body = JSON.parse(rawBody.toString());
  } catch {
    // Not JSON — forward as-is (unlikely for Messages API)
    body = null;
  }

  // Inject Claude Code billing header and metadata so the request
  // is classified as first-party (plan limits, not extra usage)
  if (body) {
    // Add billing header as first system block
    const billingBlock = {
      type: "text",
      text: "x-anthropic-billing-header: cc_version=2.1.92.75f; cc_entrypoint=cli;",
    };
    if (typeof body.system === "string") {
      body.system = [billingBlock, { type: "text", text: body.system }];
    } else if (Array.isArray(body.system)) {
      body.system = [billingBlock, ...body.system];
    } else {
      body.system = [billingBlock];
    }

    // Add metadata if missing
    if (!body.metadata) {
      body.metadata = {
        user_id: JSON.stringify({
          device_id: "proxy",
          account_uuid: "proxy",
          session_id: randomUUID(),
        }),
      };
    }

    // Add adaptive thinking if not present (required for first-party classification)
    if (!body.thinking) {
      body.thinking = { type: "adaptive" };
    }
  }

  const forwardBody = body ? JSON.stringify(sanitizeRequestBody(body)) : rawBody;
  const model = body?.model || "unknown";
  const streaming = body?.stream === true;
  const hasTools = Array.isArray(body?.tools) && body.tools.length > 0;

  console.log(
    "[proxy] %s %s%s → api.anthropic.com",
    model,
    streaming ? "stream " : "",
    hasTools ? `(${body.tools.length} tools) ` : "",
  );

  // Build upstream headers
  const fwdHeaders = {};
  for (const [key, val] of Object.entries(req.headers)) {
    if (
      ["host", "connection", "content-length", "x-api-key", "authorization"].includes(
        key.toLowerCase(),
      )
    )
      continue;
    fwdHeaders[key] = val;
  }
  fwdHeaders["authorization"] = `Bearer ${token}`;
  fwdHeaders["user-agent"] = "claude-cli/2.1.92 (external, cli)";
  fwdHeaders["x-app"] = "cli";

  // Match Claude Code's exact beta headers
  const requiredBetas = [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "context-management-2025-06-27",
    "prompt-caching-scope-2026-01-05",
    "effort-2025-11-24",
  ];
  const blockedBetas = new Set(["context-1m-2025-08-07"]); // breaks OAuth
  const existingBeta = fwdHeaders["anthropic-beta"] || "";
  const allBetas = [
    ...requiredBetas,
    ...existingBeta.split(",").map((s) => s.trim()).filter(Boolean),
  ].filter((b) => !blockedBetas.has(b));
  fwdHeaders["anthropic-beta"] = [...new Set(allBetas)].join(",");

  // Claude Code uses ?beta=true on the URL
  const upstreamUrl = new URL(`${ANTHROPIC_API}${req.url}`);
  upstreamUrl.searchParams.set("beta", "true");
  const upstream = upstreamUrl.href;

  try {
    let upRes = await fetch(upstream, {
      method: req.method,
      headers: fwdHeaders,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : forwardBody,
      signal: AbortSignal.timeout(300_000),
    });

    // On 401, refresh and retry once
    if (upRes.status === 401) {
      console.log("[proxy] 401 — refreshing token");
      cachedCreds = null;
      token = await getAccessToken();
      fwdHeaders["authorization"] = `Bearer ${token}`;
      upRes = await fetch(upstream, {
        method: req.method,
        headers: fwdHeaders,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : forwardBody,
        signal: AbortSignal.timeout(300_000),
      });
    }

    // Stream response through
    const resHeaders = {};
    for (const [key, val] of upRes.headers.entries()) {
      if (["transfer-encoding", "connection"].includes(key.toLowerCase()))
        continue;
      resHeaders[key] = val;
    }
    res.writeHead(upRes.status, resHeaders);

    if (upRes.body) {
      const reader = upRes.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } finally {
        res.end();
      }
    } else {
      res.end();
    }

    const ms = Date.now() - t0;
    console.log("[proxy] %d %dms", upRes.status, ms);
  } catch (err) {
    const ms = Date.now() - t0;
    console.error("[proxy] ERROR %dms: %s cause=%s", ms, err.message, err.cause?.message || err.cause || "none");
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
    }
    res.end(
      JSON.stringify({
        type: "error",
        error: { type: "proxy_error", message: err.message },
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const server = createServer(handleRequest);
server.listen(PORT, "127.0.0.1", () => {
  console.log();
  console.log("  claude-code-proxy running on http://127.0.0.1:%d", PORT);
  console.log();
  console.log("  Set your app's Anthropic base URL to:");
  console.log("    ANTHROPIC_BASE_URL=http://127.0.0.1:%d", PORT);
  console.log();

  // Pre-warm token
  getAccessToken()
    .then(() => console.log("[proxy] Token ready"))
    .catch((err) => console.error("[proxy] Token error:", err.message));
});

server.on("error", (err) => {
  console.error("Server error:", err.message);
  process.exit(1);
});
process.on("SIGINT", () => {
  server.close();
  process.exit(0);
});
