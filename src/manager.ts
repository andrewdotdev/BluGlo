import { BluGo } from "./bot.js";
import { BOT, TIMINGS } from "./config.js";
import { bus, log } from "./events.js";
import { deleteAccount, readAccounts, upsertAccount } from "./store.js";
import type {
  AccountData,
  BotSnapshot,
  EpicDeviceAuthResponse,
  EpicError,
  EpicExchangeCodeResponse,
  EpicTokenResponse,
  PartyLike,
} from "./types.js";

const OAUTH_TOKEN_URL =
  "https://account-public-service-prod.ol.epicgames.com/account/api/oauth/token";
const OAUTH_EXCHANGE_URL =
  "https://account-public-service-prod.ol.epicgames.com/account/api/oauth/exchange";
const DEVICE_AUTH_URL = (accountId: string): string =>
  `https://account-public-service-prod.ol.epicgames.com/account/api/public/account/${accountId}/deviceAuth`;

export class BotManager {
  public readonly bots = new Map<string, BluGo>();

  public loadAll(): void {
    const accounts = readAccounts();
    const count = Object.keys(accounts).length;

    if (count === 0) {
      log(null, "info", "No saved accounts found. Use /add to add one.");
      return;
    }

    log(null, "info", `Loading ${count} account(s)...`);
    for (const data of Object.values(accounts)) {
      this._spawnBot(data);
    }
  }

  public async add_authcode(
    authorizationCode: string,
    actions: AccountData["actions"] = {},
  ): Promise<BluGo | null> {
    try {
      if (typeof authorizationCode !== "string" || !authorizationCode.trim()) {
        log(null, "warn", "Empty or invalid authorization code");
        return null;
      }

      const code = authorizationCode.trim();
      if (!/^[a-f0-9]{32}$/i.test(code)) {
        log(null, "warn", "The authorization code format is invalid");
        return null;
      }

      const authCodeClient = BOT.auth.authorizationCodeClient;
      const deviceAuthClient = BOT.auth.deviceAuthClient;

      if (!authCodeClient.basicToken) {
        log(null, "error", "Missing bot.auth.authorizationCodeClient.basicToken in config.json");
        return null;
      }

      if (!deviceAuthClient.basicToken) {
        log(null, "error", "Missing bot.auth.deviceAuthClient.basicToken in config.json");
        return null;
      }

      log(
        null,
        "info",
        `Exchanging authorization code with ${authCodeClient.name || "PC client"}...`,
      );
      const pcToken = await this._exchangeAuthorizationCode(code);

      const accessToken = pcToken.access_token;
      const accountId = pcToken.account_id;
      const displayName =
        pcToken.displayName || pcToken.display_name || pcToken.account_name || null;

      if (!accessToken) {
        log(null, "error", "Epic did not return access_token");
        return null;
      }

      if (!accountId) {
        log(null, "error", "Epic did not return account_id");
        return null;
      }

      if (this.bots.has(accountId)) {
        log(null, "warn", `Account ${accountId.slice(0, 8)} is already loaded`);
        return this.bots.get(accountId) ?? null;
      }

      const accounts = readAccounts();
      if (accounts[accountId]) {
        log(
          null,
          "warn",
          `Account ${accountId.slice(0, 8)} already exists on disk; starting it...`,
        );
        return this._spawnBot(accounts[accountId]);
      }

      log(null, "info", "Requesting exchange code...");
      const exchangeCode = await this._getExchangeCode(accessToken);

      log(
        null,
        "info",
        `Exchanging exchange code with ${deviceAuthClient.name || "deviceAuth client"}...`,
      );
      const deviceClientToken = await this._exchangeCodeForDeviceClient(exchangeCode);

      const finalAccessToken = deviceClientToken.access_token;
      if (!finalAccessToken) {
        log(null, "error", "Epic did not return access_token del cliente final");
        return null;
      }

      log(null, "info", `Creating device auth for ${displayName || accountId.slice(0, 8)}...`);
      const deviceAuth = await this._createDeviceAuth(accountId, finalAccessToken);

      const deviceId = deviceAuth.deviceId;
      const secret = deviceAuth.secret;

      if (!deviceId) {
        log(null, "error", "Epic did not return deviceId");
        return null;
      }

      if (!secret) {
        log(null, "error", "Epic did not return secret");
        return null;
      }

      const bot = this.add(accountId, deviceId, secret, actions, displayName);

      bus.emit("account:created", {
        accountId,
        displayName,
      });

      log(null, "ok", `Device auth created for ${displayName || accountId.slice(0, 8)}`);
      return bot;
    } catch (error) {
      log(null, "error", `Could not create device auth: ${this._formatEpicError(error)}`);
      return null;
    }
  }

  public add(
    accountId: string,
    deviceId: string,
    secret: string,
    actions: AccountData["actions"] = {},
    displayName: string | null = null,
  ): BluGo {
    if (this.bots.has(accountId)) {
      log(
        null,
        "warn",
        `Account ${accountId.slice(0, 8)} already exists. Use /reload to reconnect it.`,
      );
      return this.bots.get(accountId)!;
    }

    const data: AccountData = { accountId, deviceId, secret, displayName, actions };
    upsertAccount(accountId, data);
    const bot = this._spawnBot(data);
    log(null, "ok", `Account ${accountId.slice(0, 8)} added`);
    return bot;
  }

