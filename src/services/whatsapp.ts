import pkg from "whatsapp-web.js"
const { Client, LocalAuth, WAState } = pkg
import { existsSync } from "fs"
import { join } from "path"
import { Logger } from "../utils/logger"
import { mediaCache } from "../utils/mediaCache"
import { renderQrBlocks } from "../utils/qr"
import { resolveDataPath } from "../utils/paths"
import { recoverProfileLock, ProfileLockedError } from "../utils/profileLock"
import { clearWhatsAppTabState } from "../utils/whatsappTabState"
import { BaseMessagingService } from "./base"
import type { ServiceCapabilities } from "./capabilities"
import type {
  ChatData,
  ContactData,
  MediaAttachment,
  MessageData,
  SendMessageOptions,
} from "./types"

export type { ChatData, ContactData, MediaAttachment, MessageData }

const logger = new Logger("whatsapp.log", "WhatsApp")

/** Directory holding whatsapp-web.js' `LocalAuth` session (the Chromium profile). */
function whatsappAuthDataPath(): string {
  return resolveDataPath(".wwebjs_auth")
}

/** Chromium profile directory for the default (clientId-less) LocalAuth session. */
function whatsappSessionDir(): string {
  return join(whatsappAuthDataPath(), "session")
}

/**
 * How long a single `client.initialize()` may take before we give up on it.
 * This covers booting Chromium, loading WhatsApp Web and launching its socket —
 * not the QR scan itself, which happens after `initialize()` resolves. Override
 * with `CHITCHAT_WHATSAPP_INIT_TIMEOUT_MS` (handy for fast local debugging).
 */
const INIT_TIMEOUT_MS = Number(process.env.CHITCHAT_WHATSAPP_INIT_TIMEOUT_MS) || 180000

/**
 * Minimal structural view of the puppeteer `Page` we touch for diagnostics.
 * Declared locally so we do not depend on puppeteer's own typings (which arrive
 * transitively through `whatsapp-web.js`).
 */
interface DiagnosticPage {
  on(event: string, handler: (...args: never[]) => void): unknown
  evaluate<T>(fn: () => T): Promise<T>
}

/** Capabilities advertised to the UI. */
const WHATSAPP_CAPABILITIES: ServiceCapabilities = {
  qrAuth: true,
  deleteMessage: "both",
  editMessage: true,
  pin: true,
  mute: true,
  archive: true,
  downloadMedia: true,
  reply: true,
}

/**
 * Structural view of a chat used by `formatChat`.
 *
 * Field names deliberately avoid the WhatsApp `Chat` class members that are
 * methods (`pin`, `mute`, `archive`) so both `Chat` instances and the plain
 * objects returned by the `window.Store` fast path can be normalized here.
 */
interface ChatLike {
  id?: string | { _serialized?: string }
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
    timestamp?: number
    fromMe?: boolean
    id?: { fromMe?: boolean }
  }
}

/** Minimal Puppeteer `Page` surface used for the `window.Store` fast path. */
interface StorePage {
  evaluate<T>(pageFunction: () => T | Promise<T>): Promise<T>
}

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

/**
 * Shared `whatsapp-web.js` client options. Kept in one place so the initial
 * client and the reconnect client can never drift apart.
 *
 * Two WhatsApp Web behaviours make this client unusable in the field, so both
 * are neutralised here (see {@link clearWhatsAppTabState}):
 *
 * - `evalOnNewDoc` drops stale tab-coordination state, without which a launch
 *   can hang forever on "WhatsApp is open in another window".
 * - `takeoverOnConflict` makes this client reclaim the session when WhatsApp's
 *   server reports that another browser is using it, instead of disconnecting
 *   and requiring a restart.
 */
function buildClientOptions(): pkg.ClientOptions {
  return {
    authStrategy: new LocalAuth({ dataPath: whatsappAuthDataPath() }),
    puppeteer: buildPuppeteerOptions(),
    evalOnNewDoc: clearWhatsAppTabState,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 0,
  }
}

class WhatsAppService extends BaseMessagingService {
  readonly id = "whatsapp"
  readonly displayName = "WhatsApp"

