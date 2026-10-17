/**
 * Runtime compatibility layer for the WhatsApp Web build that
 * `whatsapp-web.js` 1.34.7 — the newest release — does not cope with.
 *
 * WhatsApp Web 2.3000.x renamed the serialized id of *message keys* from
 * `_serialized` to `$1`. The library reads `msg.id._serialized` in ~30 places
 * and maps every chat with `chat.serialize()` inside one `Promise.all`, so on
 * that build:
 *
 * - `client.getChatById()` rejects with an opaque `r: r` (WhatsApp's minified
 *   error for a lookup with an undefined key), which takes down *every* call our
 *   UI makes — messages, sending, marking read, pinning, media;
 * - `client.getChats()` throws away every chat as soon as one of them fails;
 * - message ids come back as `undefined`, so replies, deletes, edits and media
 *   downloads lose their target.
 *
 * Upstream has fixes for this in review (wwebjs/whatsapp-web.js#201845, PR
 * #201850) but nothing released, so ChitChat applies them itself, at runtime,
 * after `whatsapp-web.js` has injected `window.WWebJS`:
 *
 * 1. every message key gets its `_serialized` back — the alias goes on the key
 *    class up front (the library's own send path looks up the key it has just
 *    built by that name), plus the copy the upstream patch makes on serialized
 *    models;
 * 2. `getMessageModel` and `getChatModel` never throw — a chat or message that
 *    WhatsApp cannot serialize degrades to a minimal, plain model instead of
 *    taking the whole call with it;
 * 3. `getChats` keeps the chats that do map instead of rejecting;
 * 4. `getMsgKeyId` (the helper the upstream patch adds) exists for any caller
 *    that looks it up.
 *
 * Nothing here is version-specific guesswork: each wrapper tries the original
 * implementation first and only steps in when it fails, so a fixed WhatsApp Web
 * build (or a future library release) behaves exactly as before. The counters in
 * the report are written into the page-state dump, so a real-world failure says
 * *which* fallback fired instead of showing a bare `r: r`.
 */

/** What {@link installWhatsAppCompat} did, and how often its fallbacks fired. */
export interface WhatsAppCompatReport {
  /** `window.WWebJS` exists (whatsapp-web.js has been injected). */
  available: boolean
  alreadyInstalled: boolean
  /** Names of the patches that were applied, in order. */
  patches: string[]
  wwebVersion: string | null
  /** Chats WhatsApp could not serialize (mapped by us instead). */
  chatModelFallbacks: number
  /** Messages WhatsApp could not serialize (mapped by us instead). */
  messageModelFallbacks: number
  /** First failure seen, for the log. */
  firstError: string | null
}

/**
 * Page function: install the compatibility layer.
 *
 * Idempotent — library calls the report's counters live, so calling it again
 * just returns the same object. Safe to call before WhatsApp defines
 * `window.WWebJS` (`available: false`), which is why the service calls it again
 * once the client reports itself ready.
 */
