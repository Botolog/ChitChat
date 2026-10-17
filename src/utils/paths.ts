import { join } from "node:path"

/**
 * Base directory for persistent application data (settings, keybindings, media
 * cache). Defaults to the current working directory to preserve historical
 * behaviour, but honours `CHITCHAT_DATA_DIR` — the snap sets it to a writable
 * location (`$SNAP_USER_COMMON`) because `$SNAP` itself is read-only.
 */
export function dataDir(): string {
  const override = process.env.CHITCHAT_DATA_DIR
  if (override && override.trim().length > 0) return override
  return process.cwd()
}

/** Resolve a path inside the app data directory. */
export function resolveDataPath(...parts: string[]): string {
  return join(dataDir(), ...parts)
}
