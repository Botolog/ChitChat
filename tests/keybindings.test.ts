import "./setup"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_KEYBINDINGS,
  formatKeybinding,
  getKeybindings,
  loadKeybindings,
  matchesKeybinding,
  resetKeybindings,
  saveKeybindings,
  type KeyBinding,
  type KeyBindings,
} from "../src/keybindings"

let dir: string
let keybindingsPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chitchat-keybindings-"))
  keybindingsPath = join(dir, "keybindings.json")
  process.env.CHITCHAT_KEYBINDINGS_PATH = keybindingsPath
  loadKeybindings()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.CHITCHAT_KEYBINDINGS_PATH
})

type Binding = Pick<KeyBinding, "key" | "ctrl" | "shift" | "alt">
type Event = { name: string; ctrl?: boolean; shift?: boolean; alt?: boolean }

describe("matchesKeybinding", () => {
  const cases: Array<{ title: string; binding: Binding; event: Event; expected: boolean }> = [
    // exact match
    { title: "plain key matches plain key", binding: { key: "?" }, event: { name: "?" }, expected: true },
    { title: "ctrl binding matches ctrl event", binding: { key: "q", ctrl: true }, event: { name: "q", ctrl: true }, expected: true },
    { title: "all modifiers match", binding: { key: "x", ctrl: true, shift: true, alt: true }, event: { name: "x", ctrl: true, shift: true, alt: true }, expected: true },

    // key name
    { title: "different key name does not match", binding: { key: "q", ctrl: true }, event: { name: "w", ctrl: true }, expected: false },
    { title: "case sensitive key names", binding: { key: "q" }, event: { name: "Q" }, expected: false },
    { title: "named key matches", binding: { key: "return" }, event: { name: "return" }, expected: true },

    // missing required modifier
    { title: "plain event misses a required ctrl", binding: { key: "q", ctrl: true }, event: { name: "q" }, expected: false },
    { title: "ctrl+shift event misses required alt", binding: { key: "x", ctrl: true, alt: true }, event: { name: "x", ctrl: true, shift: true }, expected: false },

    // extra modifiers must be absent — this is the C2 fix
    { title: "plain binding rejects a shifted key", binding: { key: "?" }, event: { name: "?", shift: true }, expected: false },
    { title: "ctrl binding rejects an extra shift", binding: { key: "q", ctrl: true }, event: { name: "q", ctrl: true, shift: true }, expected: false },
    { title: "ctrl binding rejects an extra alt", binding: { key: "q", ctrl: true }, event: { name: "q", ctrl: true, alt: true }, expected: false },
    { title: "shift binding rejects an extra ctrl", binding: { key: "tab", shift: true }, event: { name: "tab", ctrl: true, shift: true }, expected: false },

    // explicit false means "must be off"
    { title: "ctrl:false binding rejects a ctrl event", binding: { key: "q", ctrl: false }, event: { name: "q", ctrl: true }, expected: false },
    { title: "ctrl:false binding accepts a plain event", binding: { key: "q", ctrl: false }, event: { name: "q" }, expected: true },
  ]

  for (const { title, binding, event, expected } of cases) {
    test(title, () => {
      expect(matchesKeybinding(event, binding as KeyBinding)).toBe(expected)
    })
  }

  test("undefined event never matches", () => {
    expect(matchesKeybinding(undefined as unknown as Event, DEFAULT_KEYBINDINGS.quit)).toBe(false)
  })

  test("defaults resolve against representative events", () => {
    expect(matchesKeybinding({ name: "q", ctrl: true }, DEFAULT_KEYBINDINGS.quit)).toBe(true)
    expect(matchesKeybinding({ name: "f2" }, DEFAULT_KEYBINDINGS.settings)).toBe(true)
    expect(matchesKeybinding({ name: "?" }, DEFAULT_KEYBINDINGS.help)).toBe(true)
    expect(matchesKeybinding({ name: "space" }, DEFAULT_KEYBINDINGS.jumpToReply)).toBe(true)
    expect(matchesKeybinding({ name: "r" }, DEFAULT_KEYBINDINGS.setReplyReference)).toBe(true)
    expect(matchesKeybinding({ name: "r", ctrl: true }, DEFAULT_KEYBINDINGS.setReplyReference)).toBe(false)
  })
})

