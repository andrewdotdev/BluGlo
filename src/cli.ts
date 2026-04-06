import * as readline from "node:readline";

import { Presence } from "./bot.js";
import { BOT } from "./config.js";
import { bus } from "./events.js";
import type { BotManager } from "./manager.js";

type NoticeLevel = "info" | "warn" | "error" | "ok";
type BottomMode = "result" | "help";

interface Notice {
  ts: number;
  level: NoticeLevel;
  text: string;
}

const REFRESH_MS = 5000;

/**
 * Minimal command palette shown only when the user explicitly asks for help.
 *
 * @see https://nodejs.org/api/readline.html
 */
const HELP_LINES = [
  "/add [code]",
  "/add:device_auth <accountId> <deviceId> <secret>",
  "/remove <id>",
  "/reload <id|all>",
  "/list",
  "/stats",
  "/help",
  "/exit",
];

interface CLIState {
  dirty: boolean;
  disposed: boolean;
  notices: Notice[];
  bottomMode: BottomMode;
  banner: string | null;
  extraLines: string[];
}

/**
 * Starts a compact TUI for bot monitoring and commands.
 *
 * Design goals:
 * - Minimal by default
 * - Stable screen with throttled redraws
 * - Single command input
 * - Only last command result shown at the bottom
 * - Help hidden unless requested
 *
 * @see https://nodejs.org/api/tty.html
 * @see https://nodejs.org/api/readline.html
 */
