#!/usr/bin/env node

/**
 * claude-code-proxy
 *
 * True API forwarder that proxies Anthropic Messages API requests using
 * Claude Code's OAuth token from the macOS keychain. Requests and responses
 * pass through unmodified — tool_use blocks, streaming SSE, everything.
 *
 * Usage:
 *   npx claude-code-proxy --port 8082
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = parseInt(arg("port", "8082"), 10);
const ANTHROPIC_API = "https://api.anthropic.com";

// Path to OpenClaw's auth profiles (where it stores refreshed OAuth tokens)
const AUTH_PROFILES_PATH = arg("auth-profiles",
  `${process.env.HOME}/.openclaw/agents/main/agent/auth-profiles.json`);
const AUTH_PROFILE_ID = arg("auth-profile", "anthropic:default");

// ---------------------------------------------------------------------------
// OAuth token management — reads from OpenClaw's auth store
// ---------------------------------------------------------------------------
function getToken() {
  try {
    const data = JSON.parse(readFileSync(AUTH_PROFILES_PATH, "utf-8"));
    const profile = data.profiles?.[AUTH_PROFILE_ID];
    if (!profile) throw new Error(`Profile "${AUTH_PROFILE_ID}" not found`);
    // OpenClaw stores OAuth tokens as type:"token" with a "token" field
    const token = profile.token || profile.access;
    if (!token) throw new Error(`No token in profile "${AUTH_PROFILE_ID}"`);
    return token;
  } catch (err) {
    throw new Error(`Failed to read auth: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP handler — true API proxy
// ---------------------------------------------------------------------------
async function handleRequest(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    });
    res.end();
    return;
  }

  if (req.method !== "POST" || !req.url.includes("/messages")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { type: "not_found", message: "POST /v1/messages only" } }));
    return;
  }

  const t0 = Date.now();

  // Read request body
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const bodyBuf = Buffer.concat(chunks);

  let body;
  try { body = JSON.parse(bodyBuf.toString()); }
  catch { res.writeHead(400); res.end('{"error":{"message":"Invalid JSON"}}'); return; }

  const model = body.model || "claude-opus-4-6";
  const streaming = body.stream === true;

  console.log("[proxy] %s %s (msgs %d, stream %s)", model, req.url, (body.messages || []).length, streaming);

  let token;
  try {
    token = getToken();
  } catch (err) {
    console.error("[proxy] Auth error: %s", err.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { type: "auth_error", message: err.message } }));
    return;
  }

  // Build upstream request headers — OAuth requires specific beta flags + identity headers
  const betaFlags = new Set([
    "claude-code-20250219",
    "oauth-2025-04-20",
    "fine-grained-tool-streaming-2025-05-14",
    "interleaved-thinking-2025-05-14",
  ]);
  // Merge any beta flags from the incoming request
  if (req.headers["anthropic-beta"]) {
    for (const flag of req.headers["anthropic-beta"].split(",")) {
      betaFlags.add(flag.trim());
    }
  }

  const upstreamHeaders = {
    "Content-Type": "application/json",
    "anthropic-version": req.headers["anthropic-version"] || "2023-06-01",
    "Authorization": `Bearer ${token}`,
    "anthropic-beta": [...betaFlags].join(","),
    "user-agent": "claude-cli/2.1.97",
    "x-app": "cli",
    "accept": "application/json",
    "anthropic-dangerous-direct-browser-access": "true",
  };

  try {
    const upstreamUrl = `${ANTHROPIC_API}${req.url}`;
    const upstreamRes = await fetch(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: bodyBuf,
    });

    const ms = Date.now() - t0;

    // Forward status and headers
    const fwdHeaders = {};
    for (const [k, v] of upstreamRes.headers.entries()) {
      // Skip hop-by-hop headers
      if (["transfer-encoding", "connection", "keep-alive"].includes(k.toLowerCase())) continue;
      fwdHeaders[k] = v;
    }
    fwdHeaders["Access-Control-Allow-Origin"] = "*";

    res.writeHead(upstreamRes.status, fwdHeaders);

    if (streaming && upstreamRes.ok && upstreamRes.body) {
      // Pipe SSE stream directly through
      const reader = upstreamRes.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } catch (err) {
        console.error("[proxy] Stream error: %s", err.message);
      }
      console.log("[proxy] %s %dms (streamed)", upstreamRes.status === 200 ? "OK" : "ERR", ms);
      res.end();
    } else {
      // Non-streaming: forward response body
      const respBody = await upstreamRes.arrayBuffer();
      console.log("[proxy] %s %dms (%d bytes)", upstreamRes.status === 200 ? "OK" : "ERR", Date.now() - t0, respBody.byteLength);
      res.end(Buffer.from(respBody));
    }
  } catch (err) {
    const ms = Date.now() - t0;
    console.error("[proxy] %dms FETCH_ERROR: %s", ms, err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
    }
    res.end(JSON.stringify({ type: "error", error: { type: "proxy_error", message: err.message } }));
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const server = createServer(handleRequest);
server.listen(PORT, "127.0.0.1", () => {
  // Validate token on startup
  try { getToken(); } catch (err) {
    console.error("  WARNING: %s", err.message);
  }
  console.log("\n  claude-code-proxy on http://127.0.0.1:%d", PORT);
  console.log("  Mode: OAuth token forwarder (true API proxy)\n");
});
server.on("error", e => { console.error("Server:", e.message); process.exit(1); });
process.on("SIGINT", () => { server.close(); process.exit(0); });
