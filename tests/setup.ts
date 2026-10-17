/**
 * Test bootstrap: must be imported *before* any `src/**` module so that the
 * import-time singletons (notably `src/utils/logger.ts`) resolve their on-disk
 * paths inside a temporary directory instead of the repository working tree.
 *
 * Static imports are evaluated in source order, so every test file starts with
 * `import "./setup"` and then imports the modules under test.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = mkdtempSync(join(tmpdir(), "chitchat-tests-"))

// `??=` so a still-earlier test file's choice wins if modules are shared.
process.env.CHITCHAT_LOG_DIR ??= join(root, "logs")
process.env.CHITCHAT_SETTINGS_PATH ??= join(root, "settings.json")
process.env.CHITCHAT_KEYBINDINGS_PATH ??= join(root, "keybindings.json")

// Best-effort cleanup of the shared bootstrap directory on process exit.
process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // Best effort only.
  }
})

/** Absolute temp root that backs the bootstrap paths above. */
export const TEST_ROOT = root
