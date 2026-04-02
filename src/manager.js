import { BluGo } from './bot.js'
import { bus, log } from './events.js'
import { readAccounts, upsertAccount, deleteAccount } from './store.js'
import { BOT, TIMINGS } from './config.js'

const OAUTH_TOKEN_URL = 'https://account-public-service-prod.ol.epicgames.com/account/api/oauth/token'
const OAUTH_EXCHANGE_URL = 'https://account-public-service-prod.ol.epicgames.com/account/api/oauth/exchange'
const DEVICE_AUTH_URL = (accountId) =>
  `https://account-public-service-prod.ol.epicgames.com/account/api/public/account/${accountId}/deviceAuth`

export class BotManager {
  constructor() {
    /** @type {Map<string, BluGo>} */
    this.bots = new Map()
  }

  /** Load all saved accounts from disk and start the bots. */
  async loadAll() {
    const accounts = readAccounts()
    const count = Object.keys(accounts).length

    if (count === 0) {
      log(null, 'info', 'No saved accounts found. Use /add to add one.')
      return
    }

    log(null, 'info', `Loading ${count} account(s)...`)
    for (const data of Object.values(accounts)) {
      this._spawnBot(data)
    }
  }

  /**
   * Add an account from an authorization code.
   * Flow:
   * 1) PC authorization-code token
   * 2) exchange code
   * 3) final client token (Android/iOS)
   * 4) create device auth
   *
   * @param {string} authorizationCode
   * @param {object} [actions]
   * @returns {Promise<BluGo|null>}
   */
  async add_authcode(authorizationCode, actions = {}) {
    try {
      if (typeof authorizationCode !== 'string' || !authorizationCode.trim()) {
        log(null, 'warn', 'Empty or invalid authorization code')
        return null
      }

      const code = authorizationCode.trim()

      if (!/^[a-f0-9]{32}$/i.test(code)) {
        log(null, 'warn', 'The authorization code format is invalid')
        return null
      }

      const authCodeClient = BOT.auth.authorizationCodeClient
      const deviceAuthClient = BOT.auth.deviceAuthClient

      if (!authCodeClient?.basicToken) {
        log(null, 'error', 'Missing bot.auth.authorizationCodeClient.basicToken in config.json')
        return null
      }

      if (!deviceAuthClient?.basicToken) {
        log(null, 'error', 'Missing bot.auth.deviceAuthClient.basicToken in config.json')
        return null
      }

      log(null, 'info', `Exchanging authorization code with ${authCodeClient.name || 'PC client'}...`)
      const pcToken = await this._exchangeAuthorizationCode(code)

      const accessToken = pcToken?.access_token
      const accountId = pcToken?.account_id
      const displayName =
        pcToken?.displayName ||
        pcToken?.display_name ||
        pcToken?.account_name ||
        null

      if (!accessToken || typeof accessToken !== 'string') {
        log(null, 'error', 'Epic did not return access_token')
        return null
      }

      if (!accountId || typeof accountId !== 'string') {
        log(null, 'error', 'Epic did not return account_id')
        return null
      }

      if (this.bots.has(accountId)) {
        log(null, 'warn', `Account ${accountId.slice(0, 8)} is already loaded`)
        return this.bots.get(accountId) ?? null
      }

      const accounts = readAccounts()
      if (accounts[accountId]) {
        log(null, 'warn', `Account ${accountId.slice(0, 8)} already exists on disk; starting it...`)
        return this._spawnBot(accounts[accountId])
      }

      log(null, 'info', 'Requesting exchange code...')
      const exchangeCode = await this._getExchangeCode(accessToken)

      log(
        null,
        'info',
        `Exchanging exchange code with ${deviceAuthClient.name || 'deviceAuth client'}...`,
      )
      const deviceClientToken = await this._exchangeCodeForDeviceClient(exchangeCode)

      const finalAccessToken = deviceClientToken?.access_token
      if (!finalAccessToken || typeof finalAccessToken !== 'string') {
        log(null, 'error', 'Epic did not return access_token del cliente final')
        return null
      }

      log(null, 'info', `Creating device auth for ${displayName || accountId.slice(0, 8)}...`)
      const deviceAuth = await this._createDeviceAuth(accountId, finalAccessToken)

      const deviceId = deviceAuth?.deviceId
      const secret = deviceAuth?.secret

      if (!deviceId || typeof deviceId !== 'string') {
        log(null, 'error', 'Epic did not return deviceId')
        return null
      }

      if (!secret || typeof secret !== 'string') {
        log(null, 'error', 'Epic did not return secret')
        return null
      }

      const bot = this.add(accountId, deviceId, secret, actions, displayName)

      bus.emit('account:created', {
        accountId,
        displayName,
      })

      log(null, 'ok', `Device auth created for ${displayName || accountId.slice(0, 8)}`)
      return bot
    } catch (err) {
      log(null, 'error', `Could not create device auth: ${this._formatEpicError(err)}`)
      return null
    }
  }

  /**
   * Add a new account, persist it, and start the bot.
   * @param {string} accountId
   * @param {string} deviceId
   * @param {string} secret
   * @param {object} [actions]
   * @returns {BluGo}
   */
  add(accountId, deviceId, secret, actions = {}, displayName = null) {
    if (this.bots.has(accountId)) {
      log(null, 'warn', `Account ${accountId.slice(0,8)} already exists. Use /reload to reconnect it.`)
      return this.bots.get(accountId)
    }

    const data = { accountId, deviceId, secret, displayName, actions }
    upsertAccount(accountId, data)
    const bot = this._spawnBot(data)
    log(null, 'ok', `Account ${accountId.slice(0,8)} added`)
    return bot
  }

