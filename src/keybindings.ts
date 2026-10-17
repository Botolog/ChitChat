import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { logger } from "./utils/logger"

/**
 * Resolve the keybindings file location.
 *
 * Keeps the historical default (`<cwd>/.chitchat-keybindings.json`) but honours
 * `CHITCHAT_KEYBINDINGS_PATH`. Evaluated lazily so callers may set the env var
 * before the first load/save.
 */
function getKeybindingsPath(): string {
  const override = process.env.CHITCHAT_KEYBINDINGS_PATH
  if (override && override.trim().length > 0) return override
  return join(process.cwd(), ".chitchat-keybindings.json")
}

export interface KeyBinding {
  key: string
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
  description: string
}

export interface KeyBindings {
  // Global
  quit: KeyBinding
  settings: KeyBinding
  help: KeyBinding

  // Chat list actions
  refreshChats: KeyBinding
  pinChat: KeyBinding
  muteChat: KeyBinding
  archiveChat: KeyBinding

  // Message actions (configurable)
  jumpToReply: KeyBinding
  setReplyReference: KeyBinding
  openMedia: KeyBinding
  deleteMessageForMe: KeyBinding
  deleteMessageForEveryone: KeyBinding
  editMessage: KeyBinding
}

export const DEFAULT_KEYBINDINGS: KeyBindings = {
  // Global
  quit: { key: "q", ctrl: true, description: "Quit application" },
  settings: { key: "f2", description: "Open settings" },
  help: { key: "?", description: "Toggle help" },

  // Chat list actions
  refreshChats: { key: "r", ctrl: true, description: "Refresh chat list" },
  pinChat: { key: "p", ctrl: true, description: "Pin/unpin chat" },
  muteChat: { key: "m", ctrl: true, description: "Mute/unmute chat" },
  archiveChat: { key: "a", ctrl: true, description: "Archive chat" },

  // Message actions (configurable)
  jumpToReply: { key: "space", description: "Jump to replied message" },
  setReplyReference: { key: "r", description: "Set as reply reference" },
  openMedia: { key: "return", description: "Open media" },
  deleteMessageForMe: { key: "backspace", description: "Delete message for me" },
  deleteMessageForEveryone: { key: "delete", description: "Delete message for everyone" },
  editMessage: { key: "insert", description: "Edit message" },
}

/**
 * Normalise one persisted binding against its default. Wrong-typed fields fall
 * back per-field; unknown extra fields are dropped; modifiers are only trusted
 * when explicitly `true`.
 */
function normalizeBinding(value: unknown, fallback: KeyBinding): KeyBinding {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ...fallback }
  }
  const source = value as Record<string, unknown>
  const binding: KeyBinding = {
    key: typeof source.key === "string" && source.key.length > 0 ? source.key : fallback.key,
    description:
      typeof source.description === "string" ? source.description : fallback.description,
  }
  if (source.ctrl === true) binding.ctrl = true
  if (source.shift === true) binding.shift = true
  if (source.alt === true) binding.alt = true
  return binding
}

/** Rebuild a full, valid `KeyBindings` from an untrusted parsed payload. */
function validateKeybindings(raw: unknown): KeyBindings {
  const source =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}
  const result = {} as KeyBindings
  for (const name of Object.keys(DEFAULT_KEYBINDINGS) as (keyof KeyBindings)[]) {
    result[name] = normalizeBinding(source[name], DEFAULT_KEYBINDINGS[name])
  }
  return result
}

/** Fresh deep-ish copy of the defaults (each binding is a new object). */
function cloneDefaults(): KeyBindings {
  return validateKeybindings(DEFAULT_KEYBINDINGS)
}

let currentKeybindings: KeyBindings = cloneDefaults()

export function loadKeybindings(): KeyBindings {
  const file = getKeybindingsPath()
  try {
    if (!existsSync(file)) {
      currentKeybindings = cloneDefaults()
      logger.info("Keybindings", "Using default keybindings")
      return currentKeybindings
    }

    const data = readFileSync(file, "utf-8")
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch (err) {
      logger.warn("Keybindings", `Corrupt keybindings file at ${file}; using defaults`, err)
      currentKeybindings = cloneDefaults()
      return currentKeybindings
    }

    currentKeybindings = validateKeybindings(parsed)
    logger.info("Keybindings", "Loaded keybindings from file")
  } catch (err) {
    logger.warn("Keybindings", "Failed to read keybindings file; using defaults", err)
    currentKeybindings = cloneDefaults()
  }
  return currentKeybindings
}

/**
 * Atomically write `contents` to `filePath`: write a sibling temp file with
 * `0o600`, then `rename` it over the target. Creates the parent directory when
 * missing. Throws only to the caller; `saveKeybindings` converts that to `false`.
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

/** Persist the given keybindings. Normalised against defaults when loaded. */
export function saveKeybindings(keybindings: KeyBindings): boolean {
  try {
    writeFileAtomic(getKeybindingsPath(), JSON.stringify(keybindings, null, 2))
    currentKeybindings = keybindings
    logger.info("Keybindings", "Saved keybindings to file")
    return true
  } catch (err) {
    logger.warn("Keybindings", "Failed to save keybindings", err)
    return false
  }
}

export function getKeybindings(): KeyBindings {
  return currentKeybindings
}

export function resetKeybindings(): void {
  currentKeybindings = cloneDefaults()
  saveKeybindings(currentKeybindings)
}

/**
 * Match a key event against a binding.
 *
 * Semantics: the key name must match exactly AND every modifier must match
 * exactly — a modifier named in the binding must be present, and every modifier
 * NOT named in the binding must be absent. This prevents a plain key from
 * matching `Ctrl`/`Shift`/`Alt` combinations (and vice versa).
 */
export function matchesKeybinding(
  keyEvent: { name: string; ctrl?: boolean; shift?: boolean; alt?: boolean },
  binding: KeyBinding
): boolean {
  if (!keyEvent || keyEvent.name !== binding.key) return false
  const wantCtrl = binding.ctrl === true
  const wantShift = binding.shift === true
  const wantAlt = binding.alt === true
  return (
    (keyEvent.ctrl === true) === wantCtrl &&
    (keyEvent.shift === true) === wantShift &&
    (keyEvent.alt === true) === wantAlt
  )
}

export function formatKeybinding(binding: KeyBinding): string {
  const parts: string[] = []
  if (binding.ctrl) parts.push("Ctrl")
  if (binding.shift) parts.push("Shift")
  if (binding.alt) parts.push("Alt")

  // Format key name nicely
  let keyName = binding.key
  if (keyName === "return") keyName = "Enter"
  else if (keyName === "escape") keyName = "Esc"
  else if (keyName === "space") keyName = "Space"
  else if (keyName === "backspace") keyName = "Backspace"
  else if (keyName === "delete") keyName = "Del"
  else if (keyName === "insert") keyName = "Ins"
  else if (keyName === "up") keyName = "↑"
  else if (keyName === "down") keyName = "↓"
  else if (keyName === "left") keyName = "←"
  else if (keyName === "right") keyName = "→"
  else keyName = keyName.toUpperCase()

  parts.push(keyName)
  return parts.join("+")
}
