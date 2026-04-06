import { BOT } from "../../config.js";
import { log } from "../../events.js";
import { Presence } from "../constants.js";
import type { BluGlo } from "../../bot.js";
import type { PartyMemberLike } from "../../types.js";

/**
 * Registers lifecycle and connection handlers.
 *
 * @see https://fnbr.js.org
 * @see https://github.com/fnbrjs/fnbr.js
 */
export function registerLifecycleHandlers(bot: BluGlo, idleMsg: string): void {
  const initTimer = setTimeout(() => {
    log(bot.accountId, "error", "Startup timeout reached");
    bot.setPresence(Presence.OFFLINE, "Startup timeout");
    bot.scheduleReconnect();
  }, bot.timings.initTimeoutMs);

  bot.client?.once("ready", () => {
    clearTimeout(initTimer);
    bot.retryCount = 0;
    bot.stats.connectedAt = Date.now();
    bot.setPresence(Presence.ACTIVE, idleMsg);
    bot.startKeepalive();
    log(bot.accountId, "ok", "Connected and ready");

    const resolvedDisplayName =
      bot.client?.user?.self?.displayName ||
      bot.client?.user?.displayName ||
      bot.displayName ||
      null;

    if (resolvedDisplayName && resolvedDisplayName !== bot.displayName) {
      bot.displayName = resolvedDisplayName;
      bot.manager?.updateDisplayName(bot.accountId, resolvedDisplayName);
    }

    if (bot.actions.denyFriendRequests) {
      const pendingList = bot.client?.friend?.pendingList as any;
      const pending = pendingList?.filter?.((friend: any) => friend.direction === "INCOMING") ?? [];
      const pendingArray = Array.isArray(pending)
        ? pending
        : Array.from((pending?.values?.() ?? pending) as Iterable<any>);

      for (const friend of pendingArray) {
        void friend.decline?.().catch(() => undefined);
      }

      if (pendingArray.length > 0) {
        log(bot.accountId, "info", `Declined ${pendingArray.length} pending friend request(s)`);
      }
    }

    if (bot.reJoinTo) {
      const friend = bot.client?.friend?.resolve?.(bot.reJoinTo);
      void friend?.sendJoinRequest?.().catch(() => undefined);
      log(bot.accountId, "info", `Retrying join to ${bot.reJoinTo.slice(0, 8)}`);
      bot.reJoinTo = null;
    }
  });

  bot.client?.on("disconnected", () => bot.handleDisconnect());
  bot.client?.on("xmpp:message:error", (error: unknown) => bot.handleXmppError(error));

  bot.client?.on("party:member:disconnected", (member: PartyMemberLike) => {
    if (member.id === bot.accountId) bot.handleDisconnect();
  });

  bot.client?.on("party:member:expired", (member: PartyMemberLike) => {
    if (member.id === bot.accountId) bot.handleDisconnect();
  });

  bot.client?.on("party:member:kicked", (member: PartyMemberLike) => {
    if (member.id === bot.accountId) bot.returnToIdle(idleMsg);
  });

  bot.client?.on("party:member:left", (member: PartyMemberLike) => {
    const alone = member.party.members.size === 1 && member.party.members.first?.()?.id === bot.accountId;

    if (member.id === bot.accountId || alone) {
      bot.returnToIdle(idleMsg || BOT.idleStatus);
    }
  });

  bot.client?.on("party:member:disconnected", (member: PartyMemberLike) => {
    const alone = member.party.members.size === 1 && member.party.members.first?.()?.id === bot.accountId;

    if (member.id === bot.accountId || alone) {
      bot.returnToIdle(idleMsg || BOT.idleStatus);
    }
  });

  bot.client?.login().catch((error: Error) => {
    log(bot.accountId, "error", `Login error: ${error?.message}`);
    clearTimeout(initTimer);
    bot.setPresence(Presence.OFFLINE, "Login error");
    bot.scheduleReconnect();
  });
}
