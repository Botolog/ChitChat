import type { KeyEvent } from "@opentui/core"
import type { AppContext } from "../app/context"
import { matchesKeybinding } from "../keybindings"
import { getSettings } from "../settings"
import { logger } from "../utils/logger"
import { renderMessages, updateCursorVisuals } from "../ui/messageList"
import { handleOpenMedia } from "./mediaActions"

/** Delete the selected message (for me / for everyone), honouring confirm setting. */
async function deleteSelectedMessage(ctx: AppContext, forMe: boolean): Promise<void> {
  const state = ctx.state
  const colors = ctx.theme.colors
  const svc = ctx.service.active
  const msg = state.messages[state.selectedMessage]
  if (!msg || !state.currentChatId || !svc) return

  const settings = getSettings()
  const caps = svc.capabilities()
  const deleteSupport = caps.deleteMessage
  const allowed =
    forMe
      ? deleteSupport === "forMe" || deleteSupport === "both"
      : deleteSupport === "forEveryone" || deleteSupport === "both"

  const failureText = forMe
    ? "✗ Failed to delete message"
    : "✗ Failed to delete message for everyone"

  const performDelete = async (): Promise<void> => {
    if (!allowed || !svc.deleteMessage) {
      ctx.status.set(failureText, "#F15C6D")
      ctx.status.revertAfter(2000, { content: "● Connected", fg: colors.primary })
      return
    }

    logger.info("App", "Deleting message", { messageId: msg.id, forMe })
    ctx.status.set(
      forMe ? "⏳ Deleting message for you..." : "⏳ Deleting message for everyone...",
      colors.textMuted,
    )

    const success = await svc.deleteMessage(msg.id, state.currentChatId!, forMe)

    if (success) {
      ctx.status.set(
        forMe ? "● Message deleted ✓" : "● Message deleted for everyone ✓",
        colors.primary,
      )
      const msgIdx = state.messages.findIndex((m) => m.id === msg.id)
      if (msgIdx !== -1) {
        state.messages.splice(msgIdx, 1)
        if (state.selectedMessage >= state.messages.length) {
          state.selectedMessage = state.messages.length - 1
        }
        await renderMessages(ctx)
      }
    } else {
      ctx.status.set(failureText, "#F15C6D")
    }

    ctx.status.revertAfter(2000, { content: "● Connected", fg: colors.primary })
  }

  if (settings.confirmDeleteMessage) {
    ctx.confirm.show(
      forMe ? "Delete this message for you?" : "Delete this message for everyone?",
      async (confirmed) => {
        ctx.confirm.hide()
        if (confirmed) await performDelete()
      },
    )
  } else {
    await performDelete()
  }
}

/**
 * Message-selection navigation and actions. Only claims keys when the message
 * cursor is active and the key is one of the configured message keys.
 */
export async function handleMessageNavigation(ctx: AppContext, key: KeyEvent): Promise<boolean> {
  const state = ctx.state
  const colors = ctx.theme.colors
  const kbs = ctx.config.keybindings

  if (state.focusArea !== "messages" || state.messages.length === 0) return false

  const isMessageNavKey =
    key.name === "up" ||
    key.name === "down" ||
    matchesKeybinding(key, kbs.jumpToReply) ||
    matchesKeybinding(key, kbs.openMedia) ||
    matchesKeybinding(key, kbs.deleteMessageForMe) ||
    matchesKeybinding(key, kbs.deleteMessageForEveryone) ||
    matchesKeybinding(key, kbs.editMessage)

  if (!isMessageNavKey) return false

  logger.info("App", "MESSAGE NAVIGATION KEY DETECTED", {
    key: key.name,
    ctrl: key.ctrl,
    shift: key.shift,
    focusArea: state.focusArea,
    selectedMessage: state.selectedMessage,
    totalMessages: state.messages.length,
  })

  if (key.name === "up") {
    if (state.selectedMessage > 0) {
      state.selectedMessage--
      updateCursorVisuals(ctx, state.selectedMessage)
      ctx.status.set(`📍 Message ${state.selectedMessage + 1}/${state.messages.length}`, colors.primary)
    } else {
      logger.info("App", "Already at first message")
    }
    return true
  }

  if (key.name === "down") {
    if (state.selectedMessage < state.messages.length - 1) {
      state.selectedMessage++
      updateCursorVisuals(ctx, state.selectedMessage)
      ctx.status.set(`📍 Message ${state.selectedMessage + 1}/${state.messages.length}`, colors.primary)
    } else {
      state.focusArea = "input"
      updateCursorVisuals(ctx, -1)
      state.selectedMessage = -1
      ctx.handles.chatList.box.borderColor = colors.border
      ctx.handles.inputBar.area.borderColor = colors.primary
      ctx.handles.inputBar.input.focus()
      ctx.status.set(ctx.config.demoMode ? "● Demo Mode" : "● Connected", colors.primary)
      logger.info("App", "DOWN from last message -> focus input")
    }
    return true
  }

  if (matchesKeybinding(key, kbs.jumpToReply)) {
    const msg = state.messages[state.selectedMessage]
    logger.info("App", "Jump to reply handler reached", {
      hasMsg: !!msg,
      hasQuotedMsg: msg?.hasQuotedMsg,
      quotedMsgId: msg?.quotedMsgId,
    })
    if (msg && msg.hasQuotedMsg && msg.quotedMsgId) {
      const quotedId = msg.quotedMsgId
      let quotedMsgIndex = state.messages.findIndex((m) => m.id === quotedId)
      if (quotedMsgIndex === -1) {
        quotedMsgIndex = state.messages.findIndex((m) => m.id.includes(quotedId))
      }
      if (quotedMsgIndex !== -1) {
        updateCursorVisuals(ctx, quotedMsgIndex)
        state.selectedMessage = quotedMsgIndex
        ctx.status.set(
          `↪ Jumped to replied message (${quotedMsgIndex + 1}/${state.messages.length})`,
          colors.primary,
        )
        logger.info("App", "Jumped to quoted message", { newIndex: quotedMsgIndex })
      } else {
        ctx.status.set("✗ Replied message not found in current view", "#F15C6D")
        logger.warn("App", "Quoted message not found in messages array", {
          quotedMsgId: quotedId,
          allMsgIds: state.messages.map((m) => m.id),
        })
      }
    } else {
      ctx.status.set("This message is not a reply", colors.textMuted)
    }
    return true
  }

  if (matchesKeybinding(key, kbs.openMedia)) {
    return handleOpenMedia(ctx)
  }

  if (matchesKeybinding(key, kbs.deleteMessageForMe)) {
    await deleteSelectedMessage(ctx, true)
    return true
  }

  if (matchesKeybinding(key, kbs.deleteMessageForEveryone)) {
    await deleteSelectedMessage(ctx, false)
    return true
  }

  if (matchesKeybinding(key, kbs.editMessage)) {
    const msg = state.messages[state.selectedMessage]
    if (msg && msg.fromMe && state.currentChatId) {
      logger.info("App", "Editing message", { messageId: msg.id })
      state.editingMessageId = msg.id
      state.focusArea = "editing"
      ctx.handles.inputBar.input.value = msg.body || ""
      ctx.handles.inputBar.input.focus()
      ctx.status.set("✏ Editing message (Enter to save, Esc to cancel)", colors.primary)
      await renderMessages(ctx)
    } else if (msg && !msg.fromMe) {
      ctx.status.set("✗ Can only edit your own messages", "#F15C6D")
    }
    return true
  }

  return true
}
