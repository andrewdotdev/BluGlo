import { Client } from "fnbr";

import { BOT, RECONNECT, TIMINGS } from "./config.js";
import { bus, log } from "./events.js";
import { MatchmakingState, Presence, type PresenceValue } from "./bot/constants.js";
import { registerLifecycleHandlers } from "./bot/events/lifecycle.js";
import { registerPartyHandlers } from "./bot/events/party.js";
import { registerSocialHandlers } from "./bot/events/social.js";
import type { FnbrClient } from "./bot/types.js";
import type { BotManager } from "./manager.js";
import type { AccountData, BotSnapshot, BotStats } from "./types.js";

export { MatchmakingState, Presence };

/**
 * Main runtime wrapper around a single fnbr.js client.
 *
 * The class intentionally keeps connection helpers and shared state here,
 * while the verbose event registration lives in src/bot/events/*.
 *
 * @see https://fnbr.js.org
 * @see https://github.com/fnbrjs/fnbr.js
 */
export class BluGlo {
  public readonly accountId: string;
  public readonly deviceId: string;
  public readonly secret: string;
  public displayName: string | null;
  public readonly actions: Required<NonNullable<AccountData["actions"]>>;
  public readonly manager?: BotManager;
  public client: FnbrClient | null = null;
  public presence: PresenceValue = Presence.OFFLINE;
  public status = "offline";
  public retryCount = 0;
  public currentTimeout: ReturnType<typeof setTimeout> | null = null;
  public reJoinTo: string | null = null;
  public stats: BotStats = {
    taxisCompleted: 0,
    invitesDeclined: 0,
    totalUptime: 0,
    connectedAt: null,
  };

  private keepaliveInterval: ReturnType<typeof setInterval> | null = null;

  public constructor(accountData: AccountData, manager?: BotManager) {
    this.accountId = accountData.accountId;
    this.deviceId = accountData.deviceId;
    this.secret = accountData.secret;
    this.displayName = accountData.displayName ?? null;
    this.actions = {
      high: BOT.fortStatsHigh,
      denyFriendRequests: BOT.denyFriendRequests,
      idleStatus: BOT.idleStatus,
      busyStatus: BOT.busyStatus,
      ...accountData.actions,
    };
    this.manager = manager;
  }

  public get shortId(): string {
    return this.accountId.slice(0, 8);
  }

  public get timings() {
    return TIMINGS;
  }

  /**
   * Returns the uptime of the active session in seconds.
   */
  public getCurrentSessionUptimeSeconds(): number {
    if (!this.stats.connectedAt) return 0;
    return Math.max(0, Math.floor((Date.now() - this.stats.connectedAt) / 1000));
  }

  /**
   * Returns the accumulated uptime plus the active session uptime.
   */
  public getLiveTotalUptimeSeconds(): number {
    return this.stats.totalUptime + this.getCurrentSessionUptimeSeconds();
  }

  /**
   * Moves the active session uptime into the accumulated total.
   * This keeps totals correct across disconnects and reloads.
   */
  public accumulateUptime(): void {
    const sessionUptime = this.getCurrentSessionUptimeSeconds();
    if (sessionUptime > 0) {
      this.stats.totalUptime += sessionUptime;
    }
    this.stats.connectedAt = null;
  }

  public get snapshot(): BotSnapshot {
    return {
      accountId: this.accountId,
      shortId: this.shortId,
      displayName: this.displayName,
      presence: this.presence,
      status: this.status,
      retryCount: this.retryCount,
      stats: {
        ...this.stats,
        totalUptime: this.getLiveTotalUptimeSeconds(),
      },
      actions: this.actions,
    };
  }

  /**
   * Creates the fnbr.js client instance and wires all event handlers.
   *
   * @see https://fnbr.js.org
   * @see https://github.com/fnbrjs/fnbr.js
   */
  public start(): void {
    this.setPresence(Presence.LOADING, "Connecting...");

    const idleMsg = this.actions.idleStatus || BOT.idleStatus;
    const busyMsg = this.actions.busyStatus || BOT.busyStatus;

    this.client = new Client({
      auth: {
        deviceAuth: {
          accountId: this.accountId,
          deviceId: this.deviceId,
          secret: this.secret,
        },
        authClient: BOT.authClient as any,
        createLauncherSession: false,
        killOtherTokens: false,
      },
      partyConfig: {
        chatEnabled: true,
        discoverability: "INVITED_ONLY",
        joinability: "INVITE_AND_FORMER",
        joinConfirmation: true,
        maxSize: BOT.partyMaxSize,
        privacy: {
          acceptingMembers: true,
          invitePermission: "AnyMember",
          inviteRestriction: "AnyMember",
          onlyLeaderFriendsCanJoin: false,
          partyType: "Private",
          presencePermission: "Anyone",
        },
      },
      defaultOnlineType: "online",
      defaultStatus: idleMsg,
      restRetryLimit: RECONNECT.restRetryLimit,
      xmppMaxConnectionRetries: RECONNECT.xmppMaxConnectionRetries,
      partyBuildId: "1:3:51618937",
    }) as FnbrClient;

    registerLifecycleHandlers(this, idleMsg);
    registerSocialHandlers(this);
    registerPartyHandlers(this, idleMsg, busyMsg);
  }

