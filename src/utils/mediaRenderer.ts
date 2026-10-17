import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { promisify } from "node:util"
import type { MediaAttachment } from "../services/types"
import type { MediaDisplayMode } from "./terminalCapabilities"
import { mediaCache } from "./mediaCache"
import { mediaServer } from "./mediaServer"
import { logger as defaultLogger, type Logger } from "./logger"

const execFileAsync = promisify(execFile)

/** Hard cap for any helper child process; prevents leaked/zombie processes. */
const EXEC_TIMEOUT_MS = 5000
/** Generous buffer so sixel output is not truncated. */
const MAX_EXEC_BUFFER = 16 * 1024 * 1024
/** Kitty's per-escape payload limit (the terminal reads at most ~4 KiB/escape). */
const KITTY_CHUNK_SIZE = 4096

type ImageFormat = "png" | "jpeg" | "gif" | "webp" | "bmp" | "unknown"

/**
 * Renders {@link MediaAttachment}s for the terminal.
 *
 * Image modes (`kitty`, `iterm2`, `sixel`) resolve the cached media file via
 * {@link MediaCache} using the frozen `MediaAttachment.messageId` contract
 * (PLAN M2). When no cached file exists — or the required helper tool is
 * unavailable — every mode degrades gracefully to the ASCII/indicator output
 * instead of throwing.
 */
export class MediaRenderer {
  /**
   * @param displayMode Terminal display mode to use.
   * @param logger      Logger instance; defaults to the shared app logger.
   */
  constructor(
    private displayMode: MediaDisplayMode,
    private readonly logger: Logger = defaultLogger,
  ) {}

  /** The active display mode. */
  getDisplayMode(): MediaDisplayMode {
    return this.displayMode
  }

  /** Update the display mode at runtime. */
  setDisplayMode(mode: MediaDisplayMode): void {
    this.displayMode = mode
  }

  /**
   * Resolve the cached file path for an attachment using its message id.
   * Returns `null` when the media has not been downloaded/cached yet.
   */
  private getCachedMediaPath(media: MediaAttachment): string | null {
    if (!media.messageId) return null
    try {
      return mediaCache.get(media.messageId, media.mimetype)
    } catch (err) {
      this.logger.debug("MediaRenderer", "Cache lookup failed", { error: String(err) })
      return null
    }
  }

  /** Emoji icon for a media kind. */
  getMediaIcon(mediaType: string): string {
    const icons: Record<string, string> = {
      image: "📷",
      video: "🎥",
      audio: "🎵",
      document: "📎",
      sticker: "🎨",
    }
    return icons[mediaType] || "📎"
  }

