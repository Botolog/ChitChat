/**
 * Reading WhatsApp Web's chat list from inside the page.
 *
 * `whatsapp-web.js` maps every chat with `window.WWebJS.getChatModel()` inside a
 * single `Promise.all`, so one chat that fails to serialize rejects the whole
 * call — and current WhatsApp Web builds (2.3000.x) made that the normal case:
 * the chat model's `serialize()` throws for LID-based chats, and message-key
 * ids moved their serialized form from `_serialized` to `$1`. The result is
 * `getChats()` / `getState()` rejecting with an opaque `r: r` and the UI ending
 * up with no chats at all. See wwebjs/whatsapp-web.js#201845, and the fixes
 * proposed in wwebjs/whatsapp-web.js#201850.
 *
 * So ChitChat reads the collection itself and never lets one bad chat hide the
 * rest: each chat is mapped on its own, anything unreadable is skipped and
 * counted, and the caller gets counts plus the first error for the log.
 */

/**
 * A chat exactly as {@link collectWhatsAppChats} returns it, in the shape the
 * service's `formatChat` normalizes.
 *
 * Field names deliberately avoid the WhatsApp `Chat` class members that are
 * methods (`pin`, `mute`, `archive`) so both WhatsApp models and our own minimal
 * mapping objects can be described by one type.
 */
export interface WhatsAppChatModel {
  id?: string | { _serialized?: string; $1?: string }
  name?: string
  formattedTitle?: string
  isGroup?: boolean
  unreadCount?: number
  archived?: boolean
  pinned?: boolean
  isMuted?: boolean
  muteExpiration?: number
  t?: number
  timestamp?: number
  participantCount?: number
  lastMessage?: {
    body?: string
    /** Unix seconds. WhatsApp calls this `t`. */
    t?: number
    timestamp?: number
    fromMe?: boolean
    id?: { fromMe?: boolean }
  }
}

/** Outcome of a chat-list read, including enough detail to log a failure. */
export interface CollectChatsResult {
  chats: WhatsAppChatModel[]
  /** Chats present in WhatsApp's collection. */
  total: number
  /** Chats we could not describe at all (no id) — normally zero. */
  skipped: number
  /** Chats the library's own mapping rejected but our fallback recovered. */
  recovered: number
  /** First mapping error, for the log. */
  firstError: string | null
  /** Set when WhatsApp's chat collection itself could not be reached. */
  collectionError: string | null
}

/**
 * Page function: read every chat from WhatsApp's collection.
 *
 * Runs inside the browser via `page.evaluate`, so it must stay self-contained —
 * no imports, no closures over module scope (the service passes it straight to
 * Puppeteer, which serialises it with `toString()`).
 */
