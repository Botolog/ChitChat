import { createCliRenderer } from "@opentui/core"
import { logger, Logger } from "../utils/logger"
import { loadSettings } from "../settings"
import { loadKeybindings } from "../keybindings"
import { getEnabledServices } from "../services/registry"
import { detectTerminalCapabilities } from "../utils/terminalCapabilities"
import { mediaServer } from "../utils/mediaServer"
import { DEMO_CHATS } from "./demo"
import { ThemeManager } from "./theme"
import { Lifecycle } from "./lifecycle"
import { createShutdown } from "./shutdown"
import { registerSignalHandlers } from "./signals"
import { createInitialState } from "./state"
import { buildLayout, handleResize } from "../ui/layout"
import { StatusBar } from "../ui/statusBar"
import { ConfirmModal } from "../ui/modals/confirmModal"
import { QrModal } from "../ui/modals/qrModal"
import { createKeyHandler } from "../input/dispatcher"
import { wireInputBar } from "../ui/inputBar"
import { getChatItemCount } from "../ui/chatList"
import { showMainMenu } from "./views"
import type { AppContext } from "./context"

/**
 * Create the renderer, build the shared context, wire resize/keys/signals and
 * start the app. Everything user-visible is created here exactly once.
 */
export async function bootstrap(): Promise<void> {
  logger.info("App", "bootstrap() starting")

  const demoMode = process.argv.includes("--demo")

  const settings = loadSettings()
  Logger.setGlobalLevel(settings.logLevel)
  const keybindings = loadKeybindings()
  const termCapabilities = detectTerminalCapabilities()
  logger.info("App", "Terminal capabilities", termCapabilities)

  logger.debug("App", "Creating CLI renderer")
  const renderer = await createCliRenderer({ exitOnCtrlC: false })
  logger.info("App", "CLI renderer created")

  const width = process.stdout.columns || 80
  const height = process.stdout.rows || 24
  const chatListWidth = 32
  const msgAreaWidth = width - chatListWidth - 2
  logger.debug("App", "Terminal dimensions", { width, height, chatListWidth, msgAreaWidth })

  const theme = new ThemeManager("whatsapp")
  const services = getEnabledServices()
  const state = createInitialState(demoMode, DEMO_CHATS)

  const handles = buildLayout({
    renderer,
    width,
    height,
    chatListWidth,
    msgAreaWidth,
    colors: theme.colors,
    demoMode,
    services,
  })

  const status = new StatusBar(handles.statusText)
  const lifecycle = new Lifecycle()
  const shutdown = createShutdown({ lifecycle, status })

  const boxes = {
    mainBox: handles.mainBox,
    menuBox: handles.menu.box,
    settingsBox: handles.settings.box,
  }
  const confirm = new ConfirmModal(handles.confirmModal, boxes)
  const qr = new QrModal(handles.qrModal, boxes)

  const ctx: AppContext = {
    renderer,
    dims: { width, height, chatListWidth, msgAreaWidth },
    state,
    handles,
    theme,
    config: { demoMode, settings, keybindings, services, termCapabilities },
    service: { active: null, activeId: null },
    lifecycle,
    status,
    media: { renderer: null, server: mediaServer },
    confirm,
    qr,
    shutdown,
  }

  // Resize handling (removed on shutdown via the lifecycle, T6).
  const onResize = (): void => {
    void handleResize(ctx).catch((err) => logger.error("App", "Resize failed", err))
  }
  process.stdout.on("resize", onResize)
  lifecycle.onDispose(() => process.stdout.off("resize", onResize))

  // The single keypress listener.
  renderer.keyInput.on("keypress", createKeyHandler(ctx))

  // Input-bar listeners.
  wireInputBar(ctx)

  // Show the main menu first.
  showMainMenu(ctx)
  logger.info("App", "Main menu initialized")

  // Periodic state logging (cancellable, T6).
  lifecycle.interval(() => {
    logger.info("StateLog", "=== Periodic State Report ===", {
      isReady: state.isReady,
      demoMode,
      chatsCount: state.chats.length,
      messagesCount: state.messages.length,
      selectedChat: state.selectedChat,
      currentChatId: state.currentChatId,
      focusArea: state.focusArea,
      chatItemsCount: getChatItemCount(),
      uptime: process.uptime().toFixed(0) + "s",
      memoryUsage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
    })
  }, 30000)

  // Signal/error handlers (single registration, T4).
  registerSignalHandlers(shutdown)

  logger.info("App", "bootstrap() finished setup - periodic logging enabled")
}
