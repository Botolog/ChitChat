/**
 * Dependency-free, side-effect-free text helpers used by the TUI.
 *
 * Length-sensitive helpers measure by Unicode code points (so emoji and other
 * astral-plane characters count as one cell) rather than UTF-16 code units.
 */

const ELLIPSIS = "…"
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]

/**
 * Truncate to at most `max` code points, appending `…` when a cut happened.
 * Emoji (surrogate pairs) are never split in half.
 */
export function truncate(str: string, max: number): string {
  const limit = Math.floor(max)
  if (!Number.isFinite(limit) || limit <= 0) return ""
  const chars = Array.from(str)
  if (chars.length <= limit) return str
  return chars.slice(0, limit - 1).join("") + ELLIPSIS
}

/** Number of code points in `str` (emoji-aware). */
export function codePointLength(str: string): number {
  return Array.from(str).length
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/**
 * `HH:MM` for timestamps on the current local day, otherwise a short date
 * (`Feb 3`, or `Feb 3, 2025` when the year differs).
 */
export function formatTimestamp(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000)
  if (Number.isNaN(date.getTime())) return ""
  const now = new Date()
  if (sameDay(date, now)) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  }
  const datePart = `${MONTHS[date.getMonth()]} ${date.getDate()}`
  return date.getFullYear() === now.getFullYear()
    ? datePart
    : `${datePart}, ${date.getFullYear()}`
}

/**
 * Compact age relative to now: `now`, `2m`, `3h`, `5d`, `2w`, then a date once
 * older than about a month. Future timestamps collapse to `now`.
 */
export function formatRelativeTime(unixSeconds: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - unixSeconds))
  if (diff < 60) return "now"
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d`
  if (diff < 30 * 86400) return `${Math.floor(diff / (7 * 86400))}w`
  return formatTimestamp(unixSeconds)
}

/** Human-readable byte size using binary units (e.g. `1.5 KB`, `12 MB`). */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB", "PB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  if (unit === 0) return `${Math.round(value)} B`
  const fixed =
    value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)
  const trimmed = fixed.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1")
  return `${trimmed} ${units[unit]}`
}

/**
 * Greedy word wrap by code-point width.
 *
 * Existing newlines become hard breaks and runs of whitespace collapse to a
 * single space. Words are preserved when they fit; a word wider than `width`
 * is hard-split across lines so no returned line ever exceeds `width`.
 */
export function wrapText(str: string, width: number): string[] {
  const limit = Math.floor(width)
  if (!Number.isFinite(limit) || limit < 1) return str.length > 0 ? [str] : []
  const result: string[] = []
  for (const paragraph of str.split("\n")) {
    const words = paragraph.split(/\s+/).filter((word) => word.length > 0)
    if (words.length === 0) {
      result.push("")
      continue
    }
    let line = ""
    for (const word of words) {
      let chars = Array.from(word)
      while (chars.length > limit) {
        if (line) {
          result.push(line)
          line = ""
        }
        result.push(chars.slice(0, limit).join(""))
        chars = chars.slice(limit)
      }
      if (chars.length === 0) continue
      const candidate = chars.join("")
      if (line === "") line = candidate
      else if (codePointLength(line) + 1 + chars.length <= limit) line += ` ${candidate}`
      else {
        result.push(line)
        line = candidate
      }
    }
    if (line) result.push(line)
  }
  return result
}

// Standard ANSI escape matcher (CSI/OSC/etc.), covers the sequences the TUI emits.
const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g

/** Remove ANSI escape sequences from `str`. */
export function stripAnsi(str: string): string {
  return str.replace(ANSI_PATTERN, "")
}

/** Visible width of `str` (ANSI escapes ignored, emoji counted as one). */
export function stripAnsiVisibleLength(str: string): number {
  return codePointLength(stripAnsi(str))
}

/** Pad `str` with trailing spaces so its *visible* width reaches `width`. */
export function padEndVisible(str: string, width: number): string {
  const target = Math.floor(width)
  if (!Number.isFinite(target)) return str
  const current = stripAnsiVisibleLength(str)
  if (current >= target) return str
  return str + " ".repeat(target - current)
}