  /** Human readable file size, e.g. `1.2 MB`. */
  formatFileSize(bytes?: number): string {
    if (!bytes) return "unknown size"
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  /** Single-line fallback indicator shown under (or instead of) rich output. */
  private indicatorLine(media: MediaAttachment): string {
    const icon = this.getMediaIcon(media.type)
    const filename = media.filename || `${media.type}.${this.getExtension(media.mimetype)}`
    const size = this.formatFileSize(media.filesize)
    return `${icon} ${filename} (${size}) ['space' to open]`
  }

  /** Plain indicator output (no image escape sequences). */
  async renderMediaIndicator(media: MediaAttachment): Promise<string[]> {
    return [this.indicatorLine(media)]
  }

  /**
   * ASCII-art thumbnail. Falls back to the plain indicator when the file is not
   * cached or no ASCII converter (`jp2a`) is available.
   */
  async renderASCIIThumbnail(media: MediaAttachment, width: number = 40): Promise<string[]> {
    if (media.type !== "image") {
      return this.renderMediaIndicator(media)
    }

    const filePath = this.getCachedMediaPath(media)
    if (!filePath) {
      return this.renderMediaIndicator(media)
    }

    try {
      const { stdout } = await execFileAsync(
        "jp2a",
        [`--width=${Math.max(1, Math.floor(width))}`, "--height=20", filePath],
        { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_EXEC_BUFFER, windowsHide: true },
      )
      const asciiLines = String(stdout)
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .slice(0, 15)

      if (asciiLines.length === 0) {
        return this.renderMediaIndicator(media)
      }
      return [...asciiLines, this.indicatorLine(media)]
    } catch (err) {
      this.logger.debug("MediaRenderer", "ASCII render unavailable", { error: String(err) })
      return this.renderMediaIndicator(media)
    }
  }

  /**
   * Kitty graphics protocol.
   *
   * PNG data is transmitted directly with `f=100` in `m=1`/`m=0` chunks of
   * {@link KITTY_CHUNK_SIZE} base64 characters (the protocol caps the payload
   * per escape). Formats kitty cannot decode inline (JPEG/GIF/WebP/BMP) are
   * transmitted by file reference (`t=f`) so the terminal can auto-detect them.
   */
  async renderKittyImage(media: MediaAttachment, maxWidth: number = 80): Promise<string[]> {
    if (media.type !== "image") {
      return this.renderMediaIndicator(media)
    }

    const filePath = this.getCachedMediaPath(media)
    if (!filePath) {
      // No cached bytes: degrade to ASCII/indicator rather than throwing.
      return this.renderASCIIThumbnail(media, maxWidth)
    }

    try {
      const buffer = await readFile(filePath)
      const format = detectImageFormat(buffer)
      const sequence =
        format === "png"
          ? encodeKittyBase64(buffer.toString("base64"))
          : encodeKittyFile(filePath)

      if (!sequence) {
        return this.renderASCIIThumbnail(media, maxWidth)
      }
      return [sequence, this.indicatorLine(media)]
    } catch (err) {
      this.logger.warn("MediaRenderer", "Kitty render failed", { error: String(err) })
      return this.renderASCIIThumbnail(media, maxWidth)
    }
  }

  /**
   * iTerm2 inline-image protocol (OSC 1337).
   *
   * `\x1b]1337;File=<args>:<base64>\x07`. `name` is the base64-encoded filename
   * and `size` the decoded byte length, per the iTerm2 specification.
   */
  async renderITerm2Image(media: MediaAttachment, maxWidth: number = 80): Promise<string[]> {
    if (media.type !== "image") {
      return this.renderMediaIndicator(media)
    }

    const filePath = this.getCachedMediaPath(media)
    if (!filePath) {
      return this.renderASCIIThumbnail(media, maxWidth)
    }

    try {
      const buffer = await readFile(filePath)
      const base64 = buffer.toString("base64")
      const name = Buffer.from(media.filename || "image", "utf8").toString("base64")
      const width = Math.max(1, Math.floor(maxWidth))

      const sequence =
        `\x1b]1337;File=inline=1;size=${buffer.length};name=${name}` +
        `;width=${width}ch;height=auto;preserveAspectRatio=1:${base64}\x07`

      return [sequence, this.indicatorLine(media)]
    } catch (err) {
      this.logger.warn("MediaRenderer", "iTerm2 render failed", { error: String(err) })
      return this.renderASCIIThumbnail(media, maxWidth)
    }
  }

  /**
   * Sixel graphics, produced by ImageMagick (`convert ... sixel:-`). The raw
   * DCS payload is emitted as-is and terminated with ST.
   */
  async renderSixelImage(media: MediaAttachment, maxWidth: number = 80): Promise<string[]> {
    if (media.type !== "image") {
      return this.renderMediaIndicator(media)
    }

    const filePath = this.getCachedMediaPath(media)
    if (!filePath) {
      return this.renderASCIIThumbnail(media, maxWidth)
    }

    try {
      const { stdout } = await execFileAsync(
        "convert",
        [filePath, "-resize", `${Math.max(1, Math.floor(maxWidth))}x`, "sixel:-"],
        { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_EXEC_BUFFER, windowsHide: true },
      )
      const sixel = normalizeSixel(String(stdout))
      if (!sixel) {
        return this.renderASCIIThumbnail(media, maxWidth)
      }
      return [sixel, this.indicatorLine(media)]
    } catch (err) {
      this.logger.debug("MediaRenderer", "Sixel render unavailable", { error: String(err) })
      return this.renderASCIIThumbnail(media, maxWidth)
    }
  }

  /** Render an attachment using the configured display mode. Never throws. */
  async render(media: MediaAttachment, maxWidth: number = 80): Promise<string[]> {
    switch (this.displayMode) {
      case "kitty":
        return this.renderKittyImage(media, maxWidth)
      case "iterm2":
        return this.renderITerm2Image(media, maxWidth)
      case "sixel":
        return this.renderSixelImage(media, maxWidth)
      case "ascii":
        return this.renderASCIIThumbnail(media, maxWidth)
      case "http":
        return this.renderHTTPMode(media)
      case "indicator":
      default:
        return this.renderMediaIndicator(media)
    }
  }

  /**
   * HTTP mode: start the local gallery server and return a browser link. The
   * server files live in the same cache directory as downloaded media.
   */
  async renderHTTPMode(media: MediaAttachment): Promise<string[]> {
    try {
      const serverUrl = await mediaServer.start()
      const icon = this.getMediaIcon(media.type)
      const filename = media.filename || "media"
      const size = this.formatFileSize(media.filesize)
      return [
        `${icon} ${filename} (${size})`,
        `📱 View in browser: ${serverUrl}`,
        "['space' to open]",
      ]
    } catch (err) {
      this.logger.warn("MediaRenderer", "HTTP mode failed", { error: String(err) })
      return this.renderMediaIndicator(media)
    }
  }

  /**
   * Open a file or URL with the platform handler. Uses `execFile` (argument
   * array, no shell) with a timeout so child processes cannot leak.
   */
  async openMedia(filePath: string): Promise<void> {
    const platform = process.platform
    let command: string
    let args: string[]

    if (platform === "darwin") {
      command = "open"
      args = [filePath]
    } else if (platform === "win32") {
      command = "cmd"
      args = ["/c", "start", "", filePath]
    } else {
      command = "xdg-open"
      args = [filePath]
    }

    try {
      await execFileAsync(command, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true })
    } catch (err) {
      this.logger.warn("MediaRenderer", "Failed to open media", { error: String(err), filePath })
    }
  }