export function startCLI(manager: BotManager): void {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "› ",
    terminal: true,
  });

  const state: CLIState = {
    dirty: true,
    disposed: false,
    notices: [
      {
        ts: Date.now(),
        level: "ok",
        text: "Ready",
      },
    ],
    bottomMode: "result",
    banner: "BluGlo",
    extraLines: []
  };

  const originalLog = console.log.bind(console);

  /**
   * Redirects noisy console output into the bottom status area instead of
   * breaking the TUI layout.
   */
  console.log = (...args: unknown[]) => {
    const text = args
      .map((value) => {
        if (typeof value === "string") return value;
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      })
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (!text) return;

    setNotice(state, inferLevel(text), compactLog(text));
  };

  const dirtyEvents = [
    "status",
    "profile",
    "invite",
    "joined",
    "left",
    "friend",
    "removed",
    "account:created",
    "log",
  ];

  for (const eventName of dirtyEvents) {
    bus.on(eventName, () => {
      state.dirty = true;
    });
  }

  const timer = setInterval(() => {
    if (!state.dirty || state.disposed) return;
    render(manager, rl, state);
  }, REFRESH_MS);

  render(manager, rl, state);

  rl.on("line", (line) => {
    void (async () => {
      const trimmed = line.trim();

      if (!trimmed) {
        state.bottomMode = "result";
        state.dirty = true;
        render(manager, rl, state);
        return;
      }

      const [rawCmd, ...args] = trimmed.split(/\s+/);
      const cmd = rawCmd?.toLowerCase();

      if (!cmd) {
        state.bottomMode = "result";
        state.dirty = true;
        render(manager, rl, state);
        return;
      }

      /**
       * Every new command clears the previous visual response.
       */
      state.notices = [];
      state.extraLines = [];
      state.bottomMode = "result";
      state.dirty = true;
      render(manager, rl, state);

      try {
        switch (cmd) {
          case "/add": {
            let authInput = args.join(" ").trim();

            if (!authInput) {
              const authUrl = getAuthorizationCodeUrl();

              setNotice(state, "info", "Open Epic login URL");
              state.extraLines = [
                "Copy the code from the Epic redirect page.",
                authUrl,
              ];
              state.dirty = true;
              render(manager, rl, state);

              authInput = (await question(rl, "code › ")).trim();
              state.extraLines = [];
            }

            if (!authInput) {
              setNotice(state, "warn", "Cancelled");
              break;
            }

            const authorizationCode = extractAuthorizationCode(authInput);

            if (!authorizationCode) {
              setNotice(state, "error", "Invalid auth code");
              break;
            }

            setNotice(state, "info", "Adding bot...");
            render(manager, rl, state);

            await manager.add_authcode(authorizationCode);
            setNotice(state, "ok", "Bot added");
            break;
          }

          case "/add:device_auth": {
            const [accountId, deviceId, secret] = args;

            if (!accountId || !deviceId || !secret) {
              setNotice(state, "warn", "Usage: /add:device_auth <accountId> <deviceId> <secret>");
              break;
            }

            manager.add(accountId, deviceId, secret);
            setNotice(state, "ok", `Added ${shortId(accountId)}`);
            break;
          }

          case "/remove": {
            const target = args[0];

            if (!target) {
              setNotice(state, "warn", "Usage: /remove <id>");
              break;
            }

            const resolved = resolveBotId(manager, target);
            const ok = manager.remove(resolved);
            setNotice(state, ok ? "ok" : "warn", ok ? `Removed ${shortId(resolved)}` : "Bot not found");
            break;
          }

          case "/reload": {
            const target = args[0];

            if (!target || target === "all") {
              manager.reloadAll();
              setNotice(state, "ok", "Reloading all");
              break;
            }

            const resolved = resolveBotId(manager, target);
            const ok = manager.reload(resolved);
            setNotice(state, ok ? "ok" : "warn", ok ? `Reloading ${shortId(resolved)}` : "Bot not found");
            break;
          }

          case "/list": {
            setNotice(state, "info", `${manager.bots.size} bot(s) loaded`);
            break;
          }

          case "/stats": {
            const totals = [...manager.bots.values()].reduce(
              (acc, bot) => {
                acc.taxis += bot.stats.taxisCompleted;
                acc.declined += bot.stats.invitesDeclined;
                acc.retries += bot.retryCount;
                return acc;
              },
              { taxis: 0, declined: 0, retries: 0 },
            );

            setNotice(
              state,
              "info",
              `taxis:${totals.taxis} declined:${totals.declined} retries:${totals.retries}`,
            );
            break;
          }

          case "/help": {
            state.bottomMode = "help";
            state.dirty = true;
            break;
          }

          case "/exit": {
            setNotice(state, "warn", "Stopping...");
            render(manager, rl, state);

            clearInterval(timer);
            state.disposed = true;

            for (const bot of manager.bots.values()) {
              bot.stop();
            }

            setTimeout(() => process.exit(0), 400);
            return;
          }

          default:
            setNotice(state, "warn", `Unknown command: ${cmd}`);
            break;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setNotice(state, "error", compactLog(message));
      }

      render(manager, rl, state);
    })();
  });

  rl.on("SIGINT", () => {
    rl.close();
  });

  rl.on("close", () => {
    clearInterval(timer);
    state.disposed = true;
    console.log = originalLog;
    process.stdout.write("\x1b[2J\x1b[H");
    originalLog("CLI closed.");
  });

  process.stdout.on("resize", () => {
    state.dirty = true;
    render(manager, rl, state);
  });
}

function setNotice(state: CLIState, level: NoticeLevel, text: string): void {
  const notice: Notice = {
    ts: Date.now(),
    level,
    text,
  };

  state.notices.push(notice);

  if (state.notices.length > 5) {
    state.notices.shift();
  }

  state.bottomMode = "result";
  state.dirty = true;
}

/**
 * Full TUI render.
 *
 * Layout:
 * - title bar
 * - bots table
 * - bottom panel (last result or help)
 * - input prompt
 */
function render(manager: BotManager, rl: readline.Interface, state: CLIState): void {
  state.dirty = false;

  const width = Math.max(process.stdout.columns || 100, 96);
  const now = new Date();

  const bots = [...manager.bots.values()];
  const rows = bots.map((bot) => {
    const name = bot.displayName || shortId(bot.accountId);
    const uptime = getLiveUptime(bot.stats.totalUptime, bot.stats.connectedAt);

    return {
      id: shortId(bot.accountId),
      name,
      state: simplifyPresence(bot.presence),
      status: compactStatus(bot.status),
      high: bot.actions.high ? "yes" : "no",
      taxis: String(bot.stats.taxisCompleted),
      declined: String(bot.stats.invitesDeclined),
      retries: String(bot.retryCount),
      uptime: formatDuration(uptime),
    };
  });

  const out: string[] = [];

  out.push(clearScreen());
  out.push(drawTopBar(width, now, bots.length));
  out.push("");
  out.push(drawTableBox(width, rows));
  out.push("");
  out.push(drawBottomBox(width, state));
  out.push("");

  process.stdout.write(out.join("\n"));

  rl.setPrompt(styledPrompt());
  rl.prompt(true);
}

