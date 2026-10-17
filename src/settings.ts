import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { logger } from "./utils/logger"

/**
 * Resolve the settings file location.
 *
 * Keeps the historical default (`<cwd>/.chitchat-settings.json`) but honours
 * `CHITCHAT_SETTINGS_PATH` so tests / packagers can relocate it. Evaluated
 * lazily so callers may set the env var before the first load/save.
 */
function getSettingsPath(): string {
  const override = process.env.CHITCHAT_SETTINGS_PATH
  if (override && override.trim().length > 0) return override
  return join(process.cwd(), ".chitchat-settings.json")
}

export interface AppSettings {
  // Appearance
  theme: "dark" | "light" | "system"
  fontSize: "small" | "medium" | "large"
  showAvatars: boolean
  compactMode: boolean

  // Notifications
  notificationsEnabled: boolean
  notificationSound: boolean
  notificationPreview: boolean
  mutedChats: string[]

  // Privacy
  showReadReceipts: boolean
  showTypingIndicator: boolean
  showLastSeen: boolean

  // Chat
  enterToSend: boolean
  spellCheck: boolean
  autoDownloadMedia: "always" | "wifi" | "never"
  mediaQuality: "low" | "medium" | "high"
  confirmDeleteMessage: boolean

  // Media Display
  mediaDisplayMode: "auto" | "indicator" | "ascii" | "kitty" | "iterm2" | "sixel" | "http"
  showMediaThumbnails: boolean
  maxThumbnailSize: number // pixels
  autoDownloadMediaOnEnter: boolean // Auto-download all media when entering chat

  // Advanced
  developerMode: boolean
  logLevel: "debug" | "info" | "warn" | "error"
  autoReconnect: boolean
  connectionTimeout: number
  mouseNaturalScroll: boolean
  mouseScrollSpeed: number // Lines scrolled per wheel tick (1-10)

  // WhatsApp Settings
  whatsapp: {
    autoMarkAsRead: boolean
    deleteOldMessages: boolean
    deleteOlderThan: number // days
  }

  // Slack Settings
  slack: {
    showThreads: boolean
    autoExpandThreads: boolean
  }
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  fontSize: "medium",
  showAvatars: true,
  compactMode: false,

  notificationsEnabled: true,
  notificationSound: true,
  notificationPreview: true,
  mutedChats: [],

  showReadReceipts: true,
  showTypingIndicator: true,
  showLastSeen: true,

  enterToSend: true,
  spellCheck: false,
  autoDownloadMedia: "wifi",
  mediaQuality: "medium",
  confirmDeleteMessage: true,

  mediaDisplayMode: "auto",
  showMediaThumbnails: true,
  maxThumbnailSize: 80,
  autoDownloadMediaOnEnter: false,

  developerMode: false,
  logLevel: "info",
  autoReconnect: true,
  connectionTimeout: 60,
  mouseNaturalScroll: true,
  mouseScrollSpeed: 3,

  whatsapp: {
    autoMarkAsRead: true,
    deleteOldMessages: false,
    deleteOlderThan: 30,
  },

  slack: {
    showThreads: true,
    autoExpandThreads: false,
  },
}

/**
 * Allowed string values keyed by dotted path. Any string field listed here is
 * treated as an enum: values outside the set fall back to the default.
 */
const ENUMS: Record<string, readonly string[]> = {
  theme: ["dark", "light", "system"],
  fontSize: ["small", "medium", "large"],
  autoDownloadMedia: ["always", "wifi", "never"],
  mediaQuality: ["low", "medium", "high"],
  mediaDisplayMode: ["auto", "indicator", "ascii", "kitty", "iterm2", "sixel", "http"],
  logLevel: ["debug", "info", "warn", "error"],
}

/**
 * Inclusive numeric bounds keyed by dotted path. Numeric fields without an
 * entry here only need to be finite numbers.
 */
const NUMBER_RANGES: Record<string, { min: number; max: number }> = {
  maxThumbnailSize: { min: 1, max: 1024 },
  connectionTimeout: { min: 10, max: 300 },
  mouseScrollSpeed: { min: 1, max: 10 },
  "whatsapp.deleteOlderThan": { min: 1, max: 365 },
}

/** Keys that must never be written into nested settings (prototype pollution). */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"])

/**
 * Recursively validate `value` against the shape of `fallback` (which is always
 * a value from `DEFAULT_SETTINGS`). Returns a freshly built value: unknown keys
 * are dropped, wrong types are replaced per-field by the default, enums are
 * membership-checked and numbers are range-checked.
 */
