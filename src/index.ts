import { 
  createCliRenderer, 
  BoxRenderable, 
  TextRenderable,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  MacOSScrollAccel,
  type KeyEvent 
} from "@opentui/core"
import { logger } from "./utils/logger"
import { loadSettings, saveSettings, getSettings, updateSetting, SETTINGS_MENU, SETTINGS_PAGES, getNestedSetting, setNestedSetting, getKeybindingsSettings, type AppSettings, type SettingSection, type SettingsPage } from "./settings"
import { loadKeybindings, getKeybindings, matchesKeybinding, formatKeybinding, saveKeybindings, type KeyBindings, type KeyBinding } from "./keybindings"
import { SERVICES, getServiceTheme, getEnabledServices, type ServiceConfig, type ServiceTheme } from "./services/registry"
import { createMainMenuState, renderMainMenu, navigateMenu, getSelectedService, renderGlobalSettings, type MainMenuState } from "./ui/mainMenu"
import { detectTerminalCapabilities, getOptimalDisplayMode, type MediaDisplayMode } from "./utils/terminalCapabilities"
import { MediaRenderer } from "./utils/mediaRenderer"
import type { MessageData, MediaAttachment, ChatData } from "./services/types"
import { mediaCache } from "./utils/mediaCache"

const DEMO_MODE = process.argv.includes("--demo")

/**
 * OpenTUI 0.6 removed `Renderable.remove(id: string)` in favour of
 * `remove(child: BaseRenderable)`. This resolves a child by id first and
 * removes it when present, keeping the call sites readable.
 */
