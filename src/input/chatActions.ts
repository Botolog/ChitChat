import type { KeyEvent } from "@opentui/core"
import type { AppContext } from "../app/context"
import { matchesKeybinding } from "../keybindings"
import { getSettings } from "../settings"
import { logger } from "../utils/logger"
import { renderChats, updateSelection } from "../ui/chatList"
import { renderMessages } from "../ui/messageList"
import { updateChatHeader } from "../ui/chatHeader"
import { ensureMediaCached } from "./mediaActions"
import { DEMO_MESSAGES } from "../app/demo"

/** Select a chat, load its messages and (optionally) pre-download its media. */
export async function selectChat(ctx: AppContext, index: number): Promise<void> {
  const state = ctx.state
  const colors = ctx.theme.colors
  const svc = ctx.service.active

  logger.info("App", "selectChat() called", { index, chatCount: state.chats.length })
  if (index < 0 || index >= state.chats.length) {
    logger.warn("App", "selectChat() invalid index", { index })
    return
  }

  state.selectedChat = index
  state.selectedMessage = -1
  state.currentChatId = state.chats[index].id
  logger.info("App", "Chat selected", {
    chatId: state.currentChatId,
    chatName: state.chats[index].name,
  })
  updateSelection(ctx)

  if (ctx.config.demoMode) {
    state.messages = [...(DEMO_MESSAGES[state.currentChatId] || [])]
    state.chats[index].unreadCount = 0
    logger.debug("App", "Loaded demo messages", {
      count: state.messages.length,
      chatId: state.currentChatId,
    })
  } else if (svc) {
    ctx.status.set(" Loading...", colors.textMuted)
    const chatId = state.currentChatId
    logger.info("App", "Loading messages", { chatId })
    state.messages = await svc.getMessages(chatId, 30)
    logger.info("App", "Messages loaded", { count: state.messages.length })
    await svc.markAsRead(chatId)
    state.chats[index].unreadCount = 0
  }

  renderChats(ctx)
  await renderMessages(ctx)
  updateChatHeader(ctx, state.chats[index].name, state.messages.length, state.chats[index])
  ctx.status.set(ctx.config.demoMode ? "● Demo Mode" : "● Connected", colors.primary)

  if (getSettings().autoDownloadMediaOnEnter && !ctx.config.demoMode && svc) {
    const chatIdForDownload = state.currentChatId
    const mediaMessages = state.messages.filter((m) => m.hasMedia)

    if (mediaMessages.length > 0) {
      logger.info("App", "Starting background media download", {
        chatId: chatIdForDownload,
        count: mediaMessages.length,
      })
      ctx.status.set(`⏳ Downloading ${mediaMessages.length} media files...`, colors.textMuted)

      void (async () => {
        try {
          let downloaded = 0
          for (const msg of mediaMessages) {
            if (state.currentChatId !== chatIdForDownload) {
              logger.info("App", "Chat changed, stopping background download")
              break
            }
            try {
              await ensureMediaCached(ctx, msg, chatIdForDownload!)
              downloaded++
              if (downloaded % 3 === 0 || downloaded === mediaMessages.length) {
                ctx.status.set(
                  `⏳ Downloaded ${downloaded}/${mediaMessages.length} media...`,
                )
              }
              logger.debug("App", "Downloaded media", {
                messageId: msg.id,
                progress: `${downloaded}/${mediaMessages.length}`,
              })
            } catch (err) {
              logger.error("App", "Failed to download media", { messageId: msg.id, err })
            }
          }

          if (state.currentChatId === chatIdForDownload) {
            ctx.status.set(
              `● Downloaded ${downloaded}/${mediaMessages.length} media`,
              colors.primary,
            )
            ctx.lifecycle.timeout(() => {
              if (state.currentChatId === chatIdForDownload) {
                ctx.status.set("● Connected")
              }
            }, 2000)
            await renderMessages(ctx)
          }
        } catch (err) {
          logger.error("App", "Background media download error", err)
        }
      })()
    }
  }
}

/** Up/Down/Enter while the chat list is focused. */
export async function handleChatListNavigation(ctx: AppContext, key: KeyEvent): Promise<boolean> {
  const state = ctx.state
  if (state.focusArea !== "chats" || !state.isReady) return false
  const colors = ctx.theme.colors

  if (key.name === "up" && state.selectedChat > 0) {
    state.selectedChat--
    updateSelection(ctx)
    logger.debug("App", "Chat nav up", { selectedChat: state.selectedChat })
    return true
  }
  if (key.name === "down" && state.selectedChat < state.chats.length - 1) {
    state.selectedChat++
    updateSelection(ctx)
    logger.debug("App", "Chat nav down", { selectedChat: state.selectedChat })
    return true
  }
  if (key.name === "return" && state.chats.length > 0) {
    await selectChat(ctx, state.selectedChat)
    state.focusArea = "input"
    ctx.handles.chatList.box.borderColor = colors.border
    ctx.handles.inputBar.area.borderColor = colors.primary
    logger.debug("App", "Focus → input")
    return true
  }
  return false
}