/**
 * Pretty top bar.
 */
function drawTopBar(width: number, now: Date, botCount: number): string {
  const left = bold("BluGlo");
  const right = dim(`${now.toLocaleTimeString()} · bots ${botCount} · ${REFRESH_MS / 1000}s`);
  const spacing = Math.max(1, width - visibleLength(stripAnsi(left)) - visibleLength(stripAnsi(right)));
  return `${left}${" ".repeat(spacing)}${right}`;
}

/**
 * Main data table box.
 */
function drawTableBox(
  width: number,
  rows: Array<{
    id: string;
    name: string;
    state: string;
    status: string;
    high: string;
    taxis: string;
    declined: string;
    retries: string;
    uptime: string;
  }>,
): string {
  if (width < 96) {
    const compactLines = [
      boxTop(" Bots ", width),
    ];

    if (rows.length === 0) {
      compactLines.push(boxLine(dim("No bots loaded"), width));
      compactLines.push(boxBottom(width));
      return compactLines.join("\n");
    }

    rows.forEach((row, index) => {
      if (index > 0) compactLines.push(boxSep(width));
      compactLines.push(
        boxLine(
          `${pad(row.id, 8)}  ${pad(row.name, 18)}  ${colorState(row.state)}`,
          width,
        ),
      );
      compactLines.push(
        boxLine(
          dim(`status: ${row.status} | high: ${row.high} | taxis: ${row.taxis} | retry: ${row.retries} | up: ${row.uptime}`),
          width,
        ),
      );
    });

    compactLines.push(boxBottom(width));
    return compactLines.join("\n");
  }

  const innerWidth = width - 4;

  const idW = 10;
  const stateW = 9;
  const highW = 6;
  const taxisW = 7;
  const decW = 10;
  const retriesW = 8;
  const uptimeW = 9;

  const fixed = idW + stateW + highW + taxisW + decW + retriesW + uptimeW + 7 * 3;
  const remaining = Math.max(innerWidth - fixed, 26);
  const nameW = Math.min(Math.max(Math.floor(remaining * 0.34), 14), 22);
  const statusW = Math.max(remaining - nameW, 16);

  const header = [
    pad("ID", idW),
    pad("Name", nameW),
    pad("State", stateW),
    pad("Status", statusW),
    pad("High", highW),
    pad("Taxis", taxisW),
    pad("Declined", decW),
    pad("Retry", retriesW),
    pad("Uptime", uptimeW),
  ].join(" │ ");

  const body =
    rows.length === 0
      ? [dim("No bots loaded")]
      : rows.map((row) =>
        [
          pad(row.id, idW),
          pad(row.name, nameW),
          pad(colorState(row.state), stateW),
          pad(row.status, statusW),
          pad(row.high, highW),
          pad(row.taxis, taxisW),
          pad(row.declined, decW),
          pad(row.retries, retriesW),
          pad(row.uptime, uptimeW),
        ].join(" │ "),
      );

  const lines = [
    boxTop(" Bots ", width),
    boxLine(bold(header), width),
    boxSep(width),
    ...body.map((line) => boxLine(line, width)),
    boxBottom(width),
  ];

  return lines.join("\n");
}

/**
 * Bottom panel shows either:
 * - the latest command result
 * - the help palette
 */
