import { destroyAllServices } from "../services/index"
import { mediaServer } from "../utils/mediaServer"
import { logger } from "../utils/logger"
import { cleanupTerminal } from "./signals"
import type { Lifecycle } from "./lifecycle"
import type { StatusBar } from "../ui/statusBar"

export interface ShutdownDeps {
  lifecycle: Lifecycle
  status: StatusBar
}

/**
 * Build the one-shot graceful shutdown used by both the quit key and the signal
 * handlers.
 *
 * Cancels timers + the resize listener, stops the media server, destroys every
 * service (which clears their timers/listeners), restores the terminal and exits.
 * Re-entrant calls are ignored.
 */
export function createShutdown(deps: ShutdownDeps): (code: number) => Promise<void> {
  let shuttingDown = false
  return async (code: number): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true

    deps.status.cancelTimer()
    deps.lifecycle.dispose()

    try {
      await mediaServer.stop()
    } catch (err) {
      logger.warn("App", "Error stopping media server", err)
    }

    try {
      await destroyAllServices()
    } catch (err) {
      logger.warn("App", "Error destroying services", err)
    }

    cleanupTerminal()
    process.exit(code)
  }
}
