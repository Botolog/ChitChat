import {
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  type CliRenderer,
} from "@opentui/core"
import type { ServiceTheme } from "../services/registry"
import type { AppContext } from "../app/context"
import { logger } from "../utils/logger"
import { truncate } from "../utils/text"
import { removeChildById } from "./renderable-utils"

/** Persistent message-scroll renderables. */
export interface MessageListHandles {
  scroll: ScrollBoxRenderable
  emptyText: TextRenderable
}

/** Build the message scroll area and its empty-state text. */
export function createMessageList(
  renderer: CliRenderer,
  width: number,
  height: number,
  colors: ServiceTheme,
): MessageListHandles {
  const scroll = new ScrollBoxRenderable(renderer, {
    id: "messages-scroll",
    width,
    height,
    stickyScroll: true,
    stickyStart: "bottom",
  })

  const emptyText = new TextRenderable(renderer, {
    id: "empty-msg",
    content:
      "Select a chat to view messages\n\nUse ↑↓ to navigate\nPress Enter to select\nTab to switch focus",
    fg: colors.textMuted,
  })

  scroll.add(emptyText)
  return { scroll, emptyText }
}

// ---- message-view render bookkeeping -------------------------------------
// Owned by this module: exactly one message list exists per app instance.
let msgCount = 0
let msgBoxes: BoxRenderable[] = []
let msgBubbles: BoxRenderable[] = []
let msgCursorsLeft: TextRenderable[] = []
let msgCursorsRight: TextRenderable[] = []
let lastCursorPos = -1

/** Format a date separator label ("Today" / "Yesterday" / "Mon, Feb 3"). */
function formatDateSeparator(date: Date): string {
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)

  if (date.toDateString() === today.toDateString()) {
    return "Today"
  } else if (date.toDateString() === yesterday.toDateString()) {
    return "Yesterday"
  } else {
    return date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })
  }
}