  /**
   * Stops the current bot instance and closes listeners/connections.
   *
   * @see https://nodejs.org/api/events.html
   */
  public stop(): void {
    this.clearPartyTimeout();
    this.accumulateUptime();

    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }

    this.client?.removeAllListeners();
    this.client?.xmpp?.disconnect?.();
    void this.client?.logout?.().catch(() => undefined);
    this.setPresence(Presence.OFFLINE, "Stopped");
    log(this.accountId, "info", "Bot stopped");
  }

  /**
   * Returns the bot to idle after leaving a party or finishing a taxi.
   */
  public returnToIdle(idleMsg?: string): void {
    this.clearPartyTimeout();
    this.setPresence(Presence.ACTIVE, idleMsg || BOT.idleStatus);
    this.client?.setStatus?.(idleMsg || BOT.idleStatus, "online");
  }

  /**
   * Updates the in-memory presence and broadcasts it to the dashboard.
   */
  public setPresence(presence: PresenceValue, status: string): void {
    this.presence = presence;
    this.status = status;
    bus.emit("status", { accountId: this.accountId, presence, status });
  }

  /**
   * Clears the current auto-leave timer for a joined party.
   */
  public clearPartyTimeout(): void {
    if (this.currentTimeout != null) {
      this.client?.clearTimeout?.(this.currentTimeout);
      this.currentTimeout = null;
    }
  }

  /**
   * Starts a lightweight keepalive so the status stays fresh.
   */
  public startKeepalive(): void {
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }

    const tick = () => {
      try {
        if (!this.client) return;

        const status =
          this.presence === Presence.BUSY
            ? this.actions.busyStatus || BOT.busyStatus
            : this.actions.idleStatus || BOT.idleStatus;

        this.client.setStatus?.(status, "online");
      } catch (error) {
        log(
          this.accountId,
          "warn",
          `Keepalive failed: ${error instanceof Error ? error.message : String(error)}`,
        );

        if (this.keepaliveInterval) {
          clearInterval(this.keepaliveInterval);
          this.keepaliveInterval = null;
        }

        this.handleDisconnect();
      }
    };

    tick();

    this.keepaliveInterval = setInterval(tick, 1000 * 60 * 4);
  }

  /**
   * Called when the client is disconnected unexpectedly.
   */
  public handleDisconnect(): void {
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }

    this.accumulateUptime();
    this.setPresence(Presence.OFFLINE, "Disconnected");
    this.retryCount++;

    if (this.retryCount <= RECONNECT.maxRetries) {
      log(this.accountId, "warn", `Disconnected — retry ${this.retryCount}/${RECONNECT.maxRetries}`);
      this.scheduleReconnect();
      return;
    }

    log(this.accountId, "error", `Maximum retries reached (${RECONNECT.maxRetries})`);
    this.setPresence(Presence.OFFLINE, "Permanent error — use /reload <id>");
  }

  /**
   * Handles fnbr/XMPP errors that should trigger a reconnect.
   */
  public handleXmppError(error: unknown): void {
    const code =
      typeof (error as { code?: string })?.code === "string"
        ? (error as { code: string }).code.toLowerCase()
        : "";

    const shouldReconnect = ["disconnect", "invalid_refresh_token", "party_not_found"].some((value) =>
      code.includes(value),
    );

    if (shouldReconnect) {
      this.handleDisconnect();
    }
  }

  /**
   * Schedules a clean reconnect by rebuilding the client instance.
   */
  public scheduleReconnect(): void {
    setTimeout(() => {
      log(this.accountId, "info", "Reconnecting...");
      this.cleanup();
      this.start();
    }, TIMINGS.reconnectDelayMs);
  }

  /**
   * Releases listeners and network resources before reconnecting.
   */
  public cleanup(): void {
    this.clearPartyTimeout();
    this.accumulateUptime();

    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }

    this.client?.removeAllListeners();
    this.client?.xmpp?.disconnect?.();
    void this.client?.logout?.().catch(() => undefined);
    this.client = null;
  }
}
