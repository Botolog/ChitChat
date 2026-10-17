import "./setup"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_SETTINGS,
  getNestedSetting,
  getSettings,
  loadSettings,
  saveSettings,
  setNestedSetting,
  updateSetting,
  validateSettings,
  type AppSettings,
} from "../src/settings"

let dir: string
let settingsPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chitchat-settings-"))
  settingsPath = join(dir, "settings.json")
  process.env.CHITCHAT_SETTINGS_PATH = settingsPath
  loadSettings() // reset module state to defaults
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.CHITCHAT_SETTINGS_PATH
})

describe("validateSettings", () => {
  test("non-object payloads yield a fresh copy of the defaults", () => {
    for (const raw of [null, 42, "nope", true, [], undefined]) {
      const result = validateSettings(raw)
      expect(result).toEqual(DEFAULT_SETTINGS)
    }
  })

  test("result is not aliased to DEFAULT_SETTINGS", () => {
    const result = validateSettings({})
    result.whatsapp.autoMarkAsRead = false
    result.mutedChats.push("x")
    expect(DEFAULT_SETTINGS.whatsapp.autoMarkAsRead).toBe(true)
    expect(DEFAULT_SETTINGS.mutedChats).toEqual([])
  })

  test("deep-merges nested objects (shallow merge would drop siblings)", () => {
    const result = validateSettings({
      whatsapp: { autoMarkAsRead: false },
      slack: { showThreads: false },
    })
    expect(result.whatsapp).toEqual({
      autoMarkAsRead: false,
      deleteOldMessages: DEFAULT_SETTINGS.whatsapp.deleteOldMessages,
      deleteOlderThan: DEFAULT_SETTINGS.whatsapp.deleteOlderThan,
    })
    expect(result.slack).toEqual({
      showThreads: false,
      autoExpandThreads: DEFAULT_SETTINGS.slack.autoExpandThreads,
    })
  })

  test("deep-merge preserves top-level siblings too", () => {
    const result = validateSettings({ theme: "light" })
    expect(result.theme).toBe("light")
    expect(result.fontSize).toBe(DEFAULT_SETTINGS.fontSize)
    expect(result.logLevel).toBe(DEFAULT_SETTINGS.logLevel)
  })

  test("drops unknown keys, including unknown nested keys", () => {
    const result = validateSettings({
      notARealSetting: true,
      whatsapp: { alsoNotReal: 1, autoMarkAsRead: false },
    } as unknown)
    expect("notARealSetting" in result).toBe(false)
    expect("alsoNotReal" in (result.whatsapp as unknown as Record<string, unknown>)).toBe(false)
    expect(result.whatsapp.autoMarkAsRead).toBe(false)
  })

  test("enum values outside the allowed set fall back to the default", () => {
    const result = validateSettings({
      theme: "neon",
      fontSize: "gigantic",
      autoDownloadMedia: "sometimes",
      mediaQuality: "ultra",
      mediaDisplayMode: "hologram",
      logLevel: "trace",
    })
    expect(result.theme).toBe("dark")
    expect(result.fontSize).toBe("medium")
    expect(result.autoDownloadMedia).toBe("wifi")
    expect(result.mediaQuality).toBe("medium")
    expect(result.mediaDisplayMode).toBe("auto")
    expect(result.logLevel).toBe("info")
  })

  test("valid enum values are accepted", () => {
    const result = validateSettings({
      theme: "light",
      fontSize: "large",
      mediaDisplayMode: "kitty",
      logLevel: "debug",
    })
    expect(result.theme).toBe("light")
    expect(result.fontSize).toBe("large")
    expect(result.mediaDisplayMode).toBe("kitty")
    expect(result.logLevel).toBe("debug")
  })

  test("numeric ranges clamp out-of-range values back to defaults", () => {
    const result = validateSettings({
      maxThumbnailSize: 0,
      connectionTimeout: 5,
      mouseScrollSpeed: 99,
      whatsapp: { deleteOlderThan: 1000 },
    })
    expect(result.maxThumbnailSize).toBe(DEFAULT_SETTINGS.maxThumbnailSize)
    expect(result.connectionTimeout).toBe(DEFAULT_SETTINGS.connectionTimeout)
    expect(result.mouseScrollSpeed).toBe(DEFAULT_SETTINGS.mouseScrollSpeed)
    expect(result.whatsapp.deleteOlderThan).toBe(DEFAULT_SETTINGS.whatsapp.deleteOlderThan)
  })

  test("in-range numbers and finite bounds are accepted", () => {
    const result = validateSettings({
      maxThumbnailSize: 512,
      connectionTimeout: 300,
      mouseScrollSpeed: 1,
      whatsapp: { deleteOlderThan: 1 },
    })
    expect(result.maxThumbnailSize).toBe(512)
    expect(result.connectionTimeout).toBe(300)
    expect(result.mouseScrollSpeed).toBe(1)
    expect(result.whatsapp.deleteOlderThan).toBe(1)
  })

  test("non-finite numbers fall back to defaults", () => {
    const result = validateSettings({
      maxThumbnailSize: Number.NaN,
      connectionTimeout: Number.POSITIVE_INFINITY,
    } as unknown)
    expect(result.maxThumbnailSize).toBe(DEFAULT_SETTINGS.maxThumbnailSize)
    expect(result.connectionTimeout).toBe(DEFAULT_SETTINGS.connectionTimeout)
  })

  test("wrong-typed fields fall back per field", () => {
    const result = validateSettings({
      showAvatars: "yes",
      compactMode: 1,
      theme: 3,
      developerMode: null,
    } as unknown)
    expect(result.showAvatars).toBe(true)
    expect(result.compactMode).toBe(false)
    expect(result.theme).toBe("dark")
    expect(result.developerMode).toBe(false)
  })

  test("mutedChats keeps only string entries", () => {
    const result = validateSettings({ mutedChats: ["a", 1, null, "b", {}, true] } as unknown)
    expect(result.mutedChats).toEqual(["a", "b"])
  })

  test("mutedChats falls back to default when not an array", () => {
    const result = validateSettings({ mutedChats: "nope" } as unknown)
    expect(result.mutedChats).toEqual([])
  })

  test("rejects __proto__ / constructor / prototype pollution", () => {
    const polluted = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}}}',
    )
    const result = validateSettings(polluted)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect((result as unknown as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty("polluted")
    // The hostile keys are simply not part of the rebuilt object.
    expect(Object.keys(result)).not.toContain("__proto__")
    expect(Object.keys(result)).not.toContain("constructor")
  })
})

