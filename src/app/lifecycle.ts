/**
 * Bounded owner of every interval/timeout and one-shot disposer the app
 * registers, so shutdown can guarantee nothing outlives the process (T6).
 *
 * `clearTimeout` is used for both timeouts and intervals (Node/Bun share the
 * same handle table), so a single set of handles is sufficient.
 */
export class Lifecycle {
  private readonly timers = new Set<NodeJS.Timeout>()
  private readonly disposers = new Set<() => void>()
  private disposed = false

  /** Register a repeating timer that is cleared on `dispose()`. */
  interval(callback: () => void, ms: number): NodeJS.Timeout {
    const handle = setInterval(callback, ms)
    this.timers.add(handle)
    return handle
  }

  /** Register a one-shot timer that is cleared on `dispose()`. */
  timeout(callback: () => void, ms: number): NodeJS.Timeout {
    const handle = setTimeout(() => {
      this.timers.delete(handle)
      callback()
    }, ms)
    this.timers.add(handle)
    return handle
  }

  /** Register a teardown callback (e.g. remove a listener). Idempotent-safe. */
  onDispose(disposer: () => void): void {
    if (this.disposed) {
      this.safeRun(disposer)
      return
    }
    this.disposers.add(disposer)
  }

  /** Clear every timer and run every disposer exactly once. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    for (const handle of this.timers) clearTimeout(handle)
    this.timers.clear()

    for (const disposer of this.disposers) this.safeRun(disposer)
    this.disposers.clear()
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  private safeRun(fn: () => void): void {
    try {
      fn()
    } catch {
      // Teardown must never throw during shutdown.
    }
  }
}
