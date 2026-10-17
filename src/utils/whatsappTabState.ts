/**
 * WhatsApp Web's cross-window "tab mutex".
 *
 * WhatsApp Web only launches its WebSocket once its window wins a mutex stored
 * in web storage; until then it renders
 *
 *   WhatsApp is open in another window. Click "Use here" to use WhatsApp...
 *
 * and the socket stays unlaunched (no QR code, no `ready`) — which surfaces in
 * ChitChat as a permanent "connecting..." screen.
 *
 * Chromium already serialises access to a profile directory, so ChitChat's
 * window is the only one that can legitimately own that mutex. A run killed
 * mid-flight (or a window another instance took over) can still leave the keys
 * behind, so every launch clears them before WhatsApp boots.
 */

/**
 * Web-storage keys that belong to the tab-mutex handshake. None of them holds
 * anything durable — losing them costs nothing; keeping a stale one bricks the
 * window.
 *
 * - `whatsapp-mutex`    — which window owns the session, as `<tab id>:<state>`
 * - `no-takeover`       — "this window must not fight for the mutex"
 * - `local-takeover-ok` — handshake written when another window claims the session
 *
 * The runtime list lives inside {@link clearWhatsAppTabState} (it cannot
 * reference this constant, see there); tests assert the two never drift apart.
 */
export const TAB_COORDINATION_KEYS = [
  "whatsapp-mutex",
  "no-takeover",
  "local-takeover-ok",
] as const

/**
 * Page function that drops stale tab-mutex state. whatsapp-web.js hands it to
 * `page.evaluateOnNewDocument`, so it runs in the browser *before* any WhatsApp
 * Web script — making the window claim the mutex immediately instead of trying
 * to negotiate with a window that no longer exists.
 *
 * Must stay self-contained and dependency-free: it is serialised and re-parsed
 * inside the browser, so it cannot close over anything from this module. The
 * literal list below is the source of truth for runtime behaviour.
 */
export function clearWhatsAppTabState(): void {
  try {
    const g = globalThis as unknown as {
      localStorage?: { removeItem(key: string): void }
      sessionStorage?: { removeItem(key: string): void }
    }
    const keys = ["whatsapp-mutex", "no-takeover", "local-takeover-ok"]
    for (const key of keys) {
      g.localStorage?.removeItem(key)
      g.sessionStorage?.removeItem(key)
    }
  } catch {
    // Storage can be unavailable (sandboxing, quota, disabled) — in that case
    // there is nothing stale to clear either.
  }
}
