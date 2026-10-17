import { BoxRenderable, TextRenderable } from "@opentui/core"
import type { AppContext } from "../app/context"
import { logger } from "../utils/logger"
import { truncate } from "../utils/text"
import { removeChildById } from "./renderable-utils"

/** One rendered chat row. */
interface ChatItem {
  box: BoxRenderable
  nameText: TextRenderable
  chatIdx: number
}

// Owned by this module: the visible chat rows and their renderable ids.
const chatItems: ChatItem[] = []
let chatItemIds: string[] = []

/** Update the chat-list title with the current count. */
export function updateChatListTitle(ctx: AppContext): void {
  ctx.handles.chatList.box.title = ` Chats (${ctx.state.chats.length}) `
  logger.debug("UI", "Updated chat list title", { count: ctx.state.chats.length })
}

/** Number of chat rows currently rendered (for diagnostics). */
export function getChatItemCount(): number {
  return chatItems.length
}

/** Repaint the entire chat list (respecting the current selection and height). */
export function renderChats(ctx: AppContext): void {
  const { state, dims } = ctx
  const colors = ctx.theme.colors
  const chatListBox = ctx.handles.chatList.box

  logger.info("RenderChats", "Starting renderChats()", {
    chatsCount: state.chats.length,
    chatItemsCount: chatItems.length,
    height: dims.height,
    demoMode: ctx.config.demoMode,
  })

  removeChildById(chatListBox, "loading-text")

  for (const id of chatItemIds) {
    removeChildById(chatListBox, id)
  }
  chatItems.length = 0
  chatItemIds = []

  const maxChats = Math.floor((dims.height - 6) / 2)
  logger.info("RenderChats", "Calculated maxChats", { maxChats, height: dims.height })

  updateChatListTitle(ctx)

  if (state.chats.length === 0) {
    logger.warn("RenderChats", "No chats to render!")
    return
  }

  let startIdx = 0
  if (state.selectedChat >= maxChats) {
    startIdx = state.selectedChat - maxChats + 1
  }
  const endIdx = Math.min(state.chats.length, startIdx + maxChats)

  for (let i = startIdx; i < endIdx; i++) {
    const chat = state.chats[i]
    logger.debug("RenderChats", `Rendering chat ${i}`, { chatName: chat?.name })
    const itemBox = new BoxRenderable(ctx.renderer, {
      id: `chat-${i}`,
      width: dims.chatListWidth - 4,
      height: 2,
      backgroundColor: i === state.selectedChat ? colors.surfaceLight : colors.surface,
      flexDirection: "column",
      paddingLeft: 1,
    })

    const badge = chat.unreadCount > 0 ? ` (${chat.unreadCount})` : ""
    const pin = chat.pinned ? "📌 " : ""
    const group = chat.isGroup ? "👥 " : ""
    const muted = chat.muted ? "🔇 " : ""
    const hasUnread = chat.unreadCount > 0
    const nameText = new TextRenderable(ctx.renderer, {
      id: `chat-name-${i}`,
      content: pin + group + muted + truncate(chat.name, dims.chatListWidth - 16) + badge,
      fg: i === state.selectedChat ? colors.primary : hasUnread ? "#FFFFFF" : colors.text,
    })

    let timeStr = ""
    if (chat.lastMessage?.timestamp) {
      const msgDate = new Date(chat.lastMessage.timestamp * 1000)
      const now = new Date()
      const diffDays = Math.floor((now.getTime() - msgDate.getTime()) / (1000 * 60 * 60 * 24))
      if (diffDays === 0) {
        timeStr = `${msgDate.getHours().toString().padStart(2, "0")}:${msgDate
          .getMinutes()
          .toString()
          .padStart(2, "0")}`
      } else if (diffDays === 1) {
        timeStr = "Yesterday"
      } else if (diffDays < 7) {
        timeStr = msgDate.toLocaleDateString("en-US", { weekday: "short" })
      } else {
        timeStr = msgDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })
      }
    }

    const preview = chat.lastMessage?.body || ""
    const previewWithTime = timeStr
      ? `${truncate(preview, dims.chatListWidth - 14)} ${timeStr}`
      : truncate(preview, dims.chatListWidth - 6)
    const msgText = new TextRenderable(ctx.renderer, {
      id: `chat-msg-${i}`,
      content: previewWithTime,
      fg: colors.textMuted,
    })

    itemBox.add(nameText)
    itemBox.add(msgText)
    chatListBox.add(itemBox)
    chatItems.push({ box: itemBox, nameText, chatIdx: i })
    chatItemIds.push(`chat-${i}`)
    logger.debug("RenderChats", `Added chat item ${i} to chatListBox`)
  }
  logger.info("RenderChats", "Finished renderChats()", { renderedCount: chatItems.length })
}

/** Repaint selection styling; re-renders when the selection scrolled off-screen. */
export function updateSelection(ctx: AppContext): void {
  const { state } = ctx
  const colors = ctx.theme.colors

  logger.debug("UpdateSelection", "Starting updateSelection()", {
    selectedChat: state.selectedChat,
    chatItemsCount: chatItems.length,
  })

  if (chatItems.length === 0) {
    logger.warn("UpdateSelection", "No items to update!")
    return
  }

  const isVisible = chatItems.some((item) => item.chatIdx === state.selectedChat)
  if (!isVisible) {
    renderChats(ctx)
    return
  }

  for (let i = 0; i < chatItems.length; i++) {
    const chatIdx = chatItems[i].chatIdx
    const isSelected = chatIdx === state.selectedChat
    chatItems[i].box.backgroundColor = isSelected ? colors.surfaceLight : colors.surface
    const hasUnread = state.chats[chatIdx]?.unreadCount > 0
    chatItems[i].nameText.fg = isSelected ? colors.primary : hasUnread ? "#FFFFFF" : colors.text
  }

  if (state.chats[state.selectedChat]) {
    ctx.handles.chatHeader.text.content = state.chats[state.selectedChat].name
    logger.debug("UpdateSelection", "Updated header", {
      chatName: state.chats[state.selectedChat].name,
    })
  }
  logger.debug("UpdateSelection", "Finished updateSelection()")
}
