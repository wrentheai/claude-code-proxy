# claude-code-proxy

Local proxy that lets any app use the Anthropic Messages API through your Claude Code subscription. No API keys needed.

## The Problem

You have a Claude Pro/Max subscription with Claude Code. You want to use it from other apps (OpenClaw, custom bots, scripts) — but Anthropic's API requires API keys with separate billing, and OAuth tokens get flagged as "third-party apps" requiring extra usage credits.

## The Solution

This proxy sits between your app and Claude. It:

1. Accepts standard Anthropic Messages API requests (including SSE streaming)
2. Routes them through `claude -p` (Claude Code's print mode)
3. Returns proper Messages API responses

Your requests go through Claude Code's first-party auth — using your existing subscription, no API keys, no extra-usage credits.

```
Your App  →  claude-code-proxy (localhost:8082)  →  claude -p  →  Anthropic API
              Anthropic Messages API                First-party     Subscription
              compatible                            auth             limits
```

## Prerequisites

- **Node.js 18+**
- **Claude Code** installed and logged in (`claude auth status` should show `loggedIn: true`)
- **Claude Pro or Max subscription**

## Quick Start

```bash
npx claude-code-proxy
```

That's it. The proxy starts on `http://127.0.0.1:8082`.

Point your app's Anthropic base URL to the proxy:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8082
```

## Options

```
--port <number>     Port to listen on (default: 8082)
--claude <path>     Path to claude binary (auto-detected)
--timeout <ms>      Max time per request in ms (default: 300000)
```

## Usage with OpenClaw

### 1. Start the proxy

```bash
npx claude-code-proxy
```

### 2. Patch pi-ai to use the proxy

OpenClaw's Anthropic provider ignores `ANTHROPIC_BASE_URL`. You need to patch it so requests route through the proxy instead of directly to Anthropic.

Find the `createClient` function in:
```
<openclaw-install>/node_modules/@mariozechner/pi-ai/dist/providers/anthropic.js
```

On macOS with Homebrew, the full path is typically:
```
/opt/homebrew/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai/dist/providers/anthropic.js
```

Add these 3 lines to the **top** of the `createClient` function body:

```js
function createClient(model, apiKey, interleavedThinking, optionsHeaders, dynamicHeaders) {
    // [claude-proxy] Allow ANTHROPIC_BASE_URL env var to override hardcoded baseUrl
    if (typeof process !== "undefined" && process.env.ANTHROPIC_BASE_URL && model.provider === "anthropic") {
        model = { ...model, baseUrl: process.env.ANTHROPIC_BASE_URL };
    }
    // ... rest of function unchanged
```

> **Note:** This patch is overwritten every time you run `openclaw update`. You'll need to re-apply it after updates.

### 3. Add `ANTHROPIC_BASE_URL` to the gateway's environment

Edit your OpenClaw gateway plist (`~/Library/LaunchAgents/ai.openclaw.gateway.plist`) and add this inside the `<dict>` under `EnvironmentVariables`:

```xml
<key>ANTHROPIC_BASE_URL</key>
<string>http://127.0.0.1:8082</string>
```

### 4. Increase timeouts

The proxy routes requests through `claude -p`, which can take several minutes for complex tool-use responses. OpenClaw's default LLM idle timeout is 60 seconds — too short.

Add these to your `~/.openclaw/openclaw.json` inside `agents.defaults`:

```json
{
  "agents": {
    "defaults": {
      "timeoutSeconds": 600,
      "llm": {
        "idleTimeoutSeconds": 600
      }
    }
  }
}
```

### 5. Restart everything

```bash
# Restart the gateway to pick up env + config changes
launchctl unload ~/Library/LaunchAgents/ai.openclaw.gateway.plist
launchctl load ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

### After `openclaw update`

The only thing you need to redo is step 2 — re-apply the pi-ai patch. The proxy, plist, and config changes survive updates.

### macOS launchd service (proxy)

To run the proxy as a persistent background service:

```bash
cat > ~/Library/LaunchAgents/claude-code-proxy.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>claude-code-proxy</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/claude-code-proxy/index.js</string>
    <string>--port</string>
    <string>8082</string>
  </array>
  <key>StandardOutPath</key><string>/tmp/claude-code-proxy.log</string>
  <key>StandardErrorPath</key><string>/tmp/claude-code-proxy.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>/Users/YOU</string>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:~/.local/bin</string>
  </dict>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/claude-code-proxy.plist
```

## Usage with any Anthropic SDK app

```python
# Python
import anthropic
client = anthropic.Anthropic(base_url="http://127.0.0.1:8082", api_key="unused")
msg = client.messages.create(model="claude-opus-4-6", max_tokens=1024, messages=[...])
```

```javascript
// Node.js
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({ baseURL: "http://127.0.0.1:8082", apiKey: "unused" });
const msg = await client.messages.create({ model: "claude-opus-4-6", max_tokens: 1024, messages: [...] });
```

```bash
# curl
curl http://127.0.0.1:8082/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4-6","max_tokens":100,"messages":[{"role":"user","content":"Hello"}]}'
```

## How It Works

1. Your app sends a standard Anthropic Messages API request to the proxy
2. The proxy converts the messages to a text prompt
3. It calls `claude -p --output-format json --model <model>` via stdin
4. Claude Code handles auth using your subscription (first-party, plan limits)
5. The proxy converts Claude Code's JSON output back to Messages API format
6. If `stream: true`, it emits proper SSE events

### System prompt sanitization

Anthropic pattern-matches system prompts for known third-party app identifiers and reclassifies those requests to draw from extra-usage credits instead of plan limits. The proxy automatically replaces detected identifiers with neutral terms. You can add custom patterns in the `SANITIZE_PATTERNS` array.

## Limitations

- **Not real streaming** — Claude Code runs to completion, then the proxy emits the result as SSE events. The response appears all at once rather than token-by-token.
- **Tool use** — Tool definitions are injected into the system prompt and tool calls are parsed from text output. Works for simple cases but may not match the native API's structured tool use exactly.
- **Concurrency** — Each request spawns a `claude -p` process. Heavy concurrent usage may hit Claude Code's rate limits.
- **macOS/Linux only** — Requires Claude Code CLI. Windows support depends on Claude Code's Windows availability.

## License

MIT
