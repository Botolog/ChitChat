import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isProcessAlive, ProfileLockedError, readLockOwnerPid, recoverProfileLock } from "../src/utils/profileLock"

/** Spawn a throwaway process and return its PID once it has fully exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" })
  const pid = child.pid
  await child.exited
  return pid
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chitchat-lock-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("isProcessAlive", () => {
  test("reports the current process as alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  test("reports an exited process as dead", async () => {
    expect(isProcessAlive(await deadPid())).toBe(false)
  })

  test("rejects invalid PIDs", () => {
    for (const pid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isProcessAlive(pid), String(pid)).toBe(false)
    }
  })
})

describe("readLockOwnerPid", () => {
  test("parses the PID from the <hostname>-<pid> symlink target", () => {
    symlinkSync("myhost-4321", join(dir, "SingletonLock"))
    expect(readLockOwnerPid(join(dir, "SingletonLock"))).toBe(4321)
  })

  test("returns null when the lock is missing", () => {
    expect(readLockOwnerPid(join(dir, "SingletonLock"))).toBeNull()
  })

  test("returns null when the lock is a regular file", () => {
    writeFileSync(join(dir, "SingletonLock"), "not-a-symlink")
    expect(readLockOwnerPid(join(dir, "SingletonLock"))).toBeNull()
  })

  test("returns null when the symlink target has no PID", () => {
    symlinkSync("whatever", join(dir, "SingletonLock"))
    expect(readLockOwnerPid(join(dir, "SingletonLock"))).toBeNull()
  })
})

describe("recoverProfileLock", () => {
  test("is a no-op when no lock exists", () => {
    expect(recoverProfileLock(dir)).toEqual({ recovered: false, ownerPid: null })
  })

  test("removes a stale lock whose owner is dead", async () => {
    const pid = await deadPid()
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      symlinkSync(`host-${pid}`, join(dir, name))
    }

    expect(recoverProfileLock(dir)).toEqual({ recovered: true, ownerPid: pid })
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      // `lstatSync` (not `existsSync`) so a remaining broken symlink would fail.
      expect(() => lstatSync(join(dir, name)), name).toThrow()
    }
  })

  test("throws an actionable error when a live process owns the lock", () => {
    symlinkSync(`host-${process.pid}`, join(dir, "SingletonLock"))

    let thrown: unknown
    try {
      recoverProfileLock(dir)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ProfileLockedError)
    expect((thrown as ProfileLockedError).ownerPid).toBe(process.pid)
    // Short enough to survive the status line's truncation, and it carries the
    // PID as a structured field for the log.
    expect((thrown as Error).message).toBe("Session locked by other app")
    // The live process must not have its lock pulled out from under it.
    // `lstatSync` (not `existsSync`) because the lock is a broken symlink.
    expect(() => lstatSync(join(dir, "SingletonLock"))).not.toThrow()
  })

  test("leaves an unparseable lock for Chromium to handle", () => {
    writeFileSync(join(dir, "SingletonLock"), "garbage")
    expect(recoverProfileLock(dir)).toEqual({ recovered: false, ownerPid: null })
    expect(existsSync(join(dir, "SingletonLock"))).toBe(true)
  })
})
