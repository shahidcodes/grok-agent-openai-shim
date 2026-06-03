import http from "http";
import https from "https";
import { createWriteStream, mkdirSync, readFileSync, watch } from "node:fs";
import { resolve } from "node:path";

// ─── Config ───────────────────────────────────────────────────────────────────

interface ProviderConfig {
  host: string;
  basePath: string;
  apiKey: string;
  models: Record<string, string>;
}

interface Config {
  providers: Record<string, ProviderConfig>;
  defaultProvider?: string;
}

const CONFIG_PATH = process.env.CONFIG_PATH || resolve("config.json");

function loadConfig(): Config {
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as Config;
}

let config = loadConfig();

// Hot-reload config.json on change
watch(CONFIG_PATH, (event) => {
  if (event === "change") {
    try {
      config = loadConfig();
      log("info", "Config reloaded");
    } catch (err) {
      log("error", `Config reload failed: ${(err as Error).message}`);
    }
  }
});

// ─── Logging ──────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT || 3000);
const LOG_DIR = process.env.LOG_DIR || "logs";
const LOG_FILE = `${LOG_DIR}/proxy.log`;
const LOG_LEVEL = process.env.LOG_LEVEL || "info"; // silent | error | info | debug
const LOG_BODIES = process.env.LOG_BODIES === "true";

mkdirSync(LOG_DIR, { recursive: true });

const logStream = createWriteStream(LOG_FILE, { flags: "a" });
logStream.on("error", (err) => {
  console.error("Log stream error:", err.message);
});

const LOG_LEVELS = { silent: 0, error: 1, info: 2, debug: 3 };
const CURRENT_LOG_LEVEL = LOG_LEVELS[LOG_LEVEL as keyof typeof LOG_LEVELS] ?? 2;

function log(level: "error" | "info" | "debug", msg: string) {
  if (LOG_LEVELS[level] > CURRENT_LOG_LEVEL) return;
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    logStream.write(line);
  } catch {
    // ignore disk-full and other stream errors
  }
  console.log(line.trimEnd());
}

// ─── Payload helpers ──────────────────────────────────────────────────────────

/**
 * Recursively remove `null` from any `enum` array in a JSON payload.
 * Also remove `model_id` from message objects (Fireworks rejects it).
 */
function cleanPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cleanPayload);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (key === "model_id") continue;
      if (key === "enum" && Array.isArray(val)) {
        result[key] = val.filter((v) => v !== null);
      } else {
        result[key] = cleanPayload(val);
      }
    }
    return result;
  }
  return value;
}

interface ResolveResult {
  provider: ProviderConfig;
  resolvedModel: string;
  providerName: string;
  modelAlias: string;
}

/**
 * Resolve a model name like "fireworks/llama3-8b" to a provider + full model ID.
 * If no provider prefix is given, falls back to the default provider.
 */
function resolveProvider(modelName: string): ResolveResult | null {
  const slashIdx = modelName.indexOf("/");
  let providerName: string;
  let modelAlias: string;

  if (slashIdx === -1) {
    providerName = config.defaultProvider || "";
    modelAlias = modelName;
  } else {
    providerName = modelName.slice(0, slashIdx);
    modelAlias = modelName.slice(slashIdx + 1);
  }

  const provider = config.providers[providerName];
  if (!provider) {
    log("error", `Unknown provider: ${providerName}`);
    return null;
  }

  const resolvedModel = provider.models[modelAlias] || modelAlias;
  return { provider, providerName, modelAlias, resolvedModel };
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function setCorsHeaders(res: http.ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE, PUT");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Accept, X-Requested-With"
  );
  res.setHeader("Vary", "Origin");
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "access-control-allow-origin",
]);

function parseConnectionTokens(
  connection: string | string[] | undefined
): Set<string> {
  const tokens = new Set<string>();
  if (!connection) return tokens;
  const raw = Array.isArray(connection) ? connection.join(",") : connection;
  for (const token of raw.split(",")) {
    const trimmed = token.trim().toLowerCase();
    if (trimmed) tokens.add(trimmed);
  }
  return tokens;
}

