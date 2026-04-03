import { startCLI } from "./cli.js";
import { log } from "./events.js";
import { BotManager } from "./manager.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  🚕  BluGo STW");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const manager = new BotManager();

  startServer(manager);
  manager.loadAll();
  startCLI(manager);

  const shutdown = (): void => {
    log(null, "info", "Shutting down...");
    for (const bot of manager.bots.values()) {
      bot.stop();
    }
    setTimeout(() => process.exit(0), 800);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("uncaughtException", (error) => {
    log(null, "error", `Uncaught exception: ${error.message}`);
  });
  process.on("unhandledRejection", (reason) => {
    log(null, "error", `Unhandled rejection: ${String(reason)}`);
  });
}

void main();
