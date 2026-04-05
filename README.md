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

1. Start the proxy:
   ```bash
   npx claude-code-proxy
   ```

2. Patch OpenClaw's pi-ai to use the proxy (add to top of `createClient` in
   `node_modules/@mariozechner/pi-ai/dist/providers/anthropic.js`):
   ```js
   if (typeof process !== "undefined" && process.env.ANTHROPIC_BASE_URL && model.provider === "anthropic") {
       model = { ...model, baseUrl: process.env.ANTHROPIC_BASE_URL };
   }
   ```

3. Set the env var and restart OpenClaw's gateway:
   ```bash
   # Add to your gateway's environment:
   ANTHROPIC_BASE_URL=http://127.0.0.1:8082
   ```

### macOS launchd service

To run the proxy as a persistent service:

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
