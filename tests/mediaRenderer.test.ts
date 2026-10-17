import "./setup"
import { describe, expect, test } from "bun:test"
import type { MediaAttachment } from "../src/services/types"
import {
  MediaRenderer,
  detectImageFormat,
  encodeKittyBase64,
  encodeKittyFile,
  normalizeSixel,
} from "../src/utils/mediaRenderer"

function attachment(overrides: Partial<MediaAttachment> = {}): MediaAttachment {
  return {
    type: "image",
    mimetype: "image/png",
    filename: "photo.png",
    filesize: 2048,
    messageId: "msg-1",
    ...overrides,
  }
}

describe("MediaRenderer.getMediaIcon", () => {
  const cases: Array<[string, string]> = [
    ["image", "📷"],
    ["video", "🎥"],
    ["audio", "🎵"],
    ["document", "📎"],
    ["sticker", "🎨"],
    ["unknown", "📎"],
    ["", "📎"],
  ]
  for (const [kind, icon] of cases) {
    test(`${JSON.stringify(kind)} -> ${icon}`, () => {
      expect(new MediaRenderer("indicator").getMediaIcon(kind)).toBe(icon)
    })
  }
})

describe("MediaRenderer.formatFileSize", () => {
  const cases: Array<[number | undefined, string]> = [
    [undefined, "unknown size"],
    [0, "unknown size"],
    [512, "512 B"],
    [2048, "2.0 KB"],
    [1024 * 1024, "1.0 MB"],
    [5 * 1024 * 1024, "5.0 MB"],
  ]
  for (const [bytes, expected] of cases) {
    test(`${bytes} -> ${expected}`, () => {
      expect(new MediaRenderer("indicator").formatFileSize(bytes)).toBe(expected)
    })
  }
})

describe("MediaRenderer display mode plumbing", () => {
  test("getDisplayMode/setDisplayMode round-trip", () => {
    const renderer = new MediaRenderer("indicator")
    expect(renderer.getDisplayMode()).toBe("indicator")
    renderer.setDisplayMode("kitty")
    expect(renderer.getDisplayMode()).toBe("kitty")
  })

  test("renderMediaIndicator builds a single descriptive line", async () => {
    const lines = await new MediaRenderer("indicator").renderMediaIndicator(attachment())
    expect(lines).toEqual(["📷 photo.png (2.0 KB) ['space' to open]"])
  })

  test("indicator falls back to a derived filename when none is given", async () => {
    const lines = await new MediaRenderer("indicator").renderMediaIndicator(
      attachment({ filename: "", type: "video", mimetype: "video/mp4", filesize: 1024 }),
    )
    expect(lines[0]).toBe("🎥 video.mp4 (1.0 KB) ['space' to open]")
  })

  test("non-image media degrades to the indicator in every rich mode", async () => {
    const renderer = new MediaRenderer("ascii")
    const media = attachment({ type: "video" })
    expect(await renderer.renderASCIIThumbnail(media)).toEqual(await renderer.renderMediaIndicator(media))
    expect(await renderer.renderKittyImage(media)).toEqual(await renderer.renderMediaIndicator(media))
    expect(await renderer.renderITerm2Image(media)).toEqual(await renderer.renderMediaIndicator(media))
    expect(await renderer.renderSixelImage(media)).toEqual(await renderer.renderMediaIndicator(media))
  })

  test("render() in indicator mode returns the indicator line", async () => {
    const renderer = new MediaRenderer("indicator")
    const media = attachment()
    expect(await renderer.render(media)).toEqual(await renderer.renderMediaIndicator(media))
  })

  test("uncached image degrades instead of throwing in rich modes", async () => {
    const renderer = new MediaRenderer("kitty")
    const media = attachment({ messageId: "definitely-not-cached" })
    const lines = await renderer.renderKittyImage(media)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.join("\n")).toContain("photo.png")
  })
})

describe("detectImageFormat", () => {
  test("detects PNG / JPEG / GIF / WEBP / BMP magic bytes", () => {
    expect(detectImageFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("png")
    expect(detectImageFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg")
    expect(detectImageFormat(Buffer.from("GIF89a"))).toBe("gif")
    const webp = Buffer.alloc(12)
    webp.write("RIFF", 0, "ascii")
    webp.write("WEBP", 8, "ascii")
    expect(detectImageFormat(webp)).toBe("webp")
    expect(detectImageFormat(Buffer.from([0x42, 0x4d, 0x00, 0x00]))).toBe("bmp")
  })

  test("returns unknown for short or unrecognised buffers", () => {
    expect(detectImageFormat(Buffer.alloc(0))).toBe("unknown")
    expect(detectImageFormat(Buffer.from("nope"))).toBe("unknown")
    expect(detectImageFormat(Buffer.from([0x89, 0x50]))).toBe("unknown")
  })
})

describe("encodeKittyBase64", () => {
  test("empty payload emits a single empty final chunk", () => {
    expect(encodeKittyBase64("")).toBe("\x1b_Gf=100,a=T,m=0,q=2;\x1b\\")
  })

  test("a payload that fits one chunk uses m=0 with control data", () => {
    expect(encodeKittyBase64("QUJD")).toBe("\x1b_Gf=100,a=T,m=0,q=2;QUJD\x1b\\")
  })

  test("a large payload is chunked with m=1 continuations and a final m=0", () => {
    const base64 = "A".repeat(10)
    const encoded = encodeKittyBase64(base64, 4)
    expect(encoded).toBe(
      "\x1b_Gf=100,a=T,m=1,q=2;AAAA\x1b\\" +
        "\x1b_Gm=1;AAAA\x1b\\" +
        "\x1b_Gm=0;AA\x1b\\",
    )
    // Only the first escape carries the control data.
    expect(encoded.match(/f=100/g)?.length).toBe(1)
    expect(encoded.match(/m=0/g)?.length).toBe(1)
  })
})

describe("encodeKittyFile", () => {
  test("encodes a normal path as a file reference", () => {
    expect(encodeKittyFile("/tmp/photo.png")).toBe("\x1b_Gf=100,a=T,t=f,q=2;/tmp/photo.png\x1b\\")
  })

  test("returns null for paths containing control chars, ';' or backslash", () => {
    expect(encodeKittyFile("/tmp/a;b.png")).toBeNull()
    expect(encodeKittyFile("/tmp/a\\b.png")).toBeNull()
    expect(encodeKittyFile("/tmp/a\u0000b.png")).toBeNull()
  })
})

describe("normalizeSixel", () => {
  test("wraps bare payloads in a DCS sequence", () => {
    expect(normalizeSixel("abc")).toBe("\x1bPqabc\x1b\\")
  })

  test("keeps an existing DCS prefix and appends ST only once", () => {
    expect(normalizeSixel("\x1bPqabc")).toBe("\x1bPqabc\x1b\\")
    expect(normalizeSixel("\x1bPqabc\x1b\\")).toBe("\x1bPqabc\x1b\\")
  })

  test("empty input becomes an empty string", () => {
    expect(normalizeSixel("   ")).toBe("")
  })
})
