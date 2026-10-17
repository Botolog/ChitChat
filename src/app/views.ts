import type { KeyEvent } from "@opentui/core"
import { SERVICES } from "../services/registry"
import { getServiceInstance } from "../services/index"
import { getSettings } from "../settings"
import { getOptimalDisplayMode, type MediaDisplayMode } from "../utils/terminalCapabilities"
import { MediaRenderer } from "../utils/mediaRenderer"
import type { AppContext } from "./context"
import { logger } from "../utils/logger"
import { updateMenuSelection } from "../ui/mainMenu"
import { renderChats, updateSelection } from "../ui/chatList"
import { renderSettings } from "../ui/settingsView"
import { applyServiceTheme } from "../ui/layout"
import { setupServiceEventHandlers } from "./serviceEvents"

/** Return to the main menu (used on startup and when leaving a service). */
export function showMainMenu(ctx: AppContext): void {
  ctx.handles.mainBox.visible = false
  ctx.handles.menu.box.visible = true
  ctx.state.view = "main_menu"
  updateMenuSelection(ctx)
  logger.debug("App", "Showing main menu")
}

/** Reveal the service view (chat list + messages + input). */
export function showServiceView(ctx: AppContext): void {
  ctx.handles.menu.box.visible = false
  ctx.handles.mainBox.visible = true
  logger.debug("App", "Showing service view")
}

/** Leave the current service and go back to the menu. */
export function exitToMainMenu(ctx: AppContext): void {
  ctx.state.view = "main_menu"
  ctx.state.currentServiceId = null
  showMainMenu(ctx)
  logger.info("App", "Returned to main menu")
}

/** Enter a service: apply its theme, build its media renderer and connect. */
export async function enterService(ctx: AppContext, serviceId: string): Promise<void> {
  const state = ctx.state
  const modeLabel = ctx.config.demoMode ? " [DEMO]" : ""

  ctx.theme.setServiceTheme(serviceId)
  state.currentServiceId = serviceId
  state.view = "service"

  const settings = getSettings()
  const displayMode =
    settings.mediaDisplayMode === "auto"
      ? getOptimalDisplayMode(ctx.config.termCapabilities)
      : (settings.mediaDisplayMode as MediaDisplayMode)
  ctx.media.renderer = new MediaRenderer(displayMode)
  logger.info("App", "Media renderer initialized", { mode: displayMode })

  applyServiceTheme(ctx)

  const service = SERVICES[serviceId]
  ctx.handles.titleText.content = `${service?.icon || "💬"} ${service?.name || serviceId} Client${modeLabel}`

  showServiceView(ctx)
  ctx.handles.mainBox.visible = true
  renderChats(ctx)
  updateSelection(ctx)

  if (ctx.config.demoMode) {
    state.isReady = true
    logger.info("App", "Entered service (demo mode)", { serviceId })
    return
  }

  logger.info("App", "Loading service", { serviceId })
  try {
    const svc = await getServiceInstance(serviceId)
    if (!svc) {
      ctx.status.set(`✗ ${service?.name || serviceId} not available`, "#F15C6D")
      logger.error("App", "Service not available", { serviceId })
      return
    }
    ctx.service.active = svc
    setupServiceEventHandlers(ctx)
    await svc.initialize()
    logger.info("App", "Service initialized", { serviceId })
  } catch (err) {
    logger.error("App", "Service initialization failed", { serviceId, error: err })
    const reason =
      err instanceof Error ? err.message : typeof err === "string" ? err : "Error"
    ctx.status.set(`✗ ${reason.slice(0, 30) || "Error"}`, "#F15C6D")
  }
}

/**
 * Main-menu key handling. Consumes *every* key while the menu is visible so the
 * later dispatcher stages never run (matching the original single-branch return).
 */
export async function handleMainMenuNavigation(ctx: AppContext, key: KeyEvent): Promise<boolean> {
  const state = ctx.state
  if (state.view !== "main_menu") return false
  const services = ctx.config.services

  if (key.name === "up" && state.menuSelectedIndex > 0) {
    state.menuSelectedIndex--
    updateMenuSelection(ctx)
    return true
  }
  if (key.name === "down" && state.menuSelectedIndex < services.length - 1) {
    state.menuSelectedIndex++
    updateMenuSelection(ctx)
    return true
  }
  if (key.name === "return") {
    const service = services[state.menuSelectedIndex]
    if (service && service.enabled) {
      if (service.id === "settings") {
        state.view = "service"
        state.showSettings = true
        state.focusArea = "settings"
        state.settingsSection = 0
        state.settingsItem = 0
        renderSettings(ctx)
        logger.info("App", "Opened settings from menu")
      } else {
        await enterService(ctx, service.id)
      }
    }
    return true
  }
  if (key.name === "q" || key.name === "Q") {
    logger.info("App", "User requested exit from menu", { key: key.name })
    await ctx.shutdown(0)
  }
  return true
}
