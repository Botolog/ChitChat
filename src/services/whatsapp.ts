import pkg from "whatsapp-web.js"
const { Client, LocalAuth } = pkg
import qrcode from "qrcode-terminal"
import { EventEmitter } from "events"
import { existsSync } from "fs"
import { Logger } from "../utils/logger"
import { mediaCache } from "../utils/mediaCache"

const logger = new Logger("whatsapp.log", "WhatsApp")

/**
 * Resolve the Chromium executable Puppeteer should use.
 *
 * Puppeteer ignores `PUPPETEER_EXECUTABLE_PATH` only when it is unset; if the
 * variable points at a path that does not exist, launch fails with a
 * confusing "Browser was not found at the configured executablePath" error.
 * Snap/package managers frequently leave a stale value behind (or point at
 * `$SNAP/...` paths that were not shipped), so only honour the variable when
 * the file is actually present. Otherwise we return `undefined` and let
 * Puppeteer resolve its bundled browser from PUPPETEER_CACHE_DIR.
 */
function resolveExecutablePath(): string | undefined {
  const configured = process.env.PUPPETEER_EXECUTABLE_PATH
  if (!configured) return undefined
  if (existsSync(configured)) return configured
  logger.warn("WhatsApp", "PUPPETEER_EXECUTABLE_PATH does not exist, ignoring it", {
    executablePath: configured,
  })
  return undefined
}

/**
 * Shared Puppeteer launch options. Kept in one place so the initial client and
 * the reconnect client can never drift apart. Set CHITCHAT_PUPPETEER_DUMPIO=1
 * to pipe the Chromium process stdout/stderr into the app logs when debugging
 * launch failures.
 */
function buildPuppeteerOptions() {
  return {
    headless: true,
    executablePath: resolveExecutablePath(),
    dumpio: process.env.CHITCHAT_PUPPETEER_DUMPIO === "1",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync",
      "--disable-translate",
      "--metrics-recording-only",
      "--mute-audio",
      "--safebrowsing-disable-auto-update",
      "--disable-features=site-per-process",
    ],
    timeout: 120000,
  }
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

export interface MediaAttachment {
  type: 'image' | 'video' | 'audio' | 'document' | 'sticker'
  mimetype: string
  filename?: string
  filesize?: number
  data?: string // Base64 or file path after download
  url?: string
  thumbnail?: string // Base64 thumbnail
}

export interface MessageData {
  id: string
  body: string
  timestamp: number
  fromMe: boolean
  author?: string
  authorName?: string
  hasMedia: boolean
  type: string
  ack?: number
  isForwarded?: boolean
  forwardingScore?: number
  isStarred?: boolean
  hasQuotedMsg?: boolean
  quotedMsgBody?: string
  quotedMsgId?: string
  media?: MediaAttachment
}

export interface ContactData {
  id: string
  name: string
  number: string
  isMyContact: boolean
  isGroup: boolean
  isBlocked: boolean
}

class WhatsAppService extends EventEmitter {
  private client: pkg.Client
  private ready = false
  private qrCode: string | null = null
  private readyFallback: NodeJS.Timeout | null = null

  constructor() {
    super()
    logger.info("WhatsApp", "Creating WhatsApp client")
    const execPath = resolveExecutablePath()
    logger.info("WhatsApp", "Puppeteer config", { 
      executablePath: execPath,
      hasEnvVar: !!process.env.PUPPETEER_EXECUTABLE_PATH,
      cacheDir: process.env.PUPPETEER_CACHE_DIR,
    })
    this.client = new Client({
      authStrategy: new LocalAuth(),
      puppeteer: buildPuppeteerOptions(),
    })
    logger.info("WhatsApp", "Client created, setting up event handlers")
    this.setupEventHandlers()
  }

