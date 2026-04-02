import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const configPath = resolve(__dirname, '../config.json')

let raw
try {
  raw = readFileSync(configPath, 'utf8')
} catch (err) {
  console.error('[config] config.json was not found:', err.message)
  process.exit(1)
}

export const config = JSON.parse(raw)

const bot = config.bot ?? {}
const status = bot.status ?? {}
const party = bot.party ?? {}
const features = bot.features ?? {}
const auth = bot.auth ?? {}
const timings = bot.timings ?? {}
const reconnect = bot.reconnect ?? {}

export const BOT = {
  idleStatus: status.idle ?? 'Available 🚕',
  busyStatus: status.busy ?? 'Busy 🔒',
  partyMaxSize: party.maxSize ?? 4,
  fortStatsHigh: features.fortStatsHigh ?? true,
  denyFriendRequests: features.denyFriendRequests ?? false,
  authClient: auth.fnbrClient ?? 'fortniteAndroidGameClient',
  auth: {
    authorizationCodeClient: auth.authorizationCodeClient ?? {},
    deviceAuthClient: auth.deviceAuthClient ?? {},
  },
}

export const DASH = config.dashboard ?? {}
export const TIMINGS = timings
export const RECONNECT = reconnect
export const DATA_FILE = config.dataFile
