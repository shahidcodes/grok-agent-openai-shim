import http from "http";
import https from "https";
import { createWriteStream, mkdirSync } from "node:fs";

const TARGET_HOST = process.env.TARGET_HOST || "api.fireworks.ai";
const TARGET_PATH = process.env.TARGET_PATH || "/inference";
const TARGET_URL = `https://${TARGET_HOST}${TARGET_PATH}`;
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

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  let proxyReq: https.ClientRequest | null = null;

  // Abort upstream if the client disconnects at any point
  res.on("close", () => {
    proxyReq?.destroy();
  });

  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {

    let body = Buffer.concat(chunks);
    let originalBody: string | null = null;
    let transformedBody: string | null = null;

    const contentType = req.headers["content-type"] || "";
    if (contentType.includes("application/json")) {
      try {
        const text = body.toString();
        originalBody = text;
        const json = JSON.parse(text);
        const cleaned = cleanPayload(json);
        transformedBody = JSON.stringify(cleaned);
        body = Buffer.from(transformedBody);
      } catch {
        // Invalid JSON — forward as-is
      }
    }

    log("info", `\n--- Request ${req.method} ${req.url} ---`);
    if (LOG_BODIES && originalBody) log("debug", `Original body: ${originalBody}`);
    if (LOG_BODIES && transformedBody) log("debug", `Transformed body: ${transformedBody}`);

    // Build outgoing headers
    const headers: http.OutgoingHttpHeaders = {};
    for (const [key, val] of Object.entries(req.headers)) {
      if (val !== undefined) headers[key] = val;
    }
    headers["host"] = TARGET_HOST;
    headers["content-length"] = body.length;
    delete headers["connection"];
    delete headers["keep-alive"];
    delete headers["transfer-encoding"];
    delete headers["upgrade"];
    delete headers["proxy-authenticate"];
    delete headers["proxy-authorization"];
    delete headers["te"];
    delete headers["trailers"];

    const options: https.RequestOptions = {
      hostname: TARGET_HOST,
      port: 443,
      path: `${TARGET_PATH}${req.url}`,
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

      // Handle upstream error after headers are already sent
      proxyRes.on("error", (err) => {
        log("error", `Upstream response error: ${err.message}`);
        if (!res.destroyed && !res.writableEnded) {
          res.destroy();
        }
      });
    });

    proxyReq.setTimeout(300_000); // 5 min timeout for long generations

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

  // Safety: if the request body never arrives, timeout and close
  req.setTimeout(60_000, () => {
    log("error", "Request body timeout");
    req.destroy();
    sendError(res, 408, "Request Timeout");
  });
});

// No global socket timeout — per-request timeouts handle all phases
server.timeout = 0;
server.keepAliveTimeout = 30_000;

server.listen(PORT, () => {
  log("info", `Proxy listening on http://localhost:${PORT} -> ${TARGET_URL}`);
});
