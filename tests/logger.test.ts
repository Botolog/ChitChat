import "./setup"
import { Logger } from "../src/utils/logger"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let dir: string
let counter = 0

function newLogger(context = "Test"): { logger: Logger; path: string } {
  const filename = `log-${process.pid}-${counter++}.log`
  const logger = new Logger(filename, context)
  return { logger, path: join(dir, filename) }
}

function read(path: string): string {
  try {
    return readFileSync(path, "utf-8")
  } catch {
    return ""
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chitchat-logger-"))
  process.env.CHITCHAT_LOG_DIR = dir
})

afterEach(() => {
  Logger.setGlobalLevel("info")
  rmSync(dir, { recursive: true, force: true })
  delete process.env.CHITCHAT_LOG_DIR
})

describe("Logger level filtering", () => {
  test("respects the global level", () => {
    Logger.setGlobalLevel("warn")
    const { logger, path } = newLogger()
    logger.debug("Ctx", "DBG_MSG")
    logger.info("Ctx", "INF_MSG")
    logger.warn("Ctx", "WRN_MSG")
    logger.error("Ctx", "ERR_MSG")
    const out = read(path)
    expect(out).not.toContain("DBG_MSG")
    expect(out).not.toContain("INF_MSG")
    expect(out).toContain("WRN_MSG")
    expect(out).toContain("ERR_MSG")
  })

  test("debug level logs everything", () => {
    Logger.setGlobalLevel("debug")
    const { logger, path } = newLogger()
    logger.debug("Ctx", "DBG_MSG")
    logger.info("Ctx", "INF_MSG")
    logger.warn("Ctx", "WRN_MSG")
    const out = read(path)
    expect(out).toContain("DBG_MSG")
    expect(out).toContain("INF_MSG")
    expect(out).toContain("WRN_MSG")
  })

  test("error always logs even at the error threshold", () => {
    Logger.setGlobalLevel("error")
    const { logger, path } = newLogger()
    logger.info("Ctx", "INF_MSG")
    logger.error("Ctx", "ERR_MSG")
    const out = read(path)
    expect(out).not.toContain("INF_MSG")
    expect(out).toContain("ERR_MSG")
  })

  test("per-instance setLevel overrides the global level", () => {
    Logger.setGlobalLevel("error")
    const { logger, path } = newLogger()
    logger.setLevel("debug")
    logger.info("Ctx", "INF_MSG")
    expect(read(path)).toContain("INF_MSG")

    const { logger: other, path: otherPath } = newLogger()
    other.info("Ctx", "OTHER_MSG")
    expect(read(otherPath)).not.toContain("OTHER_MSG")
  })

  test("setLevel(null) falls back to the global level", () => {
    Logger.setGlobalLevel("error")
    const { logger, path } = newLogger()
    logger.setLevel("debug")
    logger.info("Ctx", "BEFORE")
    logger.setLevel(null)
    logger.info("Ctx", "AFTER")
    const out = read(path)
    expect(out).toContain("BEFORE")
    expect(out).not.toContain("AFTER")
  })

  test("invalid global levels are ignored", () => {
    Logger.setGlobalLevel("warn")
    Logger.setGlobalLevel("nonsense" as unknown as "info")
    const { logger, path } = newLogger()
    logger.info("Ctx", "INF_MSG")
    expect(read(path)).not.toContain("INF_MSG")
  })
})

describe("Logger serialization", () => {
  test("an Error never renders as [object Object]", () => {
    Logger.setGlobalLevel("debug")
    const { logger, path } = newLogger()
    const err = new Error("boom")
    logger.error("Ctx", "failed", err)
    const out = read(path)
    expect(out).toContain("boom")
    expect(out).toContain("Error")
    expect(out).not.toContain("[object Object]")
  })

  test("an Error with extra own props (code) is expanded", () => {
    Logger.setGlobalLevel("debug")
    const { logger, path } = newLogger()
    const err = Object.assign(new Error("disk"), { code: "ENOSPC" })
    logger.error("Ctx", "failed", err)
    const out = read(path)
    expect(out).toContain("ENOSPC")
    expect(out).not.toContain("[object Object]")
  })

  test("a plain object payload is JSON-serialized", () => {
    Logger.setGlobalLevel("debug")
    const { logger, path } = newLogger()
    logger.error("Ctx", "failed", { code: 42, nested: { a: 1 } })
    const out = read(path)
    expect(out).toContain('"code":42')
    expect(out).not.toContain("[object Object]")
  })

  test("BigInt values are stringified rather than throwing", () => {
    Logger.setGlobalLevel("debug")
    const { logger, path } = newLogger()
    expect(() => logger.info("Ctx", "big", { n: 10n })).not.toThrow()
    expect(read(path)).toContain('"10"')
  })

  test("circular payloads do not throw", () => {
    Logger.setGlobalLevel("debug")
    const { logger, path } = newLogger()
    const circular: Record<string, unknown> = { name: "root" }
    circular.self = circular
    expect(() => logger.error("Ctx", "circular", circular)).not.toThrow()
    const out = read(path)
    expect(out.length).toBeGreaterThan(0)
    expect(out).toContain("root")
  })

  test("event() logs an Event line at info level", () => {
    Logger.setGlobalLevel("info")
    const { logger, path } = newLogger()
    logger.event("Ctx", "connected", { ok: true })
    const out = read(path)
    expect(out).toContain("Event: connected")
    expect(out).toContain('"ok":true')
  })
})

describe("Logger robustness", () => {
  test("child() shares the same log file", () => {
    Logger.setGlobalLevel("info")
    const { logger, path } = newLogger("Parent")
    const child = logger.child("Child")
    child.info("Child", "CHILD_MSG")
    logger.info("Parent", "PARENT_MSG")
    const out = read(path)
    expect(out).toContain("CHILD_MSG")
    expect(out).toContain("PARENT_MSG")
    expect(out).toContain("[Parent]")
    expect(out).toContain("[Child]")
  })

  test("never throws when the log directory is unwritable", () => {
    const blocker = join(dir, "blocker")
    writeFileSync(blocker, "i am a file, not a directory")
    process.env.CHITCHAT_LOG_DIR = join(blocker, "nested")

    expect(() => {
      const logger = new Logger("unwritable.log", "Ctx")
      logger.info("Ctx", "will-not-persist")
      logger.error("Ctx", "still-no-throw", new Error("x"))
    }).not.toThrow()
  })

  test("a truncated or missing log file reads as empty without throwing", () => {
    expect(read(join(dir, "does-not-exist.log"))).toBe("")
  })
})

describe("Logger.child", () => {
  test("uses the child context when a call passes an empty context", () => {
    const { logger, path } = newLogger("Parent")
    const child = logger.child("ChildCtx")
    child.info("", "CHILD_HELLO")
    const contents = read(path)
    expect(contents).toContain("CHILD_HELLO")
    expect(contents).toContain("ChildCtx")
  })

  test("shares the parent's log file", () => {
    const { logger, path } = newLogger("Parent")
    const child = logger.child("Child")
    child.info("Child", "SHARED_LINE")
    expect(read(path)).toContain("SHARED_LINE")
  })
})
