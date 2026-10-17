import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core"
import type { ServiceTheme } from "../services/registry"
import type { MessageData } from "../services/types"
import type { AppContext } from "../app/context"
import { logger } from "../utils/logger"
import { renderMessages } from "./messageList"

/** Persistent input-bar renderables. */
export interface InputBarHandles {
  area: BoxRenderable
  input: InputRenderable
  sendHint: TextRenderable
}

/** Build the message input area (border box + input + send hint). */
export function createInputBar(
  renderer: CliRenderer,
  msgAreaWidth: number,
  colors: ServiceTheme,
): InputBarHandles {
  const area = new BoxRenderable(renderer, {
    id: "input-area",
    width: msgAreaWidth,
    height: 3,
    borderStyle: "rounded",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 1,
    paddingRight: 1,
  })

  const input = new InputRenderable(renderer, {
    id: "message-input",
    width: msgAreaWidth - 8,
    placeholder: "Type a message...",
    backgroundColor: colors.surfaceLight,
    focusedBackgroundColor: colors.surfaceLight,
    textColor: colors.text,
    cursorColor: colors.primary,
  })

  const sendHint = new TextRenderable(renderer, {
    id: "send-hint",
    content: " ⏎",
    fg: colors.textMuted,
  })

  area.add(input)
  area.add(sendHint)
  return { area, input, sendHint }
}

/** Register the input bar's CHANGE/ENTER listeners. */
export function wireInputBar(ctx: AppContext): void {
  const { input } = ctx.handles.inputBar

  input.on(InputRenderableEvents.CHANGE, (value: string) => {
    logger.debug("InputChange", "Input value changed", {
      length: value.length,
      preview: value.substring(0, 20),
    })
  })

  input.on(InputRenderableEvents.ENTER, async (value: string) => {
    await handleSubmit(ctx, value)
  })
}

async function handleSubmit(ctx: AppContext, value: string): Promise<void> {
  const { state, config, status } = ctx
  const colors = ctx.theme.colors
  const input = ctx.handles.inputBar.input
  const svc = ctx.service.active

  logger.info("MessageInput", "ENTER pressed", {
    valueLength: value.length,
    currentChatId: state.currentChatId,
    isReady: state.isReady,
    demoMode: config.demoMode,
    isEditing: state.focusArea === "editing",
    replyToMessageId: state.replyToMessageId,
  })

  if (!value.trim() && state.focusArea !== "editing") {
    logger.debug("MessageInput", "Empty message, ignoring")
    return
  }

  // Handle message editing.
  if (state.focusArea === "editing" && state.editingMessageId && state.currentChatId && svc) {
    logger.info("MessageInput", "Editing message", {
      messageId: state.editingMessageId,
      newText: value,
    })
    status.set("⏳ Editing message...", colors.textMuted)

    const success = svc.editMessage
      ? await svc.editMessage(state.editingMessageId, state.currentChatId, value.trim())
      : false

    if (success) {
      status.set("● Message edited ✓", colors.primary)
      const msgIdx = state.messages.findIndex((m) => m.id === state.editingMessageId)
      if (msgIdx !== -1) {
        state.messages[msgIdx].body = value.trim()
        await renderMessages(ctx)
      }
    } else {
      status.set("✗ Failed to edit message", "#F15C6D")
    }

    state.editingMessageId = null
    state.focusArea = "input"
    input.value = ""

    status.revertAfter(2000, { content: "● Connected", fg: colors.primary })
    return
  }

  if (config.demoMode) {
    logger.info("MessageInput", "Sending demo message", { body: value.trim() })
    const newMsg: MessageData = {
      id: `m${Date.now()}`,
      body: value.trim(),
      timestamp: Date.now() / 1000,
      fromMe: true,
      hasMedia: false,
      type: "chat",
      ack: 1,
    }
    state.messages.push(newMsg)
    await renderMessages(ctx)
    input.value = ""
    state.replyToMessageId = null
    status.set("● Sent!")
    status.revertAfter(1000, { content: "● Demo Mode" })
  } else if (svc && state.isReady) {
    logger.info("MessageInput", "Sending real message", {
      chatId: state.currentChatId,
      body: value.trim().substring(0, 20),
    })
    status.set("○ Sending...", colors.textMuted)
    try {
      const sent = await svc.sendMessage(state.currentChatId!, value.trim(), {
        replyTo: state.replyToMessageId || undefined,
      })
      if (sent) {
        logger.info("MessageInput", "Message sent successfully", { messageId: sent.id })
        state.messages.push(sent)
        await renderMessages(ctx)
        input.value = ""
        state.replyToMessageId = null
        status.set("● Sent ✓", colors.primary)
      } else {
        logger.error("MessageInput", "sendMessage returned null")
        status.set("✗ Failed to send", "#F15C6D")
      }
    } catch (err) {
      logger.error("MessageInput", "sendMessage threw exception", err)
      status.set("✗ Error sending", "#F15C6D")
    }
    status.revertAfter(2000, { content: "● Connected", fg: colors.primary })
  } else {
    logger.warn("MessageInput", "Cannot send - activeService not ready", {
      hasService: !!svc,
      isReady: state.isReady,
    })
  }
}
