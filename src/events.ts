import { EventEmitter } from "node:events";

export type LogLevel = "info" | "warn" | "error" | "ok";

export const bus = new EventEmitter();
bus.setMaxListeners(100);

export function log(accountId: string | null, level: LogLevel, message: string): void {
  const ts = new Date().toISOString();
  const tag = accountId ? `[${accountId.slice(0, 8)}]` : "[system]";
  const prefix = { info: "  ", warn: "⚠ ", error: "✖ ", ok: "✔ " }[level] ?? "  ";

  console.log(`${prefix}${tag} ${message}`);
  bus.emit("log", { accountId, level, message, ts });
}
