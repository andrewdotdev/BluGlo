import { Client } from "fnbr";

import { BOT, RECONNECT, TIMINGS } from "./config.js";
import { bus, log } from "./events.js";
import type { BotManager } from "./manager.js";
import type {
  AccountData,
  BotSnapshot,
  BotStats,
  MatchStateLike,
  PartyInvitationLike,
  PartyMemberLike,
} from "./types.js";

export const Presence = {
  ACTIVE: "active",
  BUSY: "busy",
  OFFLINE: "offline",
  LOADING: "loading",
} as const;

export const MatchmakingState = {
  NOT_MATCHMAKING: "NotMatchmaking",
  FINDING_EMPTY_SERVER: "FindingEmptyServer",
  JOINING_SESSION: "JoiningExistingSession",
  TESTING_SERVERS: "TestingEmptyServers",
} as const;

const FORT_HIGH = 92765;
const FORT_LOW = 0;

type PresenceValue = (typeof Presence)[keyof typeof Presence];
type FnbrClient = InstanceType<typeof Client> & {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  defaultStatus?: string;
  friend?: {
    pendingList?: Array<{
      direction?: string;
      decline?: () => Promise<unknown>;
    }>;
    resolve?: (accountId: string) => {
      sendJoinRequest?: () => Promise<unknown>;
    } | null;
  };
  user?: {
    self?: { displayName?: string };
    displayName?: string;
  };
  party?: {
    members?: { size: number };
    me?: {
      meta?: { schema?: Record<string, unknown> };
      sendPatch?: (patch: Record<string, string>) => Promise<unknown>;
    };
  };
  xmpp?: {
    disconnect?: () => void;
  };
  leaveParty?: () => Promise<unknown>;
  login: () => Promise<unknown>;
  logout?: () => Promise<unknown>;
  removeAllListeners: () => void;
  setStatus: (status: string, type: string) => void;
  on: (event: string, listener: (...args: any[]) => void) => void;
  once: (event: string, listener: (...args: any[]) => void) => void;
};

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

  public get snapshot(): BotSnapshot {
    return {
      accountId: this.accountId,
      shortId: this.shortId,
      displayName: this.displayName,
      presence: this.presence,
      status: this.status,
      retryCount: this.retryCount,
      stats: this.stats,
      actions: this.actions,
    };
  }

  public start(): void {
    this._setPresence(Presence.LOADING, "Connecting...");

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

    const initTimer = setTimeout(() => {
      log(this.accountId, "error", "Startup timeout reached");
      this._setPresence(Presence.OFFLINE, "Startup timeout");
      this._scheduleReconnect();
    }, TIMINGS.initTimeoutMs);

    this.client.once("ready", () => {
      clearTimeout(initTimer);
      this.retryCount = 0;
      this.stats.connectedAt = Date.now();
      this._setPresence(Presence.ACTIVE, idleMsg);
      log(this.accountId, "ok", "Connected and ready");

      const resolvedDisplayName =
        this.client?.user?.self?.displayName ||
        this.client?.user?.displayName ||
        this.displayName ||
        null;

      if (resolvedDisplayName && resolvedDisplayName !== this.displayName) {
        this.displayName = resolvedDisplayName;
        this.manager?.updateDisplayName(this.accountId, resolvedDisplayName);
      }

      if (this.actions.denyFriendRequests) {
        const pendingList = this.client?.friend?.pendingList as any;
        const pending =
          pendingList?.filter?.((friend: any) => friend.direction === "INCOMING") ?? [];
        const pendingArray = Array.isArray(pending)
          ? pending
          : Array.from((pending?.values?.() ?? pending) as Iterable<any>);
        for (const friend of pendingArray) {
          void friend.decline?.().catch(() => undefined);
        }
        if (pendingArray.length > 0) {
          log(this.accountId, "info", `Declined ${pendingArray.length} pending friend request(s)`);
        }
      }

      if (this.reJoinTo) {
        const friend = this.client?.friend?.resolve?.(this.reJoinTo);
        void friend?.sendJoinRequest?.().catch(() => undefined);
        log(this.accountId, "info", `Retrying join to ${this.reJoinTo.slice(0, 8)}`);
        this.reJoinTo = null;
      }

      this.keepaliveInterval = setInterval(
        () => {
          try {
            this.client?.setStatus(
              this.presence === Presence.BUSY
                ? this.actions.busyStatus || BOT.busyStatus
                : this.actions.idleStatus || BOT.idleStatus,
              "online",
            );
          } catch {
            log(this.accountId, "warn", "Keepalive failed, trying to reconnect...");
            if (this.keepaliveInterval) {
              clearInterval(this.keepaliveInterval);
            }
            this._onDisconnect();
          }
        },
        1000 * 60 * 4,
      );
    });

    this.client.on("disconnected", () => this._onDisconnect());
    this.client.on("xmpp:message:error", (error: unknown) => this._onXmppError(error));

    this.client.on("party:member:disconnected", (member: PartyMemberLike) => {
      if (member.id === this.accountId) this._onDisconnect();
    });
    this.client.on("party:member:expired", (member: PartyMemberLike) => {
      if (member.id === this.accountId) this._onDisconnect();
    });
    this.client.on("party:member:kicked", (member: PartyMemberLike) => {
      if (member.id === this.accountId) this._returnToIdle(idleMsg);
    });

    this.client.on("party:member:left", (member: PartyMemberLike) => {
      const alone =
        member.party.members.size === 1 && member.party.members.first?.()?.id === this.accountId;
      if (member.id === this.accountId || alone) {
        this._returnToIdle(idleMsg);
      }
    });

    this.client.on(
      "friend:request",
      (
        incoming: PartyInvitationLike["sender"] & {
          accept?: () => Promise<unknown>;
        },
      ) => {
        if (!incoming) return;
        if (this.actions.denyFriendRequests) {
          void incoming.decline?.().catch(() => undefined);
          log(this.accountId, "info", `Declined friend request from ${incoming.displayName}`);
        } else {
          void incoming.accept?.().catch(() => undefined);
          log(this.accountId, "info", `Accepted friend request from ${incoming.displayName}`);
        }
      },
    );

    this.client.on("friend:added", (friend: { id: string; displayName?: string }) => {
      log(this.accountId, "info", `New friend: ${friend.displayName}`);
      bus.emit("friend", {
        accountId: this.accountId,
        friendId: friend.id,
        displayName: friend.displayName,
      });
    });

    this.client.on("party:member:joined", async (member: PartyMemberLike) => {
      try {
        const schema = member.party.meta?.schema ?? {};
        const campaignInfo = JSON.parse(schema["Default:CampaignInfo_j"] ?? "{}") as {
          CampaignInfo?: { matchmakingState?: string };
        };
        const state = campaignInfo.CampaignInfo?.matchmakingState;

        if (state && state !== MatchmakingState.NOT_MATCHMAKING && member.id === this.accountId) {
          log(
            this.accountId,
            "warn",
            "Party already in matchmaking when joined → leaving immediately",
          );
          await this.client?.leaveParty?.().catch(() => undefined);
          this._returnToIdle(idleMsg);
          return;
        }
      } catch {
        // ignore invalid campaign info payloads
      }

      const collision = await this.manager?.handleCollision(member.party, this);
      if (collision) return;

      const members = member.party.members
        .map((partyMember) => ({
          accountId: partyMember.id,
          displayName: partyMember.displayName,
          isLeader: partyMember.isLeader,
        }))
        .filter((partyMember) => partyMember.accountId !== this.accountId);

      bus.emit("joined", { accountId: this.accountId, members });
      log(
        this.accountId,
        "info",
        `Party members: ${members.map((partyMember) => partyMember.displayName || partyMember.accountId.slice(0, 8)).join(", ")}`,
      );
    });

    this.client.on("party:invite", async (invitation: PartyInvitationLike) => {
      const senderName = invitation.sender?.displayName ?? invitation.sender?.id?.slice(0, 8);
      log(this.accountId, "info", `Party invite from ${senderName}`);
      bus.emit("invite", {
        accountId: this.accountId,
        from: senderName,
        fromId: invitation.sender?.id,
      });

      if (this.presence === Presence.BUSY) {
        log(this.accountId, "info", "Declining (busy)");
        this.stats.invitesDeclined++;
        void invitation.decline?.().catch(() => undefined);
        return;
      }

      if ((invitation.party?.members?.size ?? 0) >= BOT.partyMaxSize) {
        log(this.accountId, "info", "Declining (party full)");
        this.stats.invitesDeclined++;
        void invitation.decline?.().catch(() => undefined);
        return;
      }

      if ((this.client?.party?.members?.size ?? 1) > 1) {
        log(this.accountId, "info", "Declining (already in party)");
        this.stats.invitesDeclined++;
        void invitation.decline?.().catch(() => undefined);
        return;
      }

      if (this.manager?.hasOtherTaxiIn(invitation.party, this.accountId)) {
        log(this.accountId, "info", "Declining (another taxi already in that party)");
        this.stats.invitesDeclined++;
        void invitation.decline?.().catch(() => undefined);
        return;
      }

      try {
        const { isPlaying, sessionId } = invitation.sender?.presence ?? {};
        if (isPlaying || sessionId) {
          log(this.accountId, "info", "Declining (sender already in match)");
          this.stats.invitesDeclined++;
          void invitation.decline?.().catch(() => undefined);
          return;
        }
      } catch {
        // ignore presence parsing issues
      }

      try {
        this._setPresence(Presence.BUSY, busyMsg);
        await invitation.accept();
        this.client?.setStatus(busyMsg, "online");

        if (TIMINGS.postAcceptDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, TIMINGS.postAcceptDelayMs));
        }

        await this._applyPatch();
        log(this.accountId, "ok", `In party with ${senderName} — patch applied`);

        this._clearTimeout();
        this.currentTimeout =
          this.client?.setTimeout(() => {
            log(this.accountId, "warn", "Party timeout → leaving");
            void this.client?.leaveParty?.().catch(() => undefined);
            this.currentTimeout = null;
            this._returnToIdle(idleMsg);
          }, TIMINGS.partyAutoLeaveMs) ?? null;
      } catch (error: any) {
        log(
          this.accountId,
          "error",
          `Error while accepting invite: ${error?.code ?? error?.message ?? String(error)}`,
        );
        this._setPresence(Presence.ACTIVE, idleMsg);
        this.reJoinTo = invitation.sender?.id ?? null;
        this._onXmppError(error);
      }
    });

    this.client.on(
      "party:member:matchstate:updated",
      (member: PartyMemberLike, value: MatchStateLike, prev: MatchStateLike) => {
        void member;
        const from = `${prev?.location}`;
        const to = `${value?.location}`;

        if (from === "PreLobby" && to === "ConnectingToLobby") {
          log(
            this.accountId,
            "ok",
            `Matchmaking detected → leaving in ${TIMINGS.matchstateLeaveDelayMs}ms`,
          );

          this.client?.setTimeout(async () => {
            await this.client?.leaveParty?.().catch(() => undefined);
            this._clearTimeout();
            this.stats.taxisCompleted++;
            this._returnToIdle(idleMsg);
            log(this.accountId, "ok", `Taxi completed #${this.stats.taxisCompleted}`);
          }, TIMINGS.matchstateLeaveDelayMs);
        }
      },
    );

    void this.client.login().catch((error: Error) => {
      log(this.accountId, "error", `Login error: ${error?.message}`);
      clearTimeout(initTimer);
      this._setPresence(Presence.OFFLINE, "Login error");
      this._scheduleReconnect();
    });
  }

  public stop(): void {
    this._clearTimeout();
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
    this.client?.removeAllListeners();
    this.client?.xmpp?.disconnect?.();
    void this.client?.logout?.().catch(() => undefined);
    this._setPresence(Presence.OFFLINE, "Stopped");
    log(this.accountId, "info", "Bot stopped");
  }

  public _returnToIdle(idleMsg?: string): void {
    this._clearTimeout();
    this._setPresence(Presence.ACTIVE, idleMsg || BOT.idleStatus);
    this.client?.setStatus?.(idleMsg || BOT.idleStatus, "online");
  }

  private _onDisconnect(): void {
    this._setPresence(Presence.OFFLINE, "Disconnected");
    this.retryCount++;

    if (this.retryCount <= RECONNECT.maxRetries) {
      log(
        this.accountId,
        "warn",
        `Disconnected — retry ${this.retryCount}/${RECONNECT.maxRetries}`,
      );
      this._scheduleReconnect();
    } else {
      log(this.accountId, "error", `Maximum retries reached (${RECONNECT.maxRetries})`);
      this._setPresence(Presence.OFFLINE, "Permanent error — use /reload <id>");
    }
  }

  private _onXmppError(error: unknown): void {
    const code =
      typeof (error as { code?: string })?.code === "string"
        ? (error as { code: string }).code.toLowerCase()
        : "";
    const shouldReconnect = ["disconnect", "invalid_refresh_token", "party_not_found"].some(
      (value) => code.includes(value),
    );

    if (shouldReconnect) {
      this._onDisconnect();
    }
  }

  private _scheduleReconnect(): void {
    setTimeout(() => {
      log(this.accountId, "info", "Reconnecting...");
      this._cleanup();
      this.start();
    }, TIMINGS.reconnectDelayMs);
  }

  private _cleanup(): void {
    this._clearTimeout();
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
    this.client?.removeAllListeners?.();
    this.client?.xmpp?.disconnect?.();
    void this.client?.logout?.().catch(() => undefined);
    this.client = null;
  }

  private _setPresence(presence: PresenceValue, status: string): void {
    this.presence = presence;
    this.status = status;
    bus.emit("status", { accountId: this.accountId, presence, status });
  }

  private _clearTimeout(): void {
    if (this.currentTimeout != null) {
      this.client?.clearTimeout?.(this.currentTimeout);
      this.currentTimeout = null;
    }
  }

  private async _applyPatch(): Promise<void> {
    const stat = this.actions.high ? FORT_HIGH : FORT_LOW;

    const schema = this.client?.party?.me?.meta?.schema ?? {};
    const _mpLoadout1 = (() => {
      const value = schema["Default:MpLoadout1_j"];
      if (!value) return null;

      if (typeof value === "string") {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return null;
        }
      }

      if (typeof value === "object") {
        return value;
      }

      return null;
    })();
    void _mpLoadout1;

    const cosmetics: Record<string, string> = {
      "Default:MpLoadout1_j": JSON.stringify({
        MpLoadout1: {
          s: {
            ac: { i: "CID_039_Athena_Commando_F_Disco", v: ["0"] },
            li: { i: "StandardBanner20", v: [] },
            lc: { i: "DefaultColor2", v: [] },
          },
        },
      }),
    };

    const patch: Record<string, string> = {
      "Default:FORTStats_j": JSON.stringify({
        FORTStats: {
          fortitude: stat,
          offense: stat,
          resistance: stat,
          tech: stat,
          teamFortitude: 0,
          teamOffense: 0,
          teamResistance: 0,
          teamTech: 0,
          fortitude_Phoenix: stat,
          offense_Phoenix: stat,
          resistance_Phoenix: stat,
          tech_Phoenix: stat,
          teamFortitude_Phoenix: 0,
          teamOffense_Phoenix: 0,
          teamResistance_Phoenix: 0,
          teamTech_Phoenix: 0,
        },
      }),
      "Default:PackedState_j": JSON.stringify({
        PackedState: {
          subGame: "Campaign",
          location: "PreLobby",
          gameMode: "None",
          voiceChatStatus: "PartyVoice",
          hasCompletedSTWTutorial: true,
          hasPurchasedSTW: true,
          platformSupportsSTW: true,
          bReturnToLobbyAndReadyUp: false,
          bHideReadyUp: false,
          bDownloadOnDemandActive: false,
          bIsPartyLFG: false,
          bShouldRecordPartyChannel: false,
        },
      }),
      ...cosmetics,
    };

    if (this.actions.high) {
      patch["Default:CampaignCommanderLoadoutRating_d"] = "999.00";
      patch["Default:CampaignBackpackRating_d"] = "999.000000";
    }

    await this.client?.party?.me?.sendPatch?.(patch);
    setTimeout(() => {
      void this.client?.party?.me?.setEmote("EID_Hype").catch(() => undefined);
    }, 1000);
  }
}