function removeChildById(
  parent: { getRenderable(id: string): unknown; remove(child: any): void },
  id: string,
): void {
  const child = parent.getRenderable(id)
  if (child) parent.remove(child)
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                        ChitChat v0.0.1                        ║
║          Universal Terminal Messaging Client (TUI)            ║
╚═══════════════════════════════════════════════════════════════╝

USAGE:
  chitchat [OPTIONS]

OPTIONS:
  --demo          Run in demo mode (no real connections)
  --help, -h      Show this help message and exit

DESCRIPTION:
  ChitChat is a terminal-based messaging client that supports
  multiple messaging platforms including WhatsApp and Slack.

FEATURES:
  • Clean TUI interface built with OpenTUI
  • Multi-service support (WhatsApp, Slack)
  • Media support (images, documents, audio)
  • QR code authentication for WhatsApp
  • Real-time message synchronization

KEYBOARD SHORTCUTS:
  ↑↓              Navigate chats/messages
  Enter           Select chat or send message
  Tab             Switch focus between panels
  ?               Toggle help overlay
  F2              Open settings
  Ctrl+P          Pin/unpin chat
  Ctrl+M          Mute/unmute chat
  Ctrl+A          Archive/unarchive chat
  Ctrl+R          Refresh chat list
  Ctrl+Q          Quit application

GETTING STARTED:
  1. Run 'chitchat' to start the application
  2. Select a messaging service from the main menu
  3. Follow authentication prompts (QR code for WhatsApp)
  4. Start messaging!

EXAMPLES:
  chitchat              # Start normally
  chitchat --demo       # Run in demo mode for testing

For more information, visit:
  https://github.com/Botolog/ChitChat

Report issues at:
  https://github.com/Botolog/ChitChat/issues
`)
  process.exit(0)
}

logger.info("App", "Starting ChatClient", { demoMode: DEMO_MODE, args: process.argv })

// App view state
type AppView = "main_menu" | "global_settings" | "service"
let currentView: AppView = "main_menu"
let currentServiceId: string | null = null
let mainMenuState: MainMenuState = createMainMenuState()
let globalSettingsItem = 0

// Initialize media renderer
const termCapabilities = detectTerminalCapabilities()
logger.info("App", "Terminal capabilities", termCapabilities)
let mediaRenderer: MediaRenderer | null = null

const DEMO_CHATS: ChatData[] = [
  { id: "1", name: "John Doe", isGroup: false, unreadCount: 2, pinned: true, muted: false, archived: false, lastMessage: { body: "Hey, how are you?", timestamp: Date.now() / 1000, fromMe: false } },
  { id: "2", name: "Jane Smith", isGroup: false, unreadCount: 0, pinned: false, muted: false, archived: false, lastMessage: { body: "See you tomorrow!", timestamp: Date.now() / 1000 - 3600, fromMe: true } },
  { id: "3", name: "Work Group", isGroup: true, unreadCount: 5, pinned: false, muted: false, archived: false, participantCount: 12, lastMessage: { body: "Meeting at 3pm", timestamp: Date.now() / 1000 - 7200, fromMe: false } },
  { id: "4", name: "Family", isGroup: true, unreadCount: 0, pinned: false, muted: true, archived: false, participantCount: 8, lastMessage: { body: "Happy birthday! 🎂", timestamp: Date.now() / 1000 - 86400, fromMe: false } },
  { id: "5", name: "Bob Wilson", isGroup: false, unreadCount: 1, pinned: false, muted: false, archived: false, lastMessage: { body: "Thanks for the help!", timestamp: Date.now() / 1000 - 172800, fromMe: false } },
]

const DEMO_MESSAGES: Record<string, MessageData[]> = {
  "1": [
    { id: "m1", body: "Hey there! 👋", timestamp: Date.now() / 1000 - 300, fromMe: false, hasMedia: false, type: "chat", ack: 3 },
    { id: "m2", body: "Hi! How are you doing?", timestamp: Date.now() / 1000 - 240, fromMe: true, hasMedia: false, type: "chat", ack: 3 },
    { id: "m3", body: "I'm good! Working on that project.", timestamp: Date.now() / 1000 - 180, fromMe: false, hasMedia: false, type: "chat", ack: 3, isStarred: true },
    { id: "m4", body: "Let me know if you need help!", timestamp: Date.now() / 1000 - 120, fromMe: true, hasMedia: false, type: "chat", ack: 2 },
    { id: "m5", body: "Hey, how are you?", timestamp: Date.now() / 1000 - 60, fromMe: false, hasMedia: false, type: "chat", ack: 0, hasQuotedMsg: true, quotedMsgBody: "Let me know if you need help!", quotedMsgId: "m4" },
  ],
  "2": [
    { id: "m1", body: "Are you coming to the party?", timestamp: Date.now() / 1000 - 7200, fromMe: false, hasMedia: false, type: "chat", ack: 3 },
    { id: "m2", body: "Yes! What time?", timestamp: Date.now() / 1000 - 7000, fromMe: true, hasMedia: false, type: "chat", ack: 3 },
    { id: "m3", body: "8pm at my place", timestamp: Date.now() / 1000 - 6800, fromMe: false, hasMedia: false, type: "chat", ack: 3, isStarred: true },
    { id: "m4", body: "See you tomorrow!", timestamp: Date.now() / 1000 - 3600, fromMe: true, hasMedia: false, type: "chat", ack: 3 },
  ],
  "3": [
    { id: "m1", body: "Team, don't forget the meeting", timestamp: Date.now() / 1000 - 10000, fromMe: false, authorName: "Boss", hasMedia: false, type: "chat", ack: 3, isForwarded: true },
    { id: "m2", body: "I'll be there", timestamp: Date.now() / 1000 - 9000, fromMe: true, hasMedia: false, type: "chat", ack: 3 },
    { id: "m3", body: "Same here 👍", timestamp: Date.now() / 1000 - 8500, fromMe: false, authorName: "Alice", hasMedia: false, type: "chat", ack: 3, hasQuotedMsg: true, quotedMsgBody: "Team, don't forget the meeting", quotedMsgId: "m1" },
    { id: "m4", body: "Meeting at 3pm", timestamp: Date.now() / 1000 - 7200, fromMe: false, authorName: "Boss", hasMedia: false, type: "chat", ack: 3, isStarred: true },
  ],
  "4": [
    { id: "m1", body: "Happy birthday! 🎂🎉", timestamp: Date.now() / 1000 - 90000, fromMe: false, authorName: "Mom", hasMedia: false, type: "chat", ack: 3, isForwarded: true, forwardingScore: 5 },
    { id: "m2", body: "Thanks everyone!", timestamp: Date.now() / 1000 - 89000, fromMe: true, hasMedia: false, type: "chat", ack: 3 },
    { id: "m3", body: "🎈🎁", timestamp: Date.now() / 1000 - 88000, fromMe: false, authorName: "Dad", hasMedia: false, type: "chat", ack: 3 },
  ],
  "5": [
    { id: "m1", body: "Can you help me with the code?", timestamp: Date.now() / 1000 - 200000, fromMe: false, hasMedia: false, type: "chat", ack: 3 },
    { id: "m2", body: "Sure, what's the issue?", timestamp: Date.now() / 1000 - 199000, fromMe: true, hasMedia: false, type: "chat", ack: 3, hasQuotedMsg: true, quotedMsgBody: "Can you help me with the code?", quotedMsgId: "m1" },
    { id: "m3", body: "", timestamp: Date.now() / 1000 - 198000, fromMe: false, hasMedia: true, type: "image", ack: 3 },
    { id: "m4", body: "", timestamp: Date.now() / 1000 - 197000, fromMe: true, hasMedia: true, type: "document", ack: 3 },
    { id: "m5", body: "", timestamp: Date.now() / 1000 - 196000, fromMe: false, hasMedia: true, type: "ptt", ack: 3 },
    { id: "m6", body: "I fixed it, thanks!", timestamp: Date.now() / 1000 - 172800, fromMe: false, hasMedia: false, type: "chat", ack: 3, isStarred: true },
  ],
}

// Dynamic colors based on current service (default to WhatsApp)
let colors: ServiceTheme = getServiceTheme("whatsapp")

function setServiceTheme(serviceId: string) {
  colors = getServiceTheme(serviceId)
  currentServiceId = serviceId
  logger.info("App", "Theme changed", { serviceId, primary: colors.primary })
}

// Cleanup function to restore terminal on exit
let cleanupDone = false
function cleanupTerminal() {
  if (cleanupDone) return
  cleanupDone = true
  
  // Disable all mouse tracking modes
  process.stdout.write('\x1b[?1000l') // X11 mouse tracking
  process.stdout.write('\x1b[?1002l') // Button event tracking  
  process.stdout.write('\x1b[?1003l') // Any event tracking
  process.stdout.write('\x1b[?1006l') // SGR mouse mode
  process.stdout.write('\x1b[?1015l') // urxvt mouse mode
  process.stdout.write('\x1b[?1005l') // UTF-8 mouse mode
  
  // Restore cursor and clear
  process.stdout.write('\x1b[?25h') // Show cursor
  process.stdout.write('\x1b[0m')   // Reset colors
  process.stdout.write('\x1b[2J\x1b[H') // Clear screen
}

// Register cleanup handlers
process.on('exit', cleanupTerminal)
process.on('SIGINT', () => { cleanupTerminal(); process.exit(0) })
process.on('SIGTERM', () => { cleanupTerminal(); process.exit(0) })
process.on('uncaughtException', (err) => { 
  cleanupTerminal()
  console.error('Uncaught exception:', err)
  logger.error("App", `Uncaught exception: ${err}`)
  process.exit(2)
})

async function main() {
  logger.info("App", "main() starting")
  
  logger.debug("App", "Creating CLI renderer")
  const renderer = await createCliRenderer({ exitOnCtrlC: false })
  logger.info("App", "CLI renderer created")

  let width = process.stdout.columns || 80
  let height = process.stdout.rows || 24
  let chatListWidth = 32
  let msgAreaWidth = width - chatListWidth - 2
  logger.debug("App", "Terminal dimensions", { width, height, chatListWidth, msgAreaWidth })

  // Handle terminal resize - update dimensions and re-render
  async function handleResize() {
    logger.debug("App", "Resize detected", { width, height })
    
    // Update global dimensions
    chatListWidth = Math.floor(width * 0.15)
    msgAreaWidth = width - chatListWidth - 2
    logger.info("App", "Terminal resized - updating UI", { width, height, msgAreaWidth })
    
    // Update UI component dimensions
    mainBox.width = width
    mainBox.height = height
    rightPanel.width = msgAreaWidth
    rightPanel.height = height - 2
    chatListLeftBorder.height = height - 2
    chatListBox.height = height - 2
    messagesRightBorder.height = height - 2
    
    // Update left border 'l' characters for new height
    // Remove old border characters and recreate
    for (let i = 0; i < 100; i++) { // Remove up to 100 old characters
      removeChildById(chatListLeftBorder, `chat-border-l-${i}`)
    }
    for (let i = 0; i < height - 2; i++) {
      const borderChar = new TextRenderable(renderer, {
        id: `chat-border-l-${i}`,
        content: "l",
        fg: colors.border,
      })
      chatListLeftBorder.add(borderChar)
    }
    
    // Update right border 'l' characters for new height
    for (let i = 0; i < 100; i++) { // Remove up to 100 old characters
      removeChildById(messagesRightBorder, `messages-border-l-${i}`)
    }
    for (let i = 0; i < height - 2; i++) {
      const borderChar = new TextRenderable(renderer, {
        id: `messages-border-l-${i}`,
        content: "l",
        fg: colors.border,
      })
      messagesRightBorder.add(borderChar)
    }
    
    messagesScroll.width = msgAreaWidth
    messagesScroll.height = height - 8
    statusBar.width = width
    titleBar.width = width
    contentRow.width = width
    contentRow.height = height - 2
    inputArea.width = msgAreaWidth
    messageInput.width = msgAreaWidth - 8
    chatHeader.width = msgAreaWidth
    
    // Update menu dimensions
    if (menuBox) {
      menuBox.width = width
      menuBox.height = height
    }
    
    // Update settings dimensions
    if (settingsBox) {
      settingsBox.width = width
      settingsBox.height = height
    }

    // Update QR modal dimensions
    if (qrModalOverlay) {
      qrModalOverlay.width = width
      qrModalOverlay.height = height
    }
    
    // Re-render based on current view
    if (currentView === "main_menu") {
      // Menu will auto-update with new dimensions
    } else if (currentView === "service") {
      if (chats.length > 0) {
        renderChats()
        updateSelection()
      }
      if (messages.length > 0) {
        await renderMessages()
      }
    }
    
    // Rebuild settings if open
    if (showSettings) {
      buildSettingsItems()
    }
    
    logger.debug("App", "Resize complete - UI updated")
  }
  
  process.stdout.on("resize", handleResize)

  let chats: ChatData[] = DEMO_MODE ? DEMO_CHATS : []
  let messages: MessageData[] = []
  let selectedChat = 0
  let selectedMessage = -1 // -1 means hidden, >=0 shows cursor
  let currentChatId: string | null = null
  let focusArea: "chats" | "input" | "settings" | "messages" | "editing" = "chats"
  let isReady = DEMO_MODE
  let replyToMessageId: string | null = null // Message to reply to
  let editingMessageId: string | null = null // Message being edited
  
  // Settings state
  let showSettings = false
  let settingsSection = 0
  let settingsItem = 0
  let currentSettingsPage = 0 // Track which settings page (Main, WhatsApp, Slack)
  const settings = loadSettings()
  const keybindings = loadKeybindings()

  // Placeholder functions - will be defined after UI components are created
  let showMainMenu: () => void
  let showServiceView: () => void
  let showGlobalSettingsView: () => void
  let enterService: (serviceId: string) => void
  let exitToMainMenu: () => void

  // Service manager for multi-service support
  const { getServiceInstance, destroyAllServices } = await import("./services/index")
  let activeService: any = null
  let activeServiceId: string | null = null

  // Main container
  const mainBox = new BoxRenderable(renderer, {
    id: "main",
    width: width,
    height: height,
    flexDirection: "column",
    backgroundColor: colors.bg,
  })

  // Title bar
  const titleBar = new BoxRenderable(renderer, {
    id: "title",
    width: width,
    height: 1,
    backgroundColor: "#128C7E",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingLeft: 1,
    paddingRight: 1,
  })
  const modeLabel = DEMO_MODE ? " [DEMO]" : ""
  const titleText = new TextRenderable(renderer, {
    id: "title-text",
    content: `📱 WhatsApp TUI Client${modeLabel}`,
    fg: "#FFFFFF",
  })
  titleBar.add(titleText)

  // Content row
  const contentRow = new BoxRenderable(renderer, {
    id: "content",
    width: width,
    height: height - 2,
    flexDirection: "row",
  })

  // Custom left border for chat list (made of 'l' characters)
  const chatListLeftBorder = new BoxRenderable(renderer, {
    id: "chat-list-left-border",
    width: 1,
    height: height - 2,
    backgroundColor: colors.bg,
    flexDirection: "column",
  })
  
  // Fill with 'l' characters
  for (let i = 0; i < height - 2; i++) {
    const borderChar = new TextRenderable(renderer, {
      id: `chat-border-l-${i}`,
      content: "l",
      fg: "#00000000",
    })
    chatListLeftBorder.add(borderChar)
  }

  // Chat list
  const chatListBox = new BoxRenderable(renderer, {
    id: "chat-list",
    width: chatListWidth,
    height: height - 2,
    borderStyle: "rounded",
    borderColor: colors.primary,
    backgroundColor: colors.surface,
    title: DEMO_MODE ? " Chats (5) " : " Chats ",
    titleAlignment: "center",
    flexDirection: "column",
    padding: 1,
  })
  
  // Custom right border for messages area (made of 'l' characters)
  const messagesRightBorder = new BoxRenderable(renderer, {
    id: "messages-right-border",
    width: 1,
    height: height - 2,
    backgroundColor: colors.bg,
    flexDirection: "column",
  })
  
  // Fill with 'l' characters
  for (let i = 0; i < height - 2; i++) {
    const borderChar = new TextRenderable(renderer, {
      id: `messages-border-l-${i}`,
      content: "l",
      fg: "#00000000",
    })
    messagesRightBorder.add(borderChar)
  }
  
  // Function to update chat list title with count
  function updateChatListTitle() {
    chatListBox.title = ` Chats (${chats.length}) `
    logger.debug("UI", "Updated chat list title", { count: chats.length })
  }

  const loadingText = new TextRenderable(renderer, {
    id: "loading-text",
    content: DEMO_MODE ? "Demo mode active" : "Initializing...\nScan QR in terminal",
    fg: colors.textMuted,
  })

  // Add loading text - will be removed when chats are rendered
  // In demo mode, renderChats() will be called immediately after setup
  if (!DEMO_MODE) {
    logger.debug("Init", "Non-demo mode - adding loading text to chatListBox")
    chatListBox.add(loadingText)
  } else {
    logger.debug("Init", "Demo mode - loading text not added, renderChats() will handle display")
  }

  // Right panel
  const rightPanel = new BoxRenderable(renderer, {
    id: "right-panel",
    width: msgAreaWidth,
    height: height - 2,
    flexDirection: "column",
    backgroundColor: colors.bg,
  })

  // Chat header
  const chatHeader = new BoxRenderable(renderer, {
    id: "chat-header",
    width: msgAreaWidth,
    height: 2,
    backgroundColor: colors.surface,
    paddingLeft: 2,
    flexDirection: "row",
    alignItems: "center",
  })
  const chatHeaderText = new TextRenderable(renderer, {
    id: "chat-header-text",
    content: "Select a chat",
    fg: colors.text,
  })
  const chatHeaderMsgCount = new TextRenderable(renderer, {
    id: "chat-header-count",
    content: "",
    fg: colors.textMuted,
  })
  chatHeader.add(chatHeaderText)
  chatHeader.add(chatHeaderMsgCount)
  
  // Function to update chat header with message count and group info
  function updateChatHeader(chatName: string, msgCount: number, chat?: ChatData) {
    chatHeaderText.content = chatName
    
    let infoStr = ""
    if (chat?.isGroup && chat.participantCount) {
      infoStr = ` (${chat.participantCount} members)`
    } else if (msgCount > 0) {
      infoStr = ` (${msgCount} messages)`
    }
    chatHeaderMsgCount.content = infoStr
    logger.debug("UI", "Updated chat header", { chatName, msgCount, isGroup: chat?.isGroup, participantCount: chat?.participantCount })
  }

  // Messages scroll - stickyScroll enabled for auto-scroll to bottom on new messages
  const messagesScroll = new ScrollBoxRenderable(renderer, {
    id: "messages-scroll",
    width: msgAreaWidth,
    height: height - 8,
    stickyScroll: true,
    stickyStart: "bottom",
  })

  const emptyMsgText = new TextRenderable(renderer, {
    id: "empty-msg",
    content: "Select a chat to view messages\n\nUse ↑↓ to navigate\nPress Enter to select\nTab to switch focus",
    fg: colors.textMuted,
  })
  messagesScroll.add(emptyMsgText)

  // Input area
  const inputArea = new BoxRenderable(renderer, {
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

  const messageInput = new InputRenderable(renderer, {
    id: "message-input",
    width: msgAreaWidth - 8,
    placeholder: "Type a message...",
    backgroundColor: colors.surfaceLight,
    focusedBackgroundColor: colors.surfaceLight,
    textColor: colors.text,
    cursorColor: colors.primary,
  })
  
  // Log input changes for debugging
  messageInput.on(InputRenderableEvents.CHANGE, (value: string) => {
    logger.debug("InputChange", "Input value changed", { length: value.length, preview: value.substring(0, 20) })
  })

  const sendHint = new TextRenderable(renderer, {
    id: "send-hint",
    content: " ⏎",
    fg: colors.textMuted,
  })

  inputArea.add(messageInput)
  inputArea.add(sendHint)
  rightPanel.add(chatHeader)
  rightPanel.add(messagesScroll)
  rightPanel.add(inputArea)

  // Status bar
  const statusBar = new BoxRenderable(renderer, {
    id: "status",
    width: width,
    height: 1,
    backgroundColor: colors.surface,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingLeft: 1,
    paddingRight: 1,
  })
  const statusText = new TextRenderable(renderer, {
    id: "status-text",
    content: DEMO_MODE ? "● Demo Mode" : "○ Connecting...",
    fg: DEMO_MODE ? colors.primary : colors.textMuted,
  })
  const helpText = new TextRenderable(renderer, {
    id: "help-text",
    content: "?:Help │ F2:Settings │ ↑↓:Nav │ Ctrl+P:Pin │ Ctrl+M:Mute │ Ctrl+A:Archive │ Ctrl+R:Refresh │ Ctrl+Q:Quit",
    fg: colors.textMuted,
  })
  statusBar.add(statusText)
  statusBar.add(helpText)

  // Build tree
  contentRow.add(chatListLeftBorder)
  contentRow.add(chatListBox)
  contentRow.add(messagesRightBorder)
  contentRow.add(rightPanel)
  mainBox.add(titleBar)
  mainBox.add(contentRow)
  mainBox.add(statusBar)
  renderer.root.add(mainBox)

  // ========== MAIN MENU (OpenTUI components) ==========
  const menuBox = new BoxRenderable(renderer, {
    id: "menu-box",
    width: width,
    height: height,
    backgroundColor: "#0D1117",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
  })

  const menuTitle = new TextRenderable(renderer, {
    id: "menu-title",
    content: "═══════════════════════════════════════",
    fg: "#58A6FF",
  })
  
  const menuLogo = new TextRenderable(renderer, {
    id: "menu-logo", 
    content: "💬 ChatClient",
    fg: "#FFFFFF",
  })
  
  const menuSubtitle = new TextRenderable(renderer, {
    id: "menu-subtitle",
    content: "Universal Messaging Client v1.0",
    fg: "#8B949E",
  })

  const menuSpacer = new TextRenderable(renderer, {
    id: "menu-spacer",
    content: " ",
    fg: "#8B949E",
  })

  const menuInstructions = new TextRenderable(renderer, {
    id: "menu-instructions",
    content: "Select a service:",
    fg: "#C9D1D9",
  })

  // Service menu items (use BoxRenderable for background color support)
  const menuItemBoxes: { box: BoxRenderable; text: TextRenderable }[] = []
  const services = getEnabledServices()
  
  for (let i = 0; i < services.length; i++) {
    const svc = services[i]
    const itemBox = new BoxRenderable(renderer, {
      id: `menu-item-box-${i}`,
      width: 30,
      height: 1,
      backgroundColor: i === 0 ? "#30363D" : "#0D1117",
      justifyContent: "center",
    })
    const itemText = new TextRenderable(renderer, {
      id: `menu-item-${i}`,
      content: `${svc.icon}  ${svc.name}`,
      fg: i === 0 ? "#FFFFFF" : "#8B949E",
    })
    itemBox.add(itemText)
    menuItemBoxes.push({ box: itemBox, text: itemText })
  }

  const menuFooter = new TextRenderable(renderer, {
    id: "menu-footer",
    content: "↑↓ Navigate │ Enter Select │ S Settings │ Q Quit",
    fg: "#6E7681",
  })

  // Add all to menu
  menuBox.add(menuTitle)
  menuBox.add(menuLogo)
  menuBox.add(menuSubtitle)
  menuBox.add(menuSpacer)
  menuBox.add(menuInstructions)
  for (const item of menuItemBoxes) {
    menuBox.add(item.box)
  }
  menuBox.add(menuSpacer)
  menuBox.add(menuFooter)

  renderer.root.add(menuBox)
  
  // Start with menu visible, main hidden
  mainBox.visible = false
  menuBox.visible = true

  // Menu selection state
  let menuSelectedIndex = 0

  // ========== SETTINGS VIEW (OpenTUI components) ==========
  const settingsBox = new BoxRenderable(renderer, {
    id: "settings-box",
    width: width,
    height: height,
    backgroundColor: "#0D1117",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
  })

  const settingsTitle = new TextRenderable(renderer, {
    id: "settings-title",
    content: "⚙️  Settings",
    fg: "#58A6FF",
  })

  const settingsSpacer = new TextRenderable(renderer, {
    id: "settings-spacer",
    content: " ",
    fg: "#8B949E",
  })

  // Settings items will be dynamically built - track IDs for removal
  let settingsItemIds: string[] = []
  
  function buildSettingsItems() {
    // Remove all previously added dynamic items by ID
    for (const id of settingsItemIds) {
      removeChildById(settingsBox, id)
    }
    settingsItemIds = []
    
    // Settings page tabs
    const currentPage = SETTINGS_PAGES[currentSettingsPage]
    const pageTabsText = SETTINGS_PAGES.map((p, idx) => 
      idx === currentSettingsPage ? `[${p.title}]` : p.title
    ).join("  ")
    
    settingsTitle.content = `⚙️ Settings - ${pageTabsText}\n`
    
    // Add title
    settingsBox.add(settingsTitle)
    settingsBox.add(settingsSpacer)
    
    // Get sections - use dynamic sections for keybindings page
    const sections = currentPage.id === "keybindings" 
      ? getKeybindingsSettings() 
      : currentPage.sections
    
    // Build items from current settings page
    sections.forEach((section, sIdx) => {
      // Section header
      const headerId = `settings-section-${sIdx}`
      const sectionHeader = new TextRenderable(renderer, {
        id: headerId,
        content: section.title,
        fg: "#8B949E",
      })
      settingsBox.add(sectionHeader)
      settingsItemIds.push(headerId)
      
      section.items.forEach((menuItem, iIdx) => {
        const isSelected = sIdx === settingsSection && iIdx === settingsItem
        
        let valueStr = ""
        if (menuItem.type === "keybinding" && menuItem.keybindingKey) {
          // Get current keybinding value
          const kb = keybindings[menuItem.keybindingKey as keyof KeyBindings]
          if (kb) {
            valueStr = ` [${formatKeybinding(kb)}]`
          }
        } else if (menuItem.key) {
          const val = getNestedSetting(menuItem.key)
          if (menuItem.type === "toggle") {
            valueStr = val ? " [●]" : " [○]"
          } else if (menuItem.type === "radio" || menuItem.type === "select") {
            const opt = menuItem.options?.find(o => o.value === val)
            valueStr = ` [${opt?.label || val}]`
          } else if (menuItem.type === "number") {
            valueStr = ` [${val}]`
          }
        } else if (menuItem.type === "button") {
          valueStr = " →"
        }
        
        const boxId = `settings-item-box-${sIdx}-${iIdx}`
        const itemBox = new BoxRenderable(renderer, {
          id: boxId,
          width: 50,
          height: 1,
          backgroundColor: isSelected ? "#30363D" : "#0D1117",
          justifyContent: "flex-start",
          paddingLeft: 2,
        })
        
        const itemText = new TextRenderable(renderer, {
          id: `settings-item-${sIdx}-${iIdx}`,
          content: `${isSelected ? "▸ " : "  "}${menuItem.label}${valueStr}`,
          fg: isSelected ? "#FFFFFF" : "#8B949E",
        })
        
        itemBox.add(itemText)
        settingsBox.add(itemBox)
        settingsItemIds.push(boxId)
      })
      
      // Add spacer after section
      const spacerId = `settings-section-spacer-${sIdx}`
      const sectionSpacer = new TextRenderable(renderer, {
        id: spacerId,
        content: " ",
        fg: "#8B949E",
      })
      settingsBox.add(sectionSpacer)
      settingsItemIds.push(spacerId)
    })
    
    // Footer
    const footerId = "settings-footer"
    const settingsFooter = new TextRenderable(renderer, {
      id: footerId,
      content: "↑↓ Navigate │ Enter Toggle │ Esc Close",
      fg: "#6E7681",
    })
    settingsBox.add(settingsFooter)
    settingsItemIds.push(footerId)
  }

  renderer.root.add(settingsBox)
  settingsBox.visible = false
  
  function updateMenuSelection() {
    for (let i = 0; i < menuItemBoxes.length; i++) {
      const isSelected = i === menuSelectedIndex
      menuItemBoxes[i].box.backgroundColor = isSelected ? "#30363D" : "#0D1117"
      menuItemBoxes[i].text.fg = isSelected ? "#FFFFFF" : "#8B949E"
    }
  }

  // ========== CONFIRMATION MODAL ==========
  const confirmModalOverlay = new BoxRenderable(renderer, {
    id: "confirm-modal-overlay",
    width: width,
    height: height,
    backgroundColor: "#0D1117",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    visible: false,
  })

  const confirmModalTitle = new TextRenderable(renderer, {
    id: "confirm-modal-title",
    content: "⚠️  Confirm Delete",
    fg: "#F15C6D",
  })

  const confirmModalSpacer1 = new TextRenderable(renderer, {
    id: "confirm-modal-spacer1",
    content: " ",
    fg: "#8B949E",
  })

  const confirmModalMessage = new TextRenderable(renderer, {
    id: "confirm-modal-message",
    content: "",
    fg: "#C9D1D9",
  })

  const confirmModalSpacer2 = new TextRenderable(renderer, {
    id: "confirm-modal-spacer2",
    content: " ",
    fg: "#8B949E",
  })

  const confirmModalOptions = new TextRenderable(renderer, {
    id: "confirm-modal-options",
    content: "[Y] Yes  [N] No  [Esc] Cancel",
    fg: "#6E7681",
  })

  confirmModalOverlay.add(confirmModalTitle)
  confirmModalOverlay.add(confirmModalSpacer1)
  confirmModalOverlay.add(confirmModalMessage)
  confirmModalOverlay.add(confirmModalSpacer2)
  confirmModalOverlay.add(confirmModalOptions)
  renderer.root.add(confirmModalOverlay)

  // Confirmation modal state
  let confirmModalVisible = false
  let confirmModalCallback: ((confirmed: boolean) => void) | null = null

  // Store previous visibility state
  let modalPreviousMainBoxVisible = false
  let modalPreviousMenuBoxVisible = false
  let modalPreviousSettingsBoxVisible = false

  function showConfirmModal(message: string, callback: (confirmed: boolean) => void) {
    confirmModalMessage.content = message
    confirmModalCallback = callback
    confirmModalVisible = true
    
    // Store current visibility state
    modalPreviousMainBoxVisible = mainBox.visible
    modalPreviousMenuBoxVisible = menuBox.visible
    modalPreviousSettingsBoxVisible = settingsBox.visible
    
    // Hide all other UI elements
    mainBox.visible = false
    menuBox.visible = false
    settingsBox.visible = false
    
    // Show modal
    confirmModalOverlay.visible = true
    
    logger.info("App", "Showing confirmation modal", { 
      message, 
      overlayVisible: confirmModalOverlay.visible,
      modalVisible: confirmModalVisible 
    })
  }

  function hideConfirmModal() {
    confirmModalVisible = false
    confirmModalOverlay.visible = false
    confirmModalCallback = null
    
    // Restore previous visibility state
    mainBox.visible = modalPreviousMainBoxVisible
    menuBox.visible = modalPreviousMenuBoxVisible
    settingsBox.visible = modalPreviousSettingsBoxVisible
    
    logger.info("App", "Hiding confirmation modal")
  }

  // ========== QR CODE MODAL (WhatsApp authentication) ==========
  // Rendered inside the TUI because OpenTUI owns the terminal: a QR printed to
  // stdout by the service is overwritten by the renderer and never seen.
  const qrModalOverlay = new BoxRenderable(renderer, {
    id: "qr-modal-overlay",
    width: width,
    height: height,
    backgroundColor: "#0D1117",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    visible: false,
  })

  const qrModalTitle = new TextRenderable(renderer, {
    id: "qr-modal-title",
    content: "📱 Scan this QR code with WhatsApp",
    fg: colors.primary,
  })

  const qrModalHint = new TextRenderable(renderer, {
    id: "qr-modal-hint",
    content: "WhatsApp → Settings → Linked devices → Link a device",
    fg: "#8B949E",
  })

  const qrModalCode = new TextRenderable(renderer, {
    id: "qr-modal-code",
    content: "",
    fg: "#FFFFFF",
  })

  const qrModalFooter = new TextRenderable(renderer, {
    id: "qr-modal-footer",
    content: "",
    fg: "#6E7681",
  })

  qrModalOverlay.add(qrModalTitle)
  qrModalOverlay.add(qrModalHint)
  qrModalOverlay.add(qrModalCode)
  qrModalOverlay.add(qrModalFooter)
  renderer.root.add(qrModalOverlay)

  let qrModalVisible = false
  let qrModalPrevMainBoxVisible = false
  let qrModalPrevMenuBoxVisible = false

  function showQrModal(qrText: string) {
    qrModalTitle.content = "📱 Scan this QR code with WhatsApp"
    qrModalHint.content = "WhatsApp → Settings → Linked devices → Link a device"
    qrModalCode.content = qrText
    qrModalFooter.content = "Waiting for you to scan… (Esc to hide)"

    // Remember what was visible, then take over the screen.
    qrModalPrevMainBoxVisible = mainBox.visible
    qrModalPrevMenuBoxVisible = menuBox.visible
    mainBox.visible = false
    menuBox.visible = false
    settingsBox.visible = false

    qrModalVisible = true
    qrModalOverlay.visible = true
    logger.info("App", "Showing QR modal", { lines: qrText.split("\n").length })
  }

  function hideQrModal() {
    if (!qrModalVisible) return
    qrModalVisible = false
    qrModalOverlay.visible = false

    // Restore the previous view.
    mainBox.visible = qrModalPrevMainBoxVisible
    menuBox.visible = qrModalPrevMenuBoxVisible
    logger.info("App", "Hiding QR modal")
  }

  // Define view switching functions now that UI components exist
  showMainMenu = () => {
    mainBox.visible = false
    menuBox.visible = true
    currentView = "main_menu"
    updateMenuSelection()
    logger.debug("App", "Showing main menu")
  }

  showServiceView = () => {
    menuBox.visible = false
    mainBox.visible = true
    logger.debug("App", "Showing service view")
  }

  showGlobalSettingsView = () => {
    console.clear()
    renderGlobalSettings(width, height, globalSettingsItem, (lines) => {
      const startY = Math.max(1, Math.floor((height - lines.length) / 2))
      const boxWidth = Math.min(60, width - 4)
      const startX = Math.max(1, Math.floor((width - boxWidth) / 2))
      lines.forEach((line, i) => {
        process.stdout.write(`\x1b[${startY + i};${startX}H${line}`)
      })
    })
  }

  enterService = async (serviceId: string) => {
    setServiceTheme(serviceId)
    activeServiceId = serviceId
    currentView = "service"
    
    // Initialize media renderer based on settings
    const settings = getSettings()
    const displayMode = settings.mediaDisplayMode === 'auto' 
      ? getOptimalDisplayMode(termCapabilities)
      : settings.mediaDisplayMode as MediaDisplayMode
    mediaRenderer = new MediaRenderer(displayMode)
    logger.info("App", "Media renderer initialized", { mode: displayMode })
    
    // Update all UI component colors
    mainBox.backgroundColor = colors.bg
    titleBar.backgroundColor = colors.titleBar
    chatListBox.borderColor = colors.primary
    chatListBox.backgroundColor = colors.surface
    rightPanel.backgroundColor = colors.bg
    chatHeader.backgroundColor = colors.surface
    chatHeaderText.fg = colors.text
    chatHeaderMsgCount.fg = colors.textMuted
    messagesScroll.backgroundColor = colors.bg
    inputArea.borderColor = colors.border
    statusBar.backgroundColor = colors.surface
    statusText.fg = colors.primary
    statusText.content = DEMO_MODE ? "● Demo Mode" : "○ Connecting..."
    helpText.fg = colors.textMuted
    
    const service = SERVICES[serviceId]
    titleText.content = `${service?.icon || "💬"} ${service?.name || serviceId} Client${modeLabel}`
    
    showServiceView()
    mainBox.visible = true
    renderChats()
    updateSelection()
    
    if (DEMO_MODE) {
      isReady = true
      logger.info("App", "Entered service (demo mode)", { serviceId })
      return
    }
    
    // Load and initialize the service
    logger.info("App", "Loading service", { serviceId })
    try {
      activeService = await getServiceInstance(serviceId)
      if (!activeService) {
        statusText.content = `✗ ${service?.name || serviceId} not available`
        statusText.fg = "#F15C6D"
        logger.error("App", "Service not available", { serviceId })
        return
      }
      
      // Setup event handlers for this service
      setupServiceEventHandlers()
      
      // Initialize the service
      await activeService.initialize()
      logger.info("App", "Service initialized", { serviceId })
    } catch (err: any) {
      logger.error("App", "Service initialization failed", { serviceId, error: err })
      const reason = err instanceof Error ? err.message : (err?.message || String(err))
      statusText.content = `✗ ${reason?.slice(0, 30) || "Error"}`
      statusText.fg = "#F15C6D"
    }
  }
  
  function setupServiceEventHandlers() {
    if (!activeService) return
    
    // Remove any existing listeners first
    activeService.removeAllListeners()
    
    activeService.on("qr", (qr: string) => {
      logger.event("App", "qr received", { length: qr.length })
      statusText.content = "○ Scan QR..."
      loadingText.content = "Scan QR code\n(shown in the popup)"

      // Render the QR *inside* the TUI (modal) instead of printing to stdout,
      // which the renderer overwrites immediately.
      const qrText = activeService.renderQrCode ? activeService.renderQrCode(qr) : ""
      if (qrText) {
        showQrModal(qrText)
      } else {
        logger.warn("App", "Service did not render a QR code")
      }
    })

    activeService.on("authenticated", () => {
      logger.event("App", "authenticated")
      hideQrModal()
      statusText.content = "○ Authenticated..."
      loadingText.content = "Loading..."
    })

    activeService.on("ready", async () => {
      logger.event("App", "ready - service is ready!")
      hideQrModal()
      isReady = true
      statusText.content = "○ Loading chats..."
      
      try {
        chats = await activeService.getChats()
        logger.info("App", "Chats loaded", { count: chats.length })
        
        renderChats()
        updateSelection()
        loadingText.content = ""
        statusText.content = "● Connected"
        statusText.fg = colors.primary
      } catch (err: any) {
        logger.error("App", "Error loading chats", err)
        statusText.content = `✗ ${err.message?.slice(0, 20)}`
        statusText.fg = "#F15C6D"
      }
    })

    activeService.on("message", async () => {
      logger.event("App", "message received")
      if (currentChatId) {
        messages = await activeService.getMessages(currentChatId, 30)
        await renderMessages()
        await activeService.markAsRead(currentChatId)
        const chatIdx = chats.findIndex(c => c.id === currentChatId)
        if (chatIdx >= 0) {
          chats[chatIdx].unreadCount = 0
        }
      }
      chats = await activeService.getChats()
      renderChats()
      updateSelection()
    })

    activeService.on("disconnected", (reason: string) => {
      logger.event("App", "disconnected", { reason })
      hideQrModal()
      isReady = false
      statusText.content = `✗ ${reason}`
      statusText.fg = "#F15C6D"
    })

    activeService.on("typing", ({ chatId, isTyping }: { chatId: string; isTyping: boolean }) => {
      if (chatId === currentChatId) {
        if (isTyping) {
          chatHeaderMsgCount.content = " typing..."
          chatHeaderMsgCount.fg = colors.primary
        } else {
          chatHeaderMsgCount.content = messages.length > 0 ? ` (${messages.length} messages)` : ""
          chatHeaderMsgCount.fg = colors.textMuted
        }
      }
    })
    
    logger.info("App", "Service event handlers set up")
  }

  exitToMainMenu = () => {
    currentView = "main_menu"
    currentServiceId = null
    showMainMenu()
    logger.info("App", "Returned to main menu")
  }

  const chatItems: { box: BoxRenderable; nameText: TextRenderable; chatIdx: number }[] = []
  let chatItemIds: string[] = [] // Track IDs for proper removal

  function truncate(str: string, len: number): string {
    return str.length <= len ? str : str.slice(0, len - 1) + "…"
  }

  function renderChats() {
    logger.info("RenderChats", "Starting renderChats()", { 
      chatsCount: chats.length, 
      chatItemsCount: chatItems.length,
      height,
      DEMO_MODE 
    })
    
    removeChildById(chatListBox, "loading-text")
    logger.debug("RenderChats", "Removed loading text")
    
    // Remove all previously rendered chat items by their actual IDs
    for (const id of chatItemIds) {
      removeChildById(chatListBox, id)
    }
    chatItems.length = 0
    chatItemIds = []

    const maxChats = Math.floor((height - 6) / 2) // Calculate based on terminal height
    logger.info("RenderChats", "Calculated maxChats", { maxChats, height })
    
    // Update chat list title with count
    updateChatListTitle()
    
    if (chats.length === 0) {
      logger.warn("RenderChats", "No chats to render!")
      return
    }
    
    // Calculate scroll offset to keep selected chat visible
    let startIdx = 0
    if (selectedChat >= maxChats) {
      startIdx = selectedChat - maxChats + 1
    }
    const endIdx = Math.min(chats.length, startIdx + maxChats)
    
    for (let i = startIdx; i < endIdx; i++) {
      const displayIdx = i - startIdx
      logger.debug("RenderChats", `Rendering chat ${i}`, { chatName: chats[i]?.name })
      const chat = chats[i]
      const itemBox = new BoxRenderable(renderer, {
        id: `chat-${i}`,
        width: chatListWidth - 4,
        height: 2,
        backgroundColor: i === selectedChat ? colors.surfaceLight : colors.surface,
        flexDirection: "column",
        paddingLeft: 1,
      })
      
      const badge = chat.unreadCount > 0 ? ` (${chat.unreadCount})` : ""
      const pin = chat.pinned ? "📌 " : ""
      const group = chat.isGroup ? "👥 " : ""
      const muted = chat.muted ? "🔇 " : ""
      // Highlight unread chats with brighter text
      const hasUnread = chat.unreadCount > 0
      const nameText = new TextRenderable(renderer, {
        id: `chat-name-${i}`,
        content: pin + group + muted + truncate(chat.name, chatListWidth - 16) + badge,
        fg: i === selectedChat ? colors.primary : (hasUnread ? "#FFFFFF" : colors.text),
      })
      
      // Format last message time
      let timeStr = ""
      if (chat.lastMessage?.timestamp) {
        const msgDate = new Date(chat.lastMessage.timestamp * 1000)
        const now = new Date()
        const diffDays = Math.floor((now.getTime() - msgDate.getTime()) / (1000 * 60 * 60 * 24))
        if (diffDays === 0) {
          timeStr = `${msgDate.getHours().toString().padStart(2, '0')}:${msgDate.getMinutes().toString().padStart(2, '0')}`
        } else if (diffDays === 1) {
          timeStr = "Yesterday"
        } else if (diffDays < 7) {
          timeStr = msgDate.toLocaleDateString('en-US', { weekday: 'short' })
        } else {
          timeStr = msgDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        }
      }
      
      const preview = chat.lastMessage?.body || ""
      const previewWithTime = timeStr ? `${truncate(preview, chatListWidth - 14)} ${timeStr}` : truncate(preview, chatListWidth - 6)
      const msgText = new TextRenderable(renderer, {
        id: `chat-msg-${i}`,
        content: previewWithTime,
        fg: colors.textMuted,
      })
      
      itemBox.add(nameText)
      itemBox.add(msgText)
      chatListBox.add(itemBox)
      chatItems.push({ box: itemBox, nameText, chatIdx: i })
      chatItemIds.push(`chat-${i}`)
      logger.debug("RenderChats", `Added chat item ${i} to chatListBox`)
    }
    logger.info("RenderChats", "Finished renderChats()", { renderedCount: chatItems.length })
  }

  function updateSelection() {
    logger.debug("UpdateSelection", "Starting updateSelection()", { 
      selectedChat, 
      chatItemsCount: chatItems.length 
    })
    
    if (chatItems.length === 0) {
      logger.warn("UpdateSelection", "No items to update!")
      return
    }
    
    // Check if selected chat is visible in current view
    const isVisible = chatItems.some(item => item.chatIdx === selectedChat)
    if (!isVisible) {
      // Need to re-render to show selected chat
      renderChats()
      return
    }
    
    // Update visual selection
    for (let i = 0; i < chatItems.length; i++) {
      const chatIdx = chatItems[i].chatIdx
      const isSelected = chatIdx === selectedChat
      chatItems[i].box.backgroundColor = isSelected ? colors.surfaceLight : colors.surface
      const hasUnread = chats[chatIdx]?.unreadCount > 0
      chatItems[i].nameText.fg = isSelected ? colors.primary : (hasUnread ? "#FFFFFF" : colors.text)
    }
    
    if (chats[selectedChat]) {
      chatHeaderText.content = chats[selectedChat].name
      logger.debug("UpdateSelection", "Updated header", { chatName: chats[selectedChat].name })
    }
    logger.debug("UpdateSelection", "Finished updateSelection()")
  }

  let msgCount = 0
  // Store references to message elements for cursor updates without full re-render
  let msgBoxes: any[] = []
  let msgBubbles: any[] = []
  let msgCursorsLeft: any[] = []
  let msgCursorsRight: any[] = []
  
  async function renderMessages() {
    logger.info("RenderMessages", "Starting renderMessages()", { 
      messagesCount: messages.length, 
      currentMsgCount: msgCount,
      currentChatId,
      selectedMessage
    })
    
    // Remove old messages
    for (let i = 0; i < msgCount; i++) {
      removeChildById(messagesScroll, `msg-${i}`)
    }
    removeChildById(messagesScroll, "empty-msg")
    msgCount = 0
    // Clear stored references
    msgBoxes = []
    msgBubbles = []
    msgCursorsLeft = []
    msgCursorsRight = []
    // Keep cursor hidden unless explicitly shown, or clamp to valid range
    if (selectedMessage >= messages.length) {
      selectedMessage = messages.length - 1
    }
    // Don't auto-show cursor (keep it at -1 until UP is pressed)
    logger.debug("RenderMessages", "Cleared old messages")

    if (messages.length === 0) {
      messagesScroll.add(emptyMsgText)
      return
    }

    // Helper to format date for separator
    function formatDateSeparator(date: Date): string {
      const today = new Date()
      const yesterday = new Date(today)
      yesterday.setDate(yesterday.getDate() - 1)
      
      if (date.toDateString() === today.toDateString()) {
        return "Today"
      } else if (date.toDateString() === yesterday.toDateString()) {
        return "Yesterday"
      } else {
        return date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
      }
    }

    let lastDateStr = ""
    for (const msg of messages) {
      // Add date separator if date changed
      const msgDate = new Date(msg.timestamp * 1000)
      const dateStr = msgDate.toDateString()
      if (dateStr !== lastDateStr) {
        lastDateStr = dateStr
        const separatorBox = new BoxRenderable(renderer, {
          id: `date-sep-${msgCount}`,
          width: msgAreaWidth - 4,
          flexDirection: "row",
          justifyContent: "center",
          marginTop: 1,
          marginBottom: 1,
        })
        const separatorText = new TextRenderable(renderer, {
          id: `date-text-${msgCount}`,
          content: `── ${formatDateSeparator(msgDate)} ──`,
          fg: colors.textMuted,
        })
        separatorBox.add(separatorText)
        messagesScroll.add(separatorBox)
      }
      const isSelected = msgCount === selectedMessage && focusArea === "messages" && selectedMessage >= 0
      const msgBox = new BoxRenderable(renderer, {
        id: `msg-${msgCount}`,
        width: msgAreaWidth - 2,
        flexDirection: "row",
        justifyContent: msg.fromMe ? "flex-end" : "flex-start",
        marginBottom: 1,
      })
      
      // Create cursor indicators for ALL messages (hidden by default, shown when selected)
      const cursorLeft = new TextRenderable(renderer, {
        id: `cursor-left-${msgCount}`,
        content: ">>> ",
        fg: "#00FF00",
        visible: isSelected, // Only visible if this message is selected
      })
      const cursorRight = new TextRenderable(renderer, {
        id: `cursor-right-${msgCount}`,
        content: " <<<",
        fg: "#00FF00",
        visible: isSelected,
      })
      // Add left indicator first (always add, visibility controls display)
      msgBox.add(cursorLeft)
      
      // Limit bubble width to 70% of message area for better readability
      const maxBubbleWidth = Math.floor(msgAreaWidth * 0.7)
      const bubble = new BoxRenderable(renderer, {
        id: `bubble-${msgCount}`,
        backgroundColor: msg.fromMe ? colors.sent : colors.received,
        borderStyle: "rounded",
        borderColor: isSelected ? "#00FF00" : (msg.fromMe ? colors.primary : colors.textMuted),
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 0,
        paddingBottom: 0,
        maxWidth: maxBubbleWidth,
        flexDirection: "column",
      })
      
      // Forwarded message indicator
      if (msg.isForwarded) {
        const forwardedText = new TextRenderable(renderer, {
          id: `forwarded-${msgCount}`,
          content: msg.forwardingScore && msg.forwardingScore > 4 ? "⤳ Forwarded many times" : "⤳ Forwarded",
          fg: colors.textMuted,
        })
        bubble.add(forwardedText)
      }
      
      // Quoted message (reply) preview
      if (msg.hasQuotedMsg && msg.quotedMsgBody) {
        const quotedText = new TextRenderable(renderer, {
          id: `quoted-${msgCount}`,
          content: `┃ ${truncate(msg.quotedMsgBody, 40)}`,
          fg: colors.textMuted,
        })
        bubble.add(quotedText)
      }
      
      // Show author name for group messages
      if (msg.authorName && !msg.fromMe) {
        const authorText = new TextRenderable(renderer, {
          id: `author-${msgCount}`,
          content: msg.authorName,
          fg: colors.primary,
        })
        bubble.add(authorText)
      }
      
      // Main message content
      const content = msg.body || ""
      if (content) {
        const bubbleText = new TextRenderable(renderer, {
          id: `bubble-text-${msgCount}`,
          content: truncate(content, msgAreaWidth - 20),
          fg: colors.text,
        })
        bubble.add(bubbleText)
      }
      
      const date = new Date(msg.timestamp * 1000)
      const timeStr = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`
      
      // Message status: ✓ sent, ✓✓ delivered, blue ✓✓ read
      let ackStr = ""
      let ackColor = colors.textMuted
      if (msg.fromMe && msg.ack !== undefined) {
        if (msg.ack === 0) { ackStr = " ⏳" } // Pending
        else if (msg.ack === 1) { ackStr = " ✓" } // Sent
        else if (msg.ack === 2) { ackStr = " ✓✓" } // Delivered
        else if (msg.ack === 3) { ackStr = " ✓✓"; ackColor = colors.primary } // Read
      }
      
      // Starred indicator
      const starStr = msg.isStarred ? " ⭐" : ""
      
      const timeText = new TextRenderable(renderer, {
        id: `time-${msgCount}`,
        content: `  ${timeStr}${ackStr}${starStr}`,
        fg: ackColor,
      })
      
      // Media rendering - add to bubble BEFORE time
      if (msg.hasMedia && msg.media && mediaRenderer) {
        logger.info("RenderMessages", "Rendering media", {
          mediaType: msg.media.type,
          filename: msg.media.filename
        })
        const mediaLines = await mediaRenderer.render(msg.media, maxBubbleWidth - 4)
        logger.info("RenderMessages", "Media rendered", { 
          linesCount: mediaLines.length,
          firstLine: mediaLines[0]
        })
        
        for (const line of mediaLines) {
          const mediaText = new TextRenderable(renderer, {
            id: `media-${msgCount}-${Math.random()}`,
            content: line,
            fg: "#00FF00", // Bright green for maximum visibility
          })
          bubble.add(mediaText)
        }
      } else if (msg.hasMedia) {
        const fallbackText = new TextRenderable(renderer, {
          id: `media-fallback-${msgCount}`,
          content: `[${msg.type} media]`,
          fg: "#00FF00",
        })
        bubble.add(fallbackText)
      }
      
      bubble.add(timeText)
      msgBox.add(bubble)
      
      // Add right cursor indicator (visibility controlled)
      msgBox.add(cursorRight)
      
      // Store references for cursor updates
      msgBoxes.push(msgBox)
      msgBubbles.push(bubble)
      msgCursorsLeft.push(cursorLeft)
      msgCursorsRight.push(cursorRight)
      
      messagesScroll.add(msgBox)
      msgCount++
      logger.debug("RenderMessages", `Added message ${msgCount}`, { fromMe: msg.fromMe, bodyLen: msg.body?.length })
    }
    logger.info("RenderMessages", "Finished renderMessages()", { renderedCount: msgCount })
  }
  
  // Update cursor visuals without full re-render (preserves scroll position)
  let lastCursorPos = -1
  function updateCursorVisuals(newPos: number) {
    // Update old position - hide cursor indicators and reset border color
    if (lastCursorPos >= 0 && lastCursorPos < msgBubbles.length) {
      const oldBubble = msgBubbles[lastCursorPos]
      const oldMsg = messages[lastCursorPos]
      const oldCursorLeft = msgCursorsLeft[lastCursorPos]
      const oldCursorRight = msgCursorsRight[lastCursorPos]
      if (oldBubble && oldMsg) {
        oldBubble.borderColor = oldMsg.fromMe ? colors.primary : colors.textMuted
      }
      if (oldCursorLeft) oldCursorLeft.visible = false
      if (oldCursorRight) oldCursorRight.visible = false
    }
    
    // Update new position - show cursor indicators and highlight border
    if (newPos >= 0 && newPos < msgBubbles.length) {
      const newBubble = msgBubbles[newPos]
      const newCursorLeft = msgCursorsLeft[newPos]
      const newCursorRight = msgCursorsRight[newPos]
      if (newBubble) {
        newBubble.borderColor = "#00FF00"
      }
      if (newCursorLeft) newCursorLeft.visible = true
      if (newCursorRight) newCursorRight.visible = true
    }
    
    lastCursorPos = newPos
    logger.debug("App", "Updated cursor visuals", { from: lastCursorPos, to: newPos })
  }

  // Settings view rendering
  function renderSettings() {
    logger.info("App", "renderSettings() called")
    
    // Hide main UI and menu
    mainBox.visible = false
    menuBox.visible = false
    settingsBox.visible = true
    
    logger.debug("App", "Visibility set", {
      mainBox: mainBox.visible,
      menuBox: menuBox.visible,
      settingsBox: settingsBox.visible
    })
    
    // Build settings items
    buildSettingsItems()
    
    logger.info("App", "Settings rendered", { 
      itemsCount: settingsItemIds.length 
    })
  }
  
  function getSettingsItemCount(sectionIdx: number): number {
    const currentPage = SETTINGS_PAGES[currentSettingsPage]
    const sections = currentPage.id === "keybindings" ? getKeybindingsSettings() : currentPage.sections
    return sections[sectionIdx]?.items.length || 0
  }
  
  function getTotalSettingsItems(): { section: number; item: number }[] {
    const items: { section: number; item: number }[] = []
    const currentPage = SETTINGS_PAGES[currentSettingsPage]
    const sections = currentPage.id === "keybindings" ? getKeybindingsSettings() : currentPage.sections
    sections.forEach((section, sIdx) => {
      section.items.forEach((_, iIdx) => {
        items.push({ section: sIdx, item: iIdx })
      })
    })
    return items
  }
  
  function navigateSettings(direction: "up" | "down") {
    const allItems = getTotalSettingsItems()
    const currentIdx = allItems.findIndex(i => i.section === settingsSection && i.item === settingsItem)
    let newIdx = currentIdx
    
    if (direction === "up") {
      newIdx = Math.max(0, currentIdx - 1)
    } else {
      newIdx = Math.min(allItems.length - 1, currentIdx + 1)
    }
    
    settingsSection = allItems[newIdx].section
    settingsItem = allItems[newIdx].item
    
    // Update selection visually
    buildSettingsItems()
  }
  
  // Key capture state for keybinding configuration
  let keyCaptureActive = false
  let keyCaptureKeybindingKey: string | null = null
  let keyCaptureLabel: string = ""

  function startKeyCapture(keybindingKey: string, label: string) {
    keyCaptureActive = true
    keyCaptureKeybindingKey = keybindingKey
    keyCaptureLabel = label
    
    // Show key capture modal
    confirmModalTitle.content = "⌨️  Press a Key"
    confirmModalMessage.content = `Set keybinding for: ${label}\n\nPress any key combination...\n(Esc to cancel)`
    confirmModalOptions.content = ""
    confirmModalOverlay.visible = true
    
    logger.info("Keybindings", "Key capture started", { keybindingKey, label })
  }

  function handleKeyCapture(key: KeyEvent) {
    if (!keyCaptureActive || !keyCaptureKeybindingKey) return false
    
    // Escape cancels the capture
    if (key.name === "escape") {
      keyCaptureActive = false
      keyCaptureKeybindingKey = null
      confirmModalOverlay.visible = false
      logger.info("Keybindings", "Key capture cancelled")
      return true
    }
    
    // Capture the key
    const newBinding: KeyBinding = {
      key: key.name,
      description: keyCaptureLabel,
    }
    if (key.ctrl) newBinding.ctrl = true
    if (key.shift) newBinding.shift = true
    
    // Update keybindings
    const updatedKeybindings = { ...keybindings }
    ;(updatedKeybindings as any)[keyCaptureKeybindingKey] = newBinding
    
    // Save to file
    saveKeybindings(updatedKeybindings)
    
    // Update in-memory keybindings
    Object.assign(keybindings, updatedKeybindings)
    
    logger.info("Keybindings", "Key captured and saved", { 
      keybindingKey: keyCaptureKeybindingKey, 
      newBinding: formatKeybinding(newBinding) 
    })
    
    // Hide modal and refresh
    keyCaptureActive = false
    keyCaptureKeybindingKey = null
    confirmModalOverlay.visible = false
    buildSettingsItems()
    
    return true
  }

  function toggleCurrentSetting() {
    const currentPage = SETTINGS_PAGES[currentSettingsPage]
    const sections = currentPage.id === "keybindings" ? getKeybindingsSettings() : currentPage.sections
    const section = sections[settingsSection]
    const item = section?.items[settingsItem]
    if (!item) return
    
    // Handle keybinding items - start key capture
    if (item.type === "keybinding" && item.keybindingKey) {
      startKeyCapture(item.keybindingKey, item.label)
      return
    }
    
    // Handle button actions
    if (item.type === "button") {
      if (item.id === "clearMediaCache") {
        logger.info("Settings", "Clearing media cache")
        const { mediaCache } = require("./utils/mediaCache")
        mediaCache.clear()
        statusText.content = "● Media cache cleared"
        statusText.fg = colors.primary
        setTimeout(() => {
          statusText.content = "● Connected"
        }, 2000)
        return
      }
      // Other button actions
      if (item.action) {
        item.action()
      }
      return
    }
    
    if (item.type === "toggle" && item.key) {
      const currentVal = getNestedSetting(item.key)
      setNestedSetting(item.key, !currentVal)
      buildSettingsItems()
    } else if ((item.type === "radio" || item.type === "select") && item.key && item.options) {
      const currentVal = getNestedSetting(item.key)
      const currentIdx = item.options.findIndex(o => o.value === currentVal)
      const nextIdx = (currentIdx + 1) % item.options.length
      const newVal = item.options[nextIdx].value
      setNestedSetting(item.key, newVal)
      buildSettingsItems()
    } else if (item.type === "number" && item.key) {
      const currentVal = getNestedSetting(item.key) as number
      const step = 1
      const clampedVal = Math.min(item.max || 300, Math.max(item.min || 0, currentVal + step))
      setNestedSetting(item.key, clampedVal)
      buildSettingsItems()
    }
  }

  async function selectChat(index: number) {
    logger.info("App", "selectChat() called", { index, chatCount: chats.length })
    if (index < 0 || index >= chats.length) {
      logger.warn("App", "selectChat() invalid index", { index })
      return
    }
    
    selectedChat = index
    selectedMessage = -1 // Hide cursor when switching chats
    currentChatId = chats[index].id
    logger.info("App", "Chat selected", { chatId: currentChatId, chatName: chats[index].name })
    updateSelection()
    
    if (DEMO_MODE) {
      messages = [...(DEMO_MESSAGES[currentChatId] || [])]
      // Mark as read in demo mode
      chats[index].unreadCount = 0
      logger.debug("App", "Loaded demo messages", { count: messages.length, chatId: currentChatId })
    } else if (activeService) {
      statusText.content = " Loading..."
      statusText.fg = colors.textMuted
      logger.info("App", "Loading messages from WhatsApp", { chatId: currentChatId })
      messages = await activeService.getMessages(currentChatId, 30)
      logger.info("App", "Messages loaded", { count: messages.length })
      await activeService.markAsRead(currentChatId)
      // Update local unread count
      chats[index].unreadCount = 0
    }
    
    // Re-render chats to update unread indicator
    renderChats()
    await renderMessages()
    updateChatHeader(chats[index].name, messages.length, chats[index])
    statusText.content = DEMO_MODE ? "● Demo Mode" : "● Connected"
    statusText.fg = colors.primary
    
    // Auto-download all media if setting is enabled (non-blocking background task)
    if (getSettings().autoDownloadMediaOnEnter && !DEMO_MODE && activeService) {
      const chatIdForDownload = currentChatId
      const mediaMessages = messages.filter(m => m.hasMedia)
      
      if (mediaMessages.length > 0) {
        logger.info("App", "Starting background media download", { chatId: chatIdForDownload, count: mediaMessages.length })
        statusText.content = `⏳ Downloading ${mediaMessages.length} media files...`
        statusText.fg = colors.textMuted
        
        // Run downloads in background without blocking
        ;(async () => {
          try {
            let downloaded = 0
            for (const msg of mediaMessages) {
              // Check if we're still on the same chat
              if (currentChatId !== chatIdForDownload) {
                logger.info("App", "Chat changed, stopping background download")
                break
              }
              try {
                await activeService!.downloadMedia(msg.id, chatIdForDownload)
                downloaded++
                // Update status periodically
                if (downloaded % 3 === 0 || downloaded === mediaMessages.length) {
                  statusText.content = `⏳ Downloaded ${downloaded}/${mediaMessages.length} media...`
                }
                logger.debug("App", "Downloaded media", { messageId: msg.id, progress: `${downloaded}/${mediaMessages.length}` })
              } catch (err) {
                logger.error("App", "Failed to download media", { messageId: msg.id, err })
              }
            }
            
            // Only update if still on same chat
            if (currentChatId === chatIdForDownload) {
              statusText.content = `● Downloaded ${downloaded}/${mediaMessages.length} media`
              statusText.fg = colors.primary
              setTimeout(() => {
                if (currentChatId === chatIdForDownload) {
                  statusText.content = "● Connected"
                }
              }, 2000)
              // Re-render to show cached media
              await renderMessages()
            }
          } catch (err) {
            logger.error("App", "Background media download error", err)
          }
        })()
      }
    }
  }

  // Message sending/editing
  messageInput.on(InputRenderableEvents.ENTER, async (value: string) => {
    logger.info("MessageInput", "ENTER pressed", { 
      valueLength: value.length, 
      currentChatId, 
      isReady, 
      DEMO_MODE,
      isEditing: focusArea === "editing",
      replyToMessageId
    })
    
    if (!value.trim() && focusArea !== "editing") {
      logger.debug("MessageInput", "Empty message, ignoring")
      return
    }
    
    // Handle message editing
    if (focusArea === "editing" && editingMessageId && currentChatId && activeService) {
      logger.info("MessageInput", "Editing message", { messageId: editingMessageId, newText: value })
      statusText.content = "⏳ Editing message..."
      statusText.fg = colors.textMuted
      
      // Call editMessage service method
      const success = await activeService.editMessage(editingMessageId, currentChatId, value.trim())
      
      if (success) {
        statusText.content = "● Message edited ✓"
        statusText.fg = colors.primary
        // Update the message in the UI
        const msgIdx = messages.findIndex(m => m.id === editingMessageId)
        if (msgIdx !== -1) {
          messages[msgIdx].body = value.trim()
          await renderMessages()
        }
      } else {
        statusText.content = "✗ Failed to edit message"
        statusText.fg = "#F15C6D"
      }
      
      // Reset editing state
      editingMessageId = null
      focusArea = "input"
      messageInput.value = ""
      
      setTimeout(() => {
        statusText.content = "● Connected"
        statusText.fg = colors.primary
      }, 2000)
      return
    }
    
    if (DEMO_MODE) {
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
      messages.push(newMsg)
      logger.debug("MessageInput", "Added message to messages array", { count: messages.length })
      await renderMessages()
      messageInput.value = ""
      replyToMessageId = null // Clear reply reference
      statusText.content = "● Sent!"
      setTimeout(() => { statusText.content = "● Demo Mode" }, 1000)
    } else if (activeService && isReady) {
      logger.info("MessageInput", "Sending real WhatsApp message", { chatId: currentChatId, body: value.trim().substring(0, 20) })
      statusText.content = "○ Sending..."
      statusText.fg = colors.textMuted
      logger.info("MessageInput", "Sending message via WhatsApp", { 
        chatId: currentChatId, 
        bodyLen: value.length,
        replyTo: replyToMessageId
      })
      // Send message with reply context if replyToMessageId is set
      
      try {
        const sent = await activeService.sendMessage(currentChatId, value.trim(), { replyTo: replyToMessageId || undefined })
        if (sent) {
          logger.info("MessageInput", "Message sent successfully", { messageId: sent.id })
          messages.push(sent)
          await renderMessages()
          messageInput.value = ""
          replyToMessageId = null // Clear reply reference
          statusText.content = "● Sent ✓"
          statusText.fg = colors.primary
        } else {
          logger.error("MessageInput", "sendMessage returned null")
          statusText.content = "✗ Failed to send"
          statusText.fg = "#F15C6D"
        }
      } catch (err: any) {
        logger.error("MessageInput", "sendMessage threw exception", err)
        statusText.content = "✗ Error sending"
        statusText.fg = "#F15C6D"
      }
      setTimeout(() => { statusText.content = "● Connected"; statusText.fg = colors.primary }, 2000)
    } else {
      logger.warn("MessageInput", "Cannot send - activeService not ready", { hasWhatsapp: !!activeService, isReady })
    }
  })

  // Keyboard handling
  renderer.keyInput.on("keypress", async (key: KeyEvent) => {
    logger.debug("Keyboard", "Key pressed", { 
      name: key.name, 
      ctrl: key.ctrl, 
      shift: key.shift,
      focusArea,
      isReady,
      selectedChat,
      chatsCount: chats.length,
      currentView
    })
    
    // Handle key capture for keybinding configuration (highest priority)
    if (keyCaptureActive) {
      if (handleKeyCapture(key)) {
        return
      }
    }
    
    // Handle confirmation modal input first (highest priority)
    if (confirmModalVisible && confirmModalCallback) {
      if (key.name === "y" || key.name === "Y") {
        logger.info("App", "Confirmation modal: YES")
        confirmModalCallback(true)
        return
      } else if (key.name === "n" || key.name === "N" || key.name === "escape") {
        logger.info("App", "Confirmation modal: NO")
        confirmModalCallback(false)
        return
      }
      // Ignore all other keys when modal is visible
      return
    }

    // QR modal: Esc hides it. whatsapp-web.js re-emits "qr" periodically, so
    // the modal comes back on the next emission.
    if (qrModalVisible && key.name === "escape") {
      hideQrModal()
      logger.info("App", "QR modal hidden by user")
      return
    }

    // CRITICAL: UP from input switches to message selection mode
    if (focusArea === "input" && key.name === "up" && messages.length > 0) {
      // Switch to message selection mode with cursor on last message
      focusArea = "messages"
      selectedMessage = messages.length - 1
      // Unfocus input so text can't be written
      messageInput.blur()
      inputArea.borderColor = colors.border
      await renderMessages()
      // Initialize cursor tracking for subsequent navigation
      lastCursorPos = selectedMessage
      
      // Scroll to bottom to show last message
      messagesScroll.scrollTo({ x: 0, y: messagesScroll.scrollHeight })
      logger.debug("App", "Scrolled to bottom for last message")
      
      statusText.content = `📍 Message ${selectedMessage + 1}/${messages.length} (↑↓ nav, ${formatKeybinding(keybindings.openMedia)}=media, ${formatKeybinding(keybindings.setReplyReference)}=reply, ${formatKeybinding(keybindings.jumpToReply)}=jump, ↓↓=input)`
      statusText.fg = colors.primary
      logger.info("App", "UP from input -> message selection mode at LAST", { selectedMessage })
      return // Stop event propagation
    }
    
    // DOWN from input scrolls to bottom
    if (focusArea === "input" && key.name === "down" && messages.length > 0) {
      messagesScroll.scrollTo({ x: 0, y: messagesScroll.scrollHeight })
      logger.debug("App", "DOWN from input -> scrolled to bottom")
      return // Stop event propagation
    }
    
    // Set reply reference (handle before other message navigation)
    if (focusArea === "messages" && messages.length > 0 && matchesKeybinding(key, keybindings.setReplyReference)) {
      const msg = messages[selectedMessage]
      if (msg) {
        replyToMessageId = msg.id
        statusText.content = `↪ Replying to: ${msg.body?.slice(0, 30) || "[media]"}...`
        statusText.fg = colors.primary
        logger.info("App", "Set reply reference", { messageId: msg.id, key: formatKeybinding(keybindings.setReplyReference) })
        // Switch to input to type reply
        focusArea = "input"
        selectedMessage = -1
        inputArea.borderColor = colors.primary
        messageInput.focus()
        await renderMessages()
      }
      return
    }
    
    // Message navigation when in message selection mode
    const isMessageNavKey = focusArea === "messages" && messages.length > 0 && (
      key.name === "up" ||
      key.name === "down" ||
      matchesKeybinding(key, keybindings.jumpToReply) ||
      matchesKeybinding(key, keybindings.openMedia) ||
      matchesKeybinding(key, keybindings.deleteMessageForMe) ||
      matchesKeybinding(key, keybindings.deleteMessageForEveryone) ||
      matchesKeybinding(key, keybindings.editMessage)
    )
    if (isMessageNavKey) {
      logger.info("App", "MESSAGE NAVIGATION KEY DETECTED", { 
        key: key.name, 
        ctrl: key.ctrl,
        shift: key.shift,
        focusArea, 
        selectedMessage, 
        totalMessages: messages.length 
      })
      
      if (key.name === "up") {
        if (selectedMessage > 0) {
          selectedMessage--
          // Update cursor visuals without full re-render (preserves scroll)
          updateCursorVisuals(selectedMessage)
          statusText.content = `📍 Message ${selectedMessage + 1}/${messages.length}`
          statusText.fg = colors.primary
          logger.info("App", "Message cursor UP", { selectedMessage })
        } else {
          logger.info("App", "Already at first message")
        }
        return // Stop event propagation
      } else if (key.name === "down") {
        if (selectedMessage < messages.length - 1) {
          selectedMessage++
          // Update cursor visuals without full re-render (preserves scroll)
          updateCursorVisuals(selectedMessage)
          statusText.content = `📍 Message ${selectedMessage + 1}/${messages.length}`
          statusText.fg = colors.primary
          logger.info("App", "Message cursor DOWN", { selectedMessage })
        } else {
          // At last message, DOWN switches to input
          focusArea = "input"
          // Hide cursor without full re-render to preserve scroll
          updateCursorVisuals(-1)
          selectedMessage = -1
          chatListBox.borderColor = colors.border
          inputArea.borderColor = colors.primary
          messageInput.focus()
          statusText.content = DEMO_MODE ? "● Demo Mode" : "● Connected"
          statusText.fg = colors.primary
          logger.info("App", "DOWN from last message -> focus input")
        }
        return // Stop event propagation
      } else if (matchesKeybinding(key, keybindings.jumpToReply)) {
        // Jump to replied message if this is a reply
        const msg = messages[selectedMessage]
        logger.info("App", "Jump to reply handler reached", { 
          hasMsg: !!msg, 
          hasQuotedMsg: msg?.hasQuotedMsg, 
          quotedMsgId: msg?.quotedMsgId 
        })
        if (msg && msg.hasQuotedMsg && msg.quotedMsgId) {
          logger.info("App", "Jumping to quoted message", { 
            quotedMsgId: msg.quotedMsgId,
            sampleMsgIds: messages.slice(0, 3).map(m => m.id)
          })
          // Find the quoted message in the current messages array
          // Try exact match first, then partial match (quotedStanzaID is sometimes just the end part)
          let quotedMsgIndex = messages.findIndex(m => m.id === msg.quotedMsgId)
          if (quotedMsgIndex === -1) {
            // Try partial match - quotedMsgId might be just the stanza ID (use includes for flexibility)
            quotedMsgIndex = messages.findIndex(m => m.id.includes(msg.quotedMsgId!))
          }
          if (quotedMsgIndex !== -1) {
            // Update cursor visuals to hide old and show new (preserves scroll, tracks position)
            updateCursorVisuals(quotedMsgIndex)
            selectedMessage = quotedMsgIndex
            statusText.content = `↪ Jumped to replied message (${quotedMsgIndex + 1}/${messages.length})`
            statusText.fg = colors.primary
            logger.info("App", "Jumped to quoted message", { newIndex: quotedMsgIndex })
          } else {
            statusText.content = "✗ Replied message not found in current view"
            statusText.fg = "#F15C6D"
            logger.warn("App", "Quoted message not found in messages array", { 
              quotedMsgId: msg.quotedMsgId,
              allMsgIds: messages.map(m => m.id)
            })
          }
        } else {
          statusText.content = "This message is not a reply"
          statusText.fg = colors.textMuted
          logger.info("App", "Message is not a reply", { hasQuotedMsg: msg?.hasQuotedMsg, quotedMsgId: msg?.quotedMsgId })
        }
        return // Stop event propagation
      } else if (matchesKeybinding(key, keybindings.openMedia)) {
        logger.info("App", "Open media handler reached")
        // Open media
        const msg = messages[selectedMessage]
        logger.info("App", "Enter media check", { 
          hasMsg: !!msg, 
          hasMedia: msg?.hasMedia, 
          hasMediaObj: !!msg?.media,
          hasChatId: !!currentChatId,
          hasService: !!activeService
        })
        if (msg && msg.hasMedia && msg.media && currentChatId && activeService) {
          logger.info("App", "Opening media from selected message", { messageId: msg.id })
          try {
            // Check if file is already cached
            const chat = chats.find(c => c.id === currentChatId)
            const chatName = chat?.name || currentChatId
            const filename = msg.media.filename || 'media'
            const timestamp = msg.timestamp
            const mimetype = msg.media.mimetype || 'application/octet-stream'
            
            let filePath = mediaCache.get(chatName, filename, timestamp, mimetype)
            
            if (filePath) {
              logger.info("App", "Media already cached, opening directly", { filePath })
              statusText.content = "● Opening cached media..."
              statusText.fg = colors.primary
            } else {
              logger.info("App", "Media not cached, downloading first", { messageId: msg.id })
              statusText.content = "⏳ Downloading media..."
              statusText.fg = colors.textMuted
              filePath = await activeService.downloadMedia(msg.id, currentChatId)
            }
            
            if (filePath && mediaRenderer) {
              if (getSettings().mediaDisplayMode === 'http') {
                const { mediaServer } = await import("./utils/mediaServer")
                const serverUrl = await mediaServer.start()
                await mediaRenderer.openMedia(serverUrl)
              } else {
                await mediaRenderer.openMedia(filePath)
              }
              statusText.content = "● Opened media"
              statusText.fg = colors.primary
            } else {
              statusText.content = "✗ Failed to get media"
              statusText.fg = "#F15C6D"
            }
          } catch (err: any) {
            logger.error("App", "Failed to open media", err)
            statusText.content = `✗ ${err.message?.slice(0, 30)}`
            statusText.fg = "#F15C6D"
          }
        } else {
          statusText.content = "No media in this message"
          statusText.fg = colors.textMuted
        }
        return // Stop event propagation
      } else if (matchesKeybinding(key, keybindings.deleteMessageForMe)) {
        // Delete message for me
        const msg = messages[selectedMessage]
        if (msg && currentChatId && activeService) {
          const settings = getSettings()
          
          const performDelete = async () => {
            logger.info("App", "Deleting message for me", { messageId: msg.id })
            statusText.content = "⏳ Deleting message for you..."
            statusText.fg = colors.textMuted
            
            const success = await activeService.deleteMessage(msg.id, currentChatId, true)
            
            if (success) {
              statusText.content = "● Message deleted ✓"
              statusText.fg = colors.primary
              // Remove from UI
              const msgIdx = messages.findIndex(m => m.id === msg.id)
              if (msgIdx !== -1) {
                messages.splice(msgIdx, 1)
                if (selectedMessage >= messages.length) {
                  selectedMessage = messages.length - 1
                }
                await renderMessages()
              }
            } else {
              statusText.content = "✗ Failed to delete message"
              statusText.fg = "#F15C6D"
            }
            
            setTimeout(() => {
              statusText.content = "● Connected"
              statusText.fg = colors.primary
            }, 2000)
          }
          
          if (settings.confirmDeleteMessage) {
            showConfirmModal("Delete this message for you?", async (confirmed) => {
              hideConfirmModal()
              if (confirmed) {
                await performDelete()
              }
            })
          } else {
            await performDelete()
          }
        }
        return
      } else if (matchesKeybinding(key, keybindings.deleteMessageForEveryone)) {
        // Delete message for everyone
        const msg = messages[selectedMessage]
        if (msg && currentChatId && activeService) {
          const settings = getSettings()
          
          const performDelete = async () => {
            logger.info("App", "Deleting message for everyone", { messageId: msg.id })
            statusText.content = "⏳ Deleting message for everyone..."
            statusText.fg = colors.textMuted
            
            const success = await activeService.deleteMessage(msg.id, currentChatId, false)
            
            if (success) {
              statusText.content = "● Message deleted for everyone ✓"
              statusText.fg = colors.primary
              // Remove from UI
              const msgIdx = messages.findIndex(m => m.id === msg.id)
              if (msgIdx !== -1) {
                messages.splice(msgIdx, 1)
                if (selectedMessage >= messages.length) {
                  selectedMessage = messages.length - 1
                }
                await renderMessages()
              }
            } else {
              statusText.content = "✗ Failed to delete message for everyone"
              statusText.fg = "#F15C6D"
            }
            
            setTimeout(() => {
              statusText.content = "● Connected"
              statusText.fg = colors.primary
            }, 2000)
          }
          
          if (settings.confirmDeleteMessage) {
            showConfirmModal("Delete this message for everyone?", async (confirmed) => {
              hideConfirmModal()
              if (confirmed) {
                await performDelete()
              }
            })
          } else {
            await performDelete()
          }
        }
        return
      } else if (matchesKeybinding(key, keybindings.editMessage)) {
        // Edit message in place
        const msg = messages[selectedMessage]
        if (msg && msg.fromMe && currentChatId) {
          logger.info("App", "Editing message", { messageId: msg.id })
          editingMessageId = msg.id
          focusArea = "editing"
          messageInput.value = msg.body || ""
          messageInput.focus()
          statusText.content = `✏ Editing message (Enter to save, Esc to cancel)`
          statusText.fg = colors.primary
          await renderMessages()
        } else if (!msg.fromMe) {
          statusText.content = "✗ Can only edit your own messages"
          statusText.fg = "#F15C6D"
        }
        return
      }
    }
    
    // Debug: Log settings key detection
    if (matchesKeybinding(key, keybindings.settings)) {
      logger.info("App", "SETTINGS KEY DETECTED!", { 
        keyName: key.name, 
        ctrl: key.ctrl,
        currentView 
      })
    }
    
    // Quit application (configurable, default Ctrl+Q)
    if (matchesKeybinding(key, keybindings.quit) || (key.ctrl && key.name === "c")) {
      logger.info("App", "User requested exit", { key: key.name })
      cleanupTerminal()
      if (activeService) await activeService.destroy()
      process.exit(0)
    }

    // Main menu navigation
    if (currentView === "main_menu") {
      if (key.name === "up" && menuSelectedIndex > 0) {
        menuSelectedIndex--
        updateMenuSelection()
        return
      }
      if (key.name === "down" && menuSelectedIndex < services.length - 1) {
        menuSelectedIndex++
        updateMenuSelection()
        return
      }
      if (key.name === "return") {
        const service = services[menuSelectedIndex]
        if (service && service.enabled) {
          if (service.id === "settings") {
            // Show settings view instead of entering service
            currentView = "service"
            showSettings = true
            focusArea = "settings"
            settingsSection = 0
            settingsItem = 0
            renderSettings()
            logger.info("App", "Opened settings from menu")
          } else {
            enterService(service.id)
          }
        }
        return
      }
      if (key.name === "q" || key.name === "Q") {
        cleanupTerminal()
        if (activeService) await activeService.destroy()
        process.exit(0)
      }
      return
    }

    // Global settings navigation
    if (currentView === "global_settings") {
      if (key.name === "escape") {
        currentView = "main_menu"
        showMainMenu()
        return
      }
      if (key.name === "up" && globalSettingsItem > 0) {
        globalSettingsItem--
        showGlobalSettingsView()
        return
      }
      if (key.name === "down" && globalSettingsItem < 9) {
        globalSettingsItem++
        showGlobalSettingsView()
        return
      }
      return
    }

    // Escape to go back to main menu from service view
    if (currentView === "service" && key.name === "escape" && focusArea === "chats" && !showSettings) {
      exitToMainMenu()
      return
    }

    // Open settings (configurable, default F2)
    if (currentView === "service" && matchesKeybinding(key, keybindings.settings)) {
      logger.info("App", "Settings toggle triggered", { 
        currentShowSettings: showSettings,
        keyName: key.name,
        keyCtrl: key.ctrl 
      })
      showSettings = !showSettings
      if (showSettings) {
        focusArea = "settings"
        settingsSection = 0
        settingsItem = 0
        renderSettings()
        logger.info("App", "Settings opened", { 
          settingsBoxVisible: settingsBox.visible,
          mainBoxVisible: mainBox.visible 
        })
      } else {
        // Restore service view
        settingsBox.visible = false
        mainBox.visible = true
        menuBox.visible = false
        renderChats()
        if (messages.length > 0) await renderMessages()
        logger.info("App", "Settings closed")
      }
      return
    }

    // Settings navigation when settings view is open
    if (showSettings) {
      if (key.name === "escape") {
        showSettings = false
        focusArea = "chats"
        // Restore service view
        settingsBox.visible = false
        mainBox.visible = true
        menuBox.visible = false
        renderChats()
        if (messages.length > 0) await renderMessages()
        logger.debug("App", "Settings closed via Escape")
        return
      }
      // Tab / Shift+Tab to switch between settings pages
      if (key.name === "tab") {
        if (key.shift) {
          // Previous page
          currentSettingsPage = (currentSettingsPage - 1 + SETTINGS_PAGES.length) % SETTINGS_PAGES.length
        } else {
          // Next page
          currentSettingsPage = (currentSettingsPage + 1) % SETTINGS_PAGES.length
        }
        // Reset selection to first item
        settingsSection = 0
        settingsItem = 0
        buildSettingsItems()
        logger.info("App", "Settings page changed", { page: SETTINGS_PAGES[currentSettingsPage].title })
        return
      }
      if (key.name === "up") {
        navigateSettings("up")
        return
      }
      if (key.name === "down") {
        navigateSettings("down")
        return
      }
      if (key.name === "return" || key.name === "space") {
        toggleCurrentSetting()
        return
      }
      // Left/Right for radio/select to cycle options
      if (key.name === "left" || key.name === "right") {
        const currentPage = SETTINGS_PAGES[currentSettingsPage]
        const section = currentPage.sections[settingsSection]
        const item = section?.items[settingsItem]
        if (item && (item.type === "radio" || item.type === "select") && item.key && item.options) {
          const currentVal = getNestedSetting(item.key)
          const currentIdx = item.options.findIndex(o => o.value === currentVal)
          const direction = key.name === "right" ? 1 : -1
          const nextIdx = (currentIdx + direction + item.options.length) % item.options.length
          const newVal = item.options[nextIdx].value
          setNestedSetting(item.key, newVal)
          renderSettings()
        } else if (item && item.type === "number" && item.key) {
          const currentVal = getNestedSetting(item.key) as number
          const step = key.name === "right" ? 10 : -10
          const newVal = Math.min(item.max || 300, Math.max(item.min || 0, currentVal + step))
          setNestedSetting(item.key, newVal)
          renderSettings()
        }
        return
      }
      return // Don't process other keys while in settings
    }

    if (key.name === "tab" && isReady) {
      // Cycle through: chats <-> input (only 2 components)
      if (focusArea === "chats") {
        focusArea = "input"
        chatListBox.borderColor = colors.border
        inputArea.borderColor = colors.primary
        messageInput.focus()
        statusText.content = DEMO_MODE ? "● Demo Mode" : "● Connected"
        statusText.fg = colors.primary
        logger.info("App", "FOCUS SWITCHED TO INPUT", { focusArea })
      } else {
        // From input or messages, go to chats
        focusArea = "chats"
        selectedMessage = -1 // Hide cursor
        chatListBox.borderColor = colors.primary
        inputArea.borderColor = colors.border
        statusText.content = DEMO_MODE ? "● Demo Mode" : "● Connected"
        statusText.fg = colors.primary
        logger.info("App", "FOCUS SWITCHED TO CHATS", { focusArea })
      }
      
      // Re-render messages to hide cursor
      if (messages.length > 0) await renderMessages()
      
      logger.debug("Keyboard", "Tab pressed - switched focus", { focusArea })
    }

    if (focusArea === "chats" && isReady) {
      if (key.name === "up" && selectedChat > 0) {
        selectedChat--
        updateSelection()
        logger.debug("App", "Chat nav up", { selectedChat })
      } else if (key.name === "down" && selectedChat < chats.length - 1) {
        selectedChat++
        updateSelection()
        logger.debug("App", "Chat nav down", { selectedChat })
      } else if (key.name === "return" && chats.length > 0) {
        await selectChat(selectedChat)
        focusArea = "input"
        chatListBox.borderColor = colors.border
        inputArea.borderColor = colors.primary
        logger.debug("App", "Focus → input")
      }
    }
    

    // Number keys 1-9 for quick chat selection
    if (isReady && key.name && /^[1-9]$/.test(key.name)) {
      const idx = parseInt(key.name) - 1
      if (idx < chats.length) {
        logger.debug("App", "Quick select chat", { key: key.name, idx })
        await selectChat(idx)
        focusArea = "input"
        chatListBox.borderColor = colors.border
        inputArea.borderColor = colors.primary
        messageInput.focus()
      }
    }

    // Escape to go back to chat list or cancel editing
    if (key.name === "escape") {
      if (focusArea === "messages") {
        // Exit message select mode, refocus input
        focusArea = "input"
        // Hide cursor without full re-render to preserve scroll
        updateCursorVisuals(-1)
        selectedMessage = -1
        inputArea.borderColor = colors.primary
        messageInput.focus()
        statusText.content = "● Connected"
        statusText.fg = colors.primary
        logger.info("App", "Escape - exit message select mode")
        return
      } else if (focusArea === "editing") {
        // Cancel editing
        editingMessageId = null
        focusArea = "input"
        messageInput.value = ""
        statusText.content = "● Cancelled editing"
        statusText.fg = colors.textMuted
        setTimeout(() => {
          statusText.content = "● Connected"
          statusText.fg = colors.primary
        }, 1000)
        logger.info("App", "Cancelled message editing")
        return
      } else if (focusArea === "input") {
        // Clear reply reference
        if (replyToMessageId) {
          replyToMessageId = null
          statusText.content = "● Cancelled reply"
          statusText.fg = colors.textMuted
          setTimeout(() => {
            statusText.content = "● Connected"
            statusText.fg = colors.primary
          }, 1000)
          logger.info("App", "Cancelled reply")
          return
        }
        // Go back to chats
        focusArea = "chats"
        chatListBox.borderColor = colors.primary
        inputArea.borderColor = colors.border
        logger.debug("App", "Escape - back to chats")
      }
    }

    // Help (configurable, default ?)
    if (matchesKeybinding(key, keybindings.help)) {
      const helpLines = [
        "╭─────────────── WhatsApp TUI Help ───────────────╮",
        "│                                                 │",
        "│  Navigation                                     │",
        "│  ───────────                                    │",
        "│  Tab        Switch between chat list and input  │",
        "│  ↑ / ↓      Navigate chat list                  │",
        "│  1-9        Quick select chat by number         │",
        "│  Enter      Select chat / Send message          │",
        "│  Escape     Return to chat list                 │",
        "│                                                 │",
        "│  Actions (configurable in Settings > Keybinds)  │",
        "│  ───────                                        │",
        `│  ${formatKeybinding(keybindings.settings).padEnd(10)} Open Settings                       │`,
        `│  ${formatKeybinding(keybindings.refreshChats).padEnd(10)} Refresh chats                       │`,
        `│  ${formatKeybinding(keybindings.pinChat).padEnd(10)} Pin/Unpin chat                      │`,
        `│  ${formatKeybinding(keybindings.muteChat).padEnd(10)} Mute/Unmute chat                    │`,
        `│  ${formatKeybinding(keybindings.archiveChat).padEnd(10)} Archive chat                        │`,
        `│  ${formatKeybinding(keybindings.quit).padEnd(10)} Quit application                    │`,
        "│                                                 │",
        "│  Press any key to close this help               │",
        "╰─────────────────────────────────────────────────╯",
      ]
      console.clear()
      console.log("\n".repeat(3))
      helpLines.forEach(line => console.log("  " + line))
      console.log("\n  Press any key to continue...")
      logger.debug("App", "Help screen shown")
    }

    // Refresh chats (configurable, default Ctrl+R)
    if (matchesKeybinding(key, keybindings.refreshChats) && isReady && activeService) {
      logger.info("App", "Refreshing chats")
      statusText.content = "○ Refreshing..."
      chats = await activeService.getChats()
      renderChats()
      updateSelection()
      if (currentChatId) {
        messages = await activeService.getMessages(currentChatId, 30)
        await renderMessages()
      }
      statusText.content = "● Connected"
      statusText.fg = colors.primary
    }

    // Pin/unpin chat (configurable, default Ctrl+P)
    if (matchesKeybinding(key, keybindings.pinChat) && isReady && currentChatId && activeService) {
      const chat = chats[selectedChat]
      if (chat) {
        logger.info("App", "Toggling pin", { chatId: currentChatId, currentPin: chat.pinned })
        statusText.content = chat.pinned ? "○ Unpinning..." : "○ Pinning..."
        const success = await activeService.pinChat(currentChatId, !chat.pinned)
        if (success) {
          chats = await activeService.getChats()
          renderChats()
          updateSelection()
          statusText.content = chat.pinned ? "● Unpinned" : "● Pinned"
        } else {
          statusText.content = "✗ Failed"
        }
        setTimeout(() => { statusText.content = "● Connected"; statusText.fg = colors.primary }, 1500)
      }
    }

    // Mute/unmute chat (configurable, default Ctrl+M)
    if (matchesKeybinding(key, keybindings.muteChat) && isReady && currentChatId && activeService) {
      const chat = chats[selectedChat]
      if (chat) {
        logger.info("App", "Toggling mute", { chatId: currentChatId, currentMute: chat.muted })
        statusText.content = chat.muted ? "○ Unmuting..." : "○ Muting..."
        const success = await activeService.muteChat(currentChatId, !chat.muted)
        if (success) {
          chats = await activeService.getChats()
          renderChats()
          updateSelection()
          statusText.content = chat.muted ? "● Unmuted" : "● Muted"
        } else {
          statusText.content = "✗ Failed"
        }
        setTimeout(() => { statusText.content = "● Connected"; statusText.fg = colors.primary }, 1500)
      }
    }

    // Archive chat (configurable, default Ctrl+A)
    if (matchesKeybinding(key, keybindings.archiveChat) && isReady && currentChatId && activeService) {
      const chat = chats[selectedChat]
      if (chat) {
        logger.info("App", "Archiving chat", { chatId: currentChatId })
        statusText.content = "○ Archiving..."
        const success = await activeService.archiveChat(currentChatId, true)
        if (success) {
          chats = await activeService.getChats()
          renderChats()
          updateSelection()
          statusText.content = "● Archived"
        } else {
          statusText.content = "✗ Failed"
        }
        setTimeout(() => { statusText.content = "● Connected"; statusText.fg = colors.primary }, 1500)
      }
    }
  })

  // Initialize - show main menu first
  currentView = "main_menu"
  mainBox.visible = false
  menuBox.visible = true
  updateMenuSelection()
  
  logger.info("App", "Main menu initialized")
  
  // Periodic state logging every 30 seconds
  setInterval(() => {
    logger.info("StateLog", "=== Periodic State Report ===", {
      isReady,
      DEMO_MODE,
      chatsCount: chats.length,
      messagesCount: messages.length,
      selectedChat,
      currentChatId,
      focusArea,
      chatItemsCount: chatItems.length,
      uptime: process.uptime().toFixed(0) + "s",
      memoryUsage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB"
    })
  }, 30000)
  
  logger.info("App", "main() finished setup - periodic logging enabled")
}

main().catch((err) => {
  logger.error("App", "main() FATAL CRASH", err)
  console.error("FATAL:", err)
  process.exit(1)
})

// Uncaught exception handlers
process.on("uncaughtException", (err) => {
  logger.error("Process", "UNCAUGHT EXCEPTION", err)
  console.error("Uncaught Exception:", err)
})

process.on("unhandledRejection", (reason, promise) => {
  logger.error("Process", "UNHANDLED REJECTION", { reason: String(reason) })
  console.error("Unhandled Rejection:", reason)
})

// Signal handlers for graceful shutdown
process.on("SIGTERM", () => {
  logger.info("Process", "Received SIGTERM - shutting down")
  process.exit(0)
})

process.on("SIGINT", () => {
  logger.info("Process", "Received SIGINT - shutting down")
  process.exit(0)
})
// Signal handlers for graceful shutdown
process.on("SIGTERM", () => {
  logger.info("Process", "Received SIGTERM - shutting down")
  process.exit(0)
})

process.on("SIGINT", () => {
  logger.info("Process", "Received SIGINT - shutting down")
  process.exit(0)
})
