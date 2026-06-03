# grok-agent-openai-shim

A lightweight OpenAI-compatible proxy designed specifically for the **Grok Build** agent. Route your Grok agent's LLM requests to multiple providers (Fireworks, OpenRouter, OpenAI, etc.) through a single local endpoint, with provider/model routing and automatic API key injection.

**Built for:** Grok Build agent ([xAI](https://x.ai))

## Features

- **Multi-provider routing** — one proxy, many backends. Use `provider/model` syntax.
- **Model aliases** — map short names to provider-specific full model IDs.
- **API key injection** — proxy stores provider keys, client doesn't need to know them.
- **Hot config reload** — edit `config.json` without restarting.
- **OpenAI API compatibility** — sanitizes payloads (removes `model_id`, cleans `null` enums).
- **SSE streaming** — tokens stream in real time, no buffering.
- **CORS enabled** — works in browser-based clients.
- **Privacy-first logging** — body logging is opt-in (`LOG_BODIES`).

## Requirements

- [Bun](https://bun.sh) 1.2+

## Quick Start

1. Copy the example and fill in your real API keys:
   ```bash
   cp config.json.example config.json
   ```

2. Run the proxy:

```bash
bun run proxy.ts
```

3. Point your client at the proxy root `http://localhost:3000` (with or without `/v1`) and use model names like:

```json
{
  "model": "fireworks/llama3-8b",
  "messages": [{"role": "user", "content": "Hello"}]
}
```

If no provider prefix is given, the `defaultProvider` is used.

## Grok Build Agent Setup

Add this to your Grok config (`~/.grok/config.toml`) to connect the agent to your proxy:

```toml
[model.firepass]
name = "Kimi 2.6 Turbo"
base_url = "http://localhost:3000"
model = "fireworks/kimi-k2p6-turbo"
env_key = "FIREPASS_API_KEY"

[models]
default = "firepass"
```

Then launch the agent with a specific model:

```bash
grok --model firepass
```

Point clients at the proxy **root** (`http://localhost:3000`). The proxy accepts requests whether the client uses `/chat/completions`, `/v1/chat/completions`, etc. — the incoming path is not used to build the upstream call. The exact target is taken verbatim from the `url` you put in `config.json` for that provider.

The `env_key` is an arbitrary name for the key Grok will read from your environment (e.g., `FIREPASS_API_KEY`). The proxy will replace it with the actual provider key configured in `config.json`, so the client never needs to know the real API key.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Proxy listen port |
| `CONFIG_PATH` | `./config.json` | Provider configuration file |
| `LOG_LEVEL` | `info` | `silent`, `error`, `info`, `debug` |
| `LOG_BODIES` | `false` | Log full request/response bodies (privacy risk) |

## Docker

```bash
docker compose up -d --build
```

## License

MIT