function drawBottomBox(width: number, state: CLIState): string {
  if (state.bottomMode === "help") {
    const lines = [
      boxTop(" Help ", width),
      ...HELP_LINES.map((line) => boxLine(dim(line), width)),
      boxBottom(width),
    ];
    return lines.join("\n");
  }

  const notices = state.notices ?? [];

  if (notices.length === 0) {
    const lines = [
      boxTop(" Logs (0/5) ", width),
      boxLine(dim("No output"), width),
      boxBottom(width),
    ];
    return lines.join("\n");
  }

  const lines = [
    boxTop(` Logs (${notices.length}/5) `, width),
  ];

  notices.forEach((notice, index) => {
    const label = formatNoticeLabel(notice.level);
    const timestamp = dim(new Date(notice.ts).toLocaleTimeString());

    if (index > 0) {
      lines.push(boxSep(width));
    }

    lines.push(boxLine(`${label} ${timestamp}`, width));

    for (const line of wrapText(notice.text, width - 6)) {
      lines.push(boxLine(line, width));
    }

    if (index === notices.length - 1 && state.extraLines.length > 0) {
      lines.push(boxSep(width));
      for (const extra of state.extraLines) {
        for (const line of wrapText(extra, width - 6)) {
          lines.push(boxLine(dim(line), width));
        }
      }
    }
  });

  lines.push(boxBottom(width));
  return lines.join("\n");
}

function formatNoticeLabel(level: NoticeLevel): string {
  switch (level) {
    case "ok":
      return green("OK");
    case "warn":
      return yellow("WARN");
    case "error":
      return red("ERROR");
    default:
      return cyan("INFO");
  }
}

function simplifyPresence(presence: string): string {
  switch (presence) {
    case Presence.ACTIVE:
      return "active";
    case Presence.BUSY:
      return "busy";
    case Presence.LOADING:
      return "loading";
    case Presence.OFFLINE:
      return "offline";
    default:
      return presence;
  }
}

function colorState(value: string): string {
  switch (value) {
    case "active":
      return green(value);
    case "busy":
      return yellow(value);
    case "loading":
      return cyan(value);
    case "offline":
      return dim(value);
    default:
      return value;
  }
}

function compactStatus(status: string): string {
  return status
    .replace(/\s+/g, " ")
    .replace(/waiting for invite/i, "waiting")
    .replace(/in party/i, "party")
    .replace(/connecting/i, "connecting")
    .replace(/disconnected/i, "offline")
    .trim();
}

function getLiveUptime(totalUptime: number, connectedAt: number | null): number {
  if (!connectedAt) return totalUptime;
  return totalUptime + Math.max(0, Date.now() - connectedAt);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;

  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function shortId(accountId: string): string {
  return accountId.slice(0, 8);
}

function resolveBotId(manager: BotManager, input: string): string {
  if (input.length === 36) return input;
  for (const id of manager.bots.keys()) {
    if (id.startsWith(input)) return id;
  }
  return input;
}

function getAuthorizationCodeUrl(): string {
  const clientId =
    BOT.auth.authorizationCodeClient.clientId || "ec684b8c687f479fadea3cb2ad83f5c6";
  return `https://www.epicgames.com/id/api/redirect?clientId=${clientId}&responseType=code`;
}

function extractAuthorizationCode(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  if (/^[a-f0-9]{32}$/i.test(value)) return value;

  if (value.includes("?code=")) {
    try {
      const url = new URL(value);
      const code = url.searchParams.get("code");
      if (code?.trim()) return code.trim();
    } catch {
      return null;
    }
  }

  if (value.startsWith("{") && value.endsWith("}")) {
    try {
      const data = JSON.parse(value) as {
        authorizationCode?: string;
        code?: string;
      };
      const code = data.authorizationCode || data.code;
      if (typeof code === "string" && code.trim()) return code.trim();
    } catch {
      return null;
    }
  }

  return null;
}

function question(rl: readline.Interface, text: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(text, resolve);
  });
}

/**
 * Compresses verbose runtime logs into short readable one-liners.
 */
