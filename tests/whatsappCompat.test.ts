import { describe, expect, test } from "bun:test"
import { createContext, runInContext } from "node:vm"
import {
  installWhatsAppCompat,
  type WhatsAppCompatReport,
} from "../src/utils/whatsappCompat"

/**
 * A stand-in for `window.WWebJS` plus the modules `globalThis.require` should
 * resolve, i.e. just enough page for the compatibility layer to patch.
 */
interface FakePage {
  WWebJS?: Record<string, any>
  modules?: Record<string, unknown>
}

/**
 * Run `installWhatsAppCompat` the way Puppeteer does — serialized to source and
 * evaluated in a fresh context. Anything it closes over from module scope would
 * be missing here, so this doubles as the self-containment check.
 *
 * `install` can be called repeatedly on one page: that is what the service does
 * (once per readiness path), and it reuses the page's global object.
 */
function createPage(page: FakePage): { install: () => WhatsAppCompatReport } {
  const sandbox: Record<string, unknown> = {
    require(moduleName: string) {
      const module = page.modules?.[moduleName]
      if (!module) throw new Error(`Module ${moduleName} not found`)
      return module
    },
  }
  if (page.WWebJS) sandbox.WWebJS = page.WWebJS
  const context = createContext(sandbox)
  return {
    install: () =>
      runInContext(`(${installWhatsAppCompat})()`, context) as WhatsAppCompatReport,
  }
}

function install(page: FakePage): WhatsAppCompatReport {
  return createPage(page).install()
}