  private client: pkg.Client
  /** One-shot safety net used when whatsapp-web.js never emits `ready`. */
  private readyFallback: NodeJS.Timeout | null = null
  /** Guards against double-registering client event handlers. */
  private handlersRegistered = false
  /** Single-flight guard for `initialize()` so retries cannot overlap. */
  private initializePromise: Promise<void> | null = null
  /** Interval that waits for `client.pupPage` so page diagnostics attach early. */
  private diagnosticsPoll: NodeJS.Timeout | null = null
  /** The page diagnostics are already attached to (attach at most once). */
  private diagnosticsPage: unknown = null

  constructor() {
    super()
    logger.info("WhatsApp", "Creating WhatsApp client")
    logger.info("WhatsApp", "Puppeteer config", {
      executablePath: resolveExecutablePath(),
      hasEnvVar: !!process.env.PUPPETEER_EXECUTABLE_PATH,
      cacheDir: process.env.PUPPETEER_CACHE_DIR,
    })
    this.client = new Client(buildClientOptions())
    this.setupEventHandlers()
  }

  override capabilities(): ServiceCapabilities {
    return { ...WHATSAPP_CAPABILITIES }
  }

  /**
   * Register the client event handlers exactly once per client instance.
   *
   * `client.initialize()` may be retried and `reconnect()` builds a new client;
   * both paths call this again, so the flag prevents duplicate listeners that
   * would otherwise emit duplicate `message`/`qr` events.
   */
  private setupEventHandlers(): void {
    if (this.handlersRegistered) return
    this.handlersRegistered = true
    logger.info("WhatsApp", "=== Setting up ALL event handlers ===")

    this.client.on("qr", (qr) => {
      logger.event("WhatsApp", "EVENT: qr received", { qrLength: qr.length })
      logger.debug("WhatsApp", "QR code first 50 chars", { preview: qr.substring(0, 50) })
      this.setQr(qr)
      logger.debug("WhatsApp", "Emitted qr event to listeners")
    })

    this.client.on("ready", () => {
      logger.event("WhatsApp", "EVENT: ready - WhatsApp client is fully ready!")
      void this.logWWebVersion()
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
      logger.warn("WhatsApp", "Setting ready = false due to disconnect")
      this.clearReadyFallback()
      this.ready = false
      this.emit("disconnected", reason)
    })

    this.client.on("message", (message) => {
      logger.event("WhatsApp", "EVENT: message received", {
        id: message.id._serialized,
        from: message.from,
        body: message.body?.substring(0, 30),
        type: message.type,
      })
      this.emit("message", this.formatMessage(message))
    })

    this.client.on("message_create", (message) => {
      logger.event("WhatsApp", "EVENT: message_create", {
        id: message.id._serialized,
        fromMe: message.fromMe,
        to: message.to,
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

    // Never let a provider-level "error" crash the app: Node throws on an
    // `error` event with no listener, and the reserved name must stay unused.
    this.client.on("error", (error) => {
      logger.error("WhatsApp", "EVENT: client error", error)
      this.emit("service_error", error)
    })

    logger.info("WhatsApp", "=== All event handlers registered ===")
  }

  /** Cancel the single ready fallback timer, if one is running. */
  private clearReadyFallback(): void {
    if (this.readyFallback) {
      this.untrack(this.readyFallback)
      clearInterval(this.readyFallback)
      this.readyFallback = null
    }
  }

  /** Clear the fallback before the shared readiness transition fires. */
  protected override markReady(source: string): void {
    this.clearReadyFallback()
    super.markReady(source)
  }

  /**
   * Safety net for whatsapp-web.js not emitting "ready" after "authenticated".
   *
   * The connection can be fully established (state CONNECTED, chats available)
   * while the "ready" event never arrives, which left the app stuck on
   * "Authenticated..." forever. Poll the connection state and, once it is
   * CONNECTED (or after a bounded ~30s wait), declare the client ready so the
   * UI can proceed to load chats.
   *
   * Exactly one timer can exist: `readyFallback` doubles as the guard and is
   * cleared on ready/disconnected/destroy.
   */
  private startReadyFallback(): void {
    if (this.ready || this.readyFallback) return
    const intervalMs = 2000
    const maxAttempts = 15 // ~30s
    let attempts = 0
    logger.info("WhatsApp", 'Starting ready fallback in case the "ready" event never fires')
    this.readyFallback = this.track(
      setInterval(() => {
        void this.pollReadyState(++attempts, maxAttempts)
      }, intervalMs),
    )
  }

  private async pollReadyState(attempts: number, maxAttempts: number): Promise<void> {
    if (this.ready) {
      this.clearReadyFallback()
      return
    }
    try {
      const state = await this.client.getState()
      logger.debug("WhatsApp", "Ready fallback: client state", { state, attempts })
      if (state === WAState.CONNECTED) {
        logger.warn('WhatsApp', '"ready" never fired but state is CONNECTED - continuing anyway')
        this.markReady("ready fallback: state CONNECTED")
        return
      }
    } catch (err) {
      logger.debug("WhatsApp", "Ready fallback: getState() failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    if (attempts >= maxAttempts) {
      logger.warn("WhatsApp", "Ready fallback timed out - continuing anyway")
      this.markReady("ready fallback: timed out")
    }
  }

  override async initialize(maxRetries: number = 3): Promise<void> {
    if (this.initializePromise) return this.initializePromise
    this.initializePromise = this.runInitialize(maxRetries).finally(() => {
      this.initializePromise = null
    })
    return this.initializePromise
  }

  private async runInitialize(maxRetries: number): Promise<void> {
    logger.info("WhatsApp", "Starting initialization", { maxRetries })

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      logger.info("WhatsApp", `Initialization attempt ${attempt}/${maxRetries}`)
      try {
        await this.initializeOnce()
        logger.info("WhatsApp", "Initialization successful!")
        return
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error("WhatsApp", `Attempt ${attempt} failed`, { error: message })
        // Capture what the page was actually showing — this is the only way to
        // tell an unsupported-browser screen from a blocked WebSocket.
        await this.dumpPageState(`attempt ${attempt} failed: ${message}`)
        // A live lock owner will not go away by retrying: fail fast with the
        // actionable message instead of burning the backoff window.
        if (err instanceof ProfileLockedError) {
          logger.error(
            "WhatsApp",
            "Aborting retries: WhatsApp session is locked by another process",
            { ownerPid: err.ownerPid, dir: whatsappSessionDir() },
          )
          throw err
        }
        if (attempt >= maxRetries) {
          logger.error("WhatsApp", "All initialization attempts failed")
          throw err
        }
        // Best effort: make sure a half-started browser from this attempt is
        // gone so it cannot hold the profile lock for the next one.
        await this.closeBrowserBestEffort()
        const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 30000)
        logger.info("WhatsApp", `Retrying in ${backoffMs}ms...`)
        await new Promise((resolve) => setTimeout(resolve, backoffMs))
      }
    }
  }

  /**
   * Single initialization attempt: start the browser and wait for the service
   * to become ready (or authentication to fail). Listeners are always removed,
   * so a failed/timed-out attempt leaves nothing behind and can be retried.
   */
  private initializeOnce(): Promise<void> {
    // Recover a leftover Chromium profile lock before launching. Throws a
    // `ProfileLockedError` (with the owner PID) when another live process still
    // owns the profile.
    const lock = recoverProfileLock(whatsappSessionDir())
    if (lock.recovered) {
      logger.warn("WhatsApp", "Removed stale Chromium profile lock", {
        dir: whatsappSessionDir(),
        ownerPid: lock.ownerPid,
      })
    }
    this.attachPageDiagnostics()
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.removeListener("ready", readyHandler)
        this.removeListener("auth_failure", failHandler)
      }
      const readyHandler = () => {
        logger.info("WhatsApp", "Initialization complete - ready")
        cleanup()
        resolve()
      }
      const failHandler = (msg: string) => {
        logger.error("WhatsApp", "Initialization failed", { message: msg })
        cleanup()
        reject(new Error(`Authentication failed: ${msg}`))
      }
      this.once("ready", readyHandler)
      this.once("auth_failure", failHandler)

      logger.info("WhatsApp", "Calling client.initialize()")
      // Bounded so a browser launch that never settles fails the attempt
      // instead of hanging the caller forever. Waiting for `ready` itself is
      // intentionally unbounded (that is the QR-scan wait, and the ready
      // fallback bounds it once authenticated).
      this.withTimeout(this.client.initialize(), INIT_TIMEOUT_MS, "client.initialize()").catch((err) => {
        cleanup()
        logger.error("WhatsApp", "client.initialize() threw error", {
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        })
        reject(err)
      })
    })
  }