function compactLog(text: string): string {
  let value = text
    .replace(/\[system\]\s*/gi, "")
    .replace(/^\s*[✔⚠✖]\s*/u, "")
    .replace(/\s+/g, " ")
    .trim();

  value = value
    .replace(/Dashboard at .*/i, "Dashboard ready")
    .replace(/Loading (\d+) account\(s\)\.\.\./i, "Loading $1 account(s)")
    .replace(/No saved accounts found\. Use \/add to add one\./i, "No saved accounts")
    .replace(/Exchanging authorization code with .*?/i, "Exchanging auth code")
    .replace(/Requesting exchange code\.\.\./i, "Requesting exchange code")
    .replace(/Exchanging exchange code with .*?/i, "Creating device auth")
    .replace(/Creating device auth for (.+?)\.\.\./i, "Creating device auth: $1")
    .replace(/Device auth created for (.+)/i, "Device auth ready: $1")
    .replace(/Account ([a-f0-9]{8}).* added/i, "Added $1")
    .replace(/Reloading ([a-f0-9]{8}).*/i, "Reloading $1")
    .replace(/Disconnected — retry (\d+)\/(\d+)/i, "Retry $1/$2")
    .replace(/Maximum retries reached \((\d+)\)/i, "Max retries ($1)")
    .replace(/Bot stopped/i, "Stopped")
    .replace(/Connecting\.\.\./i, "Connecting")
    .replace(/Permanent error — use \/reload <id>/i, "Permanent error")
    .replace(/Account not found: ([a-f0-9]{8}).*/i, "Bot not found: $1");

  return value;
}

function inferLevel(text: string): NoticeLevel {
  if (/^\s*✖|error|failed|exception|rejection/i.test(text)) return "error";
  if (/^\s*⚠|warn|invalid|cancel/i.test(text)) return "warn";
  if (/^\s*✔|ready|added|loaded|connected|joined|created/i.test(text)) return "ok";
  return "info";
}

function styledPrompt(): string {
  return `${bold(cyan("›"))} `;
}

function clearScreen(): string {
  return "\x1b[2J\x1b[H";
}

function boxTop(title: string, width: number): string {
  const inner = width - 2;
  const text = `┌${title}`;
  const fill = Math.max(0, inner - visibleLength(stripAnsi(title)) - 1);
  return `${text}${"─".repeat(fill)}┐`;
}

function boxSep(width: number): string {
  return `├${"─".repeat(width - 2)}┤`;
}

function boxBottom(width: number): string {
  return `└${"─".repeat(width - 2)}┘`;
}

function boxLine(content: string, width: number): string {
  const inner = width - 4;
  const fitted = fitAnsi(content, inner);
  const cleanLen = visibleLength(stripAnsi(fitted));
  const padding = Math.max(0, inner - cleanLen);
  return `│ ${fitted}${" ".repeat(padding)} │`;
}

function pad(value: string, width: number): string {
  const fitted = fitAnsi(value, width);
  const padding = Math.max(0, width - visibleLength(stripAnsi(fitted)));
  return `${fitted}${" ".repeat(padding)}`;
}

function wrapText(value: string, width: number): string[] {
  const clean = stripAnsi(value);
  if (!clean) return [""];

  const result: string[] = [];

  for (const rawLine of clean.split("\n")) {
    if (rawLine.length <= width) {
      result.push(rawLine);
      continue;
    }

    const words = rawLine.split(" ");
    let current = "";

    for (const word of words) {
      if (word.length > width) {
        if (current) {
          result.push(current);
          current = "";
        }

        for (let i = 0; i < word.length; i += width) {
          result.push(word.slice(i, i + width));
        }
        continue;
      }

      const test = current ? `${current} ${word}` : word;
      if (test.length <= width) {
        current = test;
      } else {
        if (current) result.push(current);
        current = word;
      }
    }

    if (current) result.push(current);
  }

  return result.length ? result : [clean];
}

function fitAnsi(value: string, width: number): string {
  const clean = stripAnsi(value);
  if (clean.length <= width) return value;
  return clean.slice(0, Math.max(0, width - 1)) + "…";
}

function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-9;]*m/g, "");
}

function bold(value: string): string {
  return `\x1b[1m${value}\x1b[0m`;
}

function dim(value: string): string {
  return `\x1b[90m${value}\x1b[0m`;
}

function cyan(value: string): string {
  return `\x1b[36m${value}\x1b[0m`;
}

function green(value: string): string {
  return `\x1b[32m${value}\x1b[0m`;
}

function yellow(value: string): string {
  return `\x1b[33m${value}\x1b[0m`;
}

function red(value: string): string {
  return `\x1b[31m${value}\x1b[0m`;
}