/** `window.WWebJS` before whatsapp-web.js has injected itself. */
describe("installWhatsAppCompat", () => {
  test("does nothing when window.WWebJS is not there yet", () => {
    const report = install({})

    expect(report.available).toBe(false)
    expect(report.patches).toEqual([])
    expect(report.firstError).toBeNull()
  })

  test("leaves a healthy build alone and passes every value through", async () => {
    const chatModel = { id: "111@s.whatsapp.net", name: "Ada" }
    const WWebJS: Record<string, any> = {
      getMessageModel: (message: any) => ({ id: message.id, body: message.body }),
      getChatModel: async () => chatModel,
      getChats: async () => [chatModel],
    }
    const report = install({ WWebJS })

    expect(report.available).toBe(true)
    expect(report.patches).toEqual([
      "getMsgKeyId",
      "getMessageModel",
      "getChatModel",
      "getChats",
    ])
    expect(report.messageModelFallbacks).toBe(0)
    expect(report.chatModelFallbacks).toBe(0)

    // Unaffected builds keep behaving exactly as before.
    expect(WWebJS.getMessageModel({ id: { _serialized: "M1" }, body: "hi" })).toEqual({
      id: { _serialized: "M1" },
      body: "hi",
    })
    expect(await WWebJS.getChatModel({})).toBe(chatModel)
    expect(await WWebJS.getChats()).toEqual([chatModel])
  })

  test("adds getMsgKeyId only when the library does not have it", () => {
    const custom = (key: any) => `custom:${key._serialized}`
    const report = install({ WWebJS: { getMsgKeyId: custom } })

    expect(report.patches).not.toContain("getMsgKeyId")
  })

  test("getMsgKeyId reads either spelling of a serialized key", () => {
    const WWebJS: Record<string, any> = {}
    install({ WWebJS })

    expect(WWebJS.getMsgKeyId?.({ _serialized: "false_1@s.whatsapp.net_AB" })).toBe(
      "false_1@s.whatsapp.net_AB",
    )
    expect(WWebJS.getMsgKeyId?.({ $1: "false_1@s.whatsapp.net_CD" })).toBe("false_1@s.whatsapp.net_CD")
    expect(WWebJS.getMsgKeyId?.("plain")).toBe("plain")
    expect(WWebJS.getMsgKeyId?.(undefined)).toBeUndefined()
  })

  test("restores `_serialized` on the message-key class and on serialized ids", () => {
    // The rename lives on the key class, so the alias has to be installed there
    // — but serialized models hand out plain objects, which need their own copy.
    class MessageKey {
      [field: string]: any
      constructor(serialized: string) {
        this.$1 = serialized
      }
    }
    const WWebJS: Record<string, any> = {
      getMessageModel: (message: any) => ({ id: message.id, body: message.body }),
    }
    const report = install({ WWebJS })

    const key = new MessageKey("false_1@s.whatsapp.net_AB")
    const model = WWebJS.getMessageModel({ id: key, body: "hi" })

    expect(report.patches).toContain("messageKey._serialized")
    expect(key._serialized).toBe("false_1@s.whatsapp.net_AB")
    // New keys are covered through the prototype…
    expect(new MessageKey("false_2@s.whatsapp.net_CD")._serialized).toBe("false_2@s.whatsapp.net_CD")
    // …but `Object.prototype` is never touched.
    expect(({} as Record<string, unknown>)._serialized).toBeUndefined()

    const plain = WWebJS.getMessageModel({ id: { $1: "false_3@s.whatsapp.net_EF" }, body: "" })
    expect(plain.id._serialized).toBe("false_3@s.whatsapp.net_EF")
  })

  test("maps a message WhatsApp cannot serialize instead of failing the listing", () => {
    const raw = {
      id: { $1: "false_2@s.whatsapp.net_CD", fromMe: false },
      body: "boom",
      type: "image",
      t: 7,
      ack: 1,
      directPath: "/v/t",
      mimetype: "image/jpeg",
      filename: "a.jpg",
      size: 12,
      star: true,
      isForwarded: true,
      forwardingScore: 3,
      quotedStanzaID: "Q1",
    }
    const WWebJS: Record<string, any> = {
      getMessageModel: () => {
        throw new Error("r: r")
      },
    }
    const report = install({ WWebJS })

    const model = WWebJS.getMessageModel(raw)

    expect(model.id._serialized).toBe("false_2@s.whatsapp.net_CD")
    expect(model.body).toBe("boom")
    expect(model.type).toBe("image")
    expect(model.t).toBe(7)
    expect(model.star).toBe(true)
    expect(model.directPath).toBe("/v/t")
    expect(model.quotedStanzaID).toBe("Q1")
    expect(report.messageModelFallbacks).toBe(1)
    expect(report.firstError).toBe("Error: r: r")
  })

  test("aliases the last-message key before WhatsApp's own chat mapping runs", async () => {
    // The library maps chats by looking the last message up with
    // `chat.lastReceivedKey._serialized`. On current builds that key carries
    // `$1`, so without the alias the lookup runs with an undefined key.
    class MessageKey {
      [field: string]: any
      constructor(serialized: string) {
        this.$1 = serialized
      }
    }
    const chat = {
      id: { _serialized: "111@s.whatsapp.net" },
      lastReceivedKey: new MessageKey("false_1@s.whatsapp.net_AB"),
    }
    const WWebJS: Record<string, any> = {
      getChatModel: async (target: any) => ({
        id: "111@s.whatsapp.net",
        lastMessage: target.lastReceivedKey._serialized,
      }),
    }
    const report = install({ WWebJS })

    const model = await WWebJS.getChatModel(chat)

    expect(model.lastMessage).toBe("false_1@s.whatsapp.net_AB")
    expect(report.chatModelFallbacks).toBe(0)
  })

  test("maps a chat WhatsApp cannot serialize, keeping its id an object", async () => {
    const WWebJS: Record<string, any> = {
      getChatModel: async () => {
        throw new Error("r: r")
      },
    }
    const report = install({ WWebJS })

    const model = await WWebJS.getChatModel({
      id: { _serialized: "222@g.us" },
      formattedTitle: "Team",
      unreadCount: 4,
      t: 9,
      archive: true,
      pin: true,
      mute: { expiration: 1893456000 },
      groupMetadata: { participants: [{}, {}] },
    })

    // A plain string id would make `chat.sendMessage()` send to `undefined`.
    expect(model.id).toEqual({ _serialized: "222@g.us" })
    expect(model.name).toBe("Team")
    expect(model.isGroup).toBe(true)
    expect(model.unreadCount).toBe(4)
    expect(model.archive).toBe(true)
    expect(model.pin).toBe(true)
    expect(model.isMuted).toBe(true)
    expect(model.muteExpiration).toBe(1893456000)
    expect(model.lastMessage).toBeNull()
    expect(report.chatModelFallbacks).toBe(1)
  })

  test("returns no chat at all when the chat itself is missing", async () => {
    const WWebJS: Record<string, any> = { getChatModel: async () => null }
    install({ WWebJS })

    expect(await WWebJS.getChatModel(undefined)).toBeNull()
  })

  test("keeps the chats that map when getChats fails as a whole", async () => {
    const good = { id: { _serialized: "111@s.whatsapp.net" }, formattedTitle: "Ada" }
    const bad = { id: { _serialized: "222@g.us" }, formattedTitle: "Team" }
    const WWebJS: Record<string, any> = {
      getChats: async () => {
        throw new Error("one chat rejected the whole list")
      },
      getChatModel: async (chat: any) => {
        if (chat === bad) throw new Error("r: r")
        return { id: "111@s.whatsapp.net", name: "Ada", isGroup: false }
      },
    }
    const report = install({
      WWebJS,
      modules: { WAWebCollections: { Chat: { getModelsArray: () => [good, bad] } } },
    })

    const chats = await WWebJS.getChats()

    expect(chats.map((chat: any) => chat.id)).toEqual([
      "111@s.whatsapp.net",
      { _serialized: "222@g.us" },
    ])
    expect(report.chatModelFallbacks).toBe(1)
  })

  test("is idempotent: installing twice keeps one set of wrappers", () => {
    const WWebJS: Record<string, any> = {
      getMessageModel: () => {
        throw new Error("r: r")
      },
    }
    const page = createPage({ WWebJS })
    const first = page.install()
    const wrapper = WWebJS.getMessageModel
    const second = page.install()

    expect(second.alreadyInstalled).toBe(true)
    expect(WWebJS.getMessageModel).toBe(wrapper)
    expect(second.patches).toEqual(first.patches)

    WWebJS.getMessageModel({ id: { $1: "false_1@s.whatsapp.net_AB" } })
    expect(second.messageModelFallbacks).toBe(1)
  })
})
