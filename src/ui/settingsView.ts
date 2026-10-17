import {
  BoxRenderable,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core"
import {
  SETTINGS_PAGES,
  getNestedSetting,
  setNestedSetting,
  getKeybindingsSettings,
  type SettingSection,
} from "../settings"
import {
  formatKeybinding,
  saveKeybindings,
  matchesKeybinding,
  type KeyBinding,
  type KeyBindings,
} from "../keybindings"
import { mediaCache } from "../utils/mediaCache"
import type { AppContext } from "../app/context"
import { logger } from "../utils/logger"
import { removeChildById } from "./renderable-utils"
import { renderChats } from "./chatList"
import { renderMessages } from "./messageList"

/** Persistent settings-view renderables. */
export interface SettingsHandles {
  box: BoxRenderable
  title: TextRenderable
  spacer: TextRenderable
}

/** Build the settings overlay container. */
export function createSettingsView(
  renderer: CliRenderer,
  width: number,
  height: number,
): SettingsHandles {
  const box = new BoxRenderable(renderer, {
    id: "settings-box",
    width,
    height,
    backgroundColor: "#0D1117",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
  })

  const title = new TextRenderable(renderer, {
    id: "settings-title",
    content: "⚙️  Settings",
    fg: "#58A6FF",
  })

  const spacer = new TextRenderable(renderer, {
    id: "settings-spacer",
    content: " ",
    fg: "#8B949E",
  })

  return { box, title, spacer }
}

// Ids of every dynamically-added settings renderable, tracked for removal.
let settingsItemIds: string[] = []

/** The sections for the current settings page (keybindings are generated). */
function getSections(ctx: AppContext): SettingSection[] {
  const page = SETTINGS_PAGES[ctx.state.currentSettingsPage]
  return page.id === "keybindings" ? getKeybindingsSettings() : page.sections
}

/** Rebuild the settings item tree for the current page/selection. */
export function buildSettingsItems(ctx: AppContext): void {
  const { state } = ctx
  const { box, title, spacer } = ctx.handles.settings

  for (const id of settingsItemIds) {
    removeChildById(box, id)
  }
  settingsItemIds = []

  const pageTabsText = SETTINGS_PAGES.map((p, idx) =>
    idx === state.currentSettingsPage ? `[${p.title}]` : p.title,
  ).join("  ")
  title.content = `⚙️ Settings - ${pageTabsText}\n`

  box.add(title)
  settingsItemIds.push("settings-title")
  box.add(spacer)
  settingsItemIds.push("settings-spacer")

  const sections = getSections(ctx)
  sections.forEach((section, sIdx) => {
    const headerId = `settings-section-${sIdx}`
    const sectionHeader = new TextRenderable(ctx.renderer, {
      id: headerId,
      content: section.title,
      fg: "#8B949E",
    })
    box.add(sectionHeader)
    settingsItemIds.push(headerId)

    section.items.forEach((menuItem, iIdx) => {
      const isSelected = sIdx === state.settingsSection && iIdx === state.settingsItem

      let valueStr = ""
      if (menuItem.type === "keybinding" && menuItem.keybindingKey) {
        const kb = ctx.config.keybindings[menuItem.keybindingKey as keyof KeyBindings]
        if (kb) valueStr = ` [${formatKeybinding(kb)}]`
      } else if (menuItem.key) {
        const val = getNestedSetting(menuItem.key)
        if (menuItem.type === "toggle") {
          valueStr = val ? " [●]" : " [○]"
        } else if (menuItem.type === "radio" || menuItem.type === "select") {
          const opt = menuItem.options?.find((o) => o.value === val)
          valueStr = ` [${opt?.label || val}]`
        } else if (menuItem.type === "number") {
          valueStr = ` [${val}]`
        }
      } else if (menuItem.type === "button") {
        valueStr = " →"
      }

      const boxId = `settings-item-box-${sIdx}-${iIdx}`
      const itemBox = new BoxRenderable(ctx.renderer, {
        id: boxId,
        width: 50,
        height: 1,
        backgroundColor: isSelected ? "#30363D" : "#0D1117",
        justifyContent: "flex-start",
        paddingLeft: 2,
      })

      const itemText = new TextRenderable(ctx.renderer, {
        id: `settings-item-${sIdx}-${iIdx}`,
        content: `${isSelected ? "▸ " : "  "}${menuItem.label}${valueStr}`,
        fg: isSelected ? "#FFFFFF" : "#8B949E",
      })

      itemBox.add(itemText)
      box.add(itemBox)
      settingsItemIds.push(boxId)
    })

    const spacerId = `settings-section-spacer-${sIdx}`
    const sectionSpacer = new TextRenderable(ctx.renderer, {
      id: spacerId,
      content: " ",
      fg: "#8B949E",
    })
    box.add(sectionSpacer)
    settingsItemIds.push(spacerId)
  })

  const footerId = "settings-footer"
  const settingsFooter = new TextRenderable(ctx.renderer, {
    id: footerId,
    content: "↑↓ Navigate │ Enter Toggle │ Esc Close",
    fg: "#6E7681",
  })
  box.add(settingsFooter)
  settingsItemIds.push(footerId)
}

/** Show the settings overlay and rebuild its items. */
export function renderSettings(ctx: AppContext): void {
  const mainBox = ctx.handles.mainBox
  const menuBox = ctx.handles.menu.box
  const settings = ctx.handles.settings
  logger.info("App", "renderSettings() called")

  mainBox.visible = false
  menuBox.visible = false
  settings.box.visible = true

  buildSettingsItems(ctx)
  logger.info("App", "Settings rendered", { itemsCount: settingsItemIds.length })
}

/** Flatten the current page into a navigable list of (section, item) pairs. */
function getTotalSettingsItems(ctx: AppContext): { section: number; item: number }[] {
  const items: { section: number; item: number }[] = []
  getSections(ctx).forEach((section, sIdx) => {
    section.items.forEach((_, iIdx) => {
      items.push({ section: sIdx, item: iIdx })
    })
  })
  return items
}

/** Move the settings selection up/down across section boundaries. */
export function navigateSettings(ctx: AppContext, direction: "up" | "down"): void {
  const allItems = getTotalSettingsItems(ctx)
  const { state } = ctx
  const currentIdx = allItems.findIndex(
    (i) => i.section === state.settingsSection && i.item === state.settingsItem,
  )
  let newIdx = currentIdx

  if (direction === "up") {
    newIdx = Math.max(0, currentIdx - 1)
  } else {
    newIdx = Math.min(allItems.length - 1, currentIdx + 1)
  }

  if (!allItems[newIdx]) return
  state.settingsSection = allItems[newIdx].section
  state.settingsItem = allItems[newIdx].item
  buildSettingsItems(ctx)
}

/** Begin keybinding key-capture (reuses the confirm overlay). */
export function startKeyCapture(ctx: AppContext, keybindingKey: string, label: string): void {
  const { state } = ctx
  state.keyCaptureActive = true
  state.keyCaptureKeybindingKey = keybindingKey
  state.keyCaptureLabel = label

  ctx.confirm.beginCapture(
    "⌨️  Press a Key",
    `Set keybinding for: ${label}\n\nPress any key combination...\n(Esc to cancel)`,
  )
  logger.info("Keybindings", "Key capture started", { keybindingKey, label })
}

/** Handle a key while key-capture is active. Returns `true` when consumed. */
export function handleKeyCapture(ctx: AppContext, key: KeyEvent): boolean {
  const { state } = ctx
  if (!state.keyCaptureActive || !state.keyCaptureKeybindingKey) return false

  if (key.name === "escape") {
    state.keyCaptureActive = false
    state.keyCaptureKeybindingKey = null
    ctx.confirm.endCapture()
    logger.info("Keybindings", "Key capture cancelled")
    return true
  }

  const newBinding: KeyBinding = {
    key: key.name,
    description: state.keyCaptureLabel,
  }
  if (key.ctrl) newBinding.ctrl = true
  if (key.shift) newBinding.shift = true

  const updatedKeybindings = { ...ctx.config.keybindings }
  ;(updatedKeybindings as Record<string, KeyBinding>)[state.keyCaptureKeybindingKey] = newBinding
  saveKeybindings(updatedKeybindings)
  Object.assign(ctx.config.keybindings, updatedKeybindings)

  logger.info("Keybindings", "Key captured and saved", {
    keybindingKey: state.keyCaptureKeybindingKey,
    newBinding: formatKeybinding(newBinding),
  })

  state.keyCaptureActive = false
  state.keyCaptureKeybindingKey = null
  ctx.confirm.endCapture()
  buildSettingsItems(ctx)
  return true
}

/** Activate the currently selected settings item (toggle/cycle/capture/action). */
export function toggleCurrentSetting(ctx: AppContext): void {
  const { state } = ctx
  const colors = ctx.theme.colors
  const section = getSections(ctx)[state.settingsSection]
  const item = section?.items[state.settingsItem]
  if (!item) return

  if (item.type === "keybinding" && item.keybindingKey) {
    startKeyCapture(ctx, item.keybindingKey, item.label)
    return
  }

  if (item.type === "button") {
    if (item.id === "clearMediaCache") {
      logger.info("Settings", "Clearing media cache")
      mediaCache.clear()
      ctx.status.set("● Media cache cleared", colors.primary)
      ctx.status.revertAfter(2000, { content: "● Connected" })
      return
    }
    if (item.action) {
      void item.action()
    }
    return
  }

  if (item.type === "toggle" && item.key) {
    const currentVal = getNestedSetting(item.key)
    setNestedSetting(item.key, !currentVal)
    buildSettingsItems(ctx)
  } else if ((item.type === "radio" || item.type === "select") && item.key && item.options) {
    const currentVal = getNestedSetting(item.key)
    const currentIdx = item.options.findIndex((o) => o.value === currentVal)
    const nextIdx = (currentIdx + 1) % item.options.length
    setNestedSetting(item.key, item.options[nextIdx].value)
    buildSettingsItems(ctx)
  } else if (item.type === "number" && item.key) {
    const currentVal = getNestedSetting(item.key) as number
    const clampedVal = Math.min(item.max || 300, Math.max(item.min || 0, currentVal + 1))
    setNestedSetting(item.key, clampedVal)
    buildSettingsItems(ctx)
  }
}

/** Restore the service view after closing settings. */
async function closeSettings(ctx: AppContext): Promise<void> {
  ctx.handles.settings.box.visible = false
  ctx.handles.mainBox.visible = true
  ctx.handles.menu.box.visible = false
  renderChats(ctx)
  if (ctx.state.messages.length > 0) await renderMessages(ctx)
}

/** F2 (configurable): toggle the settings overlay from the service view. */
export async function handleSettingsToggle(ctx: AppContext, key: KeyEvent): Promise<boolean> {
  const { state } = ctx
  if (state.view !== "service") return false
  if (!matchesKeybinding(key, ctx.config.keybindings.settings)) return false

  state.showSettings = !state.showSettings
  if (state.showSettings) {
    state.focusArea = "settings"
    state.settingsSection = 0
    state.settingsItem = 0
    renderSettings(ctx)
  } else {
    await closeSettings(ctx)
  }
  return true
}

/** Navigation while the settings overlay is open. Consumes every key. */
export async function handleSettingsNavigation(ctx: AppContext, key: KeyEvent): Promise<boolean> {
  const { state } = ctx
  if (!state.showSettings) return false

  if (key.name === "escape") {
    state.showSettings = false
    state.focusArea = "chats"
    await closeSettings(ctx)
    logger.debug("App", "Settings closed via Escape")
    return true
  }

  if (key.name === "tab") {
    if (key.shift) {
      state.currentSettingsPage =
        (state.currentSettingsPage - 1 + SETTINGS_PAGES.length) % SETTINGS_PAGES.length
    } else {
      state.currentSettingsPage = (state.currentSettingsPage + 1) % SETTINGS_PAGES.length
    }
    state.settingsSection = 0
    state.settingsItem = 0
    buildSettingsItems(ctx)
    logger.info("App", "Settings page changed", {
      page: SETTINGS_PAGES[state.currentSettingsPage].title,
    })
    return true
  }

  if (key.name === "up") {
    navigateSettings(ctx, "up")
    return true
  }
  if (key.name === "down") {
    navigateSettings(ctx, "down")
    return true
  }
  if (key.name === "return" || key.name === "space") {
    toggleCurrentSetting(ctx)
    return true
  }

  if (key.name === "left" || key.name === "right") {
    const item = getSections(ctx)[state.settingsSection]?.items[state.settingsItem]
    if (item && (item.type === "radio" || item.type === "select") && item.key && item.options) {
      const currentVal = getNestedSetting(item.key)
      const currentIdx = item.options.findIndex((o) => o.value === currentVal)
      const direction = key.name === "right" ? 1 : -1
      const nextIdx = (currentIdx + direction + item.options.length) % item.options.length
      setNestedSetting(item.key, item.options[nextIdx].value)
      renderSettings(ctx)
    } else if (item && item.type === "number" && item.key) {
      const currentVal = getNestedSetting(item.key) as number
      const step = key.name === "right" ? 10 : -10
      const newVal = Math.min(item.max || 300, Math.max(item.min || 0, currentVal + step))
      setNestedSetting(item.key, newVal)
      renderSettings(ctx)
    }
    return true
  }

  return true
}