/** Remove all rendered messages and rebuild the list for the current chat. */
export async function renderMessages(ctx: AppContext): Promise<void> {
  const { state, dims, handles } = ctx
  const colors = ctx.theme.colors
  const messagesScroll = handles.messageList.scroll

  logger.info("RenderMessages", "Starting renderMessages()", {
    messagesCount: state.messages.length,
    currentMsgCount: msgCount,
    currentChatId: state.currentChatId,
    selectedMessage: state.selectedMessage,
  })

  for (let i = 0; i < msgCount; i++) {
    removeChildById(messagesScroll, `msg-${i}`)
  }
  removeChildById(messagesScroll, "empty-msg")
  msgCount = 0
  msgBoxes = []
  msgBubbles = []
  msgCursorsLeft = []
  msgCursorsRight = []

  if (state.selectedMessage >= state.messages.length) {
    state.selectedMessage = state.messages.length - 1
  }

  if (state.messages.length === 0) {
    messagesScroll.add(handles.messageList.emptyText)
    return
  }

  let lastDateStr = ""
  for (const msg of state.messages) {
    const msgDate = new Date(msg.timestamp * 1000)
    const dateStr = msgDate.toDateString()
    if (dateStr !== lastDateStr) {
      lastDateStr = dateStr
      const separatorBox = new BoxRenderable(ctx.renderer, {
        id: `date-sep-${msgCount}`,
        width: dims.msgAreaWidth - 4,
        flexDirection: "row",
        justifyContent: "center",
        marginTop: 1,
        marginBottom: 1,
      })
      const separatorText = new TextRenderable(ctx.renderer, {
        id: `date-text-${msgCount}`,
        content: `── ${formatDateSeparator(msgDate)} ──`,
        fg: colors.textMuted,
      })
      separatorBox.add(separatorText)
      messagesScroll.add(separatorBox)
    }

    const isSelected =
      msgCount === state.selectedMessage && state.focusArea === "messages" && state.selectedMessage >= 0
    const msgBox = new BoxRenderable(ctx.renderer, {
      id: `msg-${msgCount}`,
      width: dims.msgAreaWidth - 2,
      flexDirection: "row",
      justifyContent: msg.fromMe ? "flex-end" : "flex-start",
      marginBottom: 1,
    })

    const cursorLeft = new TextRenderable(ctx.renderer, {
      id: `cursor-left-${msgCount}`,
      content: ">>> ",
      fg: "#00FF00",
      visible: isSelected,
    })
    const cursorRight = new TextRenderable(ctx.renderer, {
      id: `cursor-right-${msgCount}`,
      content: " <<<",
      fg: "#00FF00",
      visible: isSelected,
    })
    msgBox.add(cursorLeft)

    const maxBubbleWidth = Math.floor(dims.msgAreaWidth * 0.7)
    const bubble = new BoxRenderable(ctx.renderer, {
      id: `bubble-${msgCount}`,
      backgroundColor: msg.fromMe ? colors.sent : colors.received,
      borderStyle: "rounded",
      borderColor: isSelected ? "#00FF00" : msg.fromMe ? colors.primary : colors.textMuted,
      paddingLeft: 1,
      paddingRight: 1,
      paddingTop: 0,
      paddingBottom: 0,
      maxWidth: maxBubbleWidth,
      flexDirection: "column",
    })

    if (msg.isForwarded) {
      const forwardedText = new TextRenderable(ctx.renderer, {
        id: `forwarded-${msgCount}`,
        content:
          msg.forwardingScore && msg.forwardingScore > 4 ? "⤳ Forwarded many times" : "⤳ Forwarded",
        fg: colors.textMuted,
      })
      bubble.add(forwardedText)
    }

    if (msg.hasQuotedMsg && msg.quotedMsgBody) {
      const quotedText = new TextRenderable(ctx.renderer, {
        id: `quoted-${msgCount}`,
        content: `┃ ${truncate(msg.quotedMsgBody, 40)}`,
        fg: colors.textMuted,
      })
      bubble.add(quotedText)
    }

    if (msg.authorName && !msg.fromMe) {
      const authorText = new TextRenderable(ctx.renderer, {
        id: `author-${msgCount}`,
        content: msg.authorName,
        fg: colors.primary,
      })
      bubble.add(authorText)
    }

    const content = msg.body || ""
    if (content) {
      const bubbleText = new TextRenderable(ctx.renderer, {
        id: `bubble-text-${msgCount}`,
        content: truncate(content, dims.msgAreaWidth - 20),
        fg: colors.text,
      })
      bubble.add(bubbleText)
    }

    const date = new Date(msg.timestamp * 1000)
    const timeStr = `${date.getHours().toString().padStart(2, "0")}:${date
      .getMinutes()
      .toString()
      .padStart(2, "0")}`

    let ackStr = ""
    let ackColor = colors.textMuted
    if (msg.fromMe && msg.ack !== undefined) {
      if (msg.ack === 0) {
        ackStr = " ⏳"
      } else if (msg.ack === 1) {
        ackStr = " ✓"
      } else if (msg.ack === 2) {
        ackStr = " ✓✓"
      } else if (msg.ack === 3) {
        ackStr = " ✓✓"
        ackColor = colors.primary
      }
    }

    const starStr = msg.isStarred ? " ⭐" : ""

    const timeText = new TextRenderable(ctx.renderer, {
      id: `time-${msgCount}`,
      content: `  ${timeStr}${ackStr}${starStr}`,
      fg: ackColor,
    })

    if (msg.hasMedia && msg.media && ctx.media.renderer) {
      logger.info("RenderMessages", "Rendering media", {
        mediaType: msg.media.type,
        filename: msg.media.filename,
      })
      const mediaLines = await ctx.media.renderer.render(msg.media, maxBubbleWidth - 4)
      logger.info("RenderMessages", "Media rendered", {
        linesCount: mediaLines.length,
        firstLine: mediaLines[0],
      })

      for (const line of mediaLines) {
        const mediaText = new TextRenderable(ctx.renderer, {
          id: `media-${msgCount}-${Math.random()}`,
          content: line,
          fg: "#00FF00",
        })
        bubble.add(mediaText)
      }
    } else if (msg.hasMedia) {
      const fallbackText = new TextRenderable(ctx.renderer, {
        id: `media-fallback-${msgCount}`,
        content: `[${msg.type} media]`,
        fg: "#00FF00",
      })
      bubble.add(fallbackText)
    }

    bubble.add(timeText)
    msgBox.add(bubble)
    msgBox.add(cursorRight)

    msgBoxes.push(msgBox)
    msgBubbles.push(bubble)
    msgCursorsLeft.push(cursorLeft)
    msgCursorsRight.push(cursorRight)

    messagesScroll.add(msgBox)
    msgCount++
    logger.debug("RenderMessages", `Added message ${msgCount}`, {
      fromMe: msg.fromMe,
      bodyLen: msg.body?.length,
    })
  }
  logger.info("RenderMessages", "Finished renderMessages()", { renderedCount: msgCount })
}

/** Move the selection cursor without a full re-render (preserves scroll). */
export function updateCursorVisuals(ctx: AppContext, newPos: number): void {
  const colors = ctx.theme.colors

  if (lastCursorPos >= 0 && lastCursorPos < msgBubbles.length) {
    const oldBubble = msgBubbles[lastCursorPos]
    const oldMsg = ctx.state.messages[lastCursorPos]
    const oldCursorLeft = msgCursorsLeft[lastCursorPos]
    const oldCursorRight = msgCursorsRight[lastCursorPos]
    if (oldBubble && oldMsg) {
      oldBubble.borderColor = oldMsg.fromMe ? colors.primary : colors.textMuted
    }
    if (oldCursorLeft) oldCursorLeft.visible = false
    if (oldCursorRight) oldCursorRight.visible = false
  }

  if (newPos >= 0 && newPos < msgBubbles.length) {
    const newBubble = msgBubbles[newPos]
    const newCursorLeft = msgCursorsLeft[newPos]
    const newCursorRight = msgCursorsRight[newPos]
    if (newBubble) newBubble.borderColor = "#00FF00"
    if (newCursorLeft) newCursorLeft.visible = true
    if (newCursorRight) newCursorRight.visible = true
  }

  lastCursorPos = newPos
  logger.debug("App", "Updated cursor visuals", { to: newPos })
}

/** Record the current cursor position without repainting (used on entry). */
export function setCursorPosition(pos: number): void {
  lastCursorPos = pos
}

/** Reset module-level render bookkeeping (used on shutdown / tests). */
export function resetMessageView(): void {  msgCount = 0
  msgBoxes = []
  msgBubbles = []
  msgCursorsLeft = []
  msgCursorsRight = []
  lastCursorPos = -1
}
