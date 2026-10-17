import type { TextRenderable } from "@opentui/core"
import type { AppContext } from "../app/context"
import { logger } from "../utils/logger"

/** What a transient status reverts to when its timer elapses. */
export interface StatusRestore {
  content: string
  fg?: string
}

/** The idle status for the current mode ("● Demo Mode" / "● Connected"). */
export function defaultStatus(ctx: AppContext): StatusRestore {
  return ctx.config.demoMode
    ? { content: "● Demo Mode", fg: ctx.theme.colors.primary }
    : { content: "● Connected", fg: ctx.theme.colors.primary }
}

/**
 * Owns the single status-line text renderable and the one timer that reverts a
 * transient message.
 *
 * T9: the legacy code scheduled ad-hoc `setTimeout`s that could clobber a newer
 * status ("Sent!" overwritten by a stale "Connected"). Here there is exactly one
 * pending revert timer; a plain `set()` (or a newer `revertAfter()`) cancels it,
 * so the most recent status always wins.
 */
export class StatusBar {
  private timer: NodeJS.Timeout | null = null
  private restore: StatusRestore | null = null

  constructor(private readonly text: TextRenderable) {}

  /** Set the status; cancels any pending revert. */
  set(content: string, fg?: string): void {
    this.cancelTimer()
    this.text.content = content
    if (fg !== undefined) this.text.fg = fg
  }

  /**
   * Schedule the status to revert to `restore` after `ms`, replacing any other
   * pending revert. Does not change the current text.
   */
  revertAfter(ms: number, restore: StatusRestore): void {
    this.cancelTimer()
    this.restore = restore
    this.timer = setTimeout(() => {
      this.timer = null
      const target = this.restore
      this.restore = null
      if (!target) return
      this.text.content = target.content
      if (target.fg !== undefined) this.text.fg = target.fg
    }, ms)
    this.timer.unref?.()
  }

  /** Cancel a pending revert without changing the text. */
  cancelTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.restore = null
  }

  /** The renderable this controller drives (for theme application). */
  get renderable(): TextRenderable {
    return this.text
  }

  /** Convenience logger used by callers that also want an audit trail. */
  debug(context: string, message: string, data?: unknown): void {
    logger.debug(context, message, data)
  }
}