function sendError(res: http.ServerResponse, status: number, message: string) {
  if (res.headersSent || res.destroyed) return;
  setCorsHeaders(res);
  const body = JSON.stringify({ error: message });
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  let proxyReq: https.ClientRequest | null = null;

  res.on("close", () => {
    proxyReq?.destroy();
  });

  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let body = Buffer.concat(chunks);
    let originalBody: string | null = null;
    let transformedBody: string | null = null;
    let resolved: ResolveResult | null = null;

    const contentType = req.headers["content-type"] || "";
    if (contentType.includes("application/json")) {
      try {
        const text = body.toString();
        originalBody = text;
        const json = JSON.parse(text);
        const modelName = json.model;

        if (typeof modelName === "string") {
          resolved = resolveProvider(modelName);
          if (resolved) {
            json.model = resolved.resolvedModel;
          }
        }

        const cleaned = cleanPayload(json);
        transformedBody = JSON.stringify(cleaned);
        body = Buffer.from(transformedBody);
      } catch {
        // Invalid JSON — forward as-is
      }
    }

    const providerName = resolved?.providerName || config.defaultProvider || "unknown";
    const provider = resolved?.provider;

    log("info", `\n--- Request ${req.method} ${req.url} [${providerName}] ---`);
    if (LOG_BODIES && originalBody) log("debug", `Original body: ${originalBody}`);
    if (LOG_BODIES && transformedBody) log("debug", `Transformed body: ${transformedBody}`);

    if (!provider) {
      sendError(res, 400, "Unknown provider or missing model");
      return;
    }

    // Build outgoing headers
    const headers: http.OutgoingHttpHeaders = {};
    for (const [key, val] of Object.entries(req.headers)) {
      if (val !== undefined) headers[key] = val;
    }

    headers["host"] = provider.host;
    headers["content-length"] = body.length;

    // Use provider API key if configured, else fall back to client auth
    if (provider.apiKey) {
      headers["authorization"] = `Bearer ${provider.apiKey}`;
    }

    delete headers["connection"];
    delete headers["keep-alive"];
    delete headers["transfer-encoding"];
    delete headers["upgrade"];
    delete headers["proxy-authenticate"];
    delete headers["proxy-authorization"];
    delete headers["te"];
    delete headers["trailers"];

    const options: https.RequestOptions = {
      hostname: provider.host,
      port: 443,
      path: `${provider.basePath}${req.url}`,
      method: req.method,
      headers,
    };

    proxyReq = https.request(options, (proxyRes) => {
      setCorsHeaders(res);

      const connectionTokens = parseConnectionTokens(
        proxyRes.headers["connection"]
      );
      const skipHeaders = new Set([...HOP_BY_HOP_HEADERS, ...connectionTokens]);

      for (const [key, val] of Object.entries(proxyRes.headers)) {
        if (val === undefined) continue;
        const lowerKey = key.toLowerCase();
        if (skipHeaders.has(lowerKey)) continue;
        res.setHeader(key, val);
      }

      res.writeHead(proxyRes.statusCode || 502);

      const isSse =
        proxyRes.headers["content-type"]?.includes("text/event-stream");

      if (isSse) {
        log("info", `Response ${proxyRes.statusCode} (SSE stream)`);
        proxyRes.pipe(res);
        proxyRes.on("end", () => {
          log("info", "--- End SSE ---\n");
        });
      } else {
        const preview: Buffer[] = [];
        let previewLen = 0;
        const MAX_PREVIEW = 5000;

        proxyRes.on("data", (chunk: Buffer) => {
          if (previewLen < MAX_PREVIEW) {
            preview.push(chunk);
            previewLen += chunk.length;
          }
        });
        proxyRes.on("end", () => {
          const bodyStr = Buffer.concat(preview)
            .toString()
            .substring(0, MAX_PREVIEW);
          log("debug", `Response ${proxyRes.statusCode}: ${bodyStr}`);
          log("info", "--- End ---\n");
        });

        proxyRes.pipe(res);
      }

      proxyRes.on("error", (err) => {
        log("error", `Upstream response error: ${err.message}`);
        if (!res.destroyed && !res.writableEnded) {
          res.destroy();
        }
      });
    });

    proxyReq.setTimeout(300_000);

    proxyReq.on("error", (err) => {
      log("error", `Proxy error: ${err.message}`);
      sendError(res, 502, "Bad Gateway");
    });

    proxyReq.on("timeout", () => {
      log("error", "Proxy request timeout");
      proxyReq?.destroy();
      sendError(res, 504, "Gateway Timeout");
    });

    proxyReq.end(body);
  });

  req.on("error", (err) => {
    log("error", `Request error: ${err.message}`);
    sendError(res, 400, "Bad Request");
  });

  req.setTimeout(60_000, () => {
    log("error", "Request body timeout");
    req.destroy();
    sendError(res, 408, "Request Timeout");
  });
});

server.timeout = 0;
server.keepAliveTimeout = 30_000;

server.listen(PORT, () => {
  log("info", `Proxy listening on http://localhost:${PORT}`);
  log("info", `Loaded providers: ${Object.keys(config.providers).join(", ")}`);
});
