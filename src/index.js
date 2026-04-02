import { BotManager } from './manager.js'
import { startServer } from './server.js'
import { startCLI } from './cli.js'
import { log } from './events.js'

async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  🚕  BluGo STW')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  const manager = new BotManager()

  startServer(manager)
  await manager.loadAll()
  startCLI(manager)

  const shutdown = () => {
    log(null, 'info', 'Shutting down...')
    for (const bot of manager.bots.values()) bot.stop()
    setTimeout(() => process.exit(0), 800)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('uncaughtException', (err) => {
    log(null, 'error', `Uncaught exception: ${err.message}`)
  })
  process.on('unhandledRejection', (reason) => {
    log(null, 'error', `Unhandled rejection: ${reason}`)
  })
}

main()
