import { EventEmitter } from 'events'

export const bus = new EventEmitter()
bus.setMaxListeners(100)

export function log(accountId, level, message) {
  const ts = new Date().toISOString()
  const tag = accountId ? `[${accountId.slice(0, 8)}]` : '[system]'
  const prefix = { info: '  ', warn: '⚠ ', error: '✖ ', ok: '✔ ' }[level] ?? '  '

  console.log(`${prefix}${tag} ${message}`)
  bus.emit('log', { accountId, level, message, ts })
}