function validateField(path: string, value: unknown, fallback: unknown): unknown {
  // Arrays (currently only `mutedChats: string[]`).
  if (Array.isArray(fallback)) {
    if (!Array.isArray(value)) return [...fallback]
    if (fallback.every((entry) => typeof entry === "string")) {
      return value.filter((entry): entry is string => typeof entry === "string")
    }
    return [...fallback]
  }

  // Nested objects (whatsapp / slack): recurse, never letting `value` inject
  // keys that don't exist in the defaults.
  if (fallback !== null && typeof fallback === "object") {
    const fallbackObj = fallback as Record<string, unknown>
    const sourceObj =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
    const merged: Record<string, unknown> = {}
    for (const key of Object.keys(fallbackObj)) {
      const childPath = path ? `${path}.${key}` : key
      merged[key] = validateField(childPath, sourceObj[key], fallbackObj[key])
    }
    return merged
  }

  if (fallback === undefined || fallback === null) return fallback

  // Enumerated strings.
  const allowed = ENUMS[path]
  if (allowed) {
    return typeof value === "string" && allowed.includes(value) ? value : fallback
  }

  if (typeof fallback === "boolean") {
    return typeof value === "boolean" ? value : fallback
  }

  if (typeof fallback === "number") {
    if (typeof value === "number" && Number.isFinite(value)) {
      const range = NUMBER_RANGES[path]
      if (!range || (value >= range.min && value <= range.max)) return value
    }
    return fallback
  }

  if (typeof fallback === "string") {
    return typeof value === "string" ? value : fallback
  }

  return fallback
}

/** Deep clone of the defaults, guaranteed not to alias `DEFAULT_SETTINGS`. */
function cloneDefaults(): AppSettings {
  return validateField("", {}, DEFAULT_SETTINGS) as AppSettings
}

/**
 * Deep-merge a parsed settings payload over the defaults with per-field
 * validation. Never throws: a non-object payload yields the defaults.
 */
export function validateSettings(raw: unknown): AppSettings {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) {
      logger.warn("Settings", "Settings payload is not an object; using defaults")
    }
    return cloneDefaults()
  }
  return validateField("", raw, DEFAULT_SETTINGS) as AppSettings
}

let currentSettings: AppSettings = cloneDefaults()

export function loadSettings(): AppSettings {
  const file = getSettingsPath()
  try {
    if (!existsSync(file)) {
      currentSettings = cloneDefaults()
      logger.info("Settings", "Using default settings")
      return currentSettings
    }

    const data = readFileSync(file, "utf-8")
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch (err) {
      logger.warn("Settings", `Corrupt settings file at ${file}; using defaults`, err)
      currentSettings = cloneDefaults()
      return currentSettings
    }

    currentSettings = validateSettings(parsed)
    logger.info("Settings", "Loaded settings from file")
  } catch (err) {
    logger.warn("Settings", "Failed to read settings file; using defaults", err)
    currentSettings = cloneDefaults()
  }
  return currentSettings
}

/**
 * Atomically write `contents` to `filePath`: write a sibling temp file with
 * `0o600`, then `rename` it over the target. Creates the parent directory when
 * missing. Throws only to the caller; `saveSettings` converts that to `false`.
 */
function writeFileAtomic(filePath: string, contents: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(tmpFile, contents, { encoding: "utf-8", mode: 0o600 })
    renameSync(tmpFile, filePath)
  } catch (err) {
    try {
      if (existsSync(tmpFile)) rmSync(tmpFile, { force: true })
    } catch {
      // Best-effort cleanup; never mask the original failure.
    }
    throw err
  }
}

/**
 * Persist the given settings object. Written as-is so callers that use
 * `setNestedSetting` at arbitrary depth are not silently pruned; input
 * validation happens in `validateSettings` when the file is read back.
 */
export function saveSettings(settings: AppSettings): boolean {
  try {
    writeFileAtomic(getSettingsPath(), JSON.stringify(settings, null, 2))
    currentSettings = settings
    logger.info("Settings", "Saved settings to file")
    return true
  } catch (err) {
    logger.warn("Settings", "Failed to save settings", err)
    return false
  }
}

export function getSettings(): AppSettings {
  return currentSettings
}

export function updateSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
  currentSettings = { ...currentSettings, [key]: value }
  saveSettings(currentSettings)
}

/** Read a value at an arbitrary dot-separated path, or `undefined`. */
export function getNestedSetting(key: string): any {
  const parts = key.split(".").filter((part) => part.length > 0)
  let value: any = currentSettings
  for (const part of parts) {
    if (FORBIDDEN_KEYS.has(part)) return undefined
    if (value === null || typeof value !== "object") return undefined
    value = value[part]
  }
  return value
}

