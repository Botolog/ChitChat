import { WebClient } from "@slack/web-api"
import { SocketModeClient } from "@slack/socket-mode"
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "fs"
import { join } from "path"
import { Logger } from "../utils/logger"
import { BaseMessagingService } from "./base"
import type { ServiceCapabilities } from "./capabilities"
import type {
  ChatData,
  ContactData,
  MessageData,
  SendMessageOptions,
} from "./types"

const logger = new Logger("slack.log", "Slack")

/** Capabilities advertised to the UI. */
const SLACK_CAPABILITIES: ServiceCapabilities = {
  qrAuth: false,
  deleteMessage: "none",
  editMessage: false,
  pin: false,
  mute: false,
  archive: false,
  downloadMedia: false,
  reply: true,
}

// Token storage for persistence
interface SlackTokenData {
  accessToken: string
  refreshToken: string
  expiresAt: number // Unix timestamp in ms
  userId: string
  teamId: string
}

const TOKEN_FILE = join(process.cwd(), ".slack-tokens.json")

interface SlackChannel {
  id: string
  name: string
  is_channel: boolean
  is_group: boolean
  is_im: boolean
  is_mpim: boolean
  is_private: boolean
  is_archived: boolean
  is_member: boolean
  num_members?: number
  /** Present on `im` conversations: the other user's id. */
  user?: string
  topic?: { value: string }
  purpose?: { value: string }
}

interface SlackFile {
  mimetype?: string
  name?: string
  size?: number
  url_private?: string
}

interface SlackMessage {
  ts: string
  text?: string
  user?: string
  bot_id?: string
  channel?: string
  thread_ts?: string
  reply_count?: number
  files?: SlackFile[]
  attachments?: unknown[]
}

interface SlackUser {
  id: string
  name: string
  real_name?: string
  profile?: {
    display_name?: string
    real_name?: string
    image_48?: string
  }
  is_bot?: boolean
}

/** Shape of the payload emitted by `@slack/socket-mode` for events_api events. */
interface SocketEnvelope<TEvent> {
  ack: (response?: unknown) => Promise<void>
  event: TEvent
}

interface SlackMessageEvent {
  channel: string
  user?: string
  bot_id?: string
  text?: string
  ts: string
  subtype?: string
  thread_ts?: string
  files?: SlackFile[]
}

interface SlackTypingEvent {
  channel: string
  user: string
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

class SlackService extends BaseMessagingService {
  readonly id = "slack"
  readonly displayName = "Slack"

  private webClient: WebClient | null = null
  private socketClient: SocketModeClient | null = null
  private accessToken: string | null = null
  private refreshToken: string | null = null
  private appToken: string | null = null
  private clientId: string | null = null
  private clientSecret: string | null = null
  private tokenExpiresAt = 0
  private refreshTimer: NodeJS.Timeout | null = null
  private readonly userCache: Map<string, SlackUser> = new Map()
  private readonly channelCache: Map<string, SlackChannel> = new Map()
  private currentUserId: string | null = null

  constructor() {
    super()
    logger.info("Slack", "SlackService created")
  }

  override capabilities(): ServiceCapabilities {
    return { ...SLACK_CAPABILITIES }
  }

  // Load tokens from file
  private loadTokens(): SlackTokenData | null {
    try {
      if (!existsSync(TOKEN_FILE)) return null
      const data = JSON.parse(readFileSync(TOKEN_FILE, "utf-8")) as SlackTokenData
      if (!data || typeof data.accessToken !== "string" || typeof data.expiresAt !== "number") {
        logger.warn("Slack", "Ignoring malformed token file")
        return null
      }
      logger.info("Slack", "Loaded tokens from file", {
        userId: data.userId,
        expiresIn: Math.round((data.expiresAt - Date.now()) / 1000 / 60) + " min",
      })
      return data
    } catch (err) {
      logger.error("Slack", "Failed to load tokens", { error: errorMessage(err) })
      return null
    }
  }

  // Save tokens to file atomically with owner-only permissions
  private saveTokens(data: SlackTokenData): void {
    const tmpFile = `${TOKEN_FILE}.tmp`
    try {
      writeFileSync(tmpFile, JSON.stringify(data, null, 2), { mode: 0o600 })
      // `writeFileSync`'s mode only applies on creation; enforce it explicitly
      // so a stale temp file can never leak looser permissions.
      chmodSync(tmpFile, 0o600)
      renameSync(tmpFile, TOKEN_FILE)
      logger.info("Slack", "Tokens saved to file")
    } catch (err) {
      logger.error("Slack", "Failed to save tokens", { error: errorMessage(err) })
    }
  }