  public updateDisplayName(accountId: string, displayName: string): boolean {
    if (!displayName.trim()) return false;

    const cleanName = displayName.trim();
    const bot = this.bots.get(accountId);
    const accounts = readAccounts();
    const saved = accounts[accountId];
    let changed = false;

    if (bot && bot.displayName !== cleanName) {
      bot.displayName = cleanName;
      changed = true;
    }

    if (saved && saved.displayName !== cleanName) {
      saved.displayName = cleanName;
      upsertAccount(accountId, saved);
      changed = true;
    }

    if (changed) {
      bus.emit("profile", { accountId, displayName: cleanName });
    }

    return changed;
  }

  public remove(accountId: string): boolean {
    const bot = this.bots.get(accountId);
    if (!bot) {
      log(null, "warn", `Account not found: ${accountId.slice(0, 8)}`);
      return false;
    }

    bot.stop();
    this.bots.delete(accountId);
    deleteAccount(accountId);
    bus.emit("removed", { accountId });
    log(null, "ok", `Account ${accountId.slice(0, 8)} removed`);
    return true;
  }

  public reload(accountId: string): boolean {
    const bot = this.bots.get(accountId);
    if (!bot) {
      log(null, "warn", `Account not found: ${accountId.slice(0, 8)}`);
      return false;
    }

    log(null, "info", `Reloading ${accountId.slice(0, 8)}...`);
    bot.stop();
    setTimeout(() => bot.start(), 300);
    return true;
  }

  public reloadAll(): void {
    log(null, "info", `Reloading ${this.bots.size} bot(s)...`);
    for (const bot of this.bots.values()) {
      bot.stop();
      setTimeout(() => bot.start(), 300);
    }
  }

  public getSnapshot(): BotSnapshot[] {
    return [...this.bots.values()].map((bot) => bot.snapshot);
  }

  public async handleCollision(party: PartyLike, currentBot: BluGo): Promise<boolean> {
    const taxiIds = [...this.bots.keys()];
    const colliding = party.members
      .filter((member) => taxiIds.includes(member.id) && member.id !== currentBot.accountId)
      .map((member) => member.id);

    if (colliding.length === 0) return false;

    log(currentBot.accountId, "warn", "Collision: another taxi is already in the party → leaving");
    await currentBot.client?.leaveParty?.().catch(() => undefined);
    currentBot._returnToIdle(currentBot.actions.idleStatus || currentBot.client?.defaultStatus);
    return true;
  }

  public hasOtherTaxiIn(party: PartyLike | undefined, excludeAccountId: string): boolean {
    const taxiIds = [...this.bots.keys()];
    return (
      party?.members?.some?.(
        (member) => taxiIds.includes(member.id) && member.id !== excludeAccountId,
      ) ?? false
    );
  }

  private _spawnBot(data: AccountData): BluGo {
    const bot = new BluGo(data, this);
    this.bots.set(data.accountId, bot);
    bot.start();
    return bot;
  }

  private async _exchangeAuthorizationCode(authorizationCode: string): Promise<EpicTokenResponse> {
    const body = new URLSearchParams({ grant_type: "authorization_code", code: authorizationCode });

    return this._fetchJson<EpicTokenResponse>(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${BOT.auth.authorizationCodeClient.basicToken}`,
      },
      body: body.toString(),
    });
  }

  private async _getExchangeCode(accessToken: string): Promise<string> {
    const data = await this._fetchJson<EpicExchangeCodeResponse>(OAUTH_EXCHANGE_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!data.code) {
      throw new Error("Epic did not return an exchange code");
    }

    return data.code;
  }

  private async _exchangeCodeForDeviceClient(exchangeCode: string): Promise<EpicTokenResponse> {
    const body = new URLSearchParams({ grant_type: "exchange_code", exchange_code: exchangeCode });

    return this._fetchJson<EpicTokenResponse>(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${BOT.auth.deviceAuthClient.basicToken}`,
      },
      body: body.toString(),
    });
  }

  private async _createDeviceAuth(
    accountId: string,
    accessToken: string,
  ): Promise<EpicDeviceAuthResponse> {
    return this._fetchJson<EpicDeviceAuthResponse>(DEVICE_AUTH_URL(accountId), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
  }

  private async _fetchJson<T>(url: string, options: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeoutMs = Number(TIMINGS.requestTimeoutMs) || 15000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const text = await response.text();
      let data: T | { raw: string } | null = null;

      try {
        data = text ? (JSON.parse(text) as T) : null;
      } catch {
        data = { raw: text };
      }

      if (!response.ok) {
        const payload = data as EpicError["payload"] | null;
        const error = new Error(
          payload?.errorMessage ||
            payload?.message ||
            `HTTP ${response.status} ${response.statusText}`,
        ) as EpicError;
        error.status = response.status;
        error.payload = payload ?? undefined;
        throw error;
      }

      return data as T;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        const timeoutError = new Error(
          `Timeout while contacting Epic (${timeoutMs}ms)`,
        ) as EpicError;
        timeoutError.code = "EPIC_TIMEOUT";
        throw timeoutError;
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private _formatEpicError(error: unknown): string {
    const err = error as EpicError;
    return err?.payload?.errorMessage || err?.payload?.message || err?.message || "Unknown error";
  }
}