  /**
   * Attach page-level diagnostics to the WhatsApp Web page.
   *
   * `whatsapp-web.js` only publishes `pupPage` once the browser has launched,
   * which happens *inside* `initialize()`, so we poll briefly for it. Without
   * this a page that boots but never connects — the classic "no QR, no ready,
   * hangs forever" failure — is a complete black box: no console output, no
   * failed requests, nothing in the log to work from.
   */
  private attachPageDiagnostics(): void {
    if (this.diagnosticsPoll) return
    const startedAt = Date.now()
    this.diagnosticsPoll = setInterval(() => {
      const page = (this.client as unknown as { pupPage?: DiagnosticPage }).pupPage
      if (page) {
        this.stopDiagnosticsPoll()
        this.attachDiagnosticsTo(page)
        return
      }
      if (Date.now() - startedAt > 30000) this.stopDiagnosticsPoll()
    }, 200)
    this.diagnosticsPoll.unref?.()
  }

  private stopDiagnosticsPoll(): void {
    if (this.diagnosticsPoll) {
      clearInterval(this.diagnosticsPoll)
      this.diagnosticsPoll = null
    }
  }

  private attachDiagnosticsTo(page: DiagnosticPage): void {
    if (this.diagnosticsPage === page) return
    this.diagnosticsPage = page
    logger.info("WhatsApp", "Page diagnostics attached")

    page.on("console", (msg: never) => {
      const m = msg as unknown as { type?: () => string; text?: () => string }
      logger.debug("WhatsApp", "page console", { type: m.type?.(), text: m.text?.() })
    })
    page.on("pageerror", (err: never) => logger.error("WhatsApp", "page error", err))
    // Request noise is only interesting while WhatsApp Web is booting; once the
    // client is ready these would just fill the log with analytics/beacon 404s.
    page.on("requestfailed", (req: never) => {
      if (this.ready) return
      const r = req as unknown as {
        url?: () => string
        failure?: () => { errorText?: string } | null
      }
      logger.warn("WhatsApp", "page request failed", {
        url: r.url?.(),
        error: r.failure?.()?.errorText,
      })
    })
    page.on("response", (res: never) => {
      if (this.ready) return
      const r = res as unknown as { url?: () => string; status?: () => number }
      const status = r.status?.()
      if (typeof status === "number" && status >= 400) {
        logger.warn("WhatsApp", "page http error", { url: r.url?.(), status })
      }
    })
  }

