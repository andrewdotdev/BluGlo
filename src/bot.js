import fnbr from "fnbr";
const { Client } = fnbr;
import { BOT, TIMINGS, RECONNECT } from "./config.js";
import { bus, log } from "./events.js";

export const Presence = {
  ACTIVE: "active",
  BUSY: "busy",
  OFFLINE: "offline",
  LOADING: "loading",
};

export const MatchmakingState = {
  NOT_MATCHMAKING: "NotMatchmaking",
  FINDING_EMPTY_SERVER: "FindingEmptyServer",
  JOINING_SESSION: "JoiningExistingSession",
  TESTING_SERVERS: "TestingEmptyServers",
};

const FORT_HIGH = 92765;
const FORT_LOW = 0;

export class BluGo {
  /**
   * @param {object} accountData
   * @param {string} accountData.accountId
   * @param {string} accountData.deviceId
   * @param {string} accountData.secret
   * @param {object} [accountData.actions]
   * @param {BotManager} manager - manager reference for collision detection
   */
  constructor(accountData, manager) {
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
    this.client = null;
    this.presence = Presence.OFFLINE;
    this.status = "offline"; // UI status label
    this.retryCount = 0;
    this.currentTimeout = null;
    this.reJoinTo = null; // pending accountId to rejoin after reconnect
    this.stats = {
      taxisCompleted: 0,
      invitesDeclined: 0,
      totalUptime: 0,
      connectedAt: null,
    };
  }

  get shortId() {
    return this.accountId.slice(0, 8);
  }

