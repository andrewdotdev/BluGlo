/**
 * High-level runtime presence shown in the dashboard and CLI.
 *
 * @see https://fnbr.js.org
 * @see https://github.com/fnbrjs/fnbr.js
 */
export const Presence = {
  ACTIVE: "active",
  BUSY: "busy",
  OFFLINE: "offline",
  LOADING: "loading",
} as const;

/**
 * Save the World matchmaking states used by Fortnite party metadata.
 *
 * @see https://github.com/MixV2/EpicResearch
 */
export const MatchmakingState = {
  NOT_MATCHMAKING: "NotMatchmaking",
  FINDING_EMPTY_SERVER: "FindingEmptyServer",
  JOINING_SESSION: "JoiningExistingSession",
  TESTING_SERVERS: "TestingEmptyServers",
} as const;

export const FORT_HIGH = 92765;
export const FORT_LOW = 0;
export const PARTY_PREFIX = "?";

export type PresenceValue = (typeof Presence)[keyof typeof Presence];
