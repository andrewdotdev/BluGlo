import { bus, log } from "../../events.js";
import type { BluGlo } from "../../bot.js";
import type { PartyInvitationLike } from "../../types.js";

/**
 * Registers friend-related handlers.
 *
 * @see https://fnbr.js.org
 * @see https://github.com/fnbrjs/fnbr.js
 */
export function registerSocialHandlers(bot: BluGlo): void {
  bot.client?.on(
    "friend:request",
    (
      incoming: PartyInvitationLike["sender"] & {
        accept?: () => Promise<unknown>;
      },
    ) => {
      if (!incoming) return;

      if (bot.actions.denyFriendRequests) {
        void incoming.decline?.().catch(() => undefined);
        log(bot.accountId, "info", `Declined friend request from ${incoming.displayName}`);
        return;
      }

      void incoming.accept?.().catch(() => undefined);
      log(bot.accountId, "info", `Accepted friend request from ${incoming.displayName}`);
    },
  );

  bot.client?.on("friend:added", (friend: { id: string; displayName?: string }) => {
    log(bot.accountId, "info", `New friend: ${friend.displayName}`);
    bus.emit("friend", {
      accountId: bot.accountId,
      friendId: friend.id,
      displayName: friend.displayName,
    });
  });
}