describe("formatKeybinding", () => {
  const cases: Array<[Binding, string]> = [
    [{ key: "q", ctrl: true }, "Ctrl+Q"],
    [{ key: "f2" }, "F2"],
    [{ key: "?" }, "?"],
    [{ key: "space" }, "Space"],
    [{ key: "return" }, "Enter"],
    [{ key: "escape" }, "Esc"],
    [{ key: "backspace" }, "Backspace"],
    [{ key: "delete" }, "Del"],
    [{ key: "insert" }, "Ins"],
    [{ key: "up" }, "↑"],
    [{ key: "down" }, "↓"],
    [{ key: "left" }, "←"],
    [{ key: "right" }, "→"],
    [{ key: "a", ctrl: true, shift: true, alt: true }, "Ctrl+Shift+Alt+A"],
  ]
  for (const [binding, expected] of cases) {
    test(`formats ${expected}`, () => {
      expect(formatKeybinding(binding as KeyBinding)).toBe(expected)
    })
  }
})

describe("DEFAULT_KEYBINDINGS", () => {
  test("every entry has a non-empty key and a description", () => {
    for (const [name, binding] of Object.entries(DEFAULT_KEYBINDINGS)) {
      expect(typeof binding.key, name).toBe("string")
      expect(binding.key.length, name).toBeGreaterThan(0)
      expect(typeof binding.description, name).toBe("string")
      expect(binding.description.length, name).toBeGreaterThan(0)
    }
  })

  test("quit is Ctrl+Q and openMedia is Enter", () => {
    expect(formatKeybinding(DEFAULT_KEYBINDINGS.quit)).toBe("Ctrl+Q")
    expect(formatKeybinding(DEFAULT_KEYBINDINGS.openMedia)).toBe("Enter")
  })
})

describe("loadKeybindings / saveKeybindings", () => {
  test("missing file yields the defaults", () => {
    expect(loadKeybindings()).toEqual(DEFAULT_KEYBINDINGS)
  })

  test("round-trips saved keybindings", () => {
    const custom: KeyBindings = {
      ...DEFAULT_KEYBINDINGS,
      quit: { key: "x", ctrl: true, alt: true, description: "custom quit" },
    }
    expect(saveKeybindings(custom)).toBe(true)
    expect(loadKeybindings()).toEqual(custom)
  })

  test("partial persisted payload is validated against defaults", () => {
    writeFileSync(
      keybindingsPath,
      JSON.stringify({ quit: { key: "z", ctrl: true }, bogusBinding: { key: "j" } }),
      "utf-8",
    )
    const loaded = loadKeybindings()
    expect(loaded.quit).toEqual({ key: "z", ctrl: true, description: DEFAULT_KEYBINDINGS.quit.description })
    expect("bogusBinding" in loaded).toBe(false)
    expect(loaded.settings).toEqual(DEFAULT_KEYBINDINGS.settings)
  })

  test("modifiers are only trusted when explicitly true", () => {
    writeFileSync(
      keybindingsPath,
      JSON.stringify({ quit: { key: "q", ctrl: false, shift: "yes", alt: 1 } }),
      "utf-8",
    )
    expect(loadKeybindings().quit).toEqual({ key: "q", description: DEFAULT_KEYBINDINGS.quit.description })
  })

  test("wrong-typed binding falls back to the default", () => {
    writeFileSync(keybindingsPath, JSON.stringify({ quit: "nope", settings: [] }), "utf-8")
    expect(loadKeybindings().quit).toEqual(DEFAULT_KEYBINDINGS.quit)
    expect(loadKeybindings().settings).toEqual(DEFAULT_KEYBINDINGS.settings)
  })

  test("empty key string falls back to the default key", () => {
    writeFileSync(keybindingsPath, JSON.stringify({ quit: { key: "" } }), "utf-8")
    expect(loadKeybindings().quit.key).toBe(DEFAULT_KEYBINDINGS.quit.key)
  })

  test("corrupt JSON falls back to defaults without throwing", () => {
    writeFileSync(keybindingsPath, "{ not json", "utf-8")
    expect(() => loadKeybindings()).not.toThrow()
    expect(getKeybindings()).toEqual(DEFAULT_KEYBINDINGS)
  })

  test("resetKeybindings restores and persists the defaults", () => {
    saveKeybindings({ ...DEFAULT_KEYBINDINGS, quit: { key: "x", description: "x" } })
    resetKeybindings()
    expect(getKeybindings()).toEqual(DEFAULT_KEYBINDINGS)
    expect(JSON.parse(readFileSync(keybindingsPath, "utf-8")).quit).toEqual(DEFAULT_KEYBINDINGS.quit)
  })
})
