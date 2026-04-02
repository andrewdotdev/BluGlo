import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { DATA_FILE } from './config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dataPath = resolve(__dirname, '..', DATA_FILE)
const dataDir = resolve(dataPath, '..')

if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true })
}

export function readAccounts() {
  if (!existsSync(dataPath)) return {}
  try {
    return JSON.parse(readFileSync(dataPath, 'utf8'))
  } catch {
    return {}
  }
}

export function writeAccounts(accounts) {
  writeFileSync(dataPath, JSON.stringify(accounts, null, 2), 'utf8')
}

export function upsertAccount(accountId, data) {
  const all = readAccounts()
  all[accountId] = data
  writeAccounts(all)
}

export function deleteAccount(accountId) {
  const all = readAccounts()
  delete all[accountId]
  writeAccounts(all)
}
