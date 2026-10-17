import { EventEmitter } from "events"
import { logger } from "../utils/logger"
import type { ServiceCapabilities } from "./capabilities"
import type {
  ChatData,
  ConnectionState,
  ContactData,
  MessageData,
  SendMessageOptions,
} from "./types"

/**
 * Shared lifecycle for every messaging backend.
 *
 * Owns the state that is identical across providers — readiness, the QR
 * payload, tracked timers and bounded waits — so each concrete service only has
 * to implement the provider-specific calls and a `teardown()` hook.
 *
 * Readiness contract:
 * - `ready` starts `false`, flips to `true` exactly once via `markReady()`.
 * - A QR payload is stored via `setQr()` and cleared when the service becomes
 *   ready.
 * - `markReady()` is idempotent: repeated calls (provider events, fallbacks)
 *   never emit a second `ready` event.
 *
 * Timer contract: use `track()` for every timer a subclass creates so
 * `destroy()` (and `clearTimers()`) can guarantee no timer outlives the
 * service. `withTimeout()` manages its own timer and always clears it.
 */
export abstract class BaseMessagingService extends EventEmitter {
  abstract readonly id: string
  abstract readonly displayName: string

  /** True once the backend is authenticated and usable. */
  protected ready = false

  /** Most recent QR payload, or `null` when none is pending. */
  protected qrCode: string | null = null

  /** Timers created by this service; cleared on `clearTimers()`/`destroy()`. */
  private readonly timers = new Set<NodeJS.Timeout>()

  /** Declares the optional operations this backend actually supports. */
  abstract capabilities(): ServiceCapabilities

  /** Connect/authenticate. Must be safe to call more than once. */
  abstract initialize(): Promise<void>

  abstract getChats(): Promise<ChatData[]>
  abstract getMessages(chatId: string, limit?: number): Promise<MessageData[]>
  abstract sendMessage(
    chatId: string,
    content: string,
    options?: SendMessageOptions,
  ): Promise<MessageData | null>
  abstract markAsRead(chatId: string): Promise<void>
  abstract getContactInfo(contactId: string): Promise<ContactData | null>

  isReady(): boolean {
    return this.ready
  }

  getConnectionState(): ConnectionState {
    return { ready: this.ready, hasQr: this.qrCode !== null }
  }

  /**
   * Transition to ready exactly once.
   *
   * The first call logs the triggering source, clears any pending QR payload
   * and emits `ready`. Later calls are no-ops so provider events and fallbacks
   * cannot emit `ready` twice.
   */
  protected markReady(source: string): void {
    if (this.ready) return
    logger.info(this.id, "Service marked ready", { source })
    this.ready = true
    this.qrCode = null
    this.emit("ready")
  }

  /** Store a QR payload and notify listeners. */
  protected setQr(qr: string): void {
    this.qrCode = qr
    this.emit("qr", qr)
  }

  /** Register a timer so it is cleared on `clearTimers()`/`destroy()`. */
  protected track(handle: NodeJS.Timeout): NodeJS.Timeout {
    this.timers.add(handle)
    return handle
  }

  /** Forget a timer that has already fired or been cleared manually. */
  protected untrack(handle: NodeJS.Timeout): void {
    this.timers.delete(handle)
  }

  /** Clear every tracked timer and forget them. */
  protected clearTimers(): void {
    for (const handle of this.timers) {
      clearTimeout(handle)
    }
    this.timers.clear()
  }

  /**
   * Race `promise` against a timer, rejecting with a descriptive error if it
   * does not settle in time. The timer is always cleared, so a resolved
   * promise never leaves a dangling timeout behind.
   */
  protected withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${ms}ms`))
      }, ms)
    })
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }

  /** Clear all timers, then run the provider-specific teardown hook. */
  async destroy(): Promise<void> {
    this.clearTimers()
    await this.teardown()
  }

  /** Provider-specific cleanup. Override; do not call `destroy()` here. */
  protected async teardown(): Promise<void> {}
}
