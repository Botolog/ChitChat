import { readFile } from "node:fs/promises"
import type { AppContext } from "../app/context"
import type { MessageData } from "../services/types"
import { getSettings } from "../settings"
import { logger } from "../utils/logger"
import { mediaCache } from "../utils/mediaCache"

/**
 * Return a cached path for `message`'s media, downloading + caching it first
 * when needed.
 *
 * Uses the frozen `MediaAttachment.messageId` cache key (PLAN M2): the service's
 * `downloadMedia` returns a path, whose bytes are re-cached under the message id
 * so `MediaRenderer` (which looks up by message id) can find it.
 */
export async function ensureMediaCached(
  ctx: AppContext,
  message: MessageData,
  chatId: string,
): Promise<string | null> {
  const media = message.media
  if (!media) return null
  const svc = ctx.service.active
  if (!svc) return null

  const mimetype = media.mimetype || "application/octet-stream"
  const cached = mediaCache.get(media.messageId, mimetype)
  if (cached) return cached

  if (!svc.capabilities().downloadMedia || !svc.downloadMedia) return null

  const filePath = await svc.downloadMedia(media.messageId, chatId)
  if (!filePath) return null

  try {
    // The service may already have stored it under the message-id key.
    const already = mediaCache.get(media.messageId, mimetype)
    if (already) return already
    const buffer = await readFile(filePath)
    return await mediaCache.cache(media.messageId, buffer, mimetype, media.filename)
  } catch (err) {
    logger.debug("App", "Media re-cache skipped", { error: String(err) })
    return filePath
  }
}

/**
 * Open the selected message's media (download if needed, then hand off to the
 * renderer / local HTTP gallery). Always consumes the key.
 */
export async function handleOpenMedia(ctx: AppContext): Promise<boolean> {
  const colors = ctx.theme.colors
  const state = ctx.state
  const svc = ctx.service.active
  const msg = state.messages[state.selectedMessage]

  logger.info("App", "Open media handler reached")
  logger.info("App", "Enter media check", {
    hasMsg: !!msg,
    hasMedia: msg?.hasMedia,
    hasMediaObj: !!msg?.media,
    hasChatId: !!state.currentChatId,
    hasService: !!svc,
  })

  if (msg && msg.hasMedia && msg.media && state.currentChatId && svc) {
    logger.info("App", "Opening media from selected message", { messageId: msg.id })
    try {
      const mimetype = msg.media.mimetype || "application/octet-stream"
      let filePath = mediaCache.get(msg.media.messageId, mimetype)

      if (filePath) {
        logger.info("App", "Media already cached, opening directly", { filePath })
        ctx.status.set("● Opening cached media...", colors.primary)
      } else {
        logger.info("App", "Media not cached, downloading first", { messageId: msg.id })
        ctx.status.set("⏳ Downloading media...", colors.textMuted)
        filePath = await ensureMediaCached(ctx, msg, state.currentChatId)
      }

      if (filePath && ctx.media.renderer) {
        if (getSettings().mediaDisplayMode === "http") {
          const serverUrl = await ctx.media.server.start()
          await ctx.media.renderer.openMedia(serverUrl)
        } else {
          await ctx.media.renderer.openMedia(filePath)
        }
        ctx.status.set("● Opened media", colors.primary)
      } else {
        ctx.status.set("✗ Failed to get media", "#F15C6D")
      }
    } catch (err) {
      logger.error("App", "Failed to open media", err)
      const message = err instanceof Error ? err.message : String(err)
      ctx.status.set(`✗ ${message.slice(0, 30)}`, "#F15C6D")
    }
  } else {
    ctx.status.set("No media in this message", colors.textMuted)
  }
  return true
}
