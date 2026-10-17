import { WebClient } from "@slack/web-api"
import { SocketModeClient } from "@slack/socket-mode"
import { EventEmitter } from "events"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { Logger } from "../utils/logger"
import type { ChatData, MessageData, ContactData } from "./whatsapp"

const logger = new Logger("slack.log", "Slack")

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
  topic?: { value: string }
  purpose?: { value: string }
}

interface SlackMessage {
  ts: string
  text: string
  user?: string
  bot_id?: string
  channel?: string
  thread_ts?: string
  reply_count?: number
  files?: any[]
  attachments?: any[]
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

class SlackService extends EventEmitter {
  private webClient: WebClient | null = null
  private socketClient: SocketModeClient | null = null
  private ready = false
  private accessToken: string | null = null
  private refreshToken: string | null = null
  private appToken: string | null = null
  private clientId: string | null = null
  private clientSecret: string | null = null
  private tokenExpiresAt: number = 0
  private refreshTimer: NodeJS.Timeout | null = null
  private userCache: Map<string, SlackUser> = new Map()
  private channelCache: Map<string, SlackChannel> = new Map()
  private currentUserId: string | null = null

  constructor() {
    super()
    logger.info("Slack", "SlackService created")
  }

  // Load tokens from file
  private loadTokens(): SlackTokenData | null {
    try {
      if (existsSync(TOKEN_FILE)) {
        const data = JSON.parse(readFileSync(TOKEN_FILE, "utf-8"))
        logger.info("Slack", "Loaded tokens from file", { 
          userId: data.userId,
          expiresIn: Math.round((data.expiresAt - Date.now()) / 1000 / 60) + " min"
        })
        return data
      }
    } catch (err: any) {
      logger.error("Slack", "Failed to load tokens", { error: err.message })
    }
    return null
  }

