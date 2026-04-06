import { existsSync, readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DASH } from "./config.js";
import { bus, log } from "./events.js";
import type { BotManager } from "./manager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, "../public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

const sseClients = new Set<ServerResponse>();

/**
 * Broadcasts dashboard-safe runtime updates to every connected SSE client.
 * Logs are intentionally excluded so the browser only receives state changes.
 */
export function broadcast(event: string, data: unknown): void {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const response of sseClients) {
    try {
      response.write(chunk);
    } catch {
      sseClients.delete(response);
    }
  }
}

export function startServer(manager: BotManager) {
  const events = ["status", "profile", "invite", "joined", "left", "friend", "removed"];
  for (const eventName of events) {
    bus.on(eventName, (data) => broadcast(eventName, data));
  }

  const server = createServer((req, res) => {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? `${DASH.host}:${DASH.port}`}`,
    );
    const pathname = url.pathname;

    if (pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.flushHeaders?.();

      const snapshot = manager.getSnapshot();
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);

      const keepalive = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
          clearInterval(keepalive);
        }
      }, 15000);

      sseClients.add(res);
      req.on("close", () => {
        clearInterval(keepalive);
        sseClients.delete(res);
      });
      return;
    }

    if (pathname === "/api/bots" && req.method === "GET") {
      const data = JSON.stringify(manager.getSnapshot());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(data);
      return;
    }

    const filePath =
      pathname === "/" || pathname === "/index.html"
        ? resolve(publicDir, "index.html")
        : resolve(publicDir, pathname.slice(1));

    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = extname(filePath);
    const mime = MIME[ext] ?? "application/octet-stream";

    try {
      const content = readFileSync(filePath);
      res.writeHead(200, { "Content-Type": mime });
      res.end(content);
    } catch {
      res.writeHead(500);
      res.end("Internal error");
    }
  });

  server.listen(DASH.port, DASH.host, () => {
    log(
      null,
      "ok",
      `Dashboard at http://${DASH.host === "0.0.0.0" ? "localhost" : DASH.host}:${DASH.port}`,
    );
  });

  return server;
}
