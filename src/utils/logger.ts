import { appendFileSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "fs"
import { dirname, isAbsolute, join, resolve } from "path"
import { inspect } from "util"

/**
 * Leveled file logger that is safe to construct at module import time.
 *
 * Design goals (see docs/PLAN.md §4.7):
 * - level filtering (`debug` < `info` < `warn` < `error`; `error` always logs),
 * - never throws: every filesystem write is guarded, failures fall back to
 *   stderr (rate-limited so a broken disk can't spam the TUI),
 * - optional stdout mirror (off by default — the TUI owns the terminal),
 * - lazy size-based rotation around 5 MB (`<file>` -> `<file>.1`).
 *
 * The log directory defaults to `process.cwd()` (matching the legacy behavior)
 * and can be overridden with `CHITCHAT_LOG_DIR`. This module deliberately does
 * NOT import `src/settings.ts` (that would create a cycle); the app pushes the
 * configured level in via `Logger.setGlobalLevel(settings.logLevel)`.
 */

export type LogLevel = "debug" | "info" | "warn" | "error"

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/** Rotate once the log file grows past this many bytes (~5 MB). */
const MAX_LOG_BYTES = 5 * 1024 * 1024

/** Filesystem write failures fall back to stderr at most this often. */
const FALLBACK_INTERVAL_MS = 5000

/** Longest line echoed to stderr when the log file is unwritable. */
const FALLBACK_MAX_CHARS = 2000

let globalLevel: LogLevel = "info"
let mirrorToStdout = false

function timestamp(): string {
  return new Date().toISOString()
}

/** Flatten an Error (plus any extra own props such as `code`) into a plain object. */
function errorToObject(err: Error): Record<string, unknown> {
  const obj: Record<string, unknown> = { name: err.name, message: err.message, stack: err.stack }
  const extras = err as unknown as Record<string, unknown>
  for (const key of Object.keys(err)) {
    if (!(key in obj)) obj[key] = extras[key]
  }
  return obj
}

/**
 * Best-effort serialization for log payloads. Errors are expanded (so they are
 * never rendered as `[object Object]`), BigInts are stringified, and circular or
 * otherwise non-JSON-able values fall back to `util.inspect`.
 */
function serialize(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (value instanceof Error) {
    try {
      return JSON.stringify(errorToObject(value))
    } catch {
      // fall through to the generic path
    }
  }
  try {
    const json = JSON.stringify(value, (_key, val) => {
      if (val instanceof Error) return errorToObject(val)
      if (typeof val === "bigint") return val.toString()
      return val
    })
    if (json !== undefined) return json
  } catch {
    // circular / non-serializable — use inspect below
  }
  try {
    return inspect(value, { depth: 4, breakLength: Infinity, maxStringLength: 2000 })
  } catch {
    try {
      return String(value)
    } catch {
      return "[unserializable]"
    }
  }
}

function formatLine(level: string, context: string, message: string, data?: unknown): string {
  let line = `[${timestamp()}] [${level}] [${context}] ${message}`
  const serialized = serialize(data)
  if (serialized !== undefined) line += ` | ${serialized}`
  return line + "\n"
}

/** Resolve the on-disk log path; `CHITCHAT_LOG_DIR` overrides the cwd default. */
function resolveLogPath(filename: string): string {
  const override = process.env.CHITCHAT_LOG_DIR?.trim()
  if (!override || isAbsolute(filename)) return resolve(filename)
  return resolve(join(override, filename))
}

/**
 * Owns the file handle/bookkeeping for a single log path. Multiple `Logger`
 * instances pointing at the same file share one sink so rotation and byte
 * accounting stay consistent.
 */
class LogSink {
  readonly path: string
  private bytes = 0
  private header = ""
  private dirReady = false
  private lastFallback = 0
  private suppressed = 0

  constructor(path: string) {
    this.path = path
  }

  /** First logger for this file: truncate and write the banner. */
  begin(context: string): void {
    this.header = `=== ${context} Log Started ${timestamp()} ===\n`
    this.bytes = 0
    this.attempt(this.header, true)
  }

  /** Additional logger writing to the same file: append its banner. */
  attach(context: string): void {
    this.header = `=== ${context} Log Started ${timestamp()} ===\n`
    this.append(this.header)
  }

  append(line: string): void {
    // Lazy rotation: a single integer comparison per line, no `stat` syscall.
    if (this.bytes > MAX_LOG_BYTES) this.rotate()
    this.attempt(line, false)
  }

  private rotate(): void {
    const backup = this.path + ".1"
    try {
      try {
        unlinkSync(backup)
      } catch {
        // No previous backup — fine.
      }
      renameSync(this.path, backup)
    } catch {
      // Rename failed (e.g. permissions); the truncating write below still
      // bounds the live file so we never grow unbounded.
    }
    this.bytes = 0
    this.attempt(this.header, true)
  }

  private ensureDir(): void {
    if (this.dirReady) return
    mkdirSync(dirname(this.path), { recursive: true })
    this.dirReady = true
  }

  private attempt(data: string, truncate: boolean): void {
    try {
      this.ensureDir()
      if (truncate) writeFileSync(this.path, data)
      else appendFileSync(this.path, data)
      this.bytes += Buffer.byteLength(data)
      return
    } catch {
      // Fall through to the stderr fallback.
    }
    this.fallback(data)
  }

  private fallback(data: string): void {
    const now = Date.now()
    if (now - this.lastFallback < FALLBACK_INTERVAL_MS) {
      this.suppressed++
      return
    }
    const note = this.suppressed > 0 ? ` (+${this.suppressed} earlier lines suppressed)` : ""
    this.suppressed = 0
    this.lastFallback = now
    try {
      const preview =
        data.length > FALLBACK_MAX_CHARS ? data.slice(0, FALLBACK_MAX_CHARS) + "…" : data
      process.stderr.write(`[logger] cannot write ${this.path}${note}: ${preview}`)
    } catch {
      // Nothing else we can safely do.
    }
  }
}

const sinks = new Map<string, LogSink>()

function sinkFor(path: string, context: string): LogSink {
  const existing = sinks.get(path)
  if (existing) {
    existing.attach(context)
    return existing
  }
  const sink = new LogSink(path)
  sink.begin(context)
  sinks.set(path, sink)
  return sink
}

export class Logger {
  private path: string
  private sink: LogSink
  private level: LogLevel | null
  /** Context used when a call passes an empty context string. */
  private label: string

  constructor(filename: string, context: string = "Service") {
    this.path = resolveLogPath(filename)
    this.sink = sinkFor(this.path, context)
    this.level = null
    this.label = context
  }

  /** Default threshold for every logger that has no explicit per-instance level. */
  static setGlobalLevel(level: LogLevel): void {
    if (level in LEVEL_RANK) globalLevel = level
  }

  /** Mirror log lines to stdout as well as the file. Off by default (TUI owns the terminal). */
  static setMirrorToStdout(enabled: boolean): void {
    mirrorToStdout = enabled
  }

  /** Override the threshold for this logger. Pass `null` to follow the global level. */
  setLevel(level: LogLevel | null): void {
    this.level = level
  }

  /** A logger sharing this logger's file but tagged with a different context. */
  child(context: string): Logger {
    const child = Object.create(Logger.prototype) as Logger
    child.path = this.path
    child.sink = this.sink
    child.level = null
    child.label = context
    return child
  }

  info(context: string, message: string, data?: unknown): void {
    this.emit("INFO", "info", context, message, data)
  }

  warn(context: string, message: string, data?: unknown): void {
    this.emit("WARN", "warn", context, message, data)
  }

  error(context: string, message: string, error?: unknown): void {
    this.emit("ERROR", "error", context, message, error)
  }

  debug(context: string, message: string, data?: unknown): void {
    this.emit("DEBUG", "debug", context, message, data)
  }

  event(context: string, eventName: string, data?: unknown): void {
    this.emit("EVENT", "info", context, `Event: ${eventName}`, data)
  }

  private enabled(kind: LogLevel): boolean {
    if (kind === "error") return true
    return LEVEL_RANK[kind] >= LEVEL_RANK[this.level ?? globalLevel]
  }

  private emit(tag: string, kind: LogLevel, context: string, message: string, data?: unknown): void {
    if (!this.enabled(kind)) return
    const line = formatLine(tag, context || this.label, message, data)
    if (mirrorToStdout) {
      try {
        process.stdout.write(line)
      } catch {
        // stdout may be closed — ignore.
      }
    }
    this.sink.append(line)
  }
}

// Default logger instance for backward compatibility.
export const logger = new Logger("chitchat.log", "ChitChat")