describe("loadSettings / saveSettings", () => {
  test("missing file yields defaults", () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  test("round-trips a saved settings object", () => {
    const custom: AppSettings = {
      ...DEFAULT_SETTINGS,
      theme: "light",
      mutedChats: ["+1"],
      whatsapp: { ...DEFAULT_SETTINGS.whatsapp, autoMarkAsRead: false },
    }
    expect(saveSettings(custom)).toBe(true)
    expect(loadSettings()).toEqual(custom)
  })

  test("persisted file is valid JSON with a trailing newline-free pretty body", () => {
    saveSettings({ ...DEFAULT_SETTINGS, fontSize: "large" })
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"))
    expect(parsed.fontSize).toBe("large")
  })

  test("corrupt JSON falls back to defaults without throwing", () => {
    writeFileSync(settingsPath, "{ not json", "utf-8")
    expect(() => loadSettings()).not.toThrow()
    expect(getSettings()).toEqual(DEFAULT_SETTINGS)
  })

  test("partially invalid persisted settings are validated on load", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ theme: "bogus", connectionTimeout: 99999, extra: 1 }),
      "utf-8",
    )
    const loaded = loadSettings()
    expect(loaded.theme).toBe("dark")
    expect(loaded.connectionTimeout).toBe(DEFAULT_SETTINGS.connectionTimeout)
    expect("extra" in loaded).toBe(false)
  })

  test("saveSettings creates missing parent directories", () => {
    const nested = join(dir, "a", "b", "settings.json")
    process.env.CHITCHAT_SETTINGS_PATH = nested
    expect(saveSettings({ ...DEFAULT_SETTINGS, theme: "light" })).toBe(true)
    expect(JSON.parse(readFileSync(nested, "utf-8")).theme).toBe("light")
  })
})

