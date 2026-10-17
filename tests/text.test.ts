import { describe, expect, test } from "bun:test"
import {
  codePointLength,
  formatFileSize,
  formatRelativeTime,
  formatTimestamp,
  padEndVisible,
  stripAnsi,
  stripAnsiVisibleLength,
  truncate,
  wrapText,
} from "../src/utils/text"

describe("truncate", () => {
  test("returns the input when it already fits", () => {
    expect(truncate("hello", 5)).toBe("hello")
    expect(truncate("hello", 99)).toBe("hello")
    expect(truncate("", 3)).toBe("")
  })

  test("appends an ellipsis when a cut happened", () => {
    expect(truncate("hello world", 8)).toBe("hello w…")
    expect(codePointLength(truncate("hello world", 8))).toBe(8)
  })

  test("counts and never splits emoji (astral code points)", () => {
    const input = "😀😀😀😀"
    const out = truncate(input, 3)
    expect(codePointLength(out)).toBe(3)
    expect(out).toBe("😀😀…")
    // No lone surrogates were produced.
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })

  test("non-positive or non-finite limits yield an empty string", () => {
    expect(truncate("abc", 0)).toBe("")
    expect(truncate("abc", -1)).toBe("")
    expect(truncate("abc", Number.NaN)).toBe("")
  })

  test("single character fit is preserved", () => {
    expect(truncate("abc", 1)).toBe("…")
  })
})

describe("codePointLength", () => {
  test("counts emoji as one", () => {
    expect(codePointLength("a😀b")).toBe(3)
    expect(codePointLength("")).toBe(0)
  })
})

describe("formatFileSize", () => {
  const cases: Array<[number, string]> = [
    [0, "0 B"],
    [-1, "0 B"],
    [Number.NaN, "0 B"],
    [Number.POSITIVE_INFINITY, "0 B"],
    [1, "1 B"],
    [1023, "1023 B"],
    [1024, "1 KB"],
    [1536, "1.5 KB"],
    [10 * 1024, "10 KB"],
    [150 * 1024, "150 KB"],
    [1024 * 1024, "1 MB"],
    [12 * 1024 * 1024, "12 MB"],
    [1024 * 1024 * 1024, "1 GB"],
    [1024 * 1024 * 1024 * 1024, "1 TB"],
    [1024 ** 5, "1 PB"],
    [1024 ** 6, "1024 PB"],
  ]
  for (const [bytes, expected] of cases) {
    test(`${bytes} -> ${expected}`, () => {
      expect(formatFileSize(bytes)).toBe(expected)
    })
  }
})

describe("formatTimestamp", () => {
  test("same-day timestamps render as HH:MM", () => {
    const d = new Date()
    d.setHours(8, 30, 0, 0)
    expect(formatTimestamp(d.getTime() / 1000)).toBe("08:30")
  })

  test("same-year but different-day timestamps render as a short date", () => {
    const now = new Date()
    const year = now.getFullYear()
    let day = 1
    const candidate = new Date(year, 0, day, 12, 0, 0)
    if (
      candidate.getFullYear() === now.getFullYear() &&
      candidate.getMonth() === now.getMonth() &&
      candidate.getDate() === now.getDate()
    ) {
      day = 2
    }
    const ts = new Date(year, 0, day, 12, 0, 0).getTime() / 1000
    expect(formatTimestamp(ts)).toBe(`Jan ${day}`)
  })

  test("older timestamps include the year", () => {
    const ts = new Date(2020, 5, 15, 8, 30).getTime() / 1000
    expect(formatTimestamp(ts)).toBe("Jun 15, 2020")
  })

  test("invalid timestamps return an empty string", () => {
    expect(formatTimestamp(Number.NaN)).toBe("")
  })
})

describe("formatRelativeTime", () => {
  const now = Math.floor(Date.now() / 1000)

  test("under a minute is 'now'", () => {
    expect(formatRelativeTime(now)).toBe("now")
    expect(formatRelativeTime(now - 59)).toBe("now")
  })

  test("future timestamps collapse to 'now'", () => {
    expect(formatRelativeTime(now + 3600)).toBe("now")
  })

  test("minutes / hours / days / weeks", () => {
    expect(formatRelativeTime(now - 120)).toBe("2m")
    expect(formatRelativeTime(now - 7200)).toBe("2h")
    expect(formatRelativeTime(now - 2 * 86400)).toBe("2d")
    expect(formatRelativeTime(now - 14 * 86400)).toBe("2w")
  })

  test("older than ~a month falls back to the formatted date", () => {
    const ts = now - 40 * 86400
    expect(formatRelativeTime(ts)).toBe(formatTimestamp(ts))
    expect(formatRelativeTime(ts)).not.toMatch(/^\d+[mhdw]$/)
  })
})

describe("wrapText", () => {
  function assertWidths(lines: string[], width: number): void {
    for (const line of lines) {
      expect(codePointLength(line)).toBeLessThanOrEqual(width)
    }
  }

  test("wraps words greedily", () => {
    expect(wrapText("hello world foo", 7)).toEqual(["hello", "world", "foo"])
  })

  test("collapses runs of whitespace and blank lines are preserved as one empty line", () => {
    expect(wrapText("a    b", 10)).toEqual(["a b"])
    expect(wrapText("a\n\nb", 10)).toEqual(["a", "", "b"])
  })

  test("hard-splits words wider than the width so no line exceeds it", () => {
    const lines = wrapText("abcdefghij", 3)
    expect(lines).toEqual(["abc", "def", "ghi", "j"])
    assertWidths(lines, 3)
  })

  test("mixed long and short words respect the width", () => {
    const lines = wrapText("hi supercalifragilistic bye", 6)
    assertWidths(lines, 6)
    expect(lines.join("").replace(/ /g, "")).toBe("hisupercalifragilisticbye")
  })

  test("width below 1 returns the input as a single line", () => {
    expect(wrapText("abc", 0)).toEqual(["abc"])
    expect(wrapText("", 0)).toEqual([])
    expect(wrapText("abc", Number.NaN)).toEqual(["abc"])
  })

  test("emoji-width counting keeps lines within the limit", () => {
    const lines = wrapText("😀😀 😀😀😀", 3)
    assertWidths(lines, 3)
  })
})

describe("ANSI helpers", () => {
  const colored = "\u001b[31mred\u001b[0m"

  test("stripAnsi removes escape sequences", () => {
    expect(stripAnsi(colored)).toBe("red")
    expect(stripAnsi("\u001b[1;32mgreen\u001b[0m text")).toBe("green text")
  })

  test("stripAnsiVisibleLength measures visible code points", () => {
    expect(stripAnsiVisibleLength(colored)).toBe(3)
    expect(stripAnsiVisibleLength("😀\u001b[0m")).toBe(1)
  })

  test("padEndVisible pads to the visible width", () => {
    const padded = padEndVisible(colored, 5)
    expect(stripAnsiVisibleLength(padded)).toBe(5)
    expect(padded.startsWith(colored)).toBe(true)
  })

  test("padEndVisible leaves longer strings untouched", () => {
    expect(padEndVisible("abcdef", 3)).toBe("abcdef")
  })
})