  // Refresh the access token using refresh token
  private async refreshAccessToken(): Promise<boolean> {
    if (!this.refreshToken || !this.clientId || !this.clientSecret) {
      logger.error("Slack", "Cannot refresh: missing refresh token or client credentials")
      return false
    }

    logger.info("Slack", "Refreshing access token...")

    try {
      const response = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          grant_type: "refresh_token",
          refresh_token: this.refreshToken,
        }),
      })

      const data = (await response.json()) as {
        ok?: boolean
        error?: string
        access_token?: string
        refresh_token?: string
        expires_in?: number
        team?: { id?: string }
        authed_user?: {
          access_token?: string
          refresh_token?: string
          expires_in?: number
        }
      }

      if (!data.ok) {
        logger.error("Slack", "Token refresh failed", { error: data.error })
        return false
      }

      // Update tokens
      const accessToken = data.access_token || data.authed_user?.access_token
      const refreshToken = data.refresh_token || data.authed_user?.refresh_token
      if (!accessToken || !refreshToken) {
        logger.error("Slack", "Token refresh response missing tokens")
        return false
      }
      this.accessToken = accessToken
      this.refreshToken = refreshToken
      const expiresIn = data.expires_in || data.authed_user?.expires_in || 43200
      this.tokenExpiresAt = Date.now() + expiresIn * 1000

      // Reinitialize WebClient with new token
      this.webClient = new WebClient(this.accessToken)

      // Save to file
      this.saveTokens({
        accessToken: this.accessToken,
        refreshToken: this.refreshToken,
        expiresAt: this.tokenExpiresAt,
        userId: this.currentUserId || "",
        teamId: data.team?.id || "",
      })

      logger.info("Slack", "Token refreshed successfully", {
        expiresIn: Math.round(expiresIn / 60) + " min",
      })

      // Schedule next refresh
      this.scheduleTokenRefresh()

      return true
    } catch (err) {
      logger.error("Slack", "Token refresh error", { error: errorMessage(err) })
      return false
    }
  }

  // Schedule automatic token refresh before expiration
  private scheduleTokenRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.untrack(this.refreshTimer)
      this.refreshTimer = null
    }

    // Refresh 10 minutes before expiration
    const refreshIn = Math.max(0, this.tokenExpiresAt - Date.now() - 10 * 60 * 1000)

    logger.info("Slack", "Scheduling token refresh", {
      refreshIn: Math.round(refreshIn / 1000 / 60) + " min",
    })

    this.refreshTimer = this.track(
      setTimeout(() => {
        void (async () => {
          const success = await this.refreshAccessToken()
          if (!success) {
            logger.error("Slack", "Auto-refresh failed, emitting auth failure")
            this.emit("auth_failure", "Token refresh failed")
          }
        })()
      }, refreshIn),
    )
  }

  /**
   * Initialize the service.
   *
   * Retries are bounded: at most one refresh-then-retry after an invalid/expired
   * token, so a persistently failing workspace cannot recurse forever.
   */
  override async initialize(): Promise<void> {
    logger.info("Slack", "Starting initialization")

    const maxAttempts = 2
    let lastError: unknown = new Error("Slack initialization failed")

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.initializeOnce()
        return
      } catch (err) {
        lastError = err
        const message = errorMessage(err)
        logger.error("Slack", `Initialization attempt ${attempt} failed`, { error: message })

        const authFailed = message.includes("invalid_auth") || message.includes("token_expired")
        const canRefresh = !!this.refreshToken && !!this.clientId && !!this.clientSecret
        if (attempt >= maxAttempts || !authFailed || !canRefresh) {
          throw err
        }

        logger.info("Slack", "Auth failed, attempting token refresh")
        const refreshed = await this.refreshAccessToken()
        if (!refreshed) throw err
      }
    }

    throw lastError
  }

  private async initializeOnce(): Promise<void> {
    // Get credentials from environment (all optional except user token)
    this.clientId = process.env.SLACK_CLIENT_ID || null
    this.clientSecret = process.env.SLACK_CLIENT_SECRET || null
    this.appToken = process.env.SLACK_APP_TOKEN || null

    // Try to load existing tokens from file first
    const savedTokens = this.loadTokens()

    if (savedTokens) {
      // Check if token is still valid (with 5 min buffer)
      if (savedTokens.expiresAt > Date.now() + 5 * 60 * 1000) {
        logger.info("Slack", "Using saved tokens (still valid)")
        this.accessToken = savedTokens.accessToken
        this.refreshToken = savedTokens.refreshToken
        this.tokenExpiresAt = savedTokens.expiresAt
        this.currentUserId = savedTokens.userId
      } else if (savedTokens.refreshToken && this.clientId && this.clientSecret) {
        // Token expired but we have refresh credentials - try refresh
        logger.info("Slack", "Saved token expired, attempting refresh")
        this.refreshToken = savedTokens.refreshToken
        this.currentUserId = savedTokens.userId
        const refreshed = await this.refreshAccessToken()
        if (!refreshed) {
          logger.warn("Slack", "Token refresh failed, falling back to env token")
          this.accessToken = null // Force reload from env
        }
      } else {
        logger.warn("Slack", "Saved token expired and no refresh credentials - using env token")
        this.accessToken = null // Force reload from env
      }
    }

    // If no valid token yet, load from env
    if (!this.accessToken) {
      const envToken = process.env.SLACK_USER_TOKEN || null
      const envRefresh = process.env.SLACK_REFRESH_TOKEN || null

      if (!envToken) {
        logger.error("Slack", "No user token. Set SLACK_USER_TOKEN env var")
        throw new Error("Slack user token required (xoxp-...)")
      }

      this.accessToken = envToken
      this.refreshToken = envRefresh || null

      // Determine token type and expiry
      if (envToken.startsWith("xoxe.xoxp-")) {
        // Rotating token - expires in 12 hours
        this.tokenExpiresAt = Date.now() + 12 * 60 * 60 * 1000
        logger.info("Slack", "Using rotating user token (12h expiry)")
      } else if (envToken.startsWith("xoxp-")) {
        // Legacy token - no expiry
        this.tokenExpiresAt = Date.now() + 365 * 24 * 60 * 60 * 1000 // 1 year placeholder
        logger.info("Slack", "Using legacy user token (no expiry)")
      } else {
        logger.warn("Slack", "Unknown token format")
        this.tokenExpiresAt = Date.now() + 12 * 60 * 60 * 1000
      }

      // Warn if refresh token provided but no client credentials
      if (envRefresh && (!this.clientId || !this.clientSecret)) {
        logger.warn(
          "Slack",
          "Refresh token provided but missing SLACK_CLIENT_ID/SECRET - auto-refresh disabled",
        )
      }
    }

    // Initialize Web API client with access token
    this.webClient = new WebClient(this.accessToken)
    logger.info("Slack", "WebClient initialized")

    // Test auth and get current user ID
    const authResult = await this.webClient.auth.test()
    this.currentUserId = (authResult.user_id as string) || null
    logger.info("Slack", "Auth successful", {
      team: authResult.team,
      user: authResult.user,
      userId: this.currentUserId,
    })

    // Diagnostic: log what the token can see (never throws)
    await this.checkTokenScopes()

    // Save tokens if we have refresh capability
    if (this.refreshToken) {
      this.saveTokens({
        accessToken: this.accessToken,
        refreshToken: this.refreshToken,
        expiresAt: this.tokenExpiresAt,
        userId: this.currentUserId || "",
        teamId: (authResult.team_id as string) || "",
      })

      // Schedule automatic refresh
      if (this.clientId && this.clientSecret) {
        this.scheduleTokenRefresh()
      }
    }

    // Initialize Socket Mode if app token provided
    if (this.appToken) {
      this.socketClient = new SocketModeClient({ appToken: this.appToken })
      this.setupSocketEventHandlers()
      await this.socketClient.start()
      logger.info("Slack", "Socket Mode connected")
    } else {
      logger.warn("Slack", "No app token - real-time events disabled. Set SLACK_APP_TOKEN for live updates")
    }

    this.markReady("slack auth.test succeeded")
  }

  /**
   * Wrap a socket event handler so a thrown error is logged and surfaced as
   * `service_error` instead of becoming an unhandled rejection.
   */
  private wrapSocketHandler<T>(
    eventName: string,
    handler: (payload: T) => Promise<void> | void,
  ): (payload: T) => void {
    return (payload: T) => {
      void (async () => {
        try {
          await handler(payload)
        } catch (err) {
          logger.error("Slack", `Socket handler failed: ${eventName}`, { error: errorMessage(err) })
          this.emit("service_error", err)
        }
      })()
    }
  }

  private setupSocketEventHandlers(): void {
    if (!this.socketClient) return

    logger.info("Slack", "=== Setting up Socket Mode event handlers ===")

    this.socketClient.on(
      "message",
      this.wrapSocketHandler<SocketEnvelope<SlackMessageEvent>>("message", async ({ event, ack }) => {
        await ack()
        logger.event("Slack", "EVENT: message", {
          channel: event.channel,
          user: event.user,
          text: event.text?.substring(0, 30),
          ts: event.ts,
        })
        const formatted = await this.formatMessage(event, event.channel)
        this.emit("message", formatted)
      }),
    )

    this.socketClient.on(
      "user_typing",
      this.wrapSocketHandler<SocketEnvelope<SlackTypingEvent>>("user_typing", async ({ event, ack }) => {
        await ack()
        logger.event("Slack", "EVENT: user_typing", { channel: event.channel, user: event.user })
        this.emit("typing", { chatId: event.channel, isTyping: true })
      }),
    )

    this.socketClient.on("error", (error) => {
      logger.error("Slack", "EVENT: Socket Mode error", { error: errorMessage(error) })
      // Never emit the reserved `error` event: Node throws when it is
      // unhandled, which would crash the whole app.
      this.emit("service_error", error)
    })

    this.socketClient.on("connected", () => {
      logger.event("Slack", "EVENT: Socket Mode connected")
      this.emit("connected")
    })

    this.socketClient.on("connecting", () => {
      logger.event("Slack", "EVENT: Socket Mode connecting...")
    })

    this.socketClient.on("disconnected", () => {
      logger.event("Slack", "EVENT: Socket Mode disconnected")
      this.emit("disconnected", "Socket disconnected")
    })

    this.socketClient.on("reconnecting", () => {
      logger.event("Slack", "EVENT: Socket Mode reconnecting...")
    })

    logger.info("Slack", "=== All Socket Mode event handlers registered ===")
  }

  // Diagnostic: log what the token actually has access to. Never throws.
  private async checkTokenScopes(): Promise<void> {
    if (!this.webClient) return

    try {
      const authTest = await this.webClient.auth.test()
      logger.info("Slack", "Token info", {
        userId: authTest.user_id,
        teamId: authTest.team_id,
        url: authTest.url,
        isEnterpriseInstall: authTest.is_enterprise_install,
      })

      // This only works for some token types; failure is expected.
      try {
        const teams = await this.webClient.auth.teams.list()
        logger.info("Slack", "Auth teams list worked", { teams: teams.teams?.length ?? 0 })
      } catch (err) {
        logger.debug("Slack", "auth.teams.list not available (expected)", {
          error: errorMessage(err),
        })
      }

      logger.info("Slack", "✓ Token is valid and authenticated")
    } catch (err) {
      logger.error("Slack", "Token scope check failed", { error: errorMessage(err) })
    }
  }

  override async getChats(): Promise<ChatData[]> {
    logger.info("Slack", "=== getChats() START ===", { ready: this.ready })
    if (!this.ready || !this.webClient) {
      logger.warn("Slack", "getChats() called but client not ready!")
      return []
    }

    try {
      const chats: ChatData[] = []

      const channelsResult = await this.webClient.conversations.list({
        types: "public_channel,private_channel,mpim,im",
        exclude_archived: true,
        limit: 100,
      })

      const channels = (channelsResult.channels ?? []) as unknown as SlackChannel[]

      for (const channel of channels) {
        // Skip public channels the user isn't a member of
        if (channel.is_channel && !channel.is_member) continue

        this.channelCache.set(channel.id, channel)

        // Get unread count (best-effort: some channels do not report it)
        let unreadCount = 0
        try {
          const info = await this.webClient.conversations.info({ channel: channel.id })
          unreadCount = (info.channel as unknown as { unread_count?: number } | undefined)?.unread_count ?? 0
        } catch {
          // Ignore - some channels may not have unread info
        }

        // Format channel name for DMs
        let name = channel.name || "Unknown"
        if (channel.is_im) {
          // For DMs, get the user's name
          if (channel.user) {
            const user = await this.getUser(channel.user)
            name = user?.real_name || user?.name || "Direct Message"
          }
        } else if (channel.is_mpim) {
          name = name.replace("mpdm-", "").replace("--", ", ").replace("-", " ")
        }

        chats.push({
          id: channel.id,
          name: channel.is_channel || channel.is_group ? `#${name}` : name,
          isGroup: channel.is_channel || channel.is_group || channel.is_mpim,
          unreadCount,
          pinned: false,
          muted: false,
          archived: channel.is_archived || false,
          participantCount: channel.num_members,
        })
      }

      // Sort: DMs first, then by name
      chats.sort((a, b) => {
        if (!a.isGroup && b.isGroup) return -1
        if (a.isGroup && !b.isGroup) return 1
        return a.name.localeCompare(b.name)
      })

      logger.info("Slack", "=== getChats() COMPLETE ===", {
        count: chats.length,
        firstChat: chats[0]?.name,
        lastChat: chats[chats.length - 1]?.name,
      })
      return chats
    } catch (err) {
      logger.error("Slack", "getChats() EXCEPTION", { error: errorMessage(err) })
      return []
    }
  }

  override async getMessages(channelId: string, limit: number = 50): Promise<MessageData[]> {
    logger.info("Slack", "getMessages() called", { channelId, limit, ready: this.ready })
    if (!this.ready || !this.webClient) {
      logger.warn("Slack", "getMessages() called but not ready")
      return []
    }

    try {
      const result = await this.webClient.conversations.history({ channel: channelId, limit })

      if (!result.messages) return []

      const messages: MessageData[] = []
      for (const msg of result.messages as unknown as SlackMessage[]) {
        messages.push(await this.formatMessage(msg, channelId))
      }

      // Slack returns newest first, reverse to get chronological order
      messages.reverse()

      logger.info("Slack", "getMessages() complete", { channelId, count: messages.length })
      return messages
    } catch (err) {
      logger.error("Slack", "getMessages() EXCEPTION", { channelId, error: errorMessage(err) })
      return []
    }
  }

  override async sendMessage(
    channelId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<MessageData | null> {
    logger.info("Slack", "sendMessage() called", {
      channelId,
      textLength: text.length,
      replyTo: options?.replyTo,
    })
    if (!this.ready || !this.webClient) {
      logger.warn("Slack", "sendMessage() called but not ready")
      return null
    }

    try {
      const result = await this.webClient.chat.postMessage({
        channel: channelId,
        text,
        // Slack threads a reply under the parent message's ts.
        thread_ts: options?.replyTo,
      })

      if (result.ts && result.message) {
        logger.info("Slack", "Message sent successfully", { ts: result.ts, channel: channelId })
        return this.formatMessage(result.message as unknown as SlackMessage, channelId)
      }
      logger.warn("Slack", "sendMessage() - no ts or message in response")
      return null
    } catch (err) {
      logger.error("Slack", "sendMessage() EXCEPTION", { channelId, error: errorMessage(err) })
      return null
    }
  }

  override async markAsRead(channelId: string): Promise<void> {
    logger.debug("Slack", "markAsRead() called", { channelId })
    if (!this.ready || !this.webClient) {
      logger.warn("Slack", "markAsRead() called but not ready")
      return
    }

    try {
      // Get latest message timestamp
      const history = await this.webClient.conversations.history({ channel: channelId, limit: 1 })

      if (history.messages && history.messages.length > 0) {
        const latestTs = (history.messages[0] as unknown as SlackMessage).ts
        await this.webClient.conversations.mark({ channel: channelId, ts: latestTs })
        logger.info("Slack", "Marked as read", { channelId, ts: latestTs })
      } else {
        logger.debug("Slack", "No messages to mark as read", { channelId })
      }
    } catch (err) {
      logger.error("Slack", "markAsRead() error", { channelId, error: errorMessage(err) })
    }
  }

  override async getContactInfo(userId: string): Promise<ContactData | null> {
    if (!this.ready) return null

    try {
      const user = await this.getUser(userId)
      if (!user) return null

      return {
        id: user.id,
        name: user.real_name || user.name || "Unknown",
        number: "", // Slack doesn't use phone numbers
        isMyContact: true,
        isGroup: false,
        isBlocked: false,
      }
    } catch {
      return null
    }
  }

  private async getUser(userId: string): Promise<SlackUser | null> {
    // Check cache first
    const cached = this.userCache.get(userId)
    if (cached) return cached

    if (!this.webClient) return null

    try {
      const result = await this.webClient.users.info({ user: userId })
      if (result.user) {
        const user = result.user as unknown as SlackUser
        this.userCache.set(userId, user)
        return user
      }
    } catch (err) {
      logger.error("Slack", "getUser() error", { userId, error: errorMessage(err) })
    }
    return null
  }

  private async formatMessage(msg: SlackMessage, channelId?: string): Promise<MessageData> {
    const userId = msg.user || msg.bot_id
    const isFromMe = !!userId && userId === this.currentUserId

    // Get author name
    let authorName = "Unknown"
    if (userId && !msg.bot_id) {
      const user = await this.getUser(userId)
      authorName = user?.real_name || user?.name || userId
    } else if (msg.bot_id) {
      authorName = "Bot"
    }

    // Determine message type
    let type = "chat"
    let hasMedia = false
    if (msg.files && msg.files.length > 0) {
      hasMedia = true
      const file = msg.files[0]
      if (file.mimetype?.startsWith("image/")) type = "image"
      else if (file.mimetype?.startsWith("video/")) type = "video"
      else if (file.mimetype?.startsWith("audio/")) type = "audio"
      else type = "document"
    }

    // Parse timestamp (Slack uses Unix timestamp with microseconds as string)
    const timestamp = Math.floor(parseFloat(msg.ts))

    return {
      id: msg.ts,
      body: msg.text || "",
      timestamp,
      fromMe: isFromMe,
      authorName,
      hasMedia,
      type,
      ack: 3, // Slack messages are always delivered
      isForwarded: false,
      isStarred: false,
      hasQuotedMsg: !!msg.thread_ts && msg.thread_ts !== msg.ts,
      quotedMsgBody: undefined,
    }
  }

  // Slack-specific helper methods (not part of the MessagingService contract).

  async getWorkspaceInfo(): Promise<{ name: string; domain: string } | null> {
    if (!this.ready || !this.webClient) return null

    try {
      const result = await this.webClient.team.info()
      if (result.team) {
        const team = result.team as unknown as { name?: string; domain?: string }
        return { name: team.name || "Unknown", domain: team.domain || "" }
      }
    } catch (err) {
      logger.error("Slack", "getWorkspaceInfo() error", { error: errorMessage(err) })
    }
    return null
  }

  async addReaction(channelId: string, timestamp: string, emoji: string): Promise<boolean> {
    if (!this.ready || !this.webClient) return false

    try {
      await this.webClient.reactions.add({ channel: channelId, timestamp, name: emoji })
      return true
    } catch (err) {
      logger.error("Slack", "addReaction() error", { error: errorMessage(err) })
      return false
    }
  }

  async removeReaction(channelId: string, timestamp: string, emoji: string): Promise<boolean> {
    if (!this.ready || !this.webClient) return false

    try {
      await this.webClient.reactions.remove({ channel: channelId, timestamp, name: emoji })
      return true
    } catch (err) {
      logger.error("Slack", "removeReaction() error", { error: errorMessage(err) })
      return false
    }
  }

  async replyInThread(channelId: string, threadTs: string, text: string): Promise<MessageData | null> {
    if (!this.ready || !this.webClient) return null

    try {
      const result = await this.webClient.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text,
      })

      if (result.ts && result.message) {
        return this.formatMessage(result.message as unknown as SlackMessage, channelId)
      }
      return null
    } catch (err) {
      logger.error("Slack", "replyInThread() error", { error: errorMessage(err) })
      return null
    }
  }

  protected override async teardown(): Promise<void> {
    logger.info("Slack", "Destroying client")
    this.ready = false
    try {
      if (this.socketClient) {
        await this.socketClient.disconnect()
      }
    } catch (err) {
      logger.error("Slack", "Error disconnecting socket", { error: errorMessage(err) })
    }
    this.socketClient = null
    this.webClient = null
    this.refreshTimer = null
    this.userCache.clear()
    this.channelCache.clear()
    logger.info("Slack", "Client destroyed")
  }
}

export const slack = new SlackService()