  private setupEventHandlers() {
    logger.info("WhatsApp", "=== Setting up ALL event handlers ===")

    this.client.on("qr", (qr) => {
      logger.event("WhatsApp", "EVENT: qr received", { qrLength: qr.length })
      logger.debug("WhatsApp", "QR code first 50 chars", { preview: qr.substring(0, 50) })
      this.qrCode = qr
      this.emit("qr", qr)
      logger.debug("WhatsApp", "Emitted qr event to listeners")
    })

    this.client.on("ready", () => {
      logger.event("WhatsApp", "EVENT: ready - WhatsApp client is fully ready!")
      this.markReady("client ready event")
    })

    this.client.on("authenticated", () => {
      logger.event("WhatsApp", "EVENT: authenticated - session validated")
      this.emit("authenticated")
      // whatsapp-web.js sometimes never emits "ready" after "authenticated"
      // (the store sync stalls even though the connection is fine). Without a
      // fallback the app stays stuck on "Authenticated..." forever.
      this.startReadyFallback()
      logger.debug("WhatsApp", "Emitted authenticated event")
    })

    this.client.on("auth_failure", (msg) => {
      logger.error("WhatsApp", "EVENT: auth_failure", { message: msg })
      this.emit("auth_failure", msg)
    })

    this.client.on("disconnected", (reason) => {
      logger.event("WhatsApp", "EVENT: disconnected", { reason })
      logger.warn("WhatsApp", "Setting this.ready = false due to disconnect")
      this.ready = false
      this.emit("disconnected", reason)
    })

    this.client.on("message", (message) => {
      logger.event("WhatsApp", "EVENT: message received", { 
        id: message.id._serialized, 
        from: message.from,
        body: message.body?.substring(0, 30),
        type: message.type
      })
      this.emit("message", this.formatMessage(message))
    })

    this.client.on("message_create", (message) => {
      logger.event("WhatsApp", "EVENT: message_create", { 
        id: message.id._serialized, 
        fromMe: message.fromMe,
        to: message.to
      })
      this.emit("message_create", this.formatMessage(message))
    })

    this.client.on("message_ack", (message, ack) => {
      logger.event("WhatsApp", "EVENT: message_ack", { id: message.id._serialized, ack })
      this.emit("message_ack", { id: message.id._serialized, ack })
    })

    // Typing indicator
    this.client.on("chat_typing", (chat) => {
      logger.event("WhatsApp", "EVENT: chat_typing", { chatId: chat.id._serialized })
      this.emit("typing", { chatId: chat.id._serialized, isTyping: true })
    })

    this.client.on("chat_stopped_typing", (chat) => {
      logger.event("WhatsApp", "EVENT: chat_stopped_typing", { chatId: chat.id._serialized })
      this.emit("typing", { chatId: chat.id._serialized, isTyping: false })
    })

    this.client.on("change_state", (state) => {
      logger.event("WhatsApp", "EVENT: change_state", { state })
      this.emit("state_change", state)
    })

    this.client.on("loading_screen", (percent, message) => {
      logger.event("WhatsApp", "EVENT: loading_screen", { percent, message })
    })

    this.client.on("remote_session_saved", () => {
      logger.event("WhatsApp", "EVENT: remote_session_saved")
    })

    logger.info("WhatsApp", "=== All event handlers registered ===")
  }

  private clearReadyFallback() {
    if (this.readyFallback) {
      clearInterval(this.readyFallback)
      this.readyFallback = null
    }
  }

  /** Mark the client ready exactly once and notify listeners. */
  private markReady(source: string) {
    if (this.ready) return
    this.clearReadyFallback()
    logger.info("WhatsApp", "Setting this.ready = true", { source })
    this.ready = true
    this.qrCode = null
    this.emit("ready")
    logger.info("WhatsApp", "Emitted ready event to listeners")
  }

  /**
   * Safety net for whatsapp-web.js not emitting "ready" after "authenticated".
   *
   * The connection can be fully established (state CONNECTED, chats available)
   * while the "ready" event never arrives, which left the app stuck on
   * "Authenticated..." forever. Poll the connection state and, once it is
   * CONNECTED (or after a bounded ~30s wait), declare the client ready so the
   * UI can proceed to load chats.
   */
  private startReadyFallback() {
    if (this.ready || this.readyFallback) return
    const intervalMs = 2000
    const maxAttempts = 15 // ~30s
    let attempts = 0
    logger.info("WhatsApp", "Starting ready fallback in case the \"ready\" event never fires")
    this.readyFallback = setInterval(async () => {
      attempts++
      if (this.ready) {
        this.clearReadyFallback()
        return
      }
      try {
        const state = await this.client.getState()
        logger.debug("WhatsApp", "Ready fallback: client state", { state, attempts })
        if (state === "CONNECTED") {
          logger.warn("WhatsApp", "\"ready\" never fired but state is CONNECTED - continuing anyway")
          this.markReady("ready fallback: state CONNECTED")
          return
        }
      } catch (err: any) {
        logger.debug("WhatsApp", "Ready fallback: getState() failed", { error: err?.message })
      }
      if (attempts >= maxAttempts) {
        logger.warn("WhatsApp", "Ready fallback timed out - continuing anyway")
        this.markReady("ready fallback: timed out")
      }
    }, intervalMs)
  }

