import type { AppContext } from "./context"
import type { MessagingService, TypingPayload } from "../services/types"
import { logger } from "../utils/logger"
import { renderChats, updateSelection } from "../ui/chatList"
import { renderMessages } from "../ui/messageList"

/** A handler we registered, recorded so we can remove exactly it (T5). */
interface RegisteredHandler {
  event: string
  fn: (...args: any[]) => void
}

let registeredService: MessagingService | null = null
let registeredHandlers: RegisteredHandler[] = []

/** Delays between chat-list reads while the list is still empty. */
const EMPTY_CHAT_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000]

/**
 * Read the chat list, render it, and keep re-reading while it stays empty.
 *
 * WhatsApp Web restores chats from its local database in the background, so a
 * fresh login can legitimately answer with an empty list for a while. Without a
 * retry the UI would sit on an empty list until some unrelated event arrived.
 * Retries stop as soon as a chat shows up, and give up after a bounded wait so a
 * genuinely empty account is not polled forever.
 */
async function loadChats(ctx: AppContext, svc: MessagingService, attempt = 0): Promise<void> {
  ctx.status.set("○ Loading chats...")
  try {
    ctx.state.chats = await svc.getChats()
  } catch (err) {
    logger.error("App", "Error loading chats", err)
    const message = err instanceof Error ? err.message : String(err)
    ctx.status.set(`✗ ${message.slice(0, 20)}`, "#F15C6D")
    return
  }

  logger.info("App", "Chats loaded", { count: ctx.state.chats.length, attempt })
  renderChats(ctx)
  updateSelection(ctx)

  const delay = EMPTY_CHAT_RETRY_DELAYS_MS[attempt]
  if (ctx.state.chats.length > 0 || delay === undefined) {
    if (ctx.state.chats.length === 0) {
      logger.warn("App", "Still no chats after retrying", { attempts: attempt + 1 })
    }
    ctx.handles.loadingText.content = ""
    ctx.status.set("● Connected", ctx.theme.colors.primary)
    return
  }

  setTimeout(() => {
    // The user may have switched service (or quit) while we waited.
    if (ctx.service.active === svc && ctx.state.isReady) {
      void loadChats(ctx, svc, attempt + 1)
    }
  }, delay)
}

/** Remove only the handlers this module registered, leaving others intact. */
export function teardownServiceEventHandlers(): void {
  if (registeredService) {
    for (const { event, fn } of registeredHandlers) {
      registeredService.off(event, fn)
    }
  }
  registeredHandlers = []
  registeredService = null
}

/**
 * Wire the service `qr`/`authenticated`/`ready`/`message`/`disconnected`/`typing`
 * events (plus `auth_failure`/`service_error`) using named handlers.
 */
export function setupServiceEventHandlers(ctx: AppContext): void {
  teardownServiceEventHandlers()
  const svc = ctx.service.active
  if (!svc) return

  registeredService = svc
  const colors = ctx.theme.colors

  const on = (event: string, fn: (...args: any[]) => void): void => {
    svc.on(event, fn)
    registeredHandlers.push({ event, fn })
  }

  const onQr = (qr: string): void => {
    logger.event("App", "qr received", { length: qr.length })
    ctx.status.set("○ Scan QR...")
    ctx.handles.loadingText.content = "Scan QR code\n(shown in the popup)"

    const qrText = svc.renderQrCode ? svc.renderQrCode(qr) : ""
    if (qrText) {
      ctx.qr.show(qrText)
    } else {
      logger.warn("App", "Service did not render a QR code")
    }
  }

  const onAuthenticated = (): void => {
    logger.event("App", "authenticated")
    ctx.qr.hide()
    ctx.status.set("○ Authenticated...")
    ctx.handles.loadingText.content = "Loading..."
  }

  const onReady = async (): Promise<void> => {
    logger.event("App", "ready - service is ready!")
    ctx.qr.hide()
    ctx.state.isReady = true
    await loadChats(ctx, svc)
  }

  const onMessage = async (): Promise<void> => {
    logger.event("App", "message received")
    if (ctx.state.currentChatId) {
      const chatId = ctx.state.currentChatId
      ctx.state.messages = await svc.getMessages(chatId, 30)
      await renderMessages(ctx)
      await svc.markAsRead(chatId)
      const chatIdx = ctx.state.chats.findIndex((c) => c.id === chatId)
      if (chatIdx >= 0) ctx.state.chats[chatIdx].unreadCount = 0
    }
    ctx.state.chats = await svc.getChats()
    renderChats(ctx)
    updateSelection(ctx)
  }

  const onDisconnected = (reason: string): void => {
    logger.event("App", "disconnected", { reason })
    ctx.qr.hide()
    ctx.state.isReady = false
    ctx.status.set(`✗ ${reason}`, "#F15C6D")
  }

  const onTyping = (payload: TypingPayload): void => {
    const { chatId, isTyping } = payload
    if (chatId === ctx.state.currentChatId) {
      if (isTyping) {
        ctx.handles.chatHeader.count.content = " typing..."
        ctx.handles.chatHeader.count.fg = colors.primary
      } else {
        ctx.handles.chatHeader.count.content =
          ctx.state.messages.length > 0 ? ` (${ctx.state.messages.length} messages)` : ""
        ctx.handles.chatHeader.count.fg = colors.textMuted
      }
    }
  }

  const onAuthFailure = (message: string): void => {
    logger.event("App", "auth_failure", { message })
    ctx.qr.hide()
    ctx.status.set(`✗ Authentication failed: ${message}`, "#F15C6D")
  }

  const onServiceError = (error: unknown): void => {
    logger.error("App", "service_error", error)
  }

  on("qr", onQr)
  on("authenticated", onAuthenticated)
  on("ready", onReady)
  on("message", onMessage)
  on("disconnected", onDisconnected)
  on("typing", onTyping)
  on("auth_failure", onAuthFailure)
  on("service_error", onServiceError)

  logger.info("App", "Service event handlers set up")
}