  /**
   * Log a snapshot of the WhatsApp Web page so a stuck/failed initialization can
   * be diagnosed from the log alone. `bodyText` is the giveaway: it shows the
   * screen WhatsApp is actually displaying (e.g. "your browser is not
   * supported", an error page, or the QR view) while `socketState` says whether
   * WhatsApp's own WebSocket ever launched.
   */
  private async dumpPageState(reason: string): Promise<void> {
    const page = (this.client as unknown as { pupPage?: DiagnosticPage }).pupPage
    if (!page?.evaluate) {
      logger.warn("WhatsApp", "Page state unavailable", { reason, hasPage: Boolean(page) })
      return
    }
    try {
      const state = await this.withTimeout(
        page.evaluate(() => {
          const g = globalThis as unknown as Record<string, any>
          let socket: any = null
          try {
            socket = g.require("WAWebSocketModel").Socket
          } catch {
            socket = null
          }
          // WhatsApp's own tab mutex: when it is owned by another window the
          // socket never launches and the page shows "WhatsApp is open in
          // another window" instead of a QR code.
          let tabMutex: string | null = null
          let noTakeover: boolean | null = null
          try {
            const mutex = g.require("WAWebUserPrefsTabMutex")
            tabMutex = mutex.getMutex?.() ?? null
            noTakeover = mutex.getNoTakeover?.() ?? null
          } catch {
            // Module not loaded yet — the rest of the dump is still useful.
          }
          return {
            href: g.location?.href ?? null,
            title: g.document?.title ?? null,
            readyState: g.document?.readyState ?? null,
            online: g.navigator?.onLine ?? null,
            userAgent: g.navigator?.userAgent ?? null,
            wwebVersion: g.Debug?.VERSION ?? null,
            wwebjsInjected: typeof g.WWebJS !== "undefined",
            socketState: socket?.state ?? null,
            socketStream: socket?.stream ?? null,
            wsReadyState: socket?.socket?.readyState ?? null,
            hasSynced: socket?.hasSynced ?? null,
            tabMutex,
            noTakeover,
            bodyText: String(g.document?.body?.innerText ?? "")
              .replace(/\s+/g, " ")
              .slice(0, 400),
          }
        }),
        15000,
        "dumpPageState()",
      )
      logger.error("WhatsApp", `Page state dump (${reason})`, state)
    } catch (err) {
      logger.error("WhatsApp", "Failed to dump page state", err)
    }
  }

