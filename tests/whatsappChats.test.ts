import { describe, expect, test } from "bun:test"
import { createContext, runInContext } from "node:vm"
import { collectWhatsAppChats, type CollectChatsResult } from "../src/utils/whatsappChats"

/**
 * Loopback for the page function: the fake window object *is* the sandbox
 * global, so `globalThis.require(...)` inside `collectWhatsAppChats` resolves to
 * these fakes.
 */
interface FakePage {
  chats?: unknown[]
  /** Stand-in for `window.WWebJS.getChatModel`; omit to simulate a build without it. */
  getChatModel?: (chat: unknown) => unknown
  /** Stand-in for `window.require("WAWebCollections").Msg.get`. */
  messages?: Record<string, unknown>
  /** Make `window.require` throw, as it does before the app has booted. */
  requireThrows?: string
}

/**
 * Run the page function the same way Puppeteer does — as source in a fresh
 * context. Anything it closes over from module scope would be missing here, so
 * this doubles as the self-containment check (the function is serialised with
 * `toString()` and evaluated in the browser).
 */
async function collect(page: FakePage): Promise<CollectChatsResult> {
  const sandbox: Record<string, unknown> = {
    require(moduleName: string) {
      if (page.requireThrows) throw new Error(page.requireThrows)
      if (moduleName !== "WAWebCollections") throw new Error(`unknown module ${moduleName}`)
      return {
        Chat: { getModelsArray: () => page.chats ?? [] },
        Msg: { get: (id: string) => page.messages?.[id] },
      }
    },
  }
  if (page.getChatModel) {
    sandbox.WWebJS = { getChatModel: page.getChatModel }
  }
  const context = createContext(sandbox)
  return (await runInContext(`(${collectWhatsAppChats})()`, context)) as CollectChatsResult
}

describe("collectWhatsAppChats", () => {
  test("maps chats from the collection without WhatsApp's own mapper", async () => {
    const result = await collect({
      chats: [
        {
          id: { _serialized: "111@s.whatsapp.net" },
          formattedTitle: "Ada",
          unreadCount: 3,
          pin: true,
          t: 1700,
          lastReceivedKey: { _serialized: "M1" },
        },
        {
          id: { _serialized: "222@g.us" },
          name: "Team",
          groupMetadata: { participants: [{}, {}, {}] },
          mute: { expiration: 1893456000 },
          archive: true,
          t: 1699,
        },
      ],
      messages: { M1: { body: "later", t: 1700, id: { fromMe: true } } },
    })

    expect(result.collectionError).toBeNull()
    expect(result.skipped).toBe(0)
    expect(result.total).toBe(2)
    expect(result.chats).toEqual([
      {
        id: "111@s.whatsapp.net",
        name: "Ada",
        isGroup: false,
        unreadCount: 3,
        archived: false,
        pinned: true,
        isMuted: false,
        muteExpiration: 0,
        t: 1700,
        participantCount: 0,
        lastMessage: { body: "later", timestamp: 1700, fromMe: true },
      },
      {
        id: "222@g.us",
        name: "Team",
        // No `isGroup` field in this build: group metadata and the @g.us id tag
        // a chat as a group on their own.
        isGroup: true,
        unreadCount: 0,
        archived: true,
        pinned: false,
        isMuted: true,
        muteExpiration: 1893456000,
        t: 1699,
        participantCount: 3,
        lastMessage: undefined,
      },
    ])
  })

  test("keeps every chat when WhatsApp's mapper rejects some of them", async () => {
    const first = { id: { _serialized: "111@s.whatsapp.net" }, formattedTitle: "Ada" }
    const second = { id: { _serialized: "222@g.us" }, formattedTitle: "Team" }
    const result = await collect({
      chats: [first, second],
      getChatModel: (chat: unknown) => {
        if (chat === first) throw new Error("serialize is not a function")
        return { id: "222@g.us", formattedTitle: "Team", isGroup: true }
      },
    })

    // The whole point of this module: one bad chat (upstream's `Promise.all`
    // rejects the entire list) must not hide the others.
    expect(result.chats.map((chat) => chat.id)).toEqual(["111@s.whatsapp.net", "222@g.us"])
    expect(result.recovered).toBe(1)
    expect(result.skipped).toBe(0)
    expect(result.firstError).toBe("Error: serialize is not a function")
  })

  test("prefers WhatsApp's own mapping when it works", async () => {
    const result = await collect({
      chats: [{ id: { _serialized: "111@s.whatsapp.net" }, formattedTitle: "Ada" }],
      getChatModel: () => ({ id: "111@s.whatsapp.net", name: "Ada from library" }),
    })

    expect(result.chats).toEqual([{ id: "111@s.whatsapp.net", name: "Ada from library" }])
    expect(result.recovered).toBe(0)
  })

  test("accepts the $1 serialized-id rename for message keys", async () => {
    const result = await collect({
      chats: [
        {
          id: { $1: "333@s.whatsapp.net" },
          contact: { pushname: "Grace" },
          lastReceivedKey: { $1: "M9" },
        },
      ],
      messages: { M9: { body: "renamed keys", t: 42, id: { fromMe: false } } },
    })

    expect(result.chats[0]?.id).toBe("333@s.whatsapp.net")
    expect(result.chats[0]?.name).toBe("Grace")
    expect(result.chats[0]?.lastMessage).toEqual({
      body: "renamed keys",
      timestamp: 42,
      fromMe: false,
    })
  })

  test("survives throwing getters and a missing message preview", async () => {
    const chat: Record<string, unknown> = { id: { _serialized: "444@s.whatsapp.net" } }
    for (const field of ["formattedTitle", "unreadCount", "t", "groupMetadata"]) {
      Object.defineProperty(chat, field, {
        enumerable: true,
        get() {
          throw new Error(`${field} exploded`)
        },
      })
    }
    // `Msg.get` itself blowing up must not cost us the chat either.
    const result = await collect({
      chats: [chat],
      messages: {},
      getChatModel: undefined,
    })

    expect(result.chats).toEqual([
      {
        id: "444@s.whatsapp.net",
        // Falls back to the id when no title can be read.
        name: "444@s.whatsapp.net",
        isGroup: false,
        unreadCount: 0,
        archived: false,
        pinned: false,
        isMuted: false,
        muteExpiration: 0,
        t: 0,
        participantCount: 0,
        lastMessage: undefined,
      },
    ])
  })

  test("skips chats that carry no usable id", async () => {
    const result = await collect({
      chats: [{ formattedTitle: "no id" }, { id: {}, formattedTitle: "empty id" }],
    })

    expect(result.chats).toEqual([])
    expect(result.total).toBe(2)
    expect(result.skipped).toBe(2)
  })

  test("reports an unreachable collection instead of throwing", async () => {
    const result = await collect({ requireThrows: "Module WAWebCollections not found" })

    expect(result.chats).toEqual([])
    expect(result.collectionError).toBe("Error: Module WAWebCollections not found")
  })
})
