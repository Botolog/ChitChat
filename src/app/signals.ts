import { logger } from "../utils/logger"

/**
 * Restore the terminal to a sane state on shutdown.
 *
 * Idempotent and synchronous so it is safe on the `exit` event (where async
 * work is not permitted). Disables mouse tracking, shows the cursor, resets
 * colours and clears the screen.
 */
let cleanupDone = false
export function cleanupTerminal(): void {
  if (cleanupDone) return
  cleanupDone = true

  // Disable all mouse tracking modes.
  process.stdout.write("\x1b[?1000l") // X11 mouse tracking
  process.stdout.write("\x1b[?1002l") // Button event tracking
  process.stdout.write("\x1b[?1003l") // Any event tracking
  process.stdout.write("\x1b[?1006l") // SGR mouse mode
  process.stdout.write("\x1b[?1015l") // urxvt mouse mode
  process.stdout.write("\x1b[?1005l") // UTF-8 mouse mode

  // Restore cursor and clear.
  process.stdout.write("\x1b[?25h") // Show cursor
  process.stdout.write("\x1b[0m") // Reset colors
  process.stdout.write("\x1b[2J\x1b[H") // Clear screen
}

/**
 * Register the process-level signal/error handlers exactly once (T4).
 *
 * The previous build registered `SIGINT`/`SIGTERM` twice and had two separate
 * `uncaughtException` handlers. This is the single place they are wired.
 */
export function registerSignalHandlers(shutdown: (code: number) => Promise<void> | void): void {
  process.on("exit", cleanupTerminal)

  process.on("SIGINT", () => {
    logger.info("Process", "Received SIGINT - shutting down")
    void shutdown(0)
  })

  process.on("SIGTERM", () => {
    logger.info("Process", "Received SIGTERM - shutting down")
    void shutdown(0)
  })

  process.on("uncaughtException", (err) => {
    cleanupTerminal()
    console.error("Uncaught Exception:", err)
    logger.error("Process", "UNCAUGHT EXCEPTION", err)
    process.exit(2)
  })

  process.on("unhandledRejection", (reason) => {
    logger.error("Process", "UNHANDLED REJECTION", { reason: String(reason) })
    console.error("Unhandled Rejection:", reason)
  })
}
