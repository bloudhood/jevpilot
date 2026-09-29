import { timingSafeEqual, createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpUserError } from "./errors.ts";

export type HttpConfig = {
  host: string;
  port: number;
  token: string;
  allowedHosts: string[];
  allowedOrigins: string[];
};

export function parseHttpConfig(env: NodeJS.ProcessEnv): {
  transport: "stdio" | "http";
  http?: HttpConfig;
} {
  const transport = env.JEVPILOT_TRANSPORT ?? "stdio";
  if (transport !== "stdio" && transport !== "http")
    throw new McpUserError("JEVPILOT_TRANSPORT must be stdio or http.");
  if (transport === "stdio") return { transport };
  const host = env.JEVPILOT_HTTP_HOST ?? "127.0.0.1";
  const rawPort = env.JEVPILOT_HTTP_PORT ?? "8940";
  if (!/^\d+$/u.test(rawPort) || Number(rawPort) > 65535)
    throw new McpUserError("JEVPILOT_HTTP_PORT must be an integer between 0 and 65535.");
  const token = env.JEVPILOT_HTTP_TOKEN;
  if (!token || token.length < 16)
    throw new McpUserError("JEVPILOT_HTTP_TOKEN is required and must be at least 16 characters.");
  const list = (value?: string) =>
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  return {
    transport,
    http: {
      host,
      port: Number(rawPort),
      token,
      allowedHosts: list(env.JEVPILOT_HTTP_ALLOWED_HOSTS),
      allowedOrigins: list(env.JEVPILOT_HTTP_ALLOWED_ORIGINS),
    },
  };
}

const digest = (value: string) => createHash("sha256").update(value).digest();
const equalToken = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));
const loopback = (host: string) => host === "localhost" || host === "::1" || /^127\./u.test(host);

export function startHttpServer(
  config: HttpConfig,
  createMcpServer: () => McpServer,
  options: { sessionIdleMs?: number } = {},
): Promise<{ server: Server; close: () => Promise<void>; port: number }> {
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: McpServer; touched: number }
  >();
  const sessionIdleMs = options.sessionIdleMs ?? 30 * 60 * 1000;
  const idleTimer = setInterval(
    () => {
      const cutoff = Date.now() - sessionIdleMs;
      for (const [id, entry] of sessions)
        if (entry.touched < cutoff) {
          void entry.transport.close();
          sessions.delete(id);
        }
    },
    Math.min(60_000, sessionIdleMs),
  );
  idleTimer.unref();
  // The real port is known only after listen (port 0 picks one).
  let port = config.port;
  let httpServer: Server;
  const reject = (
    res: ServerResponse,
    status: number,
    message: string,
    headers?: Record<string, string>,
  ) => {
    res.writeHead(status, { "content-type": "text/plain", ...headers });
    res.end(message);
  };
  const auth = (req: IncomingMessage, res: ServerResponse) => {
    const header = req.headers.authorization;
    if (!header || !/^bearer /iu.test(header) || !equalToken(header.slice(7), config.token)) {
      reject(res, 401, "Unauthorized", { "www-authenticate": "Bearer" });
      return false;
    }
    const origin = req.headers.origin;
    if (origin && !config.allowedOrigins.includes(origin)) {
      reject(res, 403, "Forbidden");
      return false;
    }
    const host = (req.headers.host ?? "").toLowerCase();
    // DNS rebinding: on a loopback bind only loopback names with our port (or listed hosts) are accepted.
    const loopbackHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    if (
      (loopback(config.host) &&
        !loopbackHosts.includes(host) &&
        !config.allowedHosts.includes(host)) ||
      (!loopback(config.host) && config.allowedHosts.length && !config.allowedHosts.includes(host))
    ) {
      reject(res, 403, "Forbidden");
      return false;
    }
    return true;
  };
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== "/mcp") {
      reject(res, 404, "Not found");
      return;
    }
    if (!auth(req, res)) return;
    const id = req.headers["mcp-session-id"] as string | undefined;
    if (req.method === "DELETE") {
      const entry = id && sessions.get(id);
      if (!entry) {
        reject(res, 404, "Unknown session");
        return;
      }
      await entry.transport.close();
      sessions.delete(id!);
      res.writeHead(200);
      res.end();
      return;
    }
    let entry = id ? sessions.get(id) : undefined;
    if (id && !entry) {
      reject(res, 404, "Unknown session");
      return;
    }
    if (!entry) {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
      const server = createMcpServer();
      entry = { transport, server, touched: Date.now() };
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport as never);
    }
    entry.touched = Date.now();
    let body: unknown;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > 4 * 1024 * 1024) {
          reject(res, 413, "Payload too large");
          req.destroy();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      if (chunks.length) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          reject(res, 400, "Invalid JSON");
          return;
        }
      }
    }
    await entry.transport.handleRequest(req, res, body);
    if (entry.transport.sessionId) sessions.set(entry.transport.sessionId, entry);
  };
  httpServer = createServer((req, res) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) reject(res, 500, "Internal server error");
    });
  });
  const close = async () => {
    clearInterval(idleTimer);
    for (const entry of sessions.values()) await entry.transport.close().catch(() => {});
    sessions.clear();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };
  return new Promise((resolve, rejectPromise) => {
    httpServer.once("error", rejectPromise);
    httpServer.listen(config.port, config.host, () => {
      const address = httpServer.address();
      port = typeof address === "object" && address ? address.port : config.port;
      process.stderr.write(`jevpilot-mcp listening on http://${config.host}:${port}/mcp\n`);
      resolve({ server: httpServer, close, port });
    });
  });
}