  /**
   * Log the WhatsApp Web build the page is running. Worth having on the happy
   * path too: WhatsApp occasionally ships a web build that breaks the version of
   * `whatsapp-web.js` in use, and knowing the exact build makes that obvious.
   */
  private async logWWebVersion(): Promise<void> {
    const page = (this.client as unknown as { pupPage?: DiagnosticPage }).pupPage
    if (!page?.evaluate) return
    try {
      const version = await this.withTimeout(
        page.evaluate(
          () => (globalThis as unknown as Record<string, any>).Debug?.VERSION ?? null,
        ),
        5000,
        "logWWebVersion()",
      )
      logger.info("WhatsApp", "WhatsApp Web version", { version })
    } catch {
      // Best effort only.
    }
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
    return renderQrBlocks(qr)
  }

  override async getChats(): Promise<ChatData[]> {
    logger.info("WhatsApp", "=== getChats() START ===", { ready: this.ready })
    if (!this.ready) {
      logger.warn("WhatsApp", "getChats() called but client not ready!")
      return []
    }

    // Fast path: read WhatsApp Web's internal Store directly (the public
    // client.getChats() can hang for a long time on newer versions). Any
    // failure — missing pupPage, evaluate throwing, Store unavailable, or the
    // bounded wait — falls through to the public API.
    let chats: ChatLike[] | null = null
    try {
      chats = await this.withTimeout(
        this.getChatsFromStore(),
        15000,
        "window.Store.Chat.getModelsArray()",
      )
    } catch (err) {
      logger.warn("WhatsApp", "Store fast path failed - falling back to client.getChats()", {
        error: err instanceof Error ? err.message : String(err),
      })
      chats = null
    }

    if (chats === null) {
      return this.getChatsViaClient()
    }

    logger.debug("WhatsApp", "Raw chats from Store", { count: chats.length })
    return this.finalizeChats(chats)
  }

