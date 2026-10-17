import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import type { ServiceTheme } from "../services/registry"
import type { ChatData } from "../services/types"
import type { AppContext } from "../app/context"
import { logger } from "../utils/logger"

/** Persistent chat-header renderables. */
export interface ChatHeaderHandles {
  box: BoxRenderable
  text: TextRenderable
  count: TextRenderable
}

/** Build the chat header (right panel, above the message list). */
export function createChatHeader(
  renderer: CliRenderer,
  width: number,
  colors: ServiceTheme,
): ChatHeaderHandles {
  const box = new BoxRenderable(renderer, {
    id: "chat-header",
    width,
    height: 2,
    backgroundColor: colors.surface,
    paddingLeft: 2,
    flexDirection: "row",
    alignItems: "center",
  })
  const text = new TextRenderable(renderer, {
    id: "chat-header-text",
    content: "Select a chat",
    fg: colors.text,
  })
  const count = new TextRenderable(renderer, {
    id: "chat-header-count",
    content: "",
    fg: colors.textMuted,
  })
  box.add(text)
  box.add(count)
  return { box, text, count }
}

/** Update the header with a chat name, message count and (for groups) member count. */
export function updateChatHeader(
  ctx: AppContext,
  chatName: string,
  msgCount: number,
  chat?: ChatData,
): void {
  const { text, count } = ctx.handles.chatHeader
  text.content = chatName

  let infoStr = ""
  if (chat?.isGroup && chat.participantCount) {
    infoStr = ` (${chat.participantCount} members)`
  } else if (msgCount > 0) {
    infoStr = ` (${msgCount} messages)`
  }
  count.content = infoStr
  logger.debug("UI", "Updated chat header", {
    chatName,
    msgCount,
    isGroup: chat?.isGroup,
    participantCount: chat?.participantCount,
  })
}
