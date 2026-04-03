export interface AuthClientConfig {
  name?: string;
  clientId?: string;
  clientSecret?: string;
  basicToken?: string;
}

export interface BotActions {
  high?: boolean;
  denyFriendRequests?: boolean;
  idleStatus?: string;
  busyStatus?: string;
}

export interface AccountData {
  accountId: string;
  deviceId: string;
  secret: string;
  displayName?: string | null;
  actions?: BotActions;
}

export type AccountsStore = Record<string, AccountData>;

export interface BotStats {
  taxisCompleted: number;
  invitesDeclined: number;
  totalUptime: number;
  connectedAt: number | null;
}

export interface BotSnapshot {
  accountId: string;
  shortId: string;
  displayName: string | null;
  presence: string;
  status: string;
  retryCount: number;
  stats: BotStats;
  actions: Required<BotActions>;
}

export interface ConfigShape {
  bot?: {
    status?: {
      idle?: string;
      busy?: string;
    };
    party?: {
      maxSize?: number;
    };
    features?: {
      fortStatsHigh?: boolean;
      denyFriendRequests?: boolean;
    };
    auth?: {
      fnbrClient?: string;
      authorizationCodeClient?: AuthClientConfig;
      deviceAuthClient?: AuthClientConfig;
    };
    timings?: Record<string, number>;
    reconnect?: Record<string, number>;
  };
  dashboard?: {
    port?: number;
    host?: string;
    title?: string;
  };
  dataFile?: string;
}

export interface EpicTokenResponse {
  access_token?: string;
  account_id?: string;
  displayName?: string;
  display_name?: string;
  account_name?: string;
}

export interface EpicExchangeCodeResponse {
  code?: string;
}

export interface EpicDeviceAuthResponse {
  deviceId?: string;
  secret?: string;
}

export interface EpicErrorPayload {
  errorMessage?: string;
  message?: string;
  raw?: string;
}

export interface EpicError extends Error {
  status?: number;
  payload?: EpicErrorPayload;
  code?: string;
}

export interface PartyMemberLike {
  id: string;
  displayName?: string;
  isLeader?: boolean;
  party: PartyLike;
}

export interface PartyMembersCollection extends Iterable<PartyMemberLike> {
  size: number;
  first?: () => PartyMemberLike | undefined;
  map: <T>(callback: (member: PartyMemberLike) => T) => T[];
  filter: (callback: (member: PartyMemberLike) => boolean) => PartyMemberLike[];
  some?: (callback: (member: PartyMemberLike) => boolean) => boolean;
}

export interface PartyLike {
  members: PartyMembersCollection;
  meta?: {
    schema?: Record<string, string>;
  };
}

export interface FriendLike {
  id: string;
  displayName?: string;
  direction?: string;
  decline?: () => Promise<unknown>;
  accept?: () => Promise<unknown>;
  sendJoinRequest?: () => Promise<unknown>;
  presence?: {
    isPlaying?: boolean;
    sessionId?: string;
  };
}

export interface PartyInvitationLike {
  sender?: FriendLike;
  party?: PartyLike;
  accept: () => Promise<unknown>;
  decline?: () => Promise<unknown>;
}

export interface MatchStateLike {
  location?: string;
}