  private async getChatsFromStore(): Promise<ChatLike[]> {
    const pupPage = (this.client as unknown as { pupPage?: StorePage }).pupPage
    if (!pupPage) {
      throw new Error("pupPage not available")
    }

    return pupPage.evaluate(() => {
      const store = (globalThis as unknown as { Store?: { Chat?: { getModelsArray?: () => unknown[] } } }).Store
      if (!store?.Chat?.getModelsArray) {
        throw new Error("Store.Chat not available")
      }
      const models = store.Chat.getModelsArray()
      return models.map((c) => {
        const chat = c as {
          id?: { _serialized?: string }
          name?: string
          formattedTitle?: string
          contact?: { pushname?: string; name?: string }
          isGroup?: boolean
          unreadCount?: number
          archive?: boolean
          archived?: boolean
          pin?: boolean
          isMuted?: boolean
          muteExpiration?: number
          mute?: { expiration?: number }
          t?: number
          groupMetadata?: { participants?: unknown[] }
          lastMessage?: { body?: string; t?: number; id?: { fromMe?: boolean } }
        }
        return {
          id: chat.id?._serialized || String(chat.id ?? ""),
          name:
            chat.name ||
            chat.formattedTitle ||
            chat.contact?.pushname ||
            chat.contact?.name ||
            "Unknown",
          isGroup: !!chat.isGroup,
          unreadCount: chat.unreadCount || 0,
          archived: !!(chat.archive || chat.archived),
          pinned: !!chat.pin,
          isMuted: !!(chat.isMuted || (chat.muteExpiration ?? 0) > 0 || (chat.mute?.expiration ?? 0) > 0),
          t: chat.t || 0,
          participantCount: chat.isGroup ? chat.groupMetadata?.participants?.length || 0 : 0,
          lastMessage: chat.lastMessage
            ? {
                body: chat.lastMessage.body || "",
                timestamp: chat.lastMessage.t || 0,
                fromMe: !!chat.lastMessage.id?.fromMe,
              }
            : undefined,
        } satisfies ChatLike
      })
    })
  }

  /**
   * Fallback used when WhatsApp Web's internal Store is unreachable: use the
   * public whatsapp-web.js API, bounded by a timeout so a stall cannot hang the
   * UI indefinitely.
   */
  private async getChatsViaClient(): Promise<ChatData[]> {
    try {
      const raw = await this.withTimeout(this.client.getChats(), 30000, "client.getChats()")
      logger.info("WhatsApp", "client.getChats() returned chats", { count: raw.length })
      return this.finalizeChats(raw)
    } catch (err) {
      logger.error("WhatsApp", "getChatsViaClient() failed", err)
      return []
    }
  }

  /** Normalize, filter archived chats out and sort pinned-first then newest. */
  private finalizeChats(raw: ChatLike[]): ChatData[] {
    return raw
      .filter((chat) => !chat.archived)
      .map((chat) => this.formatChat(chat))
      .sort((a, b) => {
        if (a.pinned && !b.pinned) return -1
        if (!a.pinned && b.pinned) return 1
        return (b.lastMessage?.timestamp ?? 0) - (a.lastMessage?.timestamp ?? 0)
      })
  }

