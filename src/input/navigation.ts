import type { KeyEvent } from "@opentui/core"
import type { AppContext } from "../app/context"
import { formatKeybinding, matchesKeybinding } from "../keybindings"
import { logger } from "../utils/logger"
import { renderMessages, setCursorPosition, updateCursorVisuals } from "../ui/messageList"
import { exitToMainMenu } from "../app/views"

/**
 * Input-focus navigation:
 *  - Up from the input enters message-selection mode (cursor on last message).
 *  - Down from the input scrolls back to the newest message.
 *  - The reply key marks the selected message as the reply target.
 */
export async function handleInputNavigation(ctx: AppContext, key: KeyEvent): Promise<boolean> {
  const state = ctx.state
  const colors = ctx.theme.colors
  const kbs = ctx.config.keybindings

  // CRITICAL: UP from input switches to message selection mode.
  if (state.focusArea === "input" && key.name === "up" && state.messages.length > 0) {
    state.focusArea = "messages"
    state.selectedMessage = state.messages.length - 1
    ctx.handles.inputBar.input.blur()
    ctx.handles.inputBar.area.borderColor = colors.border
    await renderMessages(ctx)
    setCursorPosition(state.selectedMessage)
    ctx.handles.messageList.scroll.scrollTo({
      x: 0,
      y: ctx.handles.messageList.scroll.scrollHeight,
    })
    ctx.status.set(
      `📍 Message ${state.selectedMessage + 1}/${state.messages.length} (↑↓ nav, ${formatKeybinding(
        kbs.openMedia,
      )}=media, ${formatKeybinding(kbs.setReplyReference)}=reply, ${formatKeybinding(
        kbs.jumpToReply,
      )}=jump, ↓↓=input)`,
      colors.primary,
    )
    logger.info("App", "UP from input -> message selection mode at LAST", {
      selectedMessage: state.selectedMessage,
    })
    return true
  }

  // DOWN from input scrolls to bottom.
  if (state.focusArea === "input" && key.name === "down" && state.messages.length > 0) {
    ctx.handles.messageList.scroll.scrollTo({
      x: 0,
      y: ctx.handles.messageList.scroll.scrollHeight,
    })
    logger.debug("App", "DOWN from input -> scrolled to bottom")
    return true
  }

  // Set reply reference (before other message navigation).
  if (
    state.focusArea === "messages" &&
    state.messages.length > 0 &&
    matchesKeybinding(key, kbs.setReplyReference)
  ) {
    const msg = state.messages[state.selectedMessage]
    if (msg) {
      state.replyToMessageId = msg.id
      ctx.status.set(`↪ Replying to: ${msg.body?.slice(0, 30) || "[media]"}...`, colors.primary)
      logger.info("App", "Set reply reference", {
        messageId: msg.id,
        key: formatKeybinding(kbs.setReplyReference),
      })
      state.focusArea = "input"
      state.selectedMessage = -1
      ctx.handles.inputBar.area.borderColor = colors.primary
      ctx.handles.inputBar.input.focus()
      await renderMessages(ctx)
    }
    return true
  }

  return false
}

/** Tab / Shift+Tab focus cycling between chat list and input. */
export async function handleTab(ctx: AppContext, key: KeyEvent): Promise<boolean> {
  const state = ctx.state
  if (key.name !== "tab" || !state.isReady) return false
  const colors = ctx.theme.colors

  if (state.focusArea === "chats") {
    state.focusArea = "input"
    ctx.handles.chatList.box.borderColor = colors.border
    ctx.handles.inputBar.area.borderColor = colors.primary
    ctx.handles.inputBar.input.focus()
    ctx.status.set(ctx.config.demoMode ? "● Demo Mode" : "● Connected", colors.primary)
    logger.info("App", "FOCUS SWITCHED TO INPUT", { focusArea: state.focusArea })
  } else {
    state.focusArea = "chats"
    state.selectedMessage = -1
    ctx.handles.chatList.box.borderColor = colors.primary
    ctx.handles.inputBar.area.borderColor = colors.border
    ctx.status.set(ctx.config.demoMode ? "● Demo Mode" : "● Connected", colors.primary)
    logger.info("App", "FOCUS SWITCHED TO CHATS", { focusArea: state.focusArea })
  }

  if (state.messages.length > 0) await renderMessages(ctx)
  logger.debug("Keyboard", "Tab pressed - switched focus", { focusArea: state.focusArea })
  return true
}

/** Escape from a service's chat list returns to the main menu. */
export function handleEscapeToMainMenu(ctx: AppContext, key: KeyEvent): boolean {
  const state = ctx.state
  if (
    state.view === "service" &&
    key.name === "escape" &&
    state.focusArea === "chats" &&
    !state.showSettings
  ) {
    exitToMainMenu(ctx)
    return true
  }
  return false
}

/** Generic Escape handling: exit message mode / cancel edit / cancel reply / back to chats. */
export function handleEscape(ctx: AppContext, key: KeyEvent): boolean {
  const state = ctx.state
  if (key.name !== "escape") return false
  const colors = ctx.theme.colors

  if (state.focusArea === "messages") {
    state.focusArea = "input"
    updateCursorVisuals(ctx, -1)
    state.selectedMessage = -1
    ctx.handles.inputBar.area.borderColor = colors.primary
    ctx.handles.inputBar.input.focus()
    ctx.status.set("● Connected", colors.primary)
    logger.info("App", "Escape - exit message select mode")
    return true
  } else if (state.focusArea === "editing") {
    state.editingMessageId = null
    state.focusArea = "input"
    ctx.handles.inputBar.input.value = ""
    ctx.status.set("● Cancelled editing", colors.textMuted)
    ctx.status.revertAfter(1000, { content: "● Connected", fg: colors.primary })
    logger.info("App", "Cancelled message editing")
    return true
  } else if (state.focusArea === "input") {
    if (state.replyToMessageId) {
      state.replyToMessageId = null
      ctx.status.set("● Cancelled reply", colors.textMuted)
      ctx.status.revertAfter(1000, { content: "● Connected", fg: colors.primary })
      logger.info("App", "Cancelled reply")
      return true
    }
    state.focusArea = "chats"
    ctx.handles.chatList.box.borderColor = colors.primary
    ctx.handles.inputBar.area.borderColor = colors.border
    logger.debug("App", "Escape - back to chats")
  }
  return true
}