/**
 * Write a value at an arbitrary dot-separated path, creating intermediate
 * objects as needed. Rejects `__proto__` / `constructor` / `prototype` segments
 * to avoid prototype pollution.
 */
export function setNestedSetting(key: string, value: any): void {
  const parts = key.split(".").filter((part) => part.length > 0)
  if (parts.length === 0) return

  if (parts.some((part) => FORBIDDEN_KEYS.has(part))) {
    logger.warn("Settings", `Refusing to set unsafe settings key: ${key}`)
    return
  }

  if (parts.length === 1) {
    updateSetting(parts[0] as keyof AppSettings, value as AppSettings[keyof AppSettings])
    return
  }

  let target = currentSettings as unknown as Record<string, unknown>
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    const next = target[part]
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      target[part] = {}
    }
    target = target[part] as Record<string, unknown>
  }
  target[parts[parts.length - 1]] = value
  saveSettings(currentSettings)
}

// Settings menu structure for the TUI
export interface SettingItem {
  id: string
  label: string
  type: "toggle" | "radio" | "select" | "button" | "number" | "header" | "keybinding"
  key?: keyof AppSettings | string // Allow nested keys like "whatsapp.autoMarkAsRead"
  keybindingKey?: string // For keybinding items, the key in KeyBindings
  options?: { value: string; label: string }[]
  min?: number
  max?: number
  action?: () => void | Promise<void>
}

export interface SettingSection {
  title: string
  items: SettingItem[]
}

export interface SettingsPage {
  id: string
  title: string
  sections: SettingSection[]
}

// Main settings page
const MAIN_SETTINGS: SettingSection[] = [
  {
    title: "🎨 Appearance",
    items: [
      { id: "theme", label: "Theme", type: "radio", key: "theme", options: [
        { value: "dark", label: "Dark" },
        { value: "light", label: "Light" },
        { value: "system", label: "System" },
      ]},
      { id: "fontSize", label: "Font Size", type: "radio", key: "fontSize", options: [
        { value: "small", label: "Small" },
        { value: "medium", label: "Medium" },
        { value: "large", label: "Large" },
      ]},
      { id: "showAvatars", label: "Show Avatars", type: "toggle", key: "showAvatars" },
      { id: "compactMode", label: "Compact Mode", type: "toggle", key: "compactMode" },
    ]
  },
  {
    title: "🔔 Notifications",
    items: [
      { id: "notificationsEnabled", label: "Enable Notifications", type: "toggle", key: "notificationsEnabled" },
      { id: "notificationSound", label: "Notification Sound", type: "toggle", key: "notificationSound" },
      { id: "notificationPreview", label: "Show Message Preview", type: "toggle", key: "notificationPreview" },
    ]
  },
  {
    title: "🔒 Privacy",
    items: [
      { id: "showReadReceipts", label: "Show Read Receipts", type: "toggle", key: "showReadReceipts" },
      { id: "showTypingIndicator", label: "Show Typing Indicator", type: "toggle", key: "showTypingIndicator" },
      { id: "showLastSeen", label: "Show Last Seen", type: "toggle", key: "showLastSeen" },
    ]
  },
  {
    title: "💬 Chat",
    items: [
      { id: "enterToSend", label: "Enter to Send", type: "toggle", key: "enterToSend" },
      { id: "spellCheck", label: "Spell Check", type: "toggle", key: "spellCheck" },
      { id: "autoDownloadMedia", label: "Auto-Download Media", type: "select", key: "autoDownloadMedia", options: [
        { value: "always", label: "Always" },
        { value: "wifi", label: "WiFi Only" },
        { value: "never", label: "Never" },
      ]},
      { id: "mediaQuality", label: "Media Quality", type: "select", key: "mediaQuality", options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
      ]},
      { id: "autoDownloadMediaOnEnter", label: "Auto-download Media on Chat Open", type: "toggle", key: "autoDownloadMediaOnEnter" },
      { id: "confirmDeleteMessage", label: "Confirm Before Deleting Messages", type: "toggle", key: "confirmDeleteMessage" },
    ]
  },
  {
    title: "⚙️ Advanced",
    items: [
      { id: "developerMode", label: "Developer Mode", type: "toggle", key: "developerMode" },
      { id: "logLevel", label: "Log Level", type: "select", key: "logLevel", options: [
        { value: "debug", label: "Debug" },
        { value: "info", label: "Info" },
        { value: "warn", label: "Warning" },
        { value: "error", label: "Error" },
      ]},
      { id: "autoReconnect", label: "Auto Reconnect", type: "toggle", key: "autoReconnect" },
      { id: "connectionTimeout", label: "Connection Timeout (s)", type: "number", key: "connectionTimeout", min: 10, max: 300 },
      { id: "mouseNaturalScroll", label: "Mouse Natural Scroll", type: "toggle", key: "mouseNaturalScroll" },
      { id: "mouseScrollSpeed", label: "Mouse Scroll Speed (lines)", type: "number", key: "mouseScrollSpeed", min: 1, max: 10 },
    ]
  },
  {
    title: "📋 Actions",
    items: [
      { id: "clearMediaCache", label: "Clear Media Cache", type: "button" },
      { id: "clearCache", label: "Clear Cache", type: "button", action: () => { /* TODO */ } },
      { id: "exportSettings", label: "Export Settings", type: "button", action: () => { /* TODO */ } },
      { id: "resetSettings", label: "Reset to Defaults", type: "button", action: () => {
        currentSettings = cloneDefaults()
        saveSettings(currentSettings)
      }},
    ]
  },
]

