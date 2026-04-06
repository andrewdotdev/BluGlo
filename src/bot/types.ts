import { Client } from "fnbr";

/**
 * Narrow local client shape used by this project.
 * It keeps the codebase typed without needing to model the full fnbr.js surface.
 *
 * @see https://fnbr.js.org
 * @see https://github.com/fnbrjs/fnbr.js
 */
export type FnbrClient = InstanceType<typeof Client> & {
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
      setEmote?: (emoteId: string) => Promise<unknown>;
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
