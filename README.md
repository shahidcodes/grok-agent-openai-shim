# grok-openai-proxy

An OpenAI-compatible HTTP proxy for the Fireworks AI inference API.

## Features

- **OpenAI API compatibility** — forwards requests to Fireworks with payload sanitization
- **SSE streaming** — tokens stream to the client in real time, no buffering
- **CORS enabled** — works in browser-based clients
- **Body sanitization** — removes `model_id` and `null` values from `enum` arrays
- **Configurable logging** — body logging is opt-in (`LOG_BODIES`)
- **Request size limits** — configurable max body size
- **Client disconnect handling** — aborts upstream requests when the client leaves

## Requirements

- [Bun](https://bun.sh) 1.2+

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TARGET_HOST` | `api.fireworks.ai` | Upstream API host |
| `TARGET_PATH` | `/inference` | Upstream API base path |
| `PORT` | `3000` | Proxy listen port |
| `LOG_LEVEL` | `info` | `silent`, `error`, `info`, `debug` |
| `LOG_BODIES` | `false` | Log full request/response bodies (privacy risk) |


## Quick Start

```bash
bun run proxy.ts
```

## Docker

```bash
docker compose up -d --build
```

## Deployment

Edit `deploy.sh` to set your host, then run:

```bash
./deploy.sh user@your-server
```

## License

MIT
