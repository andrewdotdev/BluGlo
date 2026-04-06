import { BOT } from "../../config.js";
import { bus, log } from "../../events.js";
import { MatchmakingState, Presence } from "../constants.js";
import { applyPartyPatch } from "../patch.js";
import type { BluGlo } from "../../bot.js";
import { PARTY_PREFIX } from "../constants.js";
import type { MatchStateLike, PartyInvitationLike, PartyMemberLike } from "../../types.js";
import type { PartyMember, PartyMessage } from "fnbr";
import { sendPartyMessageRaw, sendWhisperRaw } from "../chat.js";

/**
 * Registers party and matchmaking handlers.
 *
 * @see https://fnbr.js.org
 * @see https://github.com/fnbrjs/fnbr.js
 * @see https://github.com/MixV2/EpicResearch
 */
export function registerPartyHandlers(bot: BluGlo, idleMsg: string, busyMsg: string): void {
  bot.client?.on("party:member:joined", async (member: PartyMemberLike) => {
    try {
      const schema = member.party.meta?.schema ?? {};
      const campaignInfo = JSON.parse(schema["Default:CampaignInfo_j"] ?? "{}") as {
        CampaignInfo?: { matchmakingState?: string };
      };
      const state = campaignInfo.CampaignInfo?.matchmakingState;

      if (state && state !== MatchmakingState.NOT_MATCHMAKING && member.id === bot.accountId) {
        log(bot.accountId, "warn", "Party already in matchmaking when joined → leaving immediately");
        await bot.client?.leaveParty?.().catch(() => undefined);
        bot.returnToIdle(idleMsg);
        return;
      }
    } catch {
      // Ignore invalid campaign info payloads.
    }

    const collision = await bot.manager?.handleCollision(member.party, bot);
    if (collision) return;

    const members = bot.client?.party?.members
      .map((partyMember) => ({
        accountId: partyMember.id,
        displayName: partyMember.displayName,
        isLeader: partyMember.isLeader,
      }))
      .filter((partyMember) => partyMember.accountId !== bot.accountId) || member.party.members
        .map((partyMember) => ({
          accountId: partyMember.id,
          displayName: partyMember.displayName,
          isLeader: partyMember.isLeader,
        }))
        .filter((partyMember) => partyMember.accountId !== bot.accountId);



    bus.emit("joined", { accountId: bot.accountId, members });
    // log(
    //   bot.accountId,
    //   "info",
    //   `Party members: ${members.map((partyMember) => partyMember.displayName || partyMember.accountId.slice(0, 8)).join(", ")}`,
    // );

    const welcomeMessage = `Welcome! BluGlo is an open-source TaxiBot manager for Fortnite STW. You can check it out at https://github.com/andrewdotdev/BluGlo

Commands in party chat:
?pl min -> set power level to 0
?pl max -> set power level to maximum`;
    setTimeout(async () => {
      const partyMembers = [...(bot.client?.party?.members?.values() ?? [])];

      for (const partyMember of partyMembers) {
        if (partyMember.id === bot.accountId) continue;

        try {
          await sendWhisperRaw(bot, partyMember.id, welcomeMessage, {
            chunkLength: 256,
            betweenChunksMs: 600,
          });
        } catch (err) {
          log(bot.accountId, "error", `Whisper failed: ${err} `);
        }
      }
    }, 1000);

  });

  bot.client?.on("party:invite", async (invitation: PartyInvitationLike) => {
    const senderName = invitation.sender?.displayName ?? invitation.sender?.id?.slice(0, 8);
    log(bot.accountId, "info", `Party invite from ${senderName}`);
    bus.emit("invite", {
      accountId: bot.accountId,
      from: senderName,
      fromId: invitation.sender?.id,
    });

    if (bot.presence === Presence.BUSY) {
      log(bot.accountId, "info", "Declining (busy)");
      bot.stats.invitesDeclined++;
      void invitation.decline?.().catch(() => undefined);
      return;
    }

    if ((invitation.party?.members?.size ?? 0) >= BOT.partyMaxSize) {
      log(bot.accountId, "info", "Declining (party full)");
      bot.stats.invitesDeclined++;
      void invitation.decline?.().catch(() => undefined);
      return;
    }

    if ((bot.client?.party?.members?.size ?? 1) > 1) {
      log(bot.accountId, "info", "Declining (already in party)");
      bot.stats.invitesDeclined++;
      void invitation.decline?.().catch(() => undefined);
      return;
    }

    if (bot.manager?.hasOtherTaxiIn(invitation.party, bot.accountId)) {
      log(bot.accountId, "info", "Declining (another taxi already in that party)");
      bot.stats.invitesDeclined++;
      void invitation.decline?.().catch(() => undefined);
      return;
    }

    try {
      const { isPlaying, sessionId } = invitation.sender?.presence ?? {};
      if (isPlaying || sessionId) {
        log(bot.accountId, "info", "Declining (sender already in match)");
        bot.stats.invitesDeclined++;
        void invitation.decline?.().catch(() => undefined);
        return;
      }
    } catch {
      // Ignore presence parsing issues.
    }

    try {
      bot.setPresence(Presence.BUSY, busyMsg);
      await invitation.accept();
      bot.client?.setStatus(busyMsg, "online");

      if (bot.timings.postAcceptDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, bot.timings.postAcceptDelayMs));
      }

      // hardcoded restart before applying new patch
      bot.actions.high = true;
      await applyPartyPatch(bot);
      log(bot.accountId, "ok", `In party with ${senderName} → patch applied`);

      bot.clearPartyTimeout();
      bot.currentTimeout =
        bot.client?.setTimeout(() => {
          log(bot.accountId, "warn", "Party timeout → leaving");
          void bot.client?.leaveParty?.().catch(() => undefined);
          bot.currentTimeout = null;
          bot.returnToIdle(idleMsg);
        }, bot.timings.partyAutoLeaveMs) ?? null;
    } catch (error: any) {
      log(
        bot.accountId,
        "error",
        `Error while accepting invite: ${error?.code ?? error?.message ?? String(error)}`,
      );
      bot.setPresence(Presence.ACTIVE, idleMsg);
      bot.reJoinTo = invitation.sender?.id ?? null;
      bot.handleXmppError(error);
    }
  });

  bot.client?.on(
    "party:member:matchstate:updated",
    (member: PartyMemberLike, value: MatchStateLike, prev: MatchStateLike) => {
      void member;
      const from = `${prev?.location}`;
      const to = `${value?.location}`;

      if (from === "PreLobby" && to === "ConnectingToLobby") {
        log(bot.accountId, "ok", `Matchmaking detected → leaving in ${bot.timings.matchstateLeaveDelayMs}ms`);

        bot.client?.setTimeout(async () => {
          await bot.client?.leaveParty?.().catch(() => undefined);
          bot.clearPartyTimeout();
          bot.stats.taxisCompleted++;
          bot.returnToIdle(idleMsg);
          log(bot.accountId, "ok", `Taxi completed #${bot.stats.taxisCompleted}`);
        }, bot.timings.matchstateLeaveDelayMs);
      }
    },
  );

  bot.client?.on("party:member:message", async (message: PartyMessage) => {
    let messageContent = extractPartyMessageText(message.content);
    if (!messageContent.startsWith(PARTY_PREFIX)) return;
    messageContent = messageContent.slice(PARTY_PREFIX.length).trim();
    if (!messageContent) return;

    const [command, subcommand] = messageContent.toLowerCase().split(/\s+/);

    switch (command) {
      case "pl": {
        switch (subcommand) {
          case "min": {
            if (!bot.actions.high) return;
            bot.actions.high = false;
            await applyPartyPatch(bot);
            await bot.client?.party?.chat.send?.("Switched to low stats");
            log(bot.accountId, "info", "Session stats changed to LOW");
            break;
          }

          case "max": {
            if (bot.actions.high) return;

            bot.actions.high = true;
            await applyPartyPatch(bot);
            await bot.client?.party?.chat.send?.("Switched to high stats");
            log(bot.accountId, "info", "Session stats changed to HIGH");
            break;
          }

          default: {
            await bot.client?.party?.chat.send?.(
              `Usage: ${PARTY_PREFIX}pl min | ${PARTY_PREFIX}pl max`,
            );
            break;
          }
        }

        break;
      }
    }
  });
}

function extractPartyMessageText(content: string): string {
  try {
    // Decode base64 -> utf8
    const decoded = Buffer.from(content.trim(), "base64").toString("utf8");

    const cleanedDecoded = decoded.replace(/\0+$/, "").trim();

    const parsed = JSON.parse(cleanedDecoded) as {
      msg?: string;
    };

    return parsed.msg?.trim() ?? content.trim();
  } catch (error) {
    console.log("extractPartyMessageText failed:", error);
    return content.trim();
  }
}