/** Number keys 1-9 quickly select a chat. */
export async function handleQuickSelect(ctx: AppContext, key: KeyEvent): Promise<boolean> {
  const state = ctx.state
  if (!state.isReady || !key.name || !/^[1-9]$/.test(key.name)) return false
  const colors = ctx.theme.colors

  const idx = parseInt(key.name) - 1
  if (idx < state.chats.length) {
    logger.debug("App", "Quick select chat", { key: key.name, idx })
    await selectChat(ctx, idx)
    state.focusArea = "input"
    ctx.handles.chatList.box.borderColor = colors.border
    ctx.handles.inputBar.area.borderColor = colors.primary
    ctx.handles.inputBar.input.focus()
    return true
  }
  return false
}

/** Refresh chats (and the open conversation) from the service. */
export async function handleRefresh(ctx: AppContext, key: KeyEvent): Promise<boolean> {
  const state = ctx.state
  const svc = ctx.service.active
  if (!matchesKeybinding(key, ctx.config.keybindings.refreshChats) || !state.isReady || !svc) {
    return false
  }
  const colors = ctx.theme.colors

  logger.info("App", "Refreshing chats")
  ctx.status.set("○ Refreshing...")
  state.chats = await svc.getChats()
  renderChats(ctx)
  updateSelection(ctx)
  if (state.currentChatId) {
    state.messages = await svc.getMessages(state.currentChatId, 30)
    await renderMessages(ctx)
  }
  ctx.status.set("● Connected", colors.primary)
  return true
}

/** Pin/unpin the selected chat (capability-gated). */
export async function handlePin(ctx: AppContext, key: KeyEvent): Promise<boolean> {
  const state = ctx.state
  const svc = ctx.service.active
  if (
    !matchesKeybinding(key, ctx.config.keybindings.pinChat) ||
    !state.isReady ||
    !state.currentChatId ||
    !svc
  ) {
    return false
  }
  const colors = ctx.theme.colors
  const chat = state.chats[state.selectedChat]
  if (!chat) return true

  logger.info("App", "Toggling pin", { chatId: state.currentChatId, currentPin: chat.pinned })
  ctx.status.set(chat.pinned ? "○ Unpinning..." : "○ Pinning...")
  const success =
    svc.capabilities().pin && svc.pinChat
      ? await svc.pinChat(state.currentChatId, !chat.pinned)
      : false
  if (success) {
    state.chats = await svc.getChats()
    renderChats(ctx)
    updateSelection(ctx)
    ctx.status.set(chat.pinned ? "● Unpinned" : "● Pinned")
  } else {
    ctx.status.set("✗ Failed")
  }
  ctx.status.revertAfter(1500, { content: "● Connected", fg: colors.primary })
  return true
}

/** Mute/unmute the selected chat (capability-gated). */
export async function handleMute(ctx: AppContext, key: KeyEvent): Promise<boolean> {
  const state = ctx.state
  const svc = ctx.service.active
  if (
    !matchesKeybinding(key, ctx.config.keybindings.muteChat) ||
    !state.isReady ||
    !state.currentChatId ||
    !svc
  ) {
    return false
  }
  const colors = ctx.theme.colors
  const chat = state.chats[state.selectedChat]
  if (!chat) return true

  logger.info("App", "Toggling mute", { chatId: state.currentChatId, currentMute: chat.muted })
  ctx.status.set(chat.muted ? "○ Unmuting..." : "○ Muting...")
  const success =
    svc.capabilities().mute && svc.muteChat
      ? await svc.muteChat(state.currentChatId, !chat.muted)
      : false
  if (success) {
    state.chats = await svc.getChats()
    renderChats(ctx)
    updateSelection(ctx)
    ctx.status.set(chat.muted ? "● Unmuted" : "● Muted")
  } else {
    ctx.status.set("✗ Failed")
  }
  ctx.status.revertAfter(1500, { content: "● Connected", fg: colors.primary })
  return true
}

/** Archive the selected chat (capability-gated). */
export async function handleArchive(ctx: AppContext, key: KeyEvent): Promise<boolean> {
  const state = ctx.state
  const svc = ctx.service.active
  if (
    !matchesKeybinding(key, ctx.config.keybindings.archiveChat) ||
    !state.isReady ||
    !state.currentChatId ||
    !svc
  ) {
    return false
  }
  const colors = ctx.theme.colors
  const chat = state.chats[state.selectedChat]
  if (!chat) return true

  logger.info("App", "Archiving chat", { chatId: state.currentChatId })
  ctx.status.set("○ Archiving...")
  const success =
    svc.capabilities().archive && svc.archiveChat
      ? await svc.archiveChat(state.currentChatId, true)
      : false
  if (success) {
    state.chats = await svc.getChats()
    renderChats(ctx)
    updateSelection(ctx)
    ctx.status.set("● Archived")
  } else {
    ctx.status.set("✗ Failed")
  }
  ctx.status.revertAfter(1500, { content: "● Connected", fg: colors.primary })
  return true
}
