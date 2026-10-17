import { afterEach, describe, expect, test } from "bun:test"
import { clearWhatsAppTabState, TAB_COORDINATION_KEYS } from "../src/utils/whatsappTabState"

/**
 * Fake `Storage` that records removals, so the test can assert exactly which
 * keys WhatsApp's tab mutex logic depends on get cleared.
 */
function fakeStorage(initial: Record<string, string>) {
  const data = new Map(Object.entries(initial))
  const removed: string[] = []
  return {
    removed,
    keysLeft: () => [...data.keys()],
    removeItem(key: string) {
      removed.push(key)
      data.delete(key)
    },
  }
}

const globals = globalThis as unknown as {
  localStorage?: unknown
  sessionStorage?: unknown
}

afterEach(() => {
  delete globals.localStorage
  delete globals.sessionStorage
})

describe("clearWhatsAppTabState", () => {
  test("clears every tab-coordination key from both stores", () => {
    const local = fakeStorage({
      "whatsapp-mutex": '"x123:init_1700000000000"',
      "no-takeover": "true",
      "local-takeover-ok": '{"wa_tab_src":"x123"}',
      // Unrelated storage must survive: it is not part of the mutex handshake.
      Session: "keep-me",
      "WAUnknownID": "keep-me-too",
    })
    const session = fakeStorage({ "whatsapp-mutex": "x123:ping0.5" })
    globals.localStorage = local
    globals.sessionStorage = session

    clearWhatsAppTabState()

    expect(local.keysLeft().sort()).toEqual(["Session", "WAUnknownID"])
    expect(session.keysLeft()).toEqual([])
    // Both stores are swept, so a key found in either one never survives.
    expect(local.removed).toEqual([...TAB_COORDINATION_KEYS])
    expect(session.removed).toEqual([...TAB_COORDINATION_KEYS])
  })

  test("is a no-op when web storage is unavailable", () => {
    delete globals.localStorage
    delete globals.sessionStorage
    expect(() => clearWhatsAppTabState()).not.toThrow()
  })

  test("swallows storage errors", () => {
    globals.localStorage = {
      removeItem() {
        throw new Error("storage disabled")
      },
    }
    globals.sessionStorage = {
      removeItem() {
        throw new Error("storage disabled")
      },
    }
    expect(() => clearWhatsAppTabState()).not.toThrow()
  })

  test("documents the same key list it clears at runtime", () => {
    // The page function is serialised into the browser and therefore cannot
    // reference TAB_COORDINATION_KEYS; if the two lists drift apart, stale keys
    // survive and the window can hang on "WhatsApp is open in another window".
    const source = clearWhatsAppTabState.toString()
    for (const key of TAB_COORDINATION_KEYS) {
      expect(source).toContain(`"${key}"`)
    }
  })
})