  async initialize(maxRetries: number = 3): Promise<void> {
    logger.info("WhatsApp", "Starting initialization", { maxRetries })
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      logger.info("WhatsApp", `Initialization attempt ${attempt}/${maxRetries}`)
      
      try {
        await this.initializeOnce()
        logger.info("WhatsApp", "Initialization successful!")
        return
      } catch (err: any) {
        logger.error("WhatsApp", `Attempt ${attempt} failed`, { error: err.message })
        
        if (attempt < maxRetries) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 30000)
          logger.info("WhatsApp", `Retrying in ${backoffMs}ms...`)
          await new Promise(resolve => setTimeout(resolve, backoffMs))
        } else {
          logger.error("WhatsApp", "All initialization attempts failed")
          throw err
        }
      }
    }
  }

  private initializeOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const readyHandler = () => {
        logger.info("WhatsApp", "Initialization complete - ready")
        this.removeListener("auth_failure", failHandler)
        resolve()
      }
      const failHandler = (msg: string) => {
        logger.error("WhatsApp", "Initialization failed", { message: msg })
        this.removeListener("ready", readyHandler)
        reject(new Error(`Authentication failed: ${msg}`))
      }
      this.once("ready", readyHandler)
      this.once("auth_failure", failHandler)
      
      logger.info("WhatsApp", "Calling client.initialize()")
      this.client.initialize().catch((err) => {
        logger.error("WhatsApp", "client.initialize() threw error", { 
          message: err.message, 
          stack: err.stack,
          name: err.name 
        })
        reject(err)
      })
    })
  }

  isReady(): boolean {
    return this.ready
  }

  getQrCode(): string | null {
    return this.qrCode
  }

  /**
   * Render a QR payload into a printable string of block characters.
   *
   * Returned rather than printed on purpose: the TUI owns the terminal, so
   * writing to stdout here is invisible/overwritten (this is why the QR never
   * showed up). The UI layer draws the returned string inside a modal.
   */
  renderQrCode(qr: string): string {
    let rendered = ""
    qrcode.generate(qr, { small: true }, (out: string) => {
      rendered = out
    })
    return rendered
  }

  async getChats(): Promise<ChatData[]> {
    logger.info("WhatsApp", "=== getChats() START ===", { ready: this.ready })
    if (!this.ready) {
      logger.warn("WhatsApp", "getChats() called but client not ready!")
      return []
    }
    try {
      // Use direct Store access - client.getChats() hangs in newer versions
      logger.debug("WhatsApp", "Using direct Store.Chat access...")
      const pupPage = (this.client as any).pupPage
      if (!pupPage) {
        logger.error("WhatsApp", "pupPage not available!")
        return []
      }
      
      const rawChats = await pupPage.evaluate(() => {
        // @ts-ignore - accessing WhatsApp Web internals
        const store = window.Store
        if (!store || !store.Chat) {
          return { error: "Store.Chat not available" }
        }
        const chats = store.Chat.getModelsArray()
        return chats.map((c: any) => ({
          id: c.id?._serialized || String(c.id),
          name: c.name || c.contact?.pushname || c.contact?.name || "Unknown",
          isGroup: !!c.isGroup,
          unreadCount: c.unreadCount || 0,
          archived: !!c.archived,
          pinned: !!c.pin,
          muted: c.mute?.expiration > 0,
          timestamp: c.t || 0,
          lastMessageBody: c.lastReceivedKey ? "" : "", // Will get from lastMessage
          participantCount: c.isGroup ? (c.groupMetadata?.participants?.length || 0) : 0
        }))
      })
      
      if (rawChats.error) {
        logger.warn("WhatsApp", "Direct Store access failed - falling back to client.getChats()", { error: rawChats.error })
        return await this.getChatsViaClient()
      }
      
      logger.info("WhatsApp", "Raw chats from Store", { 
        totalCount: rawChats.length,
        firstThree: rawChats.slice(0, 3).map((c: any) => ({ name: c.name, id: c.id }))
      })
      
      const chats = rawChats as any[]
      
      const filtered = chats.filter((chat) => !chat.archived)
      logger.debug("WhatsApp", "After archive filter", { count: filtered.length })
      
      const formatted = filtered.map((chat) => {
        const f = this.formatChat(chat)
        logger.debug("WhatsApp", "Formatted chat", { name: f.name, id: f.id, unread: f.unreadCount })
        return f
      })
      
      const sorted = formatted.sort((a, b) => {
        if (a.pinned && !b.pinned) return -1
        if (!a.pinned && b.pinned) return 1
        const aTime = a.lastMessage?.timestamp ?? 0
        const bTime = b.lastMessage?.timestamp ?? 0
        return bTime - aTime
      })
      
      logger.info("WhatsApp", "=== getChats() COMPLETE ===", { 
        finalCount: sorted.length,
        firstChat: sorted[0]?.name,
        lastChat: sorted[sorted.length - 1]?.name 
      })
      return sorted
    } catch (err) {
      logger.error("WhatsApp", "getChats() EXCEPTION", err)
      return []
    }
  }

  /**
   * Fallback used when WhatsApp Web's internal Store is unreachable: use the
   * public whatsapp-web.js API, bounded by a timeout so a stall cannot hang the
   * UI indefinitely.
   */
  private async getChatsViaClient(): Promise<ChatData[]> {
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("client.getChats() timed out after 30s")), 30000)
      )
      const raw = (await Promise.race([this.client.getChats(), timeout])) as any[]
      logger.info("WhatsApp", "client.getChats() returned chats", { count: raw.length })

      const normalized = raw.map((c: any) => ({
        id: c.id?._serialized || String(c.id),
        name: c.name || c.lastMessage?.body || "Unknown",
        isGroup: !!c.isGroup,
        unreadCount: c.unreadCount || 0,
        archived: !!c.archived,
        pinned: !!c.pinned,
        muted: !!c.isMuted,
        timestamp: c.timestamp || c.lastMessage?.timestamp || 0,
        lastMessageBody: c.lastMessage?.body || "",
        participantCount: c.isGroup ? (c.groupMetadata?.participants?.length || 0) : 0,
      }))

      return normalized
        .filter((chat) => !chat.archived)
        .map((chat) => this.formatChat(chat))
        .sort((a, b) => {
          if (a.pinned && !b.pinned) return -1
          if (!a.pinned && b.pinned) return 1
          return (b.lastMessage?.timestamp ?? 0) - (a.lastMessage?.timestamp ?? 0)
        })
    } catch (err) {
      logger.error("WhatsApp", "getChatsViaClient() failed", err)
      return []
    }
  }

  async getMessages(chatId: string, limit: number = 50): Promise<MessageData[]> {
    logger.debug("WhatsApp", "getMessages() called", { chatId, limit, ready: this.ready })
    if (!this.ready) {
      logger.warn("WhatsApp", "getMessages() called but not ready")
      return []
    }
    try {
      const chat = await this.client.getChatById(chatId)
      const messages = await chat.fetchMessages({ limit })
      logger.info("WhatsApp", "Got messages", { chatId, count: messages.length })
      return messages.map((msg) => this.formatMessage(msg))
    } catch (err) {
      logger.error("WhatsApp", "getMessages() error", err)
      return []
    }
  }

  async sendMessage(chatId: string, content: string, options?: { replyTo?: string }): Promise<MessageData | null> {
    logger.info("WhatsApp", "sendMessage() called", { chatId, contentLength: content.length, replyTo: options?.replyTo })
    if (!this.ready) {
      logger.warn("WhatsApp", "sendMessage() called but not ready")
      return null
    }
    try {
      const chat = await this.client.getChatById(chatId)
      
      // If replying to a message, fetch the quoted message
      let message
      if (options?.replyTo) {
        try {
          const messages = await chat.fetchMessages({ limit: 100 })
          const quotedMsg = messages.find(m => m.id._serialized === options.replyTo)
          if (quotedMsg) {
            message = await quotedMsg.reply(content)
            logger.info("WhatsApp", "Reply sent", { messageId: message.id._serialized, quotedMsgId: options.replyTo })
          } else {
            logger.warn("WhatsApp", "Quoted message not found, sending normal message", { quotedMsgId: options.replyTo })
            message = await chat.sendMessage(content)
          }
        } catch (err) {
          logger.error("WhatsApp", "Error sending reply, falling back to normal message", err)
          message = await chat.sendMessage(content)
        }
      } else {
        message = await chat.sendMessage(content)
      }
      
      logger.info("WhatsApp", "Message sent", { messageId: message.id._serialized })
      return this.formatMessage(message)
    } catch (err) {
      logger.error("WhatsApp", "sendMessage() error", err)
      return null
    }
  }

  async deleteMessage(messageId: string, chatId: string, forMe: boolean): Promise<boolean> {
    logger.info("WhatsApp", "deleteMessage() called", { messageId, chatId, forMe })
    if (!this.ready) {
      logger.warn("WhatsApp", "deleteMessage() called but not ready")
      return false
    }
    try {
      const chat = await this.client.getChatById(chatId)
      const messages = await chat.fetchMessages({ limit: 100 })
      const message = messages.find(m => m.id._serialized === messageId)
      
      if (!message) {
        logger.warn("WhatsApp", "Message not found for deletion", { messageId })
        return false
      }
      
      // Delete for everyone or just for me
      if (forMe) {
        await message.delete(true) // true = delete for me only
        logger.info("WhatsApp", "Message deleted for me", { messageId })
      } else {
        await message.delete(false) // false = delete for everyone
        logger.info("WhatsApp", "Message deleted for everyone", { messageId })
      }
      
      return true
    } catch (err) {
      logger.error("WhatsApp", "deleteMessage() error", err)
      return false
    }
  }

  async editMessage(messageId: string, chatId: string, newText: string): Promise<boolean> {
    logger.info("WhatsApp", "editMessage() called", { messageId, chatId, newTextLength: newText.length })
    if (!this.ready) {
      logger.warn("WhatsApp", "editMessage() called but not ready")
      return false
    }
    try {
      const chat = await this.client.getChatById(chatId)
      const messages = await chat.fetchMessages({ limit: 100 })
      const message = messages.find(m => m.id._serialized === messageId)
      
      if (!message) {
        logger.warn("WhatsApp", "Message not found for editing", { messageId })
        return false
      }
      
      // Check if message is from me
      if (!message.fromMe) {
        logger.warn("WhatsApp", "Cannot edit message not from me", { messageId })
        return false
      }
      
      // Edit the message
      await message.edit(newText)
      logger.info("WhatsApp", "Message edited successfully", { messageId })
      
      return true
    } catch (err) {
      logger.error("WhatsApp", "editMessage() error", err)
      return false
    }
  }

  async markAsRead(chatId: string): Promise<void> {
    logger.debug("WhatsApp", "markAsRead() called", { chatId })
    if (!this.ready) return
    try {
      const chat = await this.client.getChatById(chatId)
      await chat.sendSeen()
      logger.debug("WhatsApp", "Marked as read", { chatId })
    } catch (err) {
      logger.error("WhatsApp", "markAsRead() error", err)
    }
  }

  async pinChat(chatId: string, pin: boolean): Promise<boolean> {
    logger.info("WhatsApp", "pinChat() called", { chatId, pin })
    if (!this.ready) return false
    try {
      const chat = await this.client.getChatById(chatId)
      if (pin) {
        await chat.pin()
      } else {
        await chat.unpin()
      }
      logger.info("WhatsApp", "Chat pin toggled", { chatId, pin })
      return true
    } catch (err) {
      logger.error("WhatsApp", "pinChat() error", err)
      return false
    }
  }

  async muteChat(chatId: string, mute: boolean): Promise<boolean> {
    logger.info("WhatsApp", "muteChat() called", { chatId, mute })
    if (!this.ready) return false
    try {
      const chat = await this.client.getChatById(chatId)
      if (mute) {
        await chat.mute()
      } else {
        await chat.unmute()
      }
      logger.info("WhatsApp", "Chat mute toggled", { chatId, mute })
      return true
    } catch (err) {
      logger.error("WhatsApp", "muteChat() error", err)
      return false
    }
  }

  async archiveChat(chatId: string, archive: boolean): Promise<boolean> {
    logger.info("WhatsApp", "archiveChat() called", { chatId, archive })
    if (!this.ready) return false
    try {
      const chat = await this.client.getChatById(chatId)
      if (archive) {
        await chat.archive()
      } else {
        await chat.unarchive()
      }
      logger.info("WhatsApp", "Chat archive toggled", { chatId, archive })
      return true
    } catch (err) {
      logger.error("WhatsApp", "archiveChat() error", err)
      return false
    }
  }

  async getContactInfo(contactId: string): Promise<ContactData | null> {
    if (!this.ready) return null
    try {
      const contact = await this.client.getContactById(contactId)
      return {
        id: contact.id._serialized,
        name: contact.name || contact.pushname || contact.number || "Unknown",
        number: contact.number || "",
        isMyContact: contact.isMyContact,
        isGroup: contact.isGroup,
        isBlocked: contact.isBlocked,
      }
    } catch {
      return null
    }
  }

  private formatChat(chat: any): ChatData {
    // Handle both whatsapp-web.js Chat objects and plain Store objects
    const chatId = chat.id?._serialized || chat.id
    const chatName = chat.name || "Unknown"
    
    logger.debug("WhatsApp", "formatChat() called", { 
      chatId, 
      chatName,
      isGroup: chat.isGroup,
      unreadCount: chat.unreadCount
    })
    
    const formatted: ChatData = {
      id: chatId,
      name: chatName,
      isGroup: !!chat.isGroup,
      unreadCount: chat.unreadCount || 0,
      pinned: !!chat.pinned || !!chat.pin,
      muted: !!chat.muted || !!chat.isMuted,
      archived: !!chat.archived,
      participantCount: chat.participantCount,
      lastMessage: chat.timestamp
        ? {
            body: chat.lastMessageBody || "",
            timestamp: chat.timestamp,
            fromMe: false,
          }
        : undefined,
    }
    logger.debug("WhatsApp", "formatChat() complete", { name: formatted.name, id: formatted.id })
    return formatted
  }

  private formatMessage(message: pkg.Message): MessageData {
    logger.debug("WhatsApp", "formatMessage() called", { 
      id: message.id._serialized, 
      fromMe: message.fromMe, 
      type: message.type,
      hasMedia: message.hasMedia
    })
    const msgAny = message as any
    
    // Extract media info if present
    let media: MediaAttachment | undefined
    if (message.hasMedia) {
      const mediaType = this.getMediaType(message.type)
      const filename = msgAny._data?.filename || msgAny.filename || 'media'
      
      media = {
        type: mediaType,
        mimetype: msgAny.mimetype || 'application/octet-stream',
        filename: filename,
        filesize: msgAny.filesize || msgAny._data?.size,
        // Store message ID and timestamp for cache lookup
        data: message.id._serialized,
      }
      logger.debug("WhatsApp", "Message has media", { 
        type: mediaType, 
        mimetype: media.mimetype,
        filename: media.filename
      })
    }
    
    // Debug quoted message extraction
    if (msgAny.hasQuotedMsg) {
      logger.info("WhatsApp", "Message has quoted msg", {
        hasQuotedMsg: msgAny.hasQuotedMsg,
        quotedMsgData: !!msgAny._data?.quotedMsg,
        quotedMsgId_path1: msgAny._data?.quotedMsg?.id?._serialized,
        quotedMsgId_path2: msgAny._data?.quotedStanzaID,
        quotedMsgBody: msgAny._data?.quotedMsg?.body?.slice(0, 30),
      })
    }
    
    // Try multiple paths for quotedMsgId since WhatsApp structure varies
    const quotedMsgId = msgAny._data?.quotedMsg?.id?._serialized || 
                        msgAny._data?.quotedStanzaID ||
                        msgAny.quotedMsgId
    
    return {
      id: message.id._serialized,
      body: message.body || "",
      timestamp: message.timestamp,
      fromMe: message.fromMe,
      author: message.author,
      hasMedia: message.hasMedia,
      type: message.type,
      ack: message.ack,
      isForwarded: msgAny.isForwarded || false,
      forwardingScore: msgAny.forwardingScore,
      isStarred: msgAny.isStarred || false,
      hasQuotedMsg: msgAny.hasQuotedMsg || false,
      quotedMsgBody: msgAny._data?.quotedMsg?.body,
      quotedMsgId: quotedMsgId,
      media,
    }
  }

  private getMediaType(messageType: string): MediaAttachment['type'] {
    if (messageType.includes('image')) return 'image'
    if (messageType.includes('video')) return 'video'
    if (messageType.includes('audio') || messageType.includes('ptt')) return 'audio'
    if (messageType.includes('sticker')) return 'sticker'
    return 'document'
  }

  async downloadMedia(messageId: string, chatId: string): Promise<string | null> {
    logger.info("WhatsApp", "downloadMedia() called", { messageId, chatId })
    if (!this.ready) {
      logger.warn("WhatsApp", "downloadMedia() called but not ready")
      return null
    }

    try {
      // Get the chat and fetch the specific message
      const chat = await this.client.getChatById(chatId)
      const chatName = chat.name || chatId
      const messages = await chat.fetchMessages({ limit: 100 })
      const waMessage = messages.find((m: any) => m.id._serialized === messageId)
      
      if (!waMessage || !waMessage.hasMedia) {
        logger.warn("WhatsApp", "Message not found or has no media", { messageId })
        return null
      }

      const msgAny = waMessage as any
      const filename = msgAny._data?.filename || msgAny.filename || 'media'
      // Use MESSAGE timestamp, not current time!
      const timestamp = waMessage.timestamp
      const mimetype = msgAny.mimetype || 'application/octet-stream'
      
      logger.info("WhatsApp", "Media info extracted", { 
        filename, 
        timestamp, 
        messageDate: new Date(timestamp * 1000).toISOString()
      })
      
      // Check cache first
      const cached = mediaCache.get(chatName, filename, timestamp, mimetype)
      if (cached) {
        logger.info("WhatsApp", "Media found in cache", { messageId, cached })
        return cached
      }

      logger.info("WhatsApp", "Downloading media...")
      const media = await waMessage.downloadMedia()
      
      if (!media) {
        logger.error("WhatsApp", "Failed to download media")
        return null
      }

      // Cache the media with chatname+filename+timestamp hash
      const buffer = Buffer.from(media.data, 'base64')
      const filePath = await mediaCache.cache(chatName, filename, timestamp, buffer, media.mimetype)
      
      logger.info("WhatsApp", "Media downloaded and cached", { 
        messageId,
        chatName,
        filename,
        filePath,
        size: buffer.length,
        mimetype: media.mimetype
      })

      return filePath
    } catch (err) {
      logger.error("WhatsApp", "downloadMedia() error", err)
      return null
    }
  }

  async destroy(): Promise<void> {
    logger.info("WhatsApp", "Destroying client")
    try {
      await this.client.destroy()
      this.ready = false
      logger.info("WhatsApp", "Client destroyed")
    } catch (err) {
      logger.error("WhatsApp", "Error destroying client", err)
    }
  }

  async reconnect(): Promise<void> {
    logger.info("WhatsApp", "Attempting to reconnect...")
    try {
      await this.destroy()
      logger.info("WhatsApp", "Client destroyed, waiting before reconnect...")
      await new Promise(resolve => setTimeout(resolve, 2000))
      
      // Recreate client
      this.client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: buildPuppeteerOptions(),
      })
      
      this.setupEventHandlers()
      await this.initialize()
      logger.info("WhatsApp", "Reconnection successful!")
    } catch (err) {
      logger.error("WhatsApp", "Reconnection failed", err)
      throw err
    }
  }

  getConnectionState(): { ready: boolean; hasQr: boolean } {
    return {
      ready: this.ready,
      hasQr: this.qrCode !== null
    }
  }
}

export const whatsapp = new WhatsAppService()