// WhatsApp service settings
const WHATSAPP_SETTINGS: SettingSection[] = [
  {
    title: "📱 WhatsApp",
    items: [
      { id: "whatsapp.autoMarkAsRead", label: "Auto Mark as Read", type: "toggle", key: "whatsapp.autoMarkAsRead" },
      { id: "whatsapp.deleteOldMessages", label: "Delete Old Messages", type: "toggle", key: "whatsapp.deleteOldMessages" },
      { id: "whatsapp.deleteOlderThan", label: "Delete Messages Older Than (days)", type: "number", key: "whatsapp.deleteOlderThan", min: 1, max: 365 },
    ]
  },
]

// Slack service settings
const SLACK_SETTINGS: SettingSection[] = [
  {
    title: "💼 Slack",
    items: [
      { id: "slack.showThreads", label: "Show Threads", type: "toggle", key: "slack.showThreads" },
      { id: "slack.autoExpandThreads", label: "Auto Expand Threads", type: "toggle", key: "slack.autoExpandThreads" },
    ]
  },
]

// Keybindings settings (dynamically generated)
// Only includes configurable keybindings - navigation/selection keys are constant
export function getKeybindingsSettings(): SettingSection[] {
  return [
    {
      title: "🌐 Global",
      items: [
        { id: "kb.quit", label: "Quit", type: "keybinding", keybindingKey: "quit" },
        { id: "kb.settings", label: "Settings", type: "keybinding", keybindingKey: "settings" },
        { id: "kb.help", label: "Help", type: "keybinding", keybindingKey: "help" },
      ]
    },
    {
      title: "💬 Chat List",
      items: [
        { id: "kb.refreshChats", label: "Refresh Chats", type: "keybinding", keybindingKey: "refreshChats" },
        { id: "kb.pinChat", label: "Pin/Unpin Chat", type: "keybinding", keybindingKey: "pinChat" },
        { id: "kb.muteChat", label: "Mute/Unmute Chat", type: "keybinding", keybindingKey: "muteChat" },
        { id: "kb.archiveChat", label: "Archive Chat", type: "keybinding", keybindingKey: "archiveChat" },
      ]
    },
    {
      title: "📨 Message Actions",
      items: [
        { id: "kb.jumpToReply", label: "Jump to Reply", type: "keybinding", keybindingKey: "jumpToReply" },
        { id: "kb.setReplyReference", label: "Reply to Message", type: "keybinding", keybindingKey: "setReplyReference" },
        { id: "kb.openMedia", label: "Open Media", type: "keybinding", keybindingKey: "openMedia" },
        { id: "kb.deleteMessageForMe", label: "Delete for Me", type: "keybinding", keybindingKey: "deleteMessageForMe" },
        { id: "kb.deleteMessageForEveryone", label: "Delete for Everyone", type: "keybinding", keybindingKey: "deleteMessageForEveryone" },
        { id: "kb.editMessage", label: "Edit Message", type: "keybinding", keybindingKey: "editMessage" },
      ]
    },
  ]
}

// All settings pages
export const SETTINGS_PAGES: SettingsPage[] = [
  { id: "main", title: "Main", sections: MAIN_SETTINGS },
  { id: "keybindings", title: "Keybindings", sections: [] }, // Sections generated dynamically
  { id: "whatsapp", title: "WhatsApp", sections: WHATSAPP_SETTINGS },
  { id: "slack", title: "Slack", sections: SLACK_SETTINGS },
]

// Legacy export for backward compatibility
export const SETTINGS_MENU: SettingSection[] = MAIN_SETTINGS
