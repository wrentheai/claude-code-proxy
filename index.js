#!/usr/bin/env node

/**
 * claude-code-proxy
 *
 * Local Anthropic Messages API proxy that uses your Claude Code subscription.
 * Captures Claude Code's billing header on startup, then forwards all requests
 * directly to the Anthropic API with full tool_use, streaming, and caching support.
 *
 * First-party rate limits, no API keys, no extra-usage credits.
 *
 * Usage:
 *   npx claude-code-proxy                   # default port 8082
 *   npx claude-code-proxy --port 9000       # custom port
 */

import { createServer } from "node:http";
import { spawn, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

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
const KEYCHAIN_SERVICE = "Claude Code-credentials";

const CLAUDE_BIN = (() => {
  try { return execSync("which claude", { encoding: "utf-8" }).trim(); }
  catch { return "claude"; }
})();

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------
const SANITIZE_PATTERNS = [
  [/OpenClaw/gi, "AssistantPlatform"],
  [/openclaw/g, "assistantplatform"],
  [/SimpleClaw/gi, "AssistantService"],
  [/simpleclaw/g, "assistantservice"],
  [/clawhub/gi, "skillhub"],
  [/claw-memory/gi, "asst-memory"],
  [/\/clawd\//g, "/workspace/"],
  [/~\/clawd/g, "~/workspace"],
  [/kevinl\/clawd/g, "kevinl/workspace"],
];

function sanitize(text) {
  if (!text) return text;
  let out = text;
  for (const [re, rep] of SANITIZE_PATTERNS) out = out.replace(re, rep);
  return out;
}

// ---------------------------------------------------------------------------
// Billing header capture
//
// Claude Code's binary adds a billing header to every API request as the
// first system prompt block. This header includes a `cch` hash that grants
// first-party rate limits. We capture it once via a probe call and reuse it.
// ---------------------------------------------------------------------------
let billingHeader = null;

async function captureBillingHeader() {
  return new Promise((resolve, reject) => {
    const sniffServer = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString();

      try {
        const body = JSON.parse(raw);
        for (const block of (Array.isArray(body.system) ? body.system : [])) {
          if ((block.text || "").includes("billing-header") && !billingHeader) {
            billingHeader = block.text.trim();
            console.log("[proxy] Captured billing header: %s", billingHeader.slice(0, 60) + "...");
          }
        }
      } catch {}

      const fwd = { ...req.headers };
      delete fwd.host;
      delete fwd.connection;
      try {
        const up = await fetch(ANTHROPIC_API + req.url, { method: req.method, headers: fwd, body: raw });
        const rh = {};
        for (const [k, v] of up.headers.entries()) {
          if (!["transfer-encoding", "connection"].includes(k)) rh[k] = v;
        }
        res.writeHead(up.status, rh);
        const text = await up.text();
        res.end(text);
      } catch {
        res.writeHead(502);
        res.end("proxy error");
      }
    });

    sniffServer.listen(0, "127.0.0.1", () => {
      const sniffPort = sniffServer.address().port;
      const proc = spawn(CLAUDE_BIN, ["-p", "--output-format", "json", "--tools", "", "--model", "haiku", "hi"], {
        env: { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${sniffPort}`, CLAUDE_CODE_ENTRYPOINT: "cli" },
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Kill probe after we capture the header or after timeout
      const killTimer = setTimeout(() => {
        proc.kill("SIGKILL");
      }, 20_000);

      proc.on("close", () => {
        clearTimeout(killTimer);
        sniffServer.close(() => {
          billingHeader ? resolve(billingHeader) : reject(new Error("No billing header captured"));
        });
      });
      proc.on("error", () => {
        clearTimeout(killTimer);
        sniffServer.close(() => reject(new Error("claude probe failed")));
      });

      // Also kill early once we have the header
      const checkInterval = setInterval(() => {
        if (billingHeader) {
          clearInterval(checkInterval);
          proc.kill();
        }
      }, 500);
    });
  });
}

// Refresh billing header periodically (every 30 min)
function scheduleBillingRefresh() {
  setInterval(async () => {
    try {
      await captureBillingHeader();
      console.log("[proxy] Billing header refreshed");
    } catch (err) {
      console.error("[proxy] Billing refresh failed:", err.message);
    }
  }, 30 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// OAuth token management
// ---------------------------------------------------------------------------
let cachedCreds = null;

function readKeychain() {
  const accounts = ["Claude Code", process.env.USER, "default"].filter(Boolean);
  let best = null;
  for (const account of accounts) {
    try {
      const raw = execSync(
        `security find-generic-password -s "${KEYCHAIN_SERVICE}" -a "${account}" -w`,
        { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
      ).trim();
      const creds = JSON.parse(raw).claudeAiOauth;
      if (creds?.accessToken && (!best || (creds.expiresAt || 0) > (best.expiresAt || 0))) {
        best = creds;
      }
    } catch { continue; }
  }
  return best;
}

async function refreshToken(refreshTok) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refreshTok }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Refresh failed (${res.status})`);
  const data = await res.json();
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + data.expires_in * 1000 - 300_000 };
}

async function getAccessToken() {
  const kc = readKeychain();
  if (!kc) throw new Error("No Claude Code credentials in keychain");
  if (kc.expiresAt > Date.now() + 120_000) return kc.accessToken;
  const refreshTok = kc.refreshToken || cachedCreds?.refreshToken;
  if (!refreshTok) throw new Error("No refresh token");
  const fresh = await refreshToken(refreshTok);
  cachedCreds = fresh;
  return fresh.accessToken;
}

// ---------------------------------------------------------------------------
// Request sanitization
// ---------------------------------------------------------------------------
function sanitizeBody(body) {
  // Nuclear: sanitize the entire JSON string
  let json = JSON.stringify(body);
  json = sanitize(json);
  return json;
}

function injectBillingHeader(body) {
  if (!billingHeader) return body;

  const billing = { type: "text", text: billingHeader };
  const cleaned = { ...body };

  if (typeof cleaned.system === "string") {
    cleaned.system = [billing, { type: "text", text: cleaned.system }];
  } else if (Array.isArray(cleaned.system)) {
    cleaned.system = [billing, ...cleaned.system];
  } else {
    cleaned.system = [billing];
  }

  return cleaned;
}

// ---------------------------------------------------------------------------
// Proxy handler
// ---------------------------------------------------------------------------
async function handleRequest(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, anthropic-version, anthropic-beta, x-api-key",
    });
    res.end();
    return;
  }

  const t0 = Date.now();
  const chunks = [];
  for await (const c of req) chunks.push(c);

  let token;
  try { token = await getAccessToken(); }
  catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { type: "proxy_error", message: err.message } }));
    return;
  }

  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString()); }
  catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { type: "invalid_request", message: "Invalid JSON" } }));
    return;
  }

  const model = body.model || "unknown";
  const streaming = body.stream === true;
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  console.log("[proxy] %s %s%s", model, streaming ? "stream " : "", hasTools ? `(${body.tools.length} tools) ` : "");
  console.log("[proxy] inbound betas: %s", req.headers["anthropic-beta"] || "none");
  console.log("[proxy] thinking: %s", JSON.stringify(body.thinking || null));

  if (Array.isArray(body.tools)) {
    console.log("[proxy] tools: %d", body.tools.length);
  }

  // Inject metadata if missing — required for first-party classification
  if (!body.metadata) {
    body.metadata = {
      user_id: JSON.stringify({
        device_id: "d31acc551cf52ca5605096f39399fff616a011ec1e60de3f4cc191605dbf8688",
        account_uuid: "eda3e3e5-2ed8-4364-a353-aa586e047252",
        session_id: global._proxySessionId || randomUUID(),
      }),
    };
  }

  const preparedBody = injectBillingHeader(body);

  // Sanitize ONLY system prompt blocks — not tools, messages, or paths
  if (Array.isArray(preparedBody.system)) {
    preparedBody.system = preparedBody.system.map((block) => {
      if (block.type === "text" && typeof block.text === "string") {
        return { ...block, text: sanitize(block.text) };
      }
      return block;
    });
  } else if (typeof preparedBody.system === "string") {
    preparedBody.system = sanitize(preparedBody.system);
  }

  const forwardBody = JSON.stringify(preparedBody);
  // Verify thinking is gone
  const parsed = JSON.parse(forwardBody);
  console.log("[proxy] FINAL body thinking: %s, tools: %d", JSON.stringify(parsed.thinking || null), (parsed.tools||[]).length);

  // Build headers
  const fwdHeaders = {};
  for (const [key, val] of Object.entries(req.headers)) {
    if (["host", "connection", "content-length", "x-api-key", "authorization"].includes(key.toLowerCase())) continue;
    fwdHeaders[key] = val;
  }
  fwdHeaders["authorization"] = `Bearer ${token}`;
  fwdHeaders["user-agent"] = "claude-cli/2.1.97 (external, cli)";
  fwdHeaders["x-app"] = "cli";
  fwdHeaders["anthropic-dangerous-direct-browser-access"] = "true";
  if (!global._proxySessionId) global._proxySessionId = randomUUID();
  fwdHeaders["x-claude-code-session-id"] = global._proxySessionId;
  fwdHeaders["x-stainless-arch"] = "arm64";
  fwdHeaders["x-stainless-lang"] = "js";
  fwdHeaders["x-stainless-os"] = "MacOS";
  fwdHeaders["x-stainless-package-version"] = "0.81.0";
  fwdHeaders["x-stainless-runtime"] = "node";
  fwdHeaders["x-stainless-runtime-version"] = process.version;
  fwdHeaders["x-stainless-retry-count"] = "0";
  fwdHeaders["x-stainless-timeout"] = "600";

  // Merge beta headers
  // Match Claude Code's exact beta set
  const requiredBetas = [
    "claude-code-20250219", "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14", "context-management-2025-06-27",
    "prompt-caching-scope-2026-01-05", "effort-2025-11-24",
  ];
  const blockedBetas = new Set(["context-1m-2025-08-07"]);
  const existing = (fwdHeaders["anthropic-beta"] || "").split(",").map(s => s.trim()).filter(Boolean);
  const finalBetas = [...new Set([...requiredBetas, ...existing])].filter(b => !blockedBetas.has(b));
  fwdHeaders["anthropic-beta"] = finalBetas.join(",");
  console.log("[proxy] outbound betas: %s", fwdHeaders["anthropic-beta"]);

  const upstreamUrl = new URL(`${ANTHROPIC_API}${req.url}`);
  upstreamUrl.searchParams.set("beta", "true");

  try {
    let upRes = await fetch(upstreamUrl.href, {
      method: req.method,
      headers: fwdHeaders,
      body: forwardBody,
      signal: AbortSignal.timeout(300_000),
    });

    // On 400/401, refresh billing header + token and retry
    if (upRes.status === 400 || upRes.status === 401) {
      console.log("[proxy] %d — refreshing billing header + token", upRes.status);
      cachedCreds = null;
      try { await captureBillingHeader(); } catch {}
      token = await getAccessToken();
      fwdHeaders["authorization"] = `Bearer ${token}`;
      // Re-inject fresh billing header
      const freshBody = injectBillingHeader(body);
      if (Array.isArray(freshBody.system)) {
        freshBody.system = freshBody.system.map(b =>
          b.type === "text" && typeof b.text === "string" ? { ...b, text: sanitize(b.text) } : b
        );
      }
      const retryBody = JSON.stringify(freshBody);
      upRes = await fetch(upstreamUrl.href, {
        method: req.method, headers: fwdHeaders, body: retryBody,
        signal: AbortSignal.timeout(300_000),
      });
    }

    // Stream response through
    const resHeaders = {};
    for (const [k, v] of upRes.headers.entries()) {
      if (!["transfer-encoding", "connection"].includes(k)) resHeaders[k] = v;
    }
    res.writeHead(upRes.status, resHeaders);

    if (upRes.body) {
      const reader = upRes.body.getReader();
      try { while (true) { const { done, value } = await reader.read(); if (done) break; res.write(value); } }
      finally { res.end(); }
    } else {
      res.end();
    }

    const ms = Date.now() - t0;
    console.log("[proxy] %d %dms", upRes.status, ms);
  } catch (err) {
    const ms = Date.now() - t0;
    console.error("[proxy] %dms ERROR: %s", ms, err.message);
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "proxy_error", message: err.message } }));
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main() {
  console.log("[proxy] Capturing billing header from Claude Code...");
  try {
    await captureBillingHeader();
  } catch (err) {
    console.error("[proxy] WARNING: Could not capture billing header:", err.message);
    console.error("[proxy] Requests may hit third-party rate limits");
  }

  scheduleBillingRefresh();

  const server = createServer(handleRequest);
  server.listen(PORT, "127.0.0.1", () => {
    console.log();
    console.log("  claude-code-proxy running on http://127.0.0.1:%d", PORT);
    console.log("  Billing header: %s", billingHeader ? "captured" : "MISSING");
    console.log();
    console.log("  Set your app's Anthropic base URL to:");
    console.log("    ANTHROPIC_BASE_URL=http://127.0.0.1:%d", PORT);
    console.log();
  });

  server.on("error", (err) => { console.error("Server error:", err.message); process.exit(1); });
  process.on("SIGINT", () => { server.close(); process.exit(0); });
}

main();