  // Save tokens to file
  private saveTokens(data: SlackTokenData): void {
    try {
      writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2))
      logger.info("Slack", "Tokens saved to file")
    } catch (err: any) {
      logger.error("Slack", "Failed to save tokens", { error: err.message })
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

      const data = await response.json() as any

      if (!data.ok) {
        logger.error("Slack", "Token refresh failed", { error: data.error })
        return false
      }

      // Update tokens
      this.accessToken = data.access_token || data.authed_user?.access_token
      this.refreshToken = data.refresh_token || data.authed_user?.refresh_token
      const expiresIn = data.expires_in || data.authed_user?.expires_in || 43200
      this.tokenExpiresAt = Date.now() + (expiresIn * 1000)

      // Reinitialize WebClient with new token
      if (this.accessToken) {
        this.webClient = new WebClient(this.accessToken)
      }

      // Save to file
      this.saveTokens({
        accessToken: this.accessToken!,
        refreshToken: this.refreshToken!,
        expiresAt: this.tokenExpiresAt,
        userId: this.currentUserId || "",
        teamId: data.team?.id || "",
      })

      logger.info("Slack", "Token refreshed successfully", {
        expiresIn: Math.round(expiresIn / 60) + " min"
      })

      // Schedule next refresh
      this.scheduleTokenRefresh()

      return true
    } catch (err: any) {
      logger.error("Slack", "Token refresh error", { error: err.message })
      return false
    }
  }

  // Schedule automatic token refresh before expiration
  private scheduleTokenRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
    }

    // Refresh 10 minutes before expiration
    const refreshIn = Math.max(0, this.tokenExpiresAt - Date.now() - (10 * 60 * 1000))
    
    logger.info("Slack", "Scheduling token refresh", {
      refreshIn: Math.round(refreshIn / 1000 / 60) + " min"
    })

    this.refreshTimer = setTimeout(async () => {
      const success = await this.refreshAccessToken()
      if (!success) {
        logger.error("Slack", "Auto-refresh failed, emitting auth error")
        this.emit("auth_error", "Token refresh failed")
      }
    }, refreshIn)
  }

  async initialize(): Promise<void> {
    logger.info("Slack", "Starting initialization")
    
    // Get credentials from environment (all optional except user token)
    this.clientId = process.env.SLACK_CLIENT_ID || null
    this.clientSecret = process.env.SLACK_CLIENT_SECRET || null
    this.appToken = process.env.SLACK_APP_TOKEN || null

    // Try to load existing tokens from file first
    const savedTokens = this.loadTokens()
    
    if (savedTokens) {
      // Check if token is still valid (with 5 min buffer)
      if (savedTokens.expiresAt > Date.now() + (5 * 60 * 1000)) {
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
        this.tokenExpiresAt = Date.now() + (12 * 60 * 60 * 1000)
        logger.info("Slack", "Using rotating user token (12h expiry)")
      } else if (envToken.startsWith("xoxp-")) {
        // Legacy token - no expiry
        this.tokenExpiresAt = Date.now() + (365 * 24 * 60 * 60 * 1000) // 1 year placeholder
        logger.info("Slack", "Using legacy user token (no expiry)")
      } else {
        logger.warn("Slack", "Unknown token format")
        this.tokenExpiresAt = Date.now() + (12 * 60 * 60 * 1000)
      }
      
      // Warn if refresh token provided but no client credentials
      if (envRefresh && (!this.clientId || !this.clientSecret)) {
        logger.warn("Slack", "Refresh token provided but missing SLACK_CLIENT_ID/SECRET - auto-refresh disabled")
      }
    }

    try {
      // Initialize Web API client with access token
      this.webClient = new WebClient(this.accessToken)
      logger.info("Slack", "WebClient initialized")

      // Test auth and get current user ID
      const authResult = await this.webClient.auth.test()
      this.currentUserId = authResult.user_id as string
      logger.info("Slack", "Auth successful", { 
        team: authResult.team, 
        user: authResult.user,
        userId: this.currentUserId
      })

      // Diagnostic: Check what scopes this token actually has
      await this.checkTokenScopes()

      // Save tokens if we have refresh capability
      if (this.refreshToken) {
        this.saveTokens({
          accessToken: this.accessToken!,
          refreshToken: this.refreshToken,
          expiresAt: this.tokenExpiresAt,
          userId: this.currentUserId,
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

      this.ready = true
      this.emit("ready")
      logger.info("Slack", "Initialization complete")
    } catch (err: any) {
      logger.error("Slack", "Initialization failed", { error: err.message })
      
      // If auth failed, try refreshing token
      if (err.message?.includes("invalid_auth") || err.message?.includes("token_expired")) {
        if (this.refreshToken && this.clientId && this.clientSecret) {
          logger.info("Slack", "Auth failed, attempting token refresh")
          const refreshed = await this.refreshAccessToken()
          if (refreshed) {
            // Retry initialization
            return this.initialize()
          }
        }
      }
      
      throw err
    }
  }

  private setupSocketEventHandlers() {
    if (!this.socketClient) return
    
    logger.info("Slack", "=== Setting up Socket Mode event handlers ===")

    this.socketClient.on("message", async ({ event, ack }) => {
      await ack()
      logger.event("Slack", "EVENT: message", { 
        channel: event.channel, 
        user: event.user,
        text: event.text?.substring(0, 30),
        ts: event.ts
      })
      
      const formatted = await this.formatMessage(event)
      this.emit("message", formatted)
      logger.debug("Slack", "Emitted message event to listeners")
    })

    this.socketClient.on("reaction_added", async ({ event, ack }) => {
      await ack()
      logger.event("Slack", "EVENT: reaction_added", { 
        reaction: event.reaction,
        user: event.user,
        channel: event.item?.channel
      })
      this.emit("reaction", { type: "added", ...event })
    })

    this.socketClient.on("reaction_removed", async ({ event, ack }) => {
      await ack()
      logger.event("Slack", "EVENT: reaction_removed", { 
        reaction: event.reaction,
        user: event.user
      })
      this.emit("reaction", { type: "removed", ...event })
    })

    this.socketClient.on("channel_marked", async ({ event, ack }) => {
      await ack()
      logger.event("Slack", "EVENT: channel_marked", { channel: event.channel })
      this.emit("marked", event)
    })

    this.socketClient.on("member_joined_channel", async ({ event, ack }) => {
      await ack()
      logger.event("Slack", "EVENT: member_joined_channel", { 
        channel: event.channel,
        user: event.user
      })
      this.emit("member_joined", event)
    })

    this.socketClient.on("member_left_channel", async ({ event, ack }) => {
      await ack()
      logger.event("Slack", "EVENT: member_left_channel", { 
        channel: event.channel,
        user: event.user
      })
      this.emit("member_left", event)
    })

    this.socketClient.on("user_typing", async ({ event, ack }) => {
      await ack()
      logger.event("Slack", "EVENT: user_typing", { 
        channel: event.channel,
        user: event.user
      })
      this.emit("typing", { chatId: event.channel, isTyping: true })
    })

    this.socketClient.on("error", (error) => {
      logger.error("Slack", "EVENT: Socket Mode error", { error: (error as any).message || error })
      this.emit("error", error)
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

  // Diagnostic: Check what scopes the token actually has
  private async checkTokenScopes(): Promise<void> {
    if (!this.webClient) return

    try {
      const authTest = await this.webClient.auth.test()
      logger.info("Slack", "Token info", {
        userId: authTest.user_id,
        teamId: authTest.team_id,
        url: authTest.url,
        isEnterpriseInstall: authTest.is_enterprise_install
      })

      // Try to get the actual scopes - this only works for some token types
      try {
        const authRevoke = await this.webClient.auth.teams.list() as any
        if (authRevoke && authRevoke.teams) {
          logger.info("Slack", "Auth teams list worked", { teams: authRevoke.teams.length })
        }
      } catch (err: any) {
        logger.debug("Slack", "auth.teams.list not available (expected)", { error: err.message })
      }

      logger.info("Slack", "✓ Token is valid and authenticated")
    } catch (err: any) {
      logger.error("Slack", "Token scope check failed", { error: err.message })
    }
  }

  isReady(): boolean {
    return this.ready
  }

  async getChats(): Promise<ChatData[]> {
    logger.info("Slack", "=== getChats() START ===", { ready: this.ready })
    if (!this.ready || !this.webClient) {
      logger.warn("Slack", "getChats() called but client not ready!")
      return []
    }

    try {
      const chats: ChatData[] = []

      // DIAGNOSTIC: Try simpler calls first to see what works
      logger.info("Slack", "Testing API access with simpler calls...")
      
      // Test 1: users.list (needs users:read)
      try {
        const usersTest = await this.webClient.users.list({ limit: 1 })
        logger.info("Slack", "✓ users.list works - has users:read scope")
      } catch (err: any) {
        logger.warn("Slack", "✗ users.list failed", { 
          error: err.message,
          data: err.data 
        })
      }

      // Test 2: conversations.list with just public channels (needs channels:read)
      try {
        logger.info("Slack", "Trying conversations.list with only public_channel...")
        const publicOnly = await this.webClient.conversations.list({
          types: "public_channel",
          exclude_archived: true,
          limit: 5
        })
        logger.info("Slack", "✓ conversations.list (public_channel) works", { 
          count: publicOnly.channels?.length || 0 
        })
      } catch (err: any) {
        logger.error("Slack", "✗ conversations.list (public_channel) failed", { 
          error: err.message,
          code: err.code,
          data: err.data
        })
      }

      // Test 3: Try with just im (needs im:read)
      try {
        logger.info("Slack", "Trying conversations.list with only im...")
        const imsOnly = await this.webClient.conversations.list({
          types: "im",
          exclude_archived: true,
          limit: 5
        })
        logger.info("Slack", "✓ conversations.list (im) works", { 
          count: imsOnly.channels?.length || 0 
        })
      } catch (err: any) {
        logger.error("Slack", "✗ conversations.list (im) failed", { 
          error: err.message,
          code: err.code,
          data: err.data
        })
      }

      // Main call: Get all conversation types
      logger.info("Slack", "Attempting full conversations.list...")
      const channelsResult = await this.webClient.conversations.list({
        types: "public_channel,private_channel,mpim,im",
        exclude_archived: true,
        limit: 100
      })

      if (channelsResult.channels) {
        for (const channel of channelsResult.channels as SlackChannel[]) {
          // Skip channels bot isn't a member of (for public channels)
          if (channel.is_channel && !channel.is_member) continue
          
          // Cache channel
          this.channelCache.set(channel.id, channel)
          
          // Get unread count
          let unreadCount = 0
          try {
            const info = await this.webClient!.conversations.info({ channel: channel.id })
            if (info.channel) {
              unreadCount = (info.channel as any).unread_count || 0
            }
          } catch {
            // Ignore - some channels may not have unread info
          }

          // Format channel name for DMs
          let name = channel.name || "Unknown"
          if (channel.is_im) {
            // For DMs, get the user's name
            const userId = (channel as any).user
            if (userId) {
              const user = await this.getUser(userId)
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
        lastChat: chats[chats.length - 1]?.name
      })
      return chats
    } catch (err: any) {
      logger.error("Slack", "getChats() EXCEPTION", { error: err.message, stack: err.stack?.substring(0, 200) })
      return []
    }
  }

  async getMessages(channelId: string, limit: number = 50): Promise<MessageData[]> {
    logger.info("Slack", "getMessages() called", { channelId, limit, ready: this.ready })
    if (!this.ready || !this.webClient) {
      logger.warn("Slack", "getMessages() called but not ready")
      return []
    }

    try {
      const result = await this.webClient.conversations.history({
        channel: channelId,
        limit
      })

      if (!result.messages) return []

      const messages: MessageData[] = []
      for (const msg of result.messages as SlackMessage[]) {
        const formatted = await this.formatMessage(msg, channelId)
        messages.push(formatted)
      }

      // Slack returns newest first, reverse to get chronological order
      messages.reverse()
      
      logger.info("Slack", "getMessages() complete", { 
        channelId, 
        count: messages.length,
        oldest: messages[0]?.body?.substring(0, 20),
        newest: messages[messages.length - 1]?.body?.substring(0, 20)
      })
      return messages
    } catch (err: any) {
      logger.error("Slack", "getMessages() EXCEPTION", { channelId, error: err.message })
      return []
    }
  }

  async sendMessage(channelId: string, text: string): Promise<MessageData | null> {
    logger.info("Slack", "sendMessage() called", { channelId, textLength: text.length, textPreview: text.substring(0, 30) })
    if (!this.ready || !this.webClient) {
      logger.warn("Slack", "sendMessage() called but not ready")
      return null
    }

    try {
      logger.debug("Slack", "Calling chat.postMessage...")
      const result = await this.webClient.chat.postMessage({
        channel: channelId,
        text
      })

      if (result.ts && result.message) {
        logger.info("Slack", "Message sent successfully", { ts: result.ts, channel: channelId })
        return this.formatMessage(result.message as SlackMessage, channelId)
      }
      logger.warn("Slack", "sendMessage() - no ts or message in response")
      return null
    } catch (err: any) {
      logger.error("Slack", "sendMessage() EXCEPTION", { channelId, error: err.message })
      return null
    }
  }

  async markAsRead(channelId: string): Promise<void> {
    logger.debug("Slack", "markAsRead() called", { channelId })
    if (!this.ready || !this.webClient) {
      logger.warn("Slack", "markAsRead() called but not ready")
      return
    }

    try {
      // Get latest message timestamp
      const history = await this.webClient.conversations.history({
        channel: channelId,
        limit: 1
      })

      if (history.messages && history.messages.length > 0) {
        const latestTs = (history.messages[0] as SlackMessage).ts
        await this.webClient.conversations.mark({
          channel: channelId,
          ts: latestTs
        })
        logger.info("Slack", "Marked as read", { channelId, ts: latestTs })
      } else {
        logger.debug("Slack", "No messages to mark as read", { channelId })
      }
    } catch (err: any) {
      logger.error("Slack", "markAsRead() error", { channelId, error: err.message })
    }
  }

  async pinChat(channelId: string, pin: boolean): Promise<boolean> {
    // Slack doesn't have channel pinning in the same way
    // Could use starred channels but that's different
    logger.warn("Slack", "pinChat() not supported in Slack")
    return false
  }

  async muteChat(channelId: string, mute: boolean): Promise<boolean> {
    logger.info("Slack", "muteChat()", { channelId, mute })
    if (!this.ready || !this.webClient) return false

    try {
      // Slack uses conversations.setNotificationPreferences or similar
      // For now, not fully implemented
      logger.warn("Slack", "muteChat() not fully implemented")
      return false
    } catch (err: any) {
      logger.error("Slack", "muteChat() error", { error: err.message })
      return false
    }
  }

  async archiveChat(channelId: string, archive: boolean): Promise<boolean> {
    logger.info("Slack", "archiveChat()", { channelId, archive })
    if (!this.ready || !this.webClient) return false

    try {
      if (archive) {
        await this.webClient.conversations.archive({ channel: channelId })
      } else {
        await this.webClient.conversations.unarchive({ channel: channelId })
      }
      logger.info("Slack", "Archive toggled", { channelId, archive })
      return true
    } catch (err: any) {
      logger.error("Slack", "archiveChat() error", { error: err.message })
      return false
    }
  }

  async getContactInfo(userId: string): Promise<ContactData | null> {
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
        isBlocked: false
      }
    } catch {
      return null
    }
  }

  private async getUser(userId: string): Promise<SlackUser | null> {
    // Check cache first
    if (this.userCache.has(userId)) {
      return this.userCache.get(userId)!
    }

    if (!this.webClient) return null

    try {
      const result = await this.webClient.users.info({ user: userId })
      if (result.user) {
        const user = result.user as SlackUser
        this.userCache.set(userId, user)
        return user
      }
    } catch (err: any) {
      logger.error("Slack", "getUser() error", { userId, error: err.message })
    }
    return null
  }

  private async formatMessage(msg: SlackMessage, channelId?: string): Promise<MessageData> {
    const userId = msg.user || msg.bot_id
    const isFromMe = userId === this.currentUserId
    
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
      quotedMsgBody: undefined
    }
  }

  async destroy(): Promise<void> {
    logger.info("Slack", "Destroying client")
    try {
      if (this.socketClient) {
        await this.socketClient.disconnect()
      }
      this.webClient = null
      this.socketClient = null
      this.ready = false
      this.userCache.clear()
      this.channelCache.clear()
      logger.info("Slack", "Client destroyed")
    } catch (err: any) {
      logger.error("Slack", "Error destroying client", { error: err.message })
    }
  }

  getConnectionState(): { ready: boolean; hasQr: boolean } {
    return {
      ready: this.ready,
      hasQr: false // Slack doesn't use QR codes
    }
  }

  // Slack-specific methods

  async getWorkspaceInfo(): Promise<{ name: string; domain: string } | null> {
    if (!this.ready || !this.webClient) return null

    try {
      const result = await this.webClient.team.info()
      if (result.team) {
        return {
          name: (result.team as any).name || "Unknown",
          domain: (result.team as any).domain || ""
        }
      }
    } catch (err: any) {
      logger.error("Slack", "getWorkspaceInfo() error", { error: err.message })
    }
    return null
  }

  async addReaction(channelId: string, timestamp: string, emoji: string): Promise<boolean> {
    if (!this.ready || !this.webClient) return false

    try {
      await this.webClient.reactions.add({
        channel: channelId,
        timestamp,
        name: emoji
      })
      return true
    } catch (err: any) {
      logger.error("Slack", "addReaction() error", { error: err.message })
      return false
    }
  }

  async removeReaction(channelId: string, timestamp: string, emoji: string): Promise<boolean> {
    if (!this.ready || !this.webClient) return false

    try {
      await this.webClient.reactions.remove({
        channel: channelId,
        timestamp,
        name: emoji
      })
      return true
    } catch (err: any) {
      logger.error("Slack", "removeReaction() error", { error: err.message })
      return false
    }
  }

  async replyInThread(channelId: string, threadTs: string, text: string): Promise<MessageData | null> {
    if (!this.ready || !this.webClient) return null

    try {
      const result = await this.webClient.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text
      })

      if (result.ts && result.message) {
        return this.formatMessage(result.message as SlackMessage, channelId)
      }
      return null
    } catch (err: any) {
      logger.error("Slack", "replyInThread() error", { error: err.message })
      return null
    }
  }
}

export const slack = new SlackService()
