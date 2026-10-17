import { EventEmitter } from "events"

/**
 * Shared data contract between messaging services and the UI.
 *
 * This module is the single source of truth for the shapes passed across the
 * service/UI boundary. Services must never expose provider-specific objects.
 */

export type MediaKind = "image" | "video" | "audio" | "sticker" | "document"

export interface MediaAttachment {
  /** Media category, mapped from the provider's message type. */
  type: MediaKind
  mimetype: string
  filename: string
  filesize?: number
  /**
   * Id of the message that owns this media. Media bytes are NOT carried on this
   * object; the UI downloads them lazily via `MessagingService.downloadMedia`
   * using this id.
   */
  messageId: string
}

export interface QuotedMessage {
  id: string
  body: string
}

export interface MessageData {
  id: string
  body: string
  /** Unix timestamp in seconds. */
  timestamp: number
  fromMe: boolean
  /** Provider message type (e.g. "chat", "image", "ptt"). */
  type: string
  ack?: number
  authorName?: string
  hasMedia: boolean
  media?: MediaAttachment
  isForwarded?: boolean
  forwardingScore?: number
  isStarred?: boolean
  hasQuotedMsg?: boolean
  quotedMsgBody?: string
  quotedMsgId?: string
}

export interface ChatData {
  id: string
  name: string
  isGroup: boolean
  unreadCount: number
  pinned: boolean
  muted: boolean
  archived: boolean
  participantCount?: number
  lastMessage?: {
    body: string
    timestamp: number
    fromMe: boolean
  }
}

export interface ContactData {
  id: string
  name: string
  number: string
  isMyContact: boolean
  isGroup: boolean
  isBlocked: boolean
}

export interface ConnectionState {
  ready: boolean
  hasQr: boolean
}

/** Payload for the `typing` event. */
export interface TypingPayload {
  chatId: string
  isTyping: boolean
}

/**
 * Events emitted by a messaging service.
 *
 * Named here so producers and consumers agree on payload shapes. `service_error`
 * is used instead of the reserved `error` event, because emitting `error` with
 * no listener throws in Node's EventEmitter.
 */
export interface MessagingServiceEvents {
  qr: (qr: string) => void
  authenticated: () => void
  ready: () => void
  auth_failure: (message: string) => void
  message: (message: MessageData) => void
  disconnected: (reason: string) => void
  typing: (payload: TypingPayload) => void
  service_error: (error: unknown) => void
}

/** Options accepted by `sendMessage`. */
export interface SendMessageOptions {
  /** Id of the message being replied to, if any. */
  replyTo?: string
}

/**
 * Unified interface every messaging backend implements.
 *
 * Capability-gated operations are optional so that the UI can feature-detect
 * (`svc.capabilities().editMessage && svc.editMessage?.(...)`) instead of
 * crashing on backends that do not support them.
 */
export interface MessagingService extends EventEmitter {
  readonly id: string
  readonly displayName: string

  capabilities(): import("./capabilities").ServiceCapabilities

  initialize(): Promise<void>
  isReady(): boolean
  getConnectionState(): ConnectionState

  getChats(): Promise<ChatData[]>
  getMessages(chatId: string, limit?: number): Promise<MessageData[]>
  sendMessage(chatId: string, content: string, options?: SendMessageOptions): Promise<MessageData | null>
  markAsRead(chatId: string): Promise<void>
  getContactInfo(contactId: string): Promise<ContactData | null>
  destroy(): Promise<void>

  // Capability-gated operations (see capabilities()).
  deleteMessage?(messageId: string, chatId: string, forMe: boolean): Promise<boolean>
  editMessage?(messageId: string, chatId: string, newText: string): Promise<boolean>
  pinChat?(chatId: string, pin: boolean): Promise<boolean>
  muteChat?(chatId: string, mute: boolean): Promise<boolean>
  archiveChat?(chatId: string, archive: boolean): Promise<boolean>
  downloadMedia?(messageId: string, chatId: string): Promise<string | null>
  /** Render a QR payload to a printable block-character string (no stdout side effects). */
  renderQrCode?(qr: string): string
}
