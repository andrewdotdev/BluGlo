import { FORT_HIGH, FORT_LOW } from "./constants.js";
import type { BluGlo } from "../bot.js";

/**
 * Applies the STW stat and cosmetic patch after the bot joins a party.
 *
 * @see https://fnbr.js.org
 * @see https://github.com/fnbrjs/fnbr.js
 */
export async function applyPartyPatch(bot: BluGlo): Promise<void> {
  const stat = bot.actions.high ? FORT_HIGH : FORT_LOW;

  const schema = bot.client?.party?.me?.meta?.schema ?? {};
  const mpLoadout1 = (() => {
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

  // Keep the parsed value available for future cosmetics logic without removing the current behavior.
  void mpLoadout1;

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

  if (bot.actions.high) {
    patch["Default:CampaignCommanderLoadoutRating_d"] = "999.00";
    patch["Default:CampaignBackpackRating_d"] = "999.000000";
  }

  await bot.client?.party?.me?.sendPatch?.(patch);

  setTimeout(() => {
    void bot.client?.party?.me?.setEmote?.("EID_Hype").catch(() => undefined);
  }, 1000);
}
