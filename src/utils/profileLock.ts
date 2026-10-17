import { readlinkSync, rmSync } from "node:fs"
import { join } from "node:path"

/**
 * Chromium serialises access to a profile directory (`userDataDir`) with a set
 * of `Singleton*` files; `SingletonLock` is a symlink whose target is
 * `<hostname>-<pid>`. When the owning browser dies without cleaning up (crash,
 * `SIGKILL`, OOM kill) the lock lingers and every later launch fails with
 * "Failed to create a ProcessSingleton for your profile directory", which
 * Puppeteer surfaces as the confusing:
 *
 *   The browser is already running for <dir>.
 *   Use a different `userDataDir` or stop the running browser first.
 *
 * `recoverProfileLock` classifies the lock and, when its owner is dead, removes
 * the stale singleton files so the next launch can claim the profile. When the
 * owner is genuinely alive it throws an actionable error instead of letting the
 * caller retry pointlessly against a directory that is still in use.
 */

/** Files Chromium leaves behind that gate access to a profile directory. */
const SINGLETON_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"] as const

/**
 * Thrown when the profile is held by a process that is still alive.
 *
 * The message is deliberately short (it is shown verbatim on the status line,
 * which has limited room); the owning PID is carried as a structured field so
 * the log records it and retry logic can recognise this fatal, non-retryable
 * case without string matching.
 */
export class ProfileLockedError extends Error {
  constructor(readonly ownerPid: number) {
    super("Session locked by other app")
    this.name = "ProfileLockedError"
  }
}

/** Outcome of {@link recoverProfileLock}. */
export interface ProfileLockResult {
  /** True when stale singleton files were removed. */
  recovered: boolean
  /** PID parsed from the lock, or `null` when absent/unparseable. */
  ownerPid: number | null
}

/**
 * Whether a PID refers to a live process. `EPERM` means the process exists but
 * is owned by another user, which still counts as alive.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Parse the owner PID out of a `SingletonLock` symlink target
 * (`<hostname>-<pid>`). Returns `null` when the lock is missing, is not a
 * symlink, or its target does not end in a PID.
 *
 * Uses `readlinkSync` directly rather than `existsSync`, because the lock is a
 * *broken* symlink (its target is a descriptive string, not a real file) and
 * `existsSync` would follow it and report the lock as absent.
 */
export function readLockOwnerPid(lockPath: string): number | null {
  try {
    const match = /-(\d+)$/.exec(readlinkSync(lockPath))
    return match ? Number(match[1]) : null
  } catch {
    // ENOENT (no lock), EINVAL (regular file), EACCES, ...
    return null
  }
}

/**
 * Inspect `dir`'s Chromium singleton lock and recover from a stale one.
 *
 * @throws when a live process still owns the profile, with a message that tells
 * the user exactly what to close.
 */
export function recoverProfileLock(dir: string): ProfileLockResult {
  const lockPath = join(dir, "SingletonLock")
  const ownerPid = readLockOwnerPid(lockPath)
  if (ownerPid === null) return { recovered: false, ownerPid: null }

  if (isProcessAlive(ownerPid)) {
    throw new ProfileLockedError(ownerPid)
  }

  for (const name of SINGLETON_FILES) {
    try {
      rmSync(join(dir, name), { force: true })
    } catch {
      // Best effort: Chromium will still attempt to claim the profile.
    }
  }
  return { recovered: true, ownerPid }
}
