import {
  BoxRenderable,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core"
import type { ServiceConfig, ServiceTheme } from "../services/registry"
import type { AppContext } from "../app/context"
import { logger } from "../utils/logger"
import { removeChildById } from "./renderable-utils"
import { createMainMenu, type MainMenuHandles } from "./mainMenu"
import { createSettingsView, type SettingsHandles, buildSettingsItems } from "./settingsView"
import { createChatHeader, type ChatHeaderHandles } from "./chatHeader"
import { createMessageList, type MessageListHandles, renderMessages } from "./messageList"
import { createInputBar, type InputBarHandles } from "./inputBar"
import { createConfirmModal, type ConfirmModalHandles } from "./modals/confirmModal"
import { createQrModal, type QrModalHandles } from "./modals/qrModal"
import { renderChats, updateSelection } from "./chatList"

/** Every persistent renderable in the app, plus the resize bookkeeping. */
export interface LayoutHandles {
  mainBox: BoxRenderable
  titleBar: BoxRenderable
  titleText: TextRenderable
  contentRow: BoxRenderable
  chatListLeftBorder: BoxRenderable
  chatList: { box: BoxRenderable }
  messagesRightBorder: BoxRenderable
  rightPanel: BoxRenderable
  chatHeader: ChatHeaderHandles
  messageList: MessageListHandles
  inputBar: InputBarHandles
  statusBar: BoxRenderable
  statusText: TextRenderable
  helpText: TextRenderable
  loadingText: TextRenderable
  menu: MainMenuHandles
  settings: SettingsHandles
  confirmModal: ConfirmModalHandles
  qrModal: QrModalHandles
  /** Number of border-character children currently attached. */
  borderCounts: { chat: number; messages: number }
}

export interface LayoutOptions {
  renderer: CliRenderer
  width: number
  height: number
  chatListWidth: number
  msgAreaWidth: number
  colors: ServiceTheme
  demoMode: boolean
  services: ServiceConfig[]
}

/** Add `count` invisible "l" border characters to `parent`. */
function fillBorder(
  renderer: CliRenderer,
  parent: BoxRenderable,
  idPrefix: string,
  count: number,
  fg: string,
): void {
  for (let i = 0; i < count; i++) {
    const borderChar = new TextRenderable(renderer, {
      id: `${idPrefix}-${i}`,
      content: "l",
      fg,
    })
    parent.add(borderChar)
  }
}

/** Build the entire static render tree. */
export function buildLayout(options: LayoutOptions): LayoutHandles {
  const { renderer, width, height, chatListWidth, msgAreaWidth, colors, demoMode, services } = options
  const modeLabel = demoMode ? " [DEMO]" : ""

  // Main container.
  const mainBox = new BoxRenderable(renderer, {
    id: "main",
    width,
    height,
    flexDirection: "column",
    backgroundColor: colors.bg,
  })

  const titleBar = new BoxRenderable(renderer, {
    id: "title",
    width,
    height: 1,
    backgroundColor: "#128C7E",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingLeft: 1,
    paddingRight: 1,
  })
  const titleText = new TextRenderable(renderer, {
    id: "title-text",
    content: `📱 WhatsApp TUI Client${modeLabel}`,
    fg: "#FFFFFF",
  })
  titleBar.add(titleText)

  const contentRow = new BoxRenderable(renderer, {
    id: "content",
    width,
    height: height - 2,
    flexDirection: "row",
  })

  const chatListLeftBorder = new BoxRenderable(renderer, {
    id: "chat-list-left-border",
    width: 1,
    height: height - 2,
    backgroundColor: colors.bg,
    flexDirection: "column",
  })
  fillBorder(renderer, chatListLeftBorder, "chat-border-l", height - 2, "#00000000")

  const chatListBox = new BoxRenderable(renderer, {
    id: "chat-list",
    width: chatListWidth,
    height: height - 2,
    borderStyle: "rounded",
    borderColor: colors.primary,
    backgroundColor: colors.surface,
    title: demoMode ? " Chats (5) " : " Chats ",
    titleAlignment: "center",
    flexDirection: "column",
    padding: 1,
  })

  const messagesRightBorder = new BoxRenderable(renderer, {
    id: "messages-right-border",
    width: 1,
    height: height - 2,
    backgroundColor: colors.bg,
    flexDirection: "column",
  })
  fillBorder(renderer, messagesRightBorder, "messages-border-l", height - 2, "#00000000")

  const loadingText = new TextRenderable(renderer, {
    id: "loading-text",
    content: demoMode ? "Demo mode active" : "Initializing...\nScan QR in terminal",
    fg: colors.textMuted,
  })
  if (!demoMode) {
    chatListBox.add(loadingText)
  }

  const rightPanel = new BoxRenderable(renderer, {
    id: "right-panel",
    width: msgAreaWidth,
    height: height - 2,
    flexDirection: "column",
    backgroundColor: colors.bg,
  })

  const chatHeader = createChatHeader(renderer, msgAreaWidth, colors)
  const messageList = createMessageList(renderer, msgAreaWidth, height - 8, colors)
  const inputBar = createInputBar(renderer, msgAreaWidth, colors)

  rightPanel.add(chatHeader.box)
  rightPanel.add(messageList.scroll)
  rightPanel.add(inputBar.area)

  const statusBar = new BoxRenderable(renderer, {
    id: "status",
    width,
    height: 1,
    backgroundColor: colors.surface,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingLeft: 1,
    paddingRight: 1,
  })
  const statusText = new TextRenderable(renderer, {
    id: "status-text",
    content: demoMode ? "● Demo Mode" : "○ Connecting...",
    fg: demoMode ? colors.primary : colors.textMuted,
  })
  const helpText = new TextRenderable(renderer, {
    id: "help-text",
    content:
      "?:Help │ F2:Settings │ ↑↓:Nav │ Ctrl+P:Pin │ Ctrl+M:Mute │ Ctrl+A:Archive │ Ctrl+R:Refresh │ Ctrl+Q:Quit",
    fg: colors.textMuted,
  })
  statusBar.add(statusText)
  statusBar.add(helpText)

  contentRow.add(chatListLeftBorder)
  contentRow.add(chatListBox)
  contentRow.add(messagesRightBorder)
  contentRow.add(rightPanel)
  mainBox.add(titleBar)
  mainBox.add(contentRow)
  mainBox.add(statusBar)
  renderer.root.add(mainBox)

  const menu = createMainMenu(renderer, width, height, services)
  renderer.root.add(menu.box)
  mainBox.visible = false
  menu.box.visible = true

  const settings = createSettingsView(renderer, width, height)
  renderer.root.add(settings.box)
  settings.box.visible = false

  const confirmModal = createConfirmModal(renderer, width, height)
  renderer.root.add(confirmModal.overlay)

  const qrModal = createQrModal(renderer, width, height, colors.primary)
  renderer.root.add(qrModal.overlay)

  return {
    mainBox,
    titleBar,
    titleText,
    contentRow,
    chatListLeftBorder,
    chatList: { box: chatListBox },
    messagesRightBorder,
    rightPanel,
    chatHeader,
    messageList,
    inputBar,
    statusBar,
    statusText,
    helpText,
    loadingText,
    menu,
    settings,
    confirmModal,
    qrModal,
    borderCounts: { chat: height - 2, messages: height - 2 },
  }
}

/** Apply the active service palette to every themed renderable. */
export function applyServiceTheme(ctx: AppContext): void {
  const c = ctx.theme.colors
  const h = ctx.handles

  h.mainBox.backgroundColor = c.bg
  h.titleBar.backgroundColor = c.titleBar
  h.chatList.box.borderColor = c.primary
  h.chatList.box.backgroundColor = c.surface
  h.rightPanel.backgroundColor = c.bg
  h.chatHeader.box.backgroundColor = c.surface
  h.chatHeader.text.fg = c.text
  h.chatHeader.count.fg = c.textMuted
  h.messageList.scroll.backgroundColor = c.bg
  h.inputBar.area.borderColor = c.border
  h.statusBar.backgroundColor = c.surface
  h.statusText.fg = c.primary
  h.statusText.content = ctx.config.demoMode ? "● Demo Mode" : "○ Connecting..."
  h.helpText.fg = c.textMuted
}

/**
 * Recalculate geometry for the (possibly new) terminal size and repaint.
 *
 * T6/T8: the previous handler leaked on shutdown and only removed the first 100
 * border characters; this removes exactly the characters it added and registers
 * itself as a disposer via the caller.
 */
export async function handleResize(ctx: AppContext): Promise<void> {
  const { dims, handles } = ctx

  const width = process.stdout.columns || dims.width
  const height = process.stdout.rows || dims.height
  dims.width = width
  dims.height = height
  dims.chatListWidth = Math.floor(width * 0.15)
  dims.msgAreaWidth = width - dims.chatListWidth - 2

  logger.info("App", "Terminal resized - updating UI", {
    width,
    height,
    msgAreaWidth: dims.msgAreaWidth,
  })

  handles.mainBox.width = width
  handles.mainBox.height = height
  handles.rightPanel.width = dims.msgAreaWidth
  handles.rightPanel.height = height - 2
  handles.chatListLeftBorder.height = height - 2
  handles.chatList.box.height = height - 2
  handles.messagesRightBorder.height = height - 2

  // Rebuild left border characters.
  for (let i = 0; i < handles.borderCounts.chat; i++) {
    removeChildById(handles.chatListLeftBorder, `chat-border-l-${i}`)
  }
  fillBorder(ctx.renderer, handles.chatListLeftBorder, "chat-border-l", height - 2, ctx.theme.colors.border)
  handles.borderCounts.chat = height - 2

  // Rebuild right border characters.
  for (let i = 0; i < handles.borderCounts.messages; i++) {
    removeChildById(handles.messagesRightBorder, `messages-border-l-${i}`)
  }
  fillBorder(ctx.renderer, handles.messagesRightBorder, "messages-border-l", height - 2, ctx.theme.colors.border)
  handles.borderCounts.messages = height - 2

  handles.messageList.scroll.width = dims.msgAreaWidth
  handles.messageList.scroll.height = height - 8
  handles.statusBar.width = width
  handles.titleBar.width = width
  handles.contentRow.width = width
  handles.contentRow.height = height - 2
  handles.inputBar.area.width = dims.msgAreaWidth
  handles.inputBar.input.width = dims.msgAreaWidth - 8
  handles.chatHeader.box.width = dims.msgAreaWidth

  handles.menu.box.width = width
  handles.menu.box.height = height
  handles.settings.box.width = width
  handles.settings.box.height = height
  handles.confirmModal.overlay.width = width
  handles.confirmModal.overlay.height = height
  handles.qrModal.overlay.width = width
  handles.qrModal.overlay.height = height

  if (ctx.state.view === "service") {
    if (ctx.state.chats.length > 0) {
      renderChats(ctx)
      updateSelection(ctx)
    }
    if (ctx.state.messages.length > 0) {
      await renderMessages(ctx)
    }
  }

  if (ctx.state.showSettings) {
    buildSettingsItems(ctx)
  }

  logger.debug("App", "Resize complete - UI updated")
}