export async function collectWhatsAppChats(): Promise<CollectChatsResult> {
  const g = globalThis as unknown as Record<string, any>
  const result: CollectChatsResult = {
    chats: [],
    total: 0,
    skipped: 0,
    recovered: 0,
    firstError: null,
    collectionError: null,
  }

  /** Read a property that may be a getter, tolerating absent/throwing fields. */
  const safe = <T>(read: () => T | undefined, fallback: T): T => {
    try {
      const value = read()
      return value === undefined || value === null ? fallback : value
    } catch {
      return fallback
    }
  }

  /**
   * Serialized id of a WhatsApp key. WhatsApp Web renamed the serialized form
   * from `_serialized` to `$1` for message keys in recent builds; chat ids still
   * use `_serialized`, so both are accepted.
   */
  const idOf = (key: any): string =>
    safe(() => {
      const raw = key?._serialized ?? key?.$1
      if (typeof raw === "string" && raw) return raw
      const text = typeof key === "string" ? key : String(key ?? "")
      // String({}) would be "[object Object]" — never useful as an id.
      return text.startsWith("[object") ? "" : text
    }, "")

  const numberOr = (read: () => unknown, fallback: number): number =>
    safe(() => {
      const value = Number(read())
      return Number.isFinite(value) ? value : fallback
    }, fallback)

  const describe = (err: unknown): string => {
    if (err instanceof Error) return `${err.name}: ${err.message}`
    return String(err)
  }

  /** Minimal read used when WhatsApp's own mapping rejects a chat. */
  const mapChat = (chat: any): WhatsAppChatModel => {
    const id = idOf(chat?.id)
    const contact = safe(() => chat.contact, null)
    const groupMetadata = safe(() => chat.groupMetadata, null)
    const mute = safe(() => chat.mute, null)
    const name =
      safe(() => String(chat.formattedTitle ?? ""), "") ||
      safe(() => String(chat.name ?? ""), "") ||
      safe(() => String(contact?.pushname ?? ""), "") ||
      safe(() => String(contact?.name ?? ""), "") ||
      safe(() => String(contact?.verifiedName ?? ""), "") ||
      id

    const lastMessage = readLastMessage(chat)
    return {
      id,
      name,
      // `isGroup` is not on the model in every build: a group chat always has
      // group metadata, and group ids end in @g.us.
      isGroup: safe(() => !!chat.isGroup, false) || !!groupMetadata || id.endsWith("@g.us"),
      unreadCount: numberOr(() => chat.unreadCount, 0),
      archived: safe(() => !!(chat.archive ?? chat.archived), false),
      pinned: safe(() => !!chat.pin, false),
      isMuted: numberOr(() => mute?.expiration ?? chat.muteExpiration, 0) > 0,
      muteExpiration: numberOr(() => chat.muteExpiration ?? mute?.expiration, 0),
      t: numberOr(() => chat.t, 0),
      participantCount: groupMetadata
        ? numberOr(() => groupMetadata?.participants?.length, 0)
        : 0,
      lastMessage,
    }
  }

  /**
   * Preview for the chat list. WhatsApp keeps the newest message key on the
   * chat, so the body has to come from the message collection; every read is
   * guarded because a missing/renamed key must not cost us the chat itself.
   */
  const readLastMessage = (chat: any): WhatsAppChatModel["lastMessage"] => {
    const key = safe(() => chat.lastReceivedKey, null)
    const messageId = idOf(key)
    if (!messageId) return undefined
    try {
      const msg = g.require("WAWebCollections").Msg.get(messageId)
      if (!msg) return undefined
      return {
        body: safe(() => String(msg.body ?? ""), ""),
        timestamp: numberOr(() => msg.t, numberOr(() => chat.t, 0)),
        fromMe: safe(() => Boolean(msg.id?.fromMe), false),
      }
    } catch {
      return undefined
    }
  }

  let models: any[]
  try {
    // `WAWebCollections.Chat` is current; `Store.Chat` existed in older builds.
    const collection = g.require("WAWebCollections").Chat ?? g.Store?.Chat
    models = collection.getModelsArray()
  } catch (err) {
    result.collectionError = describe(err)
    return result
  }
  if (!Array.isArray(models)) {
    result.collectionError = "Chat collection did not return an array"
    return result
  }
  result.total = models.length

  const getChatModel = g.WWebJS?.getChatModel
  for (const model of models) {
    let mapped: WhatsAppChatModel | null = null
    let failed = false
    if (typeof getChatModel === "function") {
      try {
        mapped = (await getChatModel(model)) ?? null
      } catch (err) {
        failed = true
        result.firstError ??= describe(err)
      }
    }
    if (!mapped || !idOf(mapped.id)) {
      // Fall back to our own mapping. WhatsApp's own mapping is richer (message
      // previews, group metadata), so it stays the first choice.
      const fallback = safe(() => mapChat(model), null)
      if (fallback && idOf(fallback.id)) {
        if (failed) result.recovered++
        mapped = fallback
      } else {
        result.skipped++
        continue
      }
    }
    result.chats.push(mapped)
  }

  return result
}