  updateDisplayName(accountId, displayName) {
    if (typeof displayName !== 'string' || !displayName.trim()) return false

    const cleanName = displayName.trim()
    const bot = this.bots.get(accountId)
    const accounts = readAccounts()
    const saved = accounts[accountId]

    let changed = false

    if (bot && bot.displayName !== cleanName) {
      bot.displayName = cleanName
      changed = true
    }

    if (saved && saved.displayName !== cleanName) {
      saved.displayName = cleanName
      upsertAccount(accountId, saved)
      changed = true
    }

    if (changed) {
      bus.emit('profile', { accountId, displayName: cleanName })
    }

    return changed
  }

  /**
   * Stop and remove a bot.
   * @param {string} accountId
   */
  remove(accountId) {
    const bot = this.bots.get(accountId)
    if (!bot) {
      log(null, 'warn', `Account not found: ${accountId.slice(0,8)}`)
      return false
    }
    bot.stop()
    this.bots.delete(accountId)
    deleteAccount(accountId)
    bus.emit('removed', { accountId })
    log(null, 'ok', `Account ${accountId.slice(0,8)} removed`)
    return true
  }

  /**
   * Reload one specific bot.
   * @param {string} accountId
   */
  reload(accountId) {
    const bot = this.bots.get(accountId)
    if (!bot) {
      log(null, 'warn', `Account not found: ${accountId.slice(0,8)}`)
      return false
    }
    log(null, 'info', `Reloading ${accountId.slice(0,8)}...`)
    bot.stop()
    setTimeout(() => bot.start(), 300)
    return true
  }

  /** Reload all bots. */
  reloadAll() {
    log(null, 'info', `Reloading ${this.bots.size} bot(s)...`)
    for (const bot of this.bots.values()) {
      bot.stop()
      setTimeout(() => bot.start(), 300)
    }
  }

  /** Return the current snapshot for new SSE clients. */
  getSnapshot() {
    return [...this.bots.values()].map((b) => b.snapshot)
  }

  /**
   * If more than one taxi bot is in the same party, make the current bot leave.
   * @param {object} party
   * @param {BluGo} currentBot
   * @returns {Promise<boolean>}
   */
  async handleCollision(party, currentBot) {
    const taxiIds = [...this.bots.keys()]
    const colliding = party.members
      .filter((m) => taxiIds.includes(m.id) && m.id !== currentBot.accountId)
      .map((m) => m.id)

    if (colliding.length === 0) return false

    log(currentBot.accountId, 'warn', 'Collision: another taxi is already in the party → leaving')
    await currentBot.client?.leaveParty?.().catch(() => {})
    currentBot._returnToIdle(currentBot.actions.idleStatus || currentBot.client?.defaultStatus)
    return true
  }

  /**
   * Check whether another taxi is already in the invite party.
   * @param {object} party
   * @param {string} excludeAccountId
   */
  hasOtherTaxiIn(party, excludeAccountId) {
    const taxiIds = [...this.bots.keys()]
    return party?.members?.some(
      (m) => taxiIds.includes(m.id) && m.id !== excludeAccountId,
    ) ?? false
  }

  _spawnBot(data) {
    const bot = new BluGo(data, this)
    this.bots.set(data.accountId, bot)
    bot.start()
    return bot
  }

  /**
   * @param {string} authorizationCode
   * @returns {Promise<any>}
   */
  async _exchangeAuthorizationCode(authorizationCode) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorizationCode,
    })

    return this._fetchJson(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${BOT.auth.authorizationCodeClient.basicToken}`,
      },
      body: body.toString(),
    })
  }

  /**
   * @param {string} accessToken
   * @returns {Promise<string>}
   */
  async _getExchangeCode(accessToken) {
    const data = await this._fetchJson(OAUTH_EXCHANGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })

    const code = data?.code
    if (!code || typeof code !== 'string') {
      throw new Error('Epic did not return an exchange code')
    }

    return code
  }

  /**
   * @param {string} exchangeCode
   * @returns {Promise<any>}
   */
  async _exchangeCodeForDeviceClient(exchangeCode) {
    const body = new URLSearchParams({
      grant_type: 'exchange_code',
      exchange_code: exchangeCode,
    })

    return this._fetchJson(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${BOT.auth.deviceAuthClient.basicToken}`,
      },
      body: body.toString(),
    })
  }

  /**
   * @param {string} accountId
   * @param {string} accessToken
   * @returns {Promise<any>}
   */
  async _createDeviceAuth(accountId, accessToken) {
    return this._fetchJson(DEVICE_AUTH_URL(accountId), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
  }

  /**
   * @param {string} url
   * @param {RequestInit} options
   * @returns {Promise<any>}
   */
  async _fetchJson(url, options) {
    const controller = new AbortController()
    const timeoutMs = Number(TIMINGS.requestTimeoutMs) || 15000
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      })

      const text = await response.text()
      let data = null

      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = { raw: text }
      }

      if (!response.ok) {
        const err = new Error(
          data?.errorMessage ||
          data?.message ||
          `HTTP ${response.status} ${response.statusText}`,
        )
        err.status = response.status
        err.payload = data
        throw err
      }

      return data
    } catch (err) {
      if (err?.name === 'AbortError') {
        const timeoutErr = new Error(`Timeout while contacting Epic (${timeoutMs}ms)`)
        timeoutErr.code = 'EPIC_TIMEOUT'
        throw timeoutErr
      }
      throw err
    } finally {
      clearTimeout(timeout)
    }
  }

  /**
   * @param {any} err
   * @returns {string}
   */
  _formatEpicError(err) {
    return (
      err?.payload?.errorMessage ||
      err?.payload?.message ||
      err?.message ||
      'Unknown error'
    )
  }
}