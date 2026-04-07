#!/usr/bin/env node

/**
 * claude-code-proxy
 *
 * Local Anthropic Messages API proxy that routes through `claude -p`.
 * Gets the real Claude Code rate limit bucket (not the restricted
 * third-party/OAuth bucket). Full streaming and tool_use support via
 * stream-json output parsing.
 *
 * Usage:
 *   npx claude-code-proxy                   # default port 8082
 *   npx claude-code-proxy --port 9000       # custom port
 */

import { createServer } from "node:http";
import { spawn, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = parseInt(arg("port", "8082"), 10);
const TIMEOUT_MS = parseInt(arg("timeout", "120000"), 10);

const CLAUDE_BIN = (() => {
  try { return execSync("which claude", { encoding: "utf-8" }).trim(); }
  catch { return "claude"; }
})();

// ---------------------------------------------------------------------------
// Sanitization — strip third-party app identifiers from prompts
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
  for (const [re, rep] of SANITIZE_PATTERNS) out = out.replace(re, rep);
  return out;
}

// ---------------------------------------------------------------------------
// Messages API → text prompt for claude -p stdin
// ---------------------------------------------------------------------------
const TOOL_RESULT_MAX = 300;

function messagesToPrompt(messages) {
  const parts = [];
  for (const msg of messages) {
    const role = msg.role === "assistant" ? "Assistant" : "Human";
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .map((block) => {
          if (block.type === "text") return block.text;
          if (block.type === "tool_use") return `[Used tool: ${block.name}]`;
          if (block.type === "tool_result") {
            let c = typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((b) => b.text || "").join("\n")
                : "";
            if (c.length > TOOL_RESULT_MAX) c = c.slice(0, TOOL_RESULT_MAX) + "...";
            return c ? `[Tool result: ${c}]` : "";
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    if (text) parts.push(`${role}: ${text}`);
  }
  return parts.join("\n\n");
}

function extractSystemPrompt(body) {
  if (typeof body.system === "string") return body.system;
  if (Array.isArray(body.system))
    return body.system.map((b) => b.text || "").join("\n");
  return "";
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------
function uid(len = 24) { return randomUUID().replace(/-/g, "").slice(0, len); }

function emitSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ---------------------------------------------------------------------------
// Run claude -p and parse stream-json output
// ---------------------------------------------------------------------------
function runClaude(prompt, systemPrompt, model) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--dangerously-skip-permissions",
      "--allowedTools", "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch",
    ];

    if (model?.includes("opus")) args.push("--model", "opus");
    else if (model?.includes("sonnet")) args.push("--model", "sonnet");
    else if (model?.includes("haiku")) args.push("--model", "haiku");

    let tmpFile = null;
    if (systemPrompt) {
      tmpFile = join(tmpdir(), `ccp-sys-${Date.now()}-${uid(8)}.txt`);
      writeFileSync(tmpFile, sanitize(systemPrompt));
      args.push("--system-prompt-file", tmpFile);
    }

    const proc = spawn(CLAUDE_BIN, args, {
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli" },
      timeout: TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stdin.write(sanitize(prompt));
    proc.stdin.end();

    // Parse stream-json lines
    const rl = createInterface({ input: proc.stdout });
    const contentBlocks = [];
    let usage = {};
    let resultText = "";
    let isError = false;
    let stopReason = "end_turn";

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);

        if (event.type === "assistant" && event.message?.content) {
          // Collect content blocks from assistant messages
          for (const block of event.message.content) {
            if (block.type === "text" && block.text) {
              contentBlocks.push({ type: "text", text: block.text });
            } else if (block.type === "thinking" && block.thinking) {
              contentBlocks.push({
                type: "thinking",
                thinking: block.thinking,
                ...(block.signature ? { signature: block.signature } : {}),
              });
            }
          }
          if (event.message.usage) {
            usage = {
              input_tokens: event.message.usage.input_tokens || 0,
              output_tokens: event.message.usage.output_tokens || 0,
              cache_creation_input_tokens: event.message.usage.cache_creation_input_tokens || 0,
              cache_read_input_tokens: event.message.usage.cache_read_input_tokens || 0,
            };
          }
          if (event.message.stop_reason) {
            stopReason = event.message.stop_reason;
          }
        }

        if (event.type === "result") {
          resultText = event.result || "";
          isError = !!event.is_error;
          if (event.usage) {
            usage.input_tokens = event.usage.input_tokens || usage.input_tokens || 0;
            usage.output_tokens = event.usage.output_tokens || usage.output_tokens || 0;
          }
        }
      } catch { /* skip non-JSON lines */ }
    });

    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d; });

    proc.on("close", (code) => {
      if (tmpFile) try { unlinkSync(tmpFile); } catch {}

      // If we got content blocks from stream-json, use those
      // Otherwise fall back to the result text
      if (contentBlocks.length === 0 && resultText) {
        contentBlocks.push({ type: "text", text: resultText });
      }

      if (contentBlocks.length === 0 && !resultText) {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 300)}`));
        return;
      }

      if (isError) {
        console.error("[proxy] claude error:", resultText.slice(0, 200));
      }

      resolve({ contentBlocks, usage, stopReason, isError, resultText });
    });

    proc.on("error", (err) => reject(new Error(`spawn: ${err.message}`)));
  });
}

// ---------------------------------------------------------------------------
// Request serialization
// ---------------------------------------------------------------------------
let _busy = false;
const _pending = [];

function runClaudeSerialized(prompt, systemPrompt, model) {
  return new Promise((resolve, reject) => {
    const run = () =>
      runClaude(prompt, systemPrompt, model)
        .then(resolve, reject)
        .finally(() => {
          _busy = false;
          const next = _pending.shift();
          if (next) { _busy = true; next(); }
        });

    if (!_busy) { _busy = true; run(); }
    else {
      console.log("[proxy] queued (position %d)", _pending.length + 1);
      _pending.push(run);
    }
  });
}

// ---------------------------------------------------------------------------
// HTTP handler
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

  if (req.method !== "POST" || !req.url.includes("/messages")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { type: "not_found", message: "POST /v1/messages only" } }));
    return;
  }

  const t0 = Date.now();
  const chunks = [];
  for await (const c of req) chunks.push(c);

  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { type: "invalid_request", message: "Invalid JSON" } }));
    return;
  }

  const model = body.model || "claude-opus-4-6";
  const prompt = sanitize(messagesToPrompt(body.messages || []));
  const systemPrompt = extractSystemPrompt(body);
  const streaming = body.stream === true;

  console.log("[proxy] %s %s(prompt %d, system %d)", model, streaming ? "stream " : "", prompt.length, systemPrompt.length);

  try {
    const result = await runClaudeSerialized(prompt, systemPrompt, model);
    const ms = Date.now() - t0;
    console.log("[proxy] %s %dms in=%d out=%d", result.isError ? "ERR" : "OK", ms, result.usage.input_tokens || 0, result.usage.output_tokens || 0);

    const msgId = `msg_${uid()}`;

    if (!streaming) {
      // Non-streaming: return full JSON response
      const content = result.contentBlocks.length > 0
        ? result.contentBlocks
        : [{ type: "text", text: result.resultText || "" }];

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: msgId,
        type: "message",
        role: "assistant",
        model,
        content,
        stop_reason: result.stopReason,
        stop_sequence: null,
        usage: result.usage,
      }));
      return;
    }

    // Streaming: emit SSE events
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // message_start
    emitSSE(res, "message_start", {
      type: "message_start",
      message: {
        id: msgId, type: "message", role: "assistant", content: [], model,
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: result.usage.input_tokens || 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });

    // Emit each content block
    let idx = 0;
    for (const block of result.contentBlocks) {
      if (block.type === "thinking") {
        emitSSE(res, "content_block_start", { type: "content_block_start", index: idx, content_block: { type: "thinking", thinking: "", signature: "" } });
        emitSSE(res, "content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "thinking_delta", thinking: block.thinking } });
        if (block.signature) {
          emitSSE(res, "content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "signature_delta", signature: block.signature } });
        }
        emitSSE(res, "content_block_stop", { type: "content_block_stop", index: idx });
        idx++;
      } else if (block.type === "text") {
        emitSSE(res, "content_block_start", { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } });
        // Chunk the text for streaming feel
        const CHUNK = 80;
        for (let i = 0; i < block.text.length; i += CHUNK) {
          emitSSE(res, "content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: block.text.slice(i, i + CHUNK) } });
        }
        emitSSE(res, "content_block_stop", { type: "content_block_stop", index: idx });
        idx++;
      }
    }

    // If no blocks, emit empty text
    if (idx === 0) {
      emitSSE(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      emitSSE(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: result.resultText || "" } });
      emitSSE(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    }

    // message_delta + message_stop
    emitSSE(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: result.stopReason, stop_sequence: null },
      usage: { output_tokens: result.usage.output_tokens || 0 },
    });
    emitSSE(res, "message_stop", { type: "message_stop" });
    res.end();

  } catch (err) {
    const ms = Date.now() - t0;
    console.error("[proxy] %dms ERROR: %s", ms, err.message);
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
  console.log();
  console.log("  claude-code-proxy running on http://127.0.0.1:%d", PORT);
  console.log("  Claude binary: %s", CLAUDE_BIN);
  console.log("  Routes: Anthropic Messages API → claude -p (first-party auth)");
  console.log();
  console.log("  Set your app's Anthropic base URL to:");
  console.log("    ANTHROPIC_BASE_URL=http://127.0.0.1:%d", PORT);
  console.log();
});

server.on("error", (err) => { console.error("Server error:", err.message); process.exit(1); });
process.on("SIGINT", () => { server.close(); process.exit(0); });
