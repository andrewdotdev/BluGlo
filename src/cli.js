import * as readline from 'readline'
import { log } from './events.js'
import { Presence } from './bot.js'
import { BOT } from './config.js'

const HELP = `
Commands:
  /add [authorizationCode]                           — Add and start a new bot
  /add:device_auth <accountId> <deviceId> <secret>  — Add and start a bot manually
  /remove <accountId>                                — Stop and remove a bot
  /reload <accountId>                                — Reconnect one bot
  /reload all                                        — Reconnect all bots
  /list                                              — List bots and states
  /stats                                             — Show bot statistics
  /help                                              — Show this help
  /exit                                              — Stop everything and exit

Docs:
  fnbr          https://fnbr.js.org
  fnbr repo     https://github.com/fnbrjs/fnbr.js
  EpicResearch  https://github.com/MixV2/EpicResearch
`

export function startCLI(manager) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'taxi> ',
    terminal: true,
  })

  console.log('\n✔ CLI ready. Type /help to see commands.\n')
  rl.prompt()

  rl.on('line', async (line) => {
    const trimmed = line.trim()
    if (!trimmed) { rl.prompt(); return }

    const [cmd, ...args] = trimmed.split(/\s+/)

    switch (cmd.toLowerCase()) {
      case '/add': {
        let authInput = args.join(' ').trim()

        if (!authInput) {
          const authUrl = _getAuthorizationCodeUrl()

          console.log('\nTo add a new account:')
          console.log('1) Open this link in your browser and sign in with the Epic/Fortnite account:')
          console.log(`\n${authUrl}\n`)
          console.log('2) Copy only the code value from the final URL, or paste the full URL.')
          console.log('3) Paste it below.\n')
          console.log('Docs:')
          console.log('  fnbr: https://fnbr.js.org')
          console.log('  EpicResearch auth code: https://github.com/MixV2/EpicResearch/blob/master/docs/auth/grant_types/authorization_code.md')
          console.log('  EpicResearch exchange code: https://github.com/MixV2/EpicResearch/blob/master/docs/auth/grant_types/exchange_code.md\n')

          authInput = (await _question(rl, 'authorizationCode> ')).trim()

          if (!authInput) {
            console.log('Operation cancelled: no authorization code was provided.')
            break
          }
        }

        try {
          const authorizationCode = _extractAuthorizationCode(authInput)

          if (!authorizationCode) {
            console.log('Could not extract a valid authorization code.')
            console.log('Paste the raw code or a full URL containing ?code=...')
            break
          }

          await manager.add_authcode(authorizationCode)
        } catch (err) {
          log(null, 'error', `Error in /add: ${err?.message || err}`)
        }

        break
      }

      case '/add:device_auth': {
        if (args.length < 3) {
          console.log('Usage: /add:device_auth <accountId> <deviceId> <secret>')
          break
        }
        const [accountId, deviceId, secret] = args
        manager.add(accountId, deviceId, secret)
        break
      }

      case '/remove': {
        if (!args[0]) { console.log('Usage: /remove <accountId>'); break }
        manager.remove(_resolve(manager, args[0]))
        break
      }

      case '/reload': {
        if (!args[0] || args[0] === 'all') {
          manager.reloadAll()
        } else {
          manager.reload(_resolve(manager, args[0]))
        }
        break
      }

      case '/list': {
        const bots = [...manager.bots.values()]
        if (bots.length === 0) {
          console.log('  No active bots.')
          break
        }
        const icon = {
          [Presence.ACTIVE]: '🟢',
          [Presence.BUSY]: '🟡',
          [Presence.OFFLINE]: '🔴',
          [Presence.LOADING]: '⚪',
        }
        console.log('')
        bots.forEach((bot) => {
          const currentIcon = icon[bot.presence] ?? '❓'
          console.log(`  ${currentIcon} ${bot.accountId.slice(0, 8)}...  ${bot.status}`)
        })
        console.log('')
        break
      }

      case '/stats': {
        const bots = [...manager.bots.values()]
        if (bots.length === 0) { console.log('  No bots.'); break }
        console.log('')
        bots.forEach((bot) => {
          const uptime = bot.stats.connectedAt
            ? Math.floor((Date.now() - bot.stats.connectedAt) / 1000)
            : 0
          console.log(
            `  ${bot.accountId.slice(0, 8)}... | taxis: ${bot.stats.taxisCompleted} | declined: ${bot.stats.invitesDeclined} | uptime: ${uptime}s | retries: ${bot.retryCount}`,
          )
        })
        console.log('')
        break
      }

      case '/help':
        console.log(HELP)
        break

      case '/exit':
        console.log('\nStopping bots...')
        for (const bot of manager.bots.values()) bot.stop()
        setTimeout(() => process.exit(0), 500)
        break

      default:
        console.log(`Unknown command: ${cmd}. Type /help`)
    }

    rl.prompt()
  })

  rl.on('close', () => {
    console.log('\nCLI closed. The server is still running.')
  })
}

function _resolve(manager, input) {
  if (input.length === 36) return input
  for (const id of manager.bots.keys()) {
    if (id.startsWith(input)) return id
  }
  return input
}

function _getAuthorizationCodeUrl() {
  const clientId = BOT.auth.authorizationCodeClient?.clientId || 'ec684b8c687f479fadea3cb2ad83f5c6'
  return `https://www.epicgames.com/id/api/redirect?clientId=${clientId}&responseType=code`
}

function _extractAuthorizationCode(input) {
  const value = input.trim()
  if (!value) return null
  if (/^[a-f0-9]{32}$/i.test(value)) return value

  if (value.includes('?code=')) {
    try {
      const url = new URL(value)
      const code = url.searchParams.get('code')
      if (code?.trim()) return code.trim()
    } catch {}
  }

  if (value.startsWith('{') && value.endsWith('}')) {
    try {
      const data = JSON.parse(value)
      const code = data?.authorizationCode || data?.code
      if (typeof code === 'string' && code.trim()) return code.trim()
    } catch {}
  }

  return null
}

function _question(rl, text) {
  return new Promise((resolve) => {
    rl.question(text, resolve)
  })
}