  private getExtension(mimetype: string): string {
    const parts = mimetype.split("/")
    return parts[1] || "bin"
  }
}

/** Detect an image container format from its magic bytes. */
export function detectImageFormat(buffer: Buffer): ImageFormat {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "png"
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg"
  }
  if (buffer.length >= 6 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return "gif"
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp"
  }
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return "bmp"
  }
  return "unknown"
}

/**
 * Encode PNG data for the kitty protocol, splitting the base64 payload into
 * `m=1` chunks with a final `m=0` chunk. Returns a single escape string.
 */
export function encodeKittyBase64(base64: string, chunkSize: number = KITTY_CHUNK_SIZE): string {
  const size = Math.max(1, Math.floor(chunkSize))
  if (base64.length === 0) {
    return "\x1b_Gf=100,a=T,m=0,q=2;\x1b\\"
  }

  let out = ""
  for (let offset = 0; offset < base64.length; offset += size) {
    const chunk = base64.slice(offset, offset + size)
    const last = offset + size >= base64.length
    if (offset === 0) {
      // First chunk carries the full control data.
      out += `\x1b_Gf=100,a=T,m=${last ? 0 : 1},q=2;${chunk}\x1b\\`
    } else {
      // Continuation chunks may only carry the `m` key.
      out += `\x1b_Gm=${last ? 0 : 1};${chunk}\x1b\\`
    }
  }
  return out
}

/**
 * Encode a file reference for the kitty protocol (`t=f`). Returns `null` when
 * the path contains characters that would break the escape sequence.
 */
export function encodeKittyFile(filePath: string): string | null {
  if (!/^[^\x00-\x1f;\\]+$/.test(filePath)) return null
  return `\x1b_Gf=100,a=T,t=f,q=2;${filePath}\x1b\\`
}

/** Ensure a sixel payload is wrapped in a DCS `...q` sequence and ST. */
export function normalizeSixel(data: string): string {
  const trimmed = data.trim()
  if (!trimmed) return ""
  const hasDcs = trimmed.startsWith("\x1bP")
  const body = hasDcs ? trimmed : `\x1bPq${trimmed}`
  return body.endsWith("\x1b\\") ? body : `${body}\x1b\\`
}
