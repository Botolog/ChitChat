import type { KeyEvent } from "@opentui/core"
import type { AppContext } from "../app/context"
import { matchesKeybinding } from "../keybindings"
import { logger } from "../utils/logger"
import { showHelp } from "../ui/help"
import { handleKeyCapture, handleSettingsNavigation, handleSettingsToggle } from "../ui/settingsView"
import { handleMainMenuNavigation } from "../app/views"
import {
  handleEscape,
  handleEscapeToMainMenu,
  handleInputNavigation,
  handleTab,
} from "./navigation"
import { handleMessageNavigation } from "./messageActions"
import {
  handleArchive,
  handleChatListNavigation,
  handleMute,
  handlePin,
  handleQuickSelect,
  handleRefresh,
} from "./chatActions"

/**
 * The single keypress router.
 *
 * PRECEDENCE (must not change):
 *  1. key-capture
 *  2. confirm modal
 *  3. QR modal
 *  4. input navigation
 *  5. message navigation
 *  6. quit
 *  7. main menu
 *  8. escape-to-menu → settings toggle → settings navigation
 *  9. tab
 * 10. chat-list navigation
 * 11. quick-select
 * 12. escape
 * 13. help
 * 14. refresh
 * 15. pin
 * 16. mute
 * 17. archive
 */
export function createKeyHandler(ctx: AppContext): (key: KeyEvent) => Promise<void> {
  return async (key: KeyEvent): Promise<void> => {
    const state = ctx.state

    logger.debug("Keyboard", "Key pressed", {
      name: key.name,
      ctrl: key.ctrl,
      shift: key.shift,
      focusArea: state.focusArea,
      isReady: state.isReady,
      selectedChat: state.selectedChat,
      chatsCount: state.chats.length,
      currentView: state.view,
    })

    // 1. Key capture for keybinding configuration (highest priority).
    if (state.keyCaptureActive && handleKeyCapture(ctx, key)) return

    // 2. Confirmation modal.
    if (ctx.confirm.isVisible && ctx.confirm.handleKey(key.name)) return

    // 3. QR modal: Esc hides it (whatsapp re-emits "qr" periodically).
    if (ctx.qr.isVisible && key.name === "escape") {
      ctx.qr.hide()
      logger.info("App", "QR modal hidden by user")
      return
    }

    // 4. Input navigation (up/down/reply).
    if (await handleInputNavigation(ctx, key)) return

    // 5. Message navigation and actions.
    if (await handleMessageNavigation(ctx, key)) return

    // 6. Quit.
    if (matchesKeybinding(key, ctx.config.keybindings.quit) || (key.ctrl && key.name === "c")) {
      logger.info("App", "User requested exit", { key: key.name })
      await ctx.shutdown(0)
      return
    }

    // 7. Main menu.
    if (await handleMainMenuNavigation(ctx, key)) return

    // 8a. Escape from a service chat list back to the menu.
    if (handleEscapeToMainMenu(ctx, key)) return

    // 8b. Settings toggle (F2).
    if (await handleSettingsToggle(ctx, key)) return

    // 8c. Settings navigation while open.
    if (await handleSettingsNavigation(ctx, key)) return

    // 9. Tab focus cycling.
    if (await handleTab(ctx, key)) return

    // 10. Chat-list navigation.
    if (await handleChatListNavigation(ctx, key)) return

    // 11. Quick chat selection (1-9).
    if (await handleQuickSelect(ctx, key)) return

    // 12. Escape.
    if (handleEscape(ctx, key)) return

    // 13. Help.
    if (matchesKeybinding(key, ctx.config.keybindings.help)) {
      showHelp(ctx.config.keybindings)
      return
    }

    // 14. Refresh chats.
    if (await handleRefresh(ctx, key)) return

    // 15. Pin/unpin.
    if (await handlePin(ctx, key)) return

    // 16. Mute/unmute.
    if (await handleMute(ctx, key)) return

    // 17. Archive.
    if (await handleArchive(ctx, key)) return
  }
}
