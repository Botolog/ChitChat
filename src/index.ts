import { existsSync, rmSync } from "node:fs"
import { logger } from "./utils/logger"
import { resolveDataPath } from "./utils/paths"
import { bootstrap } from "./app/bootstrap"

const DEMO_MODE = process.argv.includes("--demo")

/**
 * `--reset-whatsapp`: wipe the persisted WhatsApp profile and exit.
 *
 * The profile (`CHITCHAT_DATA_DIR/.wwebjs_auth`) is a real Chromium user-data
 * dir. It survives upgrades and is shared between snap revisions, so it can end
 * up holding a stale WhatsApp Web service worker / HTTP cache — which makes the
 * page boot but never connect ("no QR, no ready"). Deleting it forces a clean
 * re-link (you have to scan the QR again).
 */
const RESET_WHATSAPP = process.argv.includes("--reset-whatsapp")

if (RESET_WHATSAPP) {
  const targets = [".wwebjs_auth", ".wwebjs_cache"].map((name) => resolveDataPath(name))
  for (const target of targets) {
    const existed = existsSync(target)
    rmSync(target, { recursive: true, force: true })
    console.log(`${existed ? "Removed" : "Nothing to remove at"} ${target}`)
  }
  console.log("\nWhatsApp session cleared. Start ChitChat again and scan the QR code to re-link.")
  process.exit(0)
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                        ChitChat v0.0.1                        ║
║          Universal Terminal Messaging Client (TUI)            ║
╚═══════════════════════════════════════════════════════════════╝

USAGE:
  chitchat [OPTIONS]

OPTIONS:
  --demo             Run in demo mode (no real connections)
  --reset-whatsapp   Delete the saved WhatsApp session and exit (re-link QR)
  --help, -h         Show this help message and exit

DESCRIPTION:
  ChitChat is a terminal-based messaging client that supports
  multiple messaging platforms including WhatsApp and Slack.

FEATURES:
  • Clean TUI interface built with OpenTUI
  • Multi-service support (WhatsApp, Slack)
  • Media support (images, documents, audio)
  • QR code authentication for WhatsApp
  • Real-time message synchronization

KEYBOARD SHORTCUTS:
  ↑↓              Navigate chats/messages
  Enter           Select chat or send message
  Tab             Switch focus between panels
  ?               Toggle help overlay
  F2              Open settings
  Ctrl+P          Pin/unpin chat
  Ctrl+M          Mute/unmute chat
  Ctrl+A          Archive/unarchive chat
  Ctrl+R          Refresh chat list
  Ctrl+Q          Quit application

GETTING STARTED:
  1. Run 'chitchat' to start the application
  2. Select a messaging service from the main menu
  3. Follow authentication prompts (QR code for WhatsApp)
  4. Start messaging!

EXAMPLES:
  chitchat                    # Start normally
  chitchat --demo             # Run in demo mode for testing
  chitchat --reset-whatsapp   # Clear the WhatsApp session and re-link

For more information, visit:
  https://github.com/Botolog/ChitChat

Report issues at:
  https://github.com/Botolog/ChitChat/issues
`)
  process.exit(0)
}

logger.info("App", "Starting ChatClient", { demoMode: DEMO_MODE, args: process.argv })

bootstrap().catch((err) => {
  logger.error("App", "bootstrap() FATAL CRASH", err)
  console.error("FATAL:", err)
  process.exit(1)
})