  override async getMessages(chatId: string, limit: number = 50): Promise<MessageData[]> {
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

  override async sendMessage(
    chatId: string,
    content: string,
    options?: SendMessageOptions,
  ): Promise<MessageData | null> {
    logger.info("WhatsApp", "sendMessage() called", {
      chatId,
      contentLength: content.length,
      replyTo: options?.replyTo,
    })
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
          const quotedMsg = messages.find((m) => m.id._serialized === options.replyTo)
          if (quotedMsg) {
            message = await quotedMsg.reply(content)
            logger.info("WhatsApp", "Reply sent", {
              messageId: message.id._serialized,
              quotedMsgId: options.replyTo,
            })
          } else {
            logger.warn("WhatsApp", "Quoted message not found, sending normal message", {
              quotedMsgId: options.replyTo,
            })
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

  /**
   * Delete a message.
   *
   * whatsapp-web.js `Message.delete(everyone)` revokes the message for everyone
   * when `everyone` is true and deletes it locally (for me) when false, so the
   * `forMe` flag is inverted before being passed through.
   */
  async deleteMessage(messageId: string, chatId: string, forMe: boolean): Promise<boolean> {
    logger.info("WhatsApp", "deleteMessage() called", { messageId, chatId, forMe })
    if (!this.ready) {
      logger.warn("WhatsApp", "deleteMessage() called but not ready")
      return false
    }
    try {
      const chat = await this.client.getChatById(chatId)
      const messages = await chat.fetchMessages({ limit: 100 })
      const message = messages.find((m) => m.id._serialized === messageId)

      if (!message) {
        logger.warn("WhatsApp", "Message not found for deletion", { messageId })
        return false
      }

      // forMe=true  -> delete(false) -> local delete (for me)
      // forMe=false -> delete(true)  -> revoke (for everyone)
      await message.delete(!forMe)
      logger.info("WhatsApp", forMe ? "Message deleted for me" : "Message deleted for everyone", {
        messageId,
      })

      return true
    } catch (err) {
      logger.error("WhatsApp", "deleteMessage() error", err)
      return false
    }
  }

  async editMessage(messageId: string, chatId: string, newText: string): Promise<boolean> {
    logger.info("WhatsApp", "editMessage() called", {
      messageId,
      chatId,
      newTextLength: newText.length,
    })
    if (!this.ready) {
      logger.warn("WhatsApp", "editMessage() called but not ready")
      return false
    }
    try {
      const chat = await this.client.getChatById(chatId)
      const messages = await chat.fetchMessages({ limit: 100 })
      const message = messages.find((m) => m.id._serialized === messageId)

      if (!message) {
        logger.warn("WhatsApp", "Message not found for editing", { messageId })
        return false
      }

      // Check if message is from me
      if (!message.fromMe) {
        logger.warn("WhatsApp", "Cannot edit message not from me", { messageId })
        return false
      }

      await message.edit(newText)
      logger.info("WhatsApp", "Message edited successfully", { messageId })

      return true
    } catch (err) {
      logger.error("WhatsApp", "editMessage() error", err)
      return false
    }
  }

  override async markAsRead(chatId: string): Promise<void> {
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

  override async getContactInfo(contactId: string): Promise<ContactData | null> {
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

  private formatChat(chat: ChatLike): ChatData {
    const chatId = typeof chat.id === "string" ? chat.id : chat.id?._serialized || ""
    const lastBody = chat.lastMessage?.body || ""
    const lastTimestamp = chat.timestamp || chat.lastMessage?.timestamp || chat.t || 0
    const lastFromMe = chat.lastMessage?.fromMe ?? !!chat.lastMessage?.id?.fromMe

    return {
      id: chatId,
      name: chat.name || chat.formattedTitle || "Unknown",
      isGroup: !!chat.isGroup,
      unreadCount: chat.unreadCount || 0,
      pinned: !!chat.pinned,
      muted: !!(chat.isMuted || (chat.muteExpiration ?? 0) > 0),
      archived: !!chat.archived,
      participantCount: chat.participantCount,
      lastMessage: lastTimestamp
        ? {
            body: lastBody,
            timestamp: lastTimestamp,
            fromMe: lastFromMe,
          }
        : undefined,
    }
  }

  private formatMessage(message: pkg.Message): MessageData {
    const msgAny = message as unknown as {
      _data?: {
        filename?: string
        size?: number
        quotedMsg?: { id?: { _serialized?: string }; body?: string }
        quotedStanzaID?: string
      }
      filename?: string
      mimetype?: string
      filesize?: number
      isForwarded?: boolean
      forwardingScore?: number
      isStarred?: boolean
      hasQuotedMsg?: boolean
      quotedMsgId?: string
    }

    logger.debug("WhatsApp", "formatMessage() called", {
      id: message.id._serialized,
      fromMe: message.fromMe,
      type: message.type,
      hasMedia: message.hasMedia,
    })

    // Extract media info if present
    let media: MediaAttachment | undefined
    if (message.hasMedia) {
      const mediaType = this.getMediaType(message.type)
      const filename = msgAny._data?.filename || msgAny.filename || "media"

      media = {
        type: mediaType,
        mimetype: msgAny.mimetype || "application/octet-stream",
        filename,
        filesize: msgAny.filesize || msgAny._data?.size,
        // Media bytes are fetched lazily from this message id.
        messageId: message.id._serialized,
      }
    }

    // Try multiple paths for quotedMsgId since WhatsApp structure varies
    const quotedMsgId =
      msgAny._data?.quotedMsg?.id?._serialized ||
      msgAny._data?.quotedStanzaID ||
      msgAny.quotedMsgId

    return {
      id: message.id._serialized,
      body: message.body || "",
      timestamp: message.timestamp,
      fromMe: message.fromMe,
      authorName: message.author,
      hasMedia: message.hasMedia,
      type: message.type,
      ack: message.ack,
      isForwarded: msgAny.isForwarded || false,
      forwardingScore: msgAny.forwardingScore,
      isStarred: msgAny.isStarred || false,
      hasQuotedMsg: msgAny.hasQuotedMsg || false,
      quotedMsgBody: msgAny._data?.quotedMsg?.body,
      quotedMsgId,
      media,
    }
  }

  private getMediaType(messageType: string): MediaAttachment["type"] {
    if (messageType.includes("image")) return "image"
    if (messageType.includes("video")) return "video"
    if (messageType.includes("audio") || messageType.includes("ptt")) return "audio"
    if (messageType.includes("sticker")) return "sticker"
    return "document"
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
      const waMessage = messages.find((m) => m.id._serialized === messageId)

      if (!waMessage || !waMessage.hasMedia) {
        logger.warn("WhatsApp", "Message not found or has no media", { messageId })
        return null
      }

      const msgAny = waMessage as unknown as { _data?: { filename?: string }; filename?: string; mimetype?: string }
      const filename = msgAny._data?.filename || msgAny.filename || "media"
      // Use the MESSAGE timestamp, not current time!
      const timestamp = waMessage.timestamp
      const mimetype = msgAny.mimetype || "application/octet-stream"

      // Check cache first (`await` keeps this working whether the cache API is
      // synchronous or promise-based).
      const cached = await mediaCache.get(chatName, filename, timestamp, mimetype)
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
      const buffer = Buffer.from(media.data, "base64")
      const filePath = await mediaCache.cache(chatName, filename, timestamp, buffer, media.mimetype)

      logger.info("WhatsApp", "Media downloaded and cached", {
        messageId,
        chatName,
        filename,
        filePath,
        size: buffer.length,
        mimetype: media.mimetype,
      })

      return filePath
    } catch (err) {
      logger.error("WhatsApp", "downloadMedia() error", err)
      return null
    }
  }

  async reconnect(): Promise<void> {
    logger.info("WhatsApp", "Attempting to reconnect...")
    try {
      await this.destroy()
      logger.info("WhatsApp", "Client destroyed, waiting before reconnect...")
      await new Promise((resolve) => setTimeout(resolve, 2000))

      // Recreate client and re-register handlers for the new instance
      this.client = new Client(buildClientOptions())
      this.handlersRegistered = false
      this.setupEventHandlers()
      await this.initialize()
      logger.info("WhatsApp", "Reconnection successful!")
    } catch (err) {
      logger.error("WhatsApp", "Reconnection failed", err)
      throw err
    }
  }

  /**
   * Best-effort close of the underlying browser process.
   *
   * `client.destroy()` only calls `browser.close()` when the browser still
   * reports itself as connected; if the connection dropped first it silently
   * leaks a Chromium holding the profile lock, which breaks the *next* launch
   * with a confusing "browser is already running" error. Closing the handle
   * explicitly (and on a timeout, so shutdown can never hang) avoids that.
   */
  private async closeBrowserBestEffort(): Promise<void> {
    const browser = (this.client as unknown as { pupBrowser?: { close?: () => Promise<void> } })
      .pupBrowser
    if (!browser?.close) return
    try {
      await this.withTimeout(browser.close(), 10000, "browser.close()")
      logger.info("WhatsApp", "Browser closed")
    } catch (err) {
      logger.warn("WhatsApp", "Best-effort browser close failed", err)
    }
  }

  protected override async teardown(): Promise<void> {
    logger.info("WhatsApp", "Destroying client")
    this.stopDiagnosticsPoll()
    this.diagnosticsPage = null
    this.clearReadyFallback()
    this.ready = false
    this.qrCode = null
    // Drop every provider listener so the destroyed client cannot call back
    // into this service (and so `reconnect()` starts from a clean slate).
    this.client.removeAllListeners()
    this.handlersRegistered = false
    try {
      await this.client.destroy()
      logger.info("WhatsApp", "Client destroyed")
    } catch (err) {
      logger.error("WhatsApp", "Error destroying client", err)
    }
    await this.closeBrowserBestEffort()
  }
}

export const whatsapp = new WhatsAppService()
