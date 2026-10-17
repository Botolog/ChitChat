import { describe, expect, test } from "bun:test"
import { NO_CAPABILITIES, type ServiceCapabilities } from "../src/services/capabilities"

describe("NO_CAPABILITIES", () => {
  test("declares no optional features", () => {
    const expected: ServiceCapabilities = {
      qrAuth: false,
      deleteMessage: "none",
      editMessage: false,
      pin: false,
      mute: false,
      archive: false,
      downloadMedia: false,
      reply: false,
    }
    expect(NO_CAPABILITIES).toEqual(expected)
  })

  test("exposes exactly the documented keys", () => {
    expect(Object.keys(NO_CAPABILITIES).sort()).toEqual(
      ["archive", "deleteMessage", "downloadMedia", "editMessage", "mute", "pin", "qrAuth", "reply"],
    )
  })

  test("every boolean capability is false and deletion is disabled", () => {
    for (const [key, value] of Object.entries(NO_CAPABILITIES)) {
      if (key === "deleteMessage") expect(value).toBe("none")
      else expect(value, key).toBe(false)
    }
  })
})
