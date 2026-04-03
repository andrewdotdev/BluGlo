import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ConfigShape } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(__dirname, "../config.json");

let raw: string;
try {
  raw = readFileSync(configPath, "utf8");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[config] config.json was not found:", message);
  process.exit(1);
}

export const config = JSON.parse(raw) as ConfigShape;

const bot = config.bot ?? {};
const status = bot.status ?? {};
const party = bot.party ?? {};
const features = bot.features ?? {};
const auth = bot.auth ?? {};
const timings = bot.timings ?? {};
const reconnect = bot.reconnect ?? {};

export const BOT = {
  idleStatus: status.idle ?? "Available 🚕",
  busyStatus: status.busy ?? "Busy 🔒",
  partyMaxSize: party.maxSize ?? 4,
  fortStatsHigh: features.fortStatsHigh ?? true,
  denyFriendRequests: features.denyFriendRequests ?? false,
  authClient: auth.fnbrClient ?? "fortniteAndroidGameClient",
  auth: {
    authorizationCodeClient: auth.authorizationCodeClient ?? {},
    deviceAuthClient: auth.deviceAuthClient ?? {},
  },
} as const;

export const DASH = {
  port: config.dashboard?.port ?? 3000,
  host: config.dashboard?.host ?? "0.0.0.0",
  title: config.dashboard?.title ?? "BluGo Dashboard",
} as const;

export const TIMINGS = {
  initTimeoutMs: timings.initTimeoutMs ?? 10000,
  postAcceptDelayMs: timings.postAcceptDelayMs ?? 1000,
  partyAutoLeaveMs: timings.partyAutoLeaveMs ?? 90000,
  reloadDelayMs: timings.reloadDelayMs ?? 150,
  matchstateLeaveDelayMs: timings.matchstateLeaveDelayMs ?? 500,
  reconnectDelayMs: timings.reconnectDelayMs ?? 200,
  requestTimeoutMs: timings.requestTimeoutMs ?? 15000,
} as const;

export const RECONNECT = {
  maxRetries: reconnect.maxRetries ?? 3,
  restRetryLimit: reconnect.restRetryLimit ?? 3,
  xmppMaxConnectionRetries: reconnect.xmppMaxConnectionRetries ?? 3,
} as const;

export const DATA_FILE = config.dataFile ?? "./data/accounts.json";