export function installWhatsAppCompat(): WhatsAppCompatReport {
  const g = globalThis as unknown as Record<string, any>
  const existing = g.__chitchatCompat as WhatsAppCompatReport | undefined
  if (existing) {
    existing.alreadyInstalled = true
    return existing
  }

  const report: WhatsAppCompatReport = {
    available: false,
    alreadyInstalled: false,
    patches: [],
    wwebVersion: null,
    chatModelFallbacks: 0,
    messageModelFallbacks: 0,
    firstError: null,
  }
  const applied: Record<string, boolean> = {}
  const mark = (name: string): void => {
    if (applied[name]) return
    applied[name] = true
    report.patches.push(name)
  }
  const note = (err: unknown): void => {
    if (report.firstError === null) {
      report.firstError = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    }
  }
  /** Read a property that may be a getter, tolerating absent/throwing fields. */
  const read = <T>(fn: () => T | undefined, fallback: T): T => {
    try {
      const value = fn()
      return value === undefined || value === null ? fallback : value
    } catch {
      return fallback
    }
  }
  const numberOr = (fn: () => unknown, fallback: number): number =>
    read(() => {
      const value = Number(fn())
      return Number.isFinite(value) ? value : fallback
    }, fallback)

  /** Serialized id of a WhatsApp key (`_serialized`, or `$1` after the rename). */
  const idOf = (key: any): string =>
    read(() => {
      const raw = key && (key._serialized ?? key.$1)
      if (typeof raw === "string" && raw) return raw
      const text = typeof key === "string" ? key : String(key ?? "")
      return text.startsWith("[object") ? "" : text
    }, "")

  /**
   * Give the message-key class its `_serialized` back.
   *
   * The renamed field is an *instance* property, so the alias belongs on the
   * class prototype — and instances that still set `_serialized` themselves keep
   * their own value (an own property always wins), which makes this inert on
   * builds that never renamed anything. `Object.prototype` is never touched.
   */
  const aliasKeyPrototype = (proto: any): void => {
    if (!proto || proto === Object.prototype) return
    if (Object.prototype.hasOwnProperty.call(proto, "_serialized")) return
    try {
      Object.defineProperty(proto, "_serialized", {
        configurable: true,
        get(this: any) {
          return this.$1
        },
        // A setter-less accessor would make `key._serialized = …` throw in strict
        // mode; assigning keeps normal semantics by creating an own property.
        set(this: any, value: unknown) {
          Object.defineProperty(this, "_serialized", {
            configurable: true,
            writable: true,
            enumerable: true,
            value,
          })
        },
      })
      mark("messageKey._serialized")
    } catch (err) {
      note(err)
    }
  }

  /**
   * Restore `_serialized` on one key object.
   *
   * Raw keys are covered by {@link aliasKeyPrototype}; serialized models hand out
   * plain objects (`Object.assign({}, msg.id, …)` in `getMessageModel`), which
   * need the property copied onto them individually — what the upstream patch
   * does.
   */
  const aliasKey = (key: any): void => {
    if (!key || typeof key !== "object") return
    if (typeof key._serialized === "string") return
    if (typeof key.$1 !== "string") return
    aliasKeyPrototype(Object.getPrototypeOf(key))
    if (typeof key._serialized !== "string") {
      try {
        Object.defineProperty(key, "_serialized", {
          value: key.$1,
          configurable: true,
          writable: true,
          enumerable: true,
        })
      } catch (err) {
        note(err)
      }
    }
  }

  const W = g.WWebJS
  if (!W || typeof W !== "object") return report
  report.available = true
  report.wwebVersion = read(() => g.Debug.VERSION, null)
  g.__chitchatCompat = report

  /** Minimal message, used only when WhatsApp's own mapping rejects one. */
  const minimalMessage = (message: any): any => {
    const key = read(() => message && message.id, null)
    const id = idOf(key)
    const fromMe = read(() => Boolean(key && key.fromMe), false)
    return {
      id: id
        ? {
            _serialized: id,
            fromMe,
            remote: read(() => key.remote, undefined),
            id: read(() => key.id, undefined),
          }
        : undefined,
      body: read(() => (message ? message.body || message.caption : ""), ""),
      caption: read(() => message.caption, undefined),
      type: read(() => message.type, "chat"),
      t: numberOr(() => message.t, 0),
      from: read(() => message.from, undefined),
      to: read(() => message.to, undefined),
      author: read(() => message.author, undefined),
      ack: numberOr(() => message.ack, 0),
      isForwarded: read(() => Boolean(message.isForwarded), false),
      forwardingScore: numberOr(() => message.forwardingScore, 0),
      star: read(() => Boolean(message.star), false),
      directPath: read(() => message.directPath, undefined),
      mimetype: read(() => message.mimetype, undefined),
      filename: read(() => message.filename, undefined),
      size: numberOr(() => message.size, 0),
      quotedStanzaID: read(() => message.quotedStanzaID, undefined),
      isStatusV3: false,
    }
  }

  /**
   * Minimal chat, used only when WhatsApp's own mapping rejects one.
   *
   * `Chat` reads `id._serialized`, so the id stays an object — a plain string
   * would make `chat.sendMessage()` send to `undefined`.
   */
  const minimalChat = (chat: any, options: any): any => {
    if (!chat) return null
    const isChannel = Boolean(options && options.isChannel)
    const id = idOf(read(() => chat.id, null))
    const groupMetadata = read(() => chat.groupMetadata, null)
    const mute = read(() => chat.mute, null)
    const contact = read(() => chat.contact, null)
    const title =
      read(() => chat.formattedTitle, "") ||
      read(() => chat.name, "") ||
      read(() => contact.pushname, "") ||
      read(() => contact.name, "")
    return {
      id: id ? { _serialized: id } : undefined,
      name: title || id,
      formattedTitle: title || id,
      isGroup:
        !isChannel &&
        (read(() => Boolean(chat.isGroup), false) || Boolean(groupMetadata) || id.endsWith("@g.us")),
      isChannel,
      isReadOnly: false,
      isLocked: false,
      unreadCount: numberOr(() => chat.unreadCount, 0),
      t: numberOr(() => chat.t, 0),
      archive: read(() => Boolean(chat.archive), false),
      pin: read(() => Boolean(chat.pin), false),
      isMuted: numberOr(() => chat.muteExpiration || (mute && mute.expiration), 0) > 0,
      muteExpiration: numberOr(() => chat.muteExpiration || (mute && mute.expiration), 0),
      // Group metadata is what made WhatsApp's own mapping throw for LID chats;
      // leaving it out keeps `GroupChat`'s lazy getters out of the failure path.
      groupMetadata: null,
      lastMessage: null,
    }
  }

  // 1. Message keys: installed on the class up front, because it has to be in
  //    place before the *first* key is built. whatsapp-web.js' own send path
  //    looks a brand-new key up by `_serialized` (see `sendMessage` in the
  //    library's injected utils), so waiting for a key to show up in a listing
  //    is not enough.
  aliasKeyPrototype(read(() => g.require("WAWebMsgKey").prototype, null))

  // 2. The helper the upstream patch introduces, for callers that look it up.
  if (typeof W.getMsgKeyId !== "function") {
    W.getMsgKeyId = (key: any): string | undefined => idOf(key) || undefined
    mark("getMsgKeyId")
  }

  // 3. Messages: alias the key, and never let one message break a listing.
  const originalGetMessageModel = W.getMessageModel
  if (typeof originalGetMessageModel === "function") {
    W.getMessageModel = function (this: any, ...args: any[]): any {
      const message = args[0]
      aliasKey(read(() => message.id, null))
      let model: any = null
      try {
        model = originalGetMessageModel.apply(this, args)
      } catch (err) {
        note(err)
        report.messageModelFallbacks++
      }
      if (!model) model = minimalMessage(message)
      // Serialized models carry a plain id object, which the prototype getter
      // above cannot reach.
      aliasKey(read(() => model.id, null))
      return model
    }
    mark("getMessageModel")
  }

  // 4. Chats: same, but the fallback has to keep `id` an object (see above).
  const originalGetChatModel = W.getChatModel
  if (typeof originalGetChatModel === "function") {
    W.getChatModel = async function (this: any, ...args: any[]): Promise<any> {
      const chat = args[0]
      // The rename breaks the library's *own* chat mapping too: it looks the
      // last message up by `chat.lastReceivedKey._serialized`, which is `$1`
      // here, so the lookup runs with an undefined key and WhatsApp throws. With
      // the key aliased first, that mapping — preview, title and all — works.
      aliasKey(read(() => chat.lastReceivedKey, null))
      aliasKey(read(() => chat.id, null))
      try {
        const model = await originalGetChatModel.apply(this, args)
        if (model) return model
      } catch (err) {
        note(err)
        report.chatModelFallbacks++
      }
      return minimalChat(chat, args[1])
    }
    mark("getChatModel")
  }

  // 5. `getChats` as the upstream patch rewrites it: one bad chat costs one chat.
  const originalGetChats = W.getChats
  if (typeof originalGetChats === "function") {
    W.getChats = async function (this: any, ...args: any[]): Promise<any[]> {
      try {
        return await originalGetChats.apply(this, args)
      } catch (err) {
        note(err)
      }
      const chats = read(() => g.require("WAWebCollections").Chat.getModelsArray(), [] as any[])
      const models: any[] = []
      for (const chat of chats) {
        let model: any = null
        try {
          model = await W.getChatModel(chat)
        } catch (err) {
          note(err)
        }
        if (model) models.push(model)
      }
      return models
    }
    mark("getChats")
  }

  return report
}
