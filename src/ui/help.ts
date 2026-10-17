import type { KeyBindings } from "../keybindings"
import { formatKeybinding } from "../keybindings"
import { logger } from "../utils/logger"

/**
 * Render the "?" help overlay.
 *
 * The text is printed straight to the console (outside OpenTUI) exactly as it
 * always was — including the `padEnd(10)` columns — so the output stays
 * byte-identical.
 */
export function showHelp(keybindings: KeyBindings): void {
  const helpLines = [
    "╭─────────────── WhatsApp TUI Help ───────────────╮",
    "│                                                 │",
    "│  Navigation                                     │",
    "│  ───────────                                    │",
    "│  Tab        Switch between chat list and input  │",
    "│  ↑ / ↓      Navigate chat list                  │",
    "│  1-9        Quick select chat by number         │",
    "│  Enter      Select chat / Send message          │",
    "│  Escape     Return to chat list                 │",
    "│                                                 │",
    "│  Actions (configurable in Settings > Keybinds)  │",
    "│  ───────                                        │",
    `│  ${formatKeybinding(keybindings.settings).padEnd(10)} Open Settings                       │`,
    `│  ${formatKeybinding(keybindings.refreshChats).padEnd(10)} Refresh chats                       │`,
    `│  ${formatKeybinding(keybindings.pinChat).padEnd(10)} Pin/Unpin chat                      │`,
    `│  ${formatKeybinding(keybindings.muteChat).padEnd(10)} Mute/Unmute chat                    │`,
    `│  ${formatKeybinding(keybindings.archiveChat).padEnd(10)} Archive chat                        │`,
    `│  ${formatKeybinding(keybindings.quit).padEnd(10)} Quit application                    │`,
    "│                                                 │",
    "│  Press any key to close this help               │",
    "╰─────────────────────────────────────────────────╯",
  ]
  console.clear()
  console.log("\n".repeat(3))
  helpLines.forEach((line) => console.log("  " + line))
  console.log("\n  Press any key to continue...")
  logger.debug("App", "Help screen shown")
}