describe("updateSetting / nested access", () => {
  test("updateSetting mutates state and persists", () => {
    updateSetting("compactMode", true)
    expect(getSettings().compactMode).toBe(true)
    expect(JSON.parse(readFileSync(settingsPath, "utf-8")).compactMode).toBe(true)
  })

  test("getNestedSetting reads arbitrary depth", () => {
    expect(getNestedSetting("whatsapp.autoMarkAsRead")).toBe(true)
    expect(getNestedSetting("slack.autoExpandThreads")).toBe(false)
    expect(getNestedSetting("")).toBe(getSettings())
  })

  test("getNestedSetting returns undefined for missing or unsafe paths", () => {
    expect(getNestedSetting("whatsapp.nope")).toBeUndefined()
    expect(getNestedSetting("a.b.c.d")).toBeUndefined()
    expect(getNestedSetting("__proto__")).toBeUndefined()
    expect(getNestedSetting("whatsapp.__proto__.polluted")).toBeUndefined()
    expect(getNestedSetting("constructor.prototype")).toBeUndefined()
  })

  test("setNestedSetting writes an existing depth-2 path and persists", () => {
    setNestedSetting("whatsapp.deleteOldMessages", true)
    expect(getSettings().whatsapp.deleteOldMessages).toBe(true)
    expect(JSON.parse(readFileSync(settingsPath, "utf-8")).whatsapp.deleteOldMessages).toBe(true)
  })

  test("setNestedSetting creates intermediate objects beyond depth 2 (C4)", () => {
    setNestedSetting("a.b.c", 42)
    const root = getSettings() as unknown as Record<string, unknown>
    expect((root.a as Record<string, unknown>).b).toEqual({ c: 42 })
    expect(getNestedSetting("a.b.c")).toBe(42)
  })

  test("setNestedSetting replaces a primitive intermediate with an object", () => {
    setNestedSetting("theme.sub", "x")
    const root = getSettings() as unknown as Record<string, unknown>
    expect(root.theme).toEqual({ sub: "x" })
  })

  test("setNestedSetting refuses prototype-polluting paths", () => {
    setNestedSetting("__proto__.polluted", true)
    setNestedSetting("constructor.prototype.polluted", true)
    setNestedSetting("a.__proto__.b", true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(getNestedSetting("a")).toBeUndefined()
  })

  test("setNestedSetting on an empty path is a no-op", () => {
    saveSettings(getSettings())
    const before = readFileSync(settingsPath, "utf-8")
    setNestedSetting("", 1)
    expect(readFileSync(settingsPath, "utf-8")).toBe(before)
  })
})

describe("DEFAULT_SETTINGS shape", () => {
  test("carries the documented defaults", () => {
    expect(DEFAULT_SETTINGS.theme).toBe("dark")
    expect(DEFAULT_SETTINGS.mediaDisplayMode).toBe("auto")
    expect(DEFAULT_SETTINGS.connectionTimeout).toBe(60)
    expect(DEFAULT_SETTINGS.whatsapp).toEqual({
      autoMarkAsRead: true,
      deleteOldMessages: false,
      deleteOlderThan: 30,
    })
    expect(DEFAULT_SETTINGS.slack).toEqual({
      showThreads: true,
      autoExpandThreads: false,
    })
  })
})