  get snapshot() {
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

  /** Start the fnbr client and register listeners. */
  start() {
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
        authClient: BOT.authClient,
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
    });

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
        this.manager?.updateDisplayName?.(this.accountId, resolvedDisplayName);
      }

      if (this.actions.denyFriendRequests) {
        const pending =
          this.client.friend?.pendingList?.filter(
            (f) => f.direction === "INCOMING",
          ) ?? [];
        pending.forEach((f) => f.decline?.().catch(() => { }));
        if (pending.length > 0) {
          log(
            this.accountId,
            "info",
            `Declined ${pending.length} pending friend request(s)`,
          );
        }
      }

      if (this.reJoinTo) {
        const friend = this.client.friend?.resolve(this.reJoinTo);
        friend?.sendJoinRequest?.().catch(() => { });
        log(
          this.accountId,
          "info",
          `Retrying join to ${this.reJoinTo.slice(0, 8)}`,
        );
        this.reJoinTo = null;
      }

      // this is like a heartbeat interval, AND IS CRITICAL!!!
      this._keepaliveInterval = setInterval(async () => {
        try {
          this.client.setStatus(
            this.presence === Presence.BUSY
              ? (this.actions.busyStatus || BOT.busyStatus)
              : (this.actions.idleStatus || BOT.idleStatus),
            'online'
          )
        } catch (err) {
          log(this.accountId, 'warn', `Keepalive failed, trying to reconnect...`)
          clearInterval(this._keepaliveInterval)
          this._onDisconnect()
        }
      }, 1000 * 60 * 4) // each 4 minutes
    });

    this.client.on("disconnected", () => this._onDisconnect());
    this.client.on("xmpp:message:error", (err) => this._onXmppError(err));

    this.client.on("party:member:disconnected", (m) => {
      if (m.id === this.accountId) this._onDisconnect();
    });
    this.client.on("party:member:expired", (m) => {
      if (m.id === this.accountId) this._onDisconnect();
    });

    this.client.on("party:member:kicked", (m) => {
      if (m.id === this.accountId) this._returnToIdle(idleMsg);
    });

    this.client.on("party:member:left", (m) => {
      const alone =
        m.party.members.size === 1 &&
        m.party.members.first()?.id === this.accountId;

      if (m.id === this.accountId || alone) {
        this._returnToIdle(idleMsg);
      }
    });

    this.client.on("friend:request", (incoming) => {
      if (this.actions.denyFriendRequests) {
        incoming.decline?.().catch(() => { });
        log(
          this.accountId,
          "info",
          `Declined friend request from ${incoming.displayName}`,
        );
      } else {
        incoming.accept?.().catch(() => { });
        log(
          this.accountId,
          "info",
          `Accepted friend request from ${incoming.displayName}`,
        );
      }
    });

    this.client.on("friend:added", (friend) => {
      log(this.accountId, "info", `New friend: ${friend.displayName}`);
      bus.emit("friend", {
        accountId: this.accountId,
        friendId: friend.id,
        displayName: friend.displayName,
      });
    });

    this.client.on("party:member:joined", async (member) => {
      try {
        const schema = member.party.meta?.schema ?? {};
        const ci = JSON.parse(schema["Default:CampaignInfo_j"] ?? "{}");
        const state = ci?.CampaignInfo?.matchmakingState;

        if (state && state !== MatchmakingState.NOT_MATCHMAKING) {
          if (member.id === this.accountId) {
            log(
              this.accountId,
              "warn",
              "Party already in matchmaking when joined → leaving immediately",
            );
            await this.client.leaveParty().catch(() => { });
            this._returnToIdle(idleMsg);
            return;
          }
        }
      } catch (_) { }

      const collision = await this.manager?.handleCollision(member.party, this);
      if (collision) return;

      const members = member.party.members
        .map((m) => ({
          accountId: m.id,
          displayName: m.displayName,
          isLeader: m.isLeader,
        }))
        .filter((m) => m.accountId !== this.accountId);

      bus.emit("joined", { accountId: this.accountId, members });
      log(
        this.accountId,
        "info",
        `Party members: ${members.map((m) => m.displayName || m.accountId.slice(0, 8)).join(", ")}`,
      );
    });

    this.client.on("party:invite", async (invitation) => {
      const senderName =
        invitation.sender?.displayName ?? invitation.sender?.id?.slice(0, 8);
      log(this.accountId, "info", `Party invite from ${senderName}`);
      bus.emit("invite", {
        accountId: this.accountId,
        from: senderName,
        fromId: invitation.sender?.id,
      });

      if (this.presence === Presence.BUSY) {
        log(this.accountId, "info", `Declining (busy)`);
        this.stats.invitesDeclined++;
        invitation.decline?.().catch(() => { });
        return;
      }

      if (invitation.party?.members?.size >= BOT.partyMaxSize) {
        log(this.accountId, "info", `Declining (party full)`);
        this.stats.invitesDeclined++;
        invitation.decline?.().catch(() => { });
        return;
      }

      if ((this.client.party?.members?.size ?? 1) > 1) {
        log(this.accountId, "info", `Declining (already in party)`);
        this.stats.invitesDeclined++;
        invitation.decline?.().catch(() => { });
        return;
      }

      if (this.manager?.hasOtherTaxiIn(invitation.party, this.accountId)) {
        log(
          this.accountId,
          "info",
          `Declining (another taxi already in that party)`,
        );
        this.stats.invitesDeclined++;
        invitation.decline?.().catch(() => { });
        return;
      }

      try {
        const { isPlaying, sessionId } = invitation.sender?.presence ?? {};
        if (isPlaying || sessionId) {
          log(this.accountId, "info", `Declining (sender already in match)`);
          this.stats.invitesDeclined++;
          invitation.decline?.().catch(() => { });
          return;
        }
      } catch (_) { }

      try {
        this._setPresence(Presence.BUSY, busyMsg);
        await invitation.accept();
        this.client.setStatus(busyMsg, "online");

        if (TIMINGS.postAcceptDelayMs > 0) {
          await new Promise((r) => setTimeout(r, TIMINGS.postAcceptDelayMs));
        }

        await this._applyPatch();
        log(
          this.accountId,
          "ok",
          `In party with ${senderName} — patch applied`,
        );

        this._clearTimeout();
        this.currentTimeout = this.client.setTimeout(() => {
          log(this.accountId, "warn", "Party timeout → leaving");
          this.client.leaveParty().catch(() => { });
          this.currentTimeout = null;
          this._returnToIdle(idleMsg);
        }, TIMINGS.partyAutoLeaveMs);
      } catch (err) {
        log(
          this.accountId,
          "error",
          `Error while accepting invite: ${err?.code ?? err?.message}`,
        );
        this._setPresence(Presence.ACTIVE, idleMsg);
        this.reJoinTo = invitation.sender?.id ?? null;
        this._onXmppError(err);
      }
    });

    this.client.on("party:member:matchstate:updated", (member, value, prev) => {
      const from = `${prev?.location}`;
      const to = `${value?.location}`;

      // PreLobby → ConnectingToLobby: matchmaking just started
      if (from === "PreLobby" && to === "ConnectingToLobby") {
        log(
          this.accountId,
          "ok",
          `Matchmaking detected → leaving in ${TIMINGS.matchstateLeaveDelayMs}ms`,
        );

        this.client.setTimeout(async () => {
          await this.client.leaveParty().catch(() => { });
          this._clearTimeout();
          this.stats.taxisCompleted++;
          this._returnToIdle(idleMsg);
          log(
            this.accountId,
            "ok",
            `Taxi completed #${this.stats.taxisCompleted}`,
          );
        }, TIMINGS.matchstateLeaveDelayMs);
      }
    });

    this.client.login().catch((err) => {
      log(this.accountId, "error", `Login error: ${err?.message}`);
      clearTimeout(initTimer);
      this._setPresence(Presence.OFFLINE, "Login error");
      this._scheduleReconnect();
    });
  }

  /** Stop the client completely without reconnecting. */
  stop() {
    this._clearTimeout();
    clearInterval(this._keepaliveInterval)
    this._keepaliveInterval = null
    this.client?.removeAllListeners();
    this.client?.xmpp?.disconnect?.();
    this.client?.logout?.().catch(() => { });
    this._setPresence(Presence.OFFLINE, "Stopped");
    log(this.accountId, "info", "Bot stopped");
  }

  _onDisconnect() {
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
      log(
        this.accountId,
        "error",
        `Maximum retries reached (${RECONNECT.maxRetries})`,
      );
      this._setPresence(Presence.OFFLINE, "Permanent error — use /reload <id>");
    }
  }

  _onXmppError(err) {
    const code = err?.code?.toLowerCase() ?? "";
    const shouldReconnect = [
      "disconnect",
      "invalid_refresh_token",
      "party_not_found",
    ].some((c) => code.includes(c));

    if (shouldReconnect) this._onDisconnect();
  }

  _scheduleReconnect() {
    setTimeout(() => {
      log(this.accountId, "info", "Reconnecting...");
      this._cleanup();
      this.start();
    }, TIMINGS.reconnectDelayMs);
  }

  _cleanup() {
    this._clearTimeout();
    clearInterval(this._keepaliveInterval)
    this._keepaliveInterval = null
    this.client?.removeAllListeners?.();
    this.client?.xmpp?.disconnect?.();
    this.client?.logout?.().catch(() => { });
    this.client = null;
  }

  _setPresence(presence, status) {
    this.presence = presence;
    this.status = status;
    bus.emit("status", { accountId: this.accountId, presence, status });
  }

  _returnToIdle(idleMsg) {
    this._clearTimeout();
    this._setPresence(Presence.ACTIVE, idleMsg || BOT.idleStatus);
    this.client?.setStatus?.(idleMsg || BOT.idleStatus, "online");
  }

  _clearTimeout() {
    if (this.currentTimeout != null) {
      this.client?.clearTimeout?.(this.currentTimeout);
      this.currentTimeout = null;
    }
  }

  /** Apply the metadata patch to the party member. */
  async _applyPatch() {
    const stat = this.actions.high ? FORT_HIGH : FORT_LOW;

    // Lee el schema actual para saber si hay que actualizar MpLoadout
    const schema = this.client.party?.me?.meta?.schema ?? {};
    // eslint-disable-next-line no-unused-vars
    const mpLoadout1 = (() => {
      const value = schema["Default:MpLoadout1_j"];
      if (!value) return null;

      if (typeof value === "string") {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      }

      if (typeof value === "object") {
        return value;
      }

      return null;
    })();

    const cosmetics = {
      "Default:MpLoadout1_j": JSON.stringify({
        MpLoadout1: {
          s: {
            ac: { i: "CID_039_Athena_Commando_F_Disco", v: ["0"] },
            li: { i: "StandardBanner20", v: [] },
            lc: { i: "DefaultColor2", v: [] }
          }
        }
      }),
    };

    // log(this.accountId, "info", `Has Default:MpLoadout1_j: ${schema["Default:MpLoadout1_j"] ? "yes" : "no"}`);
    // log(this.accountId, "info", `Parsed MpLoadout1 keys: ${Object.keys(mpLoadout1?.MpLoadout1?.s ?? {}).join(", ")}`);

    /**
    if (mpLoadout1?.MpLoadout1?.s !== undefined) {
      log(this.accountId, "info", "Pushing Cosmetics");
      cosmetics["Default:MpLoadout1_j"] = JSON.stringify({
        MpLoadout1: {
          s: {
            ac: { i: "CID_039_Athena_Commando_F_Disco", v: ["0"] },
            li: { i: "StandardBanner20", v: [] },
            lc: { i: "DefaultColor2", v: [] }
          }
        }
      })
    }
      */

    const patch = {
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

    // Send the Stats, Skin and Banner patch
    await this.client.party?.me?.sendPatch(patch);
    setTimeout(() => {
      this.client.party?.me?.sendPatch({
        "Default:FrontendEmote_j": JSON.stringify({
          FrontendEmote: {
            pickable:
              "/BRCosmetics/Athena/Items/Cosmetics/Dances/EID_Hype.EID_Hype",
            emoteEKey: "",
            emoteSection: -2,
            multipurposeEmoteData: -1
          },
        }),
      })
    }, 1000 * 60 * 3)
  }
}
