import { describe, expect, test } from "bun:test"
import { renderQrBlocks } from "../src/utils/qr"

const BLOCK_CHARS = /^[\u2580\u2584\u2588 \n]*$/

describe("renderQrBlocks", () => {
  test("renders a non-empty block-character string", () => {
    const out = renderQrBlocks("https://example.test/invite")
    expect(out.length).toBeGreaterThan(0)
    expect(out.split("\n").length).toBeGreaterThan(1)
  })

  test("contains block characters and no ANSI escapes", () => {
    const out = renderQrBlocks("hello world")
    expect(out).not.toContain("\u001b")
    expect(out).toMatch(BLOCK_CHARS)
    expect(out).toMatch(/[\u2580\u2584\u2588]/)
  })

  test("never writes control characters other than newline", () => {
    const out = renderQrBlocks("payload")
    // eslint-disable-next-line no-control-regex
    expect(out.replace(/\n/g, "")).not.toMatch(/[\u0000-\u001f\u007f]/)
  })

  test("is deterministic for a fixed payload", () => {
    const a = renderQrBlocks("stable-payload")
    const b = renderQrBlocks("stable-payload")
    expect(a).toBe(b)
  })

  test("has fixed dimensions for a fixed payload", () => {
    const lines = renderQrBlocks("dimensions").split("\n")
    const widths = new Set(lines.map((line) => line.length))
    expect(widths.size).toBe(1)
    expect(lines[0].length).toBeGreaterThan(0)
  })

  test("the quiet zone changes the output dimensions (border 0 vs default)", () => {
    const withBorder = renderQrBlocks("quiet-zone", { border: 2 }).split("\n")
    const withoutBorder = renderQrBlocks("quiet-zone", { border: 0 }).split("\n")
    expect(withBorder.length).toBeGreaterThan(withoutBorder.length)
    expect(withBorder[0].length).toBeGreaterThan(withoutBorder[0].length)
  })

  test("negative borders are clamped to zero", () => {
    expect(renderQrBlocks("clamp", { border: -5 })).toBe(renderQrBlocks("clamp", { border: 0 }))
  })

  test("higher error-correction levels still render valid blocks", () => {
    for (const level of ["L", "M", "Q", "H"] as const) {
      const out = renderQrBlocks("levels", { errorCorrectionLevel: level })
      expect(out, level).toMatch(BLOCK_CHARS)
      expect(out, level).not.toContain("\u001b")
    }
  })

  test("different payloads produce different codes", () => {
    expect(renderQrBlocks("aaa")).not.toBe(renderQrBlocks("bbbbbbbb"))
  })
})
