import { readFileSync, existsSync } from "fs"
import { exec } from "child_process"
import { promisify } from "util"
import type { MediaAttachment } from "../services/types"
import type { MediaDisplayMode } from "./terminalCapabilities"
import { mediaCache } from "./mediaCache"
import { mediaServer } from "./mediaServer"

const execAsync = promisify(exec)

export class MediaRenderer {
  constructor(private displayMode: MediaDisplayMode) {}
  
  // Get cached media file path or null if not cached
  private getCachedMediaPath(media: MediaAttachment): string | null {
    // Media bytes are downloaded lazily; without a cached path we cannot render
    // here. Callers resolve the path via the media cache after downloading.
    return null
  }

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

  formatFileSize(bytes?: number): string {
    if (!bytes) return "unknown size"
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  async renderMediaIndicator(media: MediaAttachment): Promise<string[]> {
    const icon = this.getMediaIcon(media.type)
    const filename = media.filename || `${media.type}.${this.getExtension(media.mimetype)}`
    const size = this.formatFileSize(media.filesize)
    
    return [
      `${icon} ${filename} (${size}) ['space' to open]`
    ]
  }

  async renderASCIIThumbnail(media: MediaAttachment, width: number = 40): Promise<string[]> {
    if (media.type !== 'image') {
      return this.renderMediaIndicator(media)
    }

    try {
      // Get cached file path
      const filePath = this.getCachedMediaPath(media)
      if (!filePath) {
        return this.renderMediaIndicator(media)
      }

      // Use jp2a (JPEG to ASCII) or similar tool
      // Requires: jp2a installed (apt-get install jp2a or brew install jp2a)
      const { stdout } = await execAsync(`jp2a --width=${width} "${filePath}" 2>/dev/null || convert "${filePath}" txt:- | head -n 20`)
      
      const icon = this.getMediaIcon(media.type)
      const filename = media.filename || "image"
      const size = this.formatFileSize(media.filesize)
      
      const asciiLines = stdout.split('\n').slice(0, 15) // Limit height
      
      return [
        ...asciiLines,
        `${icon} ${filename} (${size}) ['space' to open]`
      ]
    } catch (err) {
      // ASCII art not supported, fall back to indicator
      return this.renderMediaIndicator(media)
    }
  }

  async renderKittyImage(media: MediaAttachment, maxWidth: number = 80): Promise<string[]> {
    if (media.type !== 'image') {
      return this.renderMediaIndicator(media)
    }

    try {
      // Get cached file path
      const filePath = this.getCachedMediaPath(media)
      if (!filePath) {
        return this.renderMediaIndicator(media)
      }

      // Read image file and convert to base64
      const imageBuffer = readFileSync(filePath)
      const base64Data = imageBuffer.toString('base64')

      // Kitty graphics protocol: transmit base64 directly with chunking if needed
      // Using action=T (transmit) and format=100 (PNG/JPEG auto-detect)
      const kittyCmd = `\x1b_Gf=100,a=T,t=d;${base64Data}\x1b\\`
      
      const icon = this.getMediaIcon(media.type)
      const filename = media.filename || "image"
      const size = this.formatFileSize(media.filesize)
      
      return [
        kittyCmd,
        `${icon} ${filename} (${size}) ['space' to open]`
      ]
    } catch (err) {
      console.error("Kitty render error:", err)
      return this.renderMediaIndicator(media)
    }
  }

  async renderITerm2Image(media: MediaAttachment, maxWidth: number = 80): Promise<string[]> {
    if (media.type !== 'image') {
      return this.renderMediaIndicator(media)
    }

    try {
      // Get cached file path
      const filePath = this.getCachedMediaPath(media)
      if (!filePath) {
        return this.renderMediaIndicator(media)
      }

      // Read image file and convert to base64
      const imageBuffer = readFileSync(filePath)
      const base64Data = imageBuffer.toString('base64')

      // iTerm2 inline images protocol
      // Format: \x1b]1337;File=inline=1;width=<chars>ch;height=auto:<base64>\x07
      const iterm2Cmd = `\x1b]1337;File=inline=1;width=${maxWidth}ch;height=auto:${base64Data}\x07`
      
      const icon = this.getMediaIcon(media.type)
      const filename = media.filename || "image"
      const size = this.formatFileSize(media.filesize)
      
      return [
        iterm2Cmd,
        `${icon} ${filename} (${size}) ['space' to open]`
      ]
    } catch (err) {
      console.error("iTerm2 render error:", err)
      return this.renderMediaIndicator(media)
    }
  }

  async renderSixelImage(media: MediaAttachment, maxWidth: number = 80): Promise<string[]> {
    if (media.type !== 'image') {
      return this.renderMediaIndicator(media)
    }

    try {
      // Get cached file path
      const filePath = this.getCachedMediaPath(media)
      if (!filePath) {
        return this.renderMediaIndicator(media)
      }

      // Use ImageMagick to convert to sixel
      // Requires: imagemagick with sixel support
      const { stdout } = await execAsync(`convert "${filePath}" -resize ${maxWidth}x sixel:-`)
      
      const icon = this.getMediaIcon(media.type)
      const filename = media.filename || "image"
      const size = this.formatFileSize(media.filesize)
      
      return [
        stdout, // Sixel data
        `${icon} ${filename} (${size}) ['space' to open]`
      ]
    } catch (err) {
      // Sixel not supported, fall back to indicator
      return this.renderMediaIndicator(media)
    }
  }

  async render(media: MediaAttachment, maxWidth: number = 80): Promise<string[]> {
    switch (this.displayMode) {
      case 'kitty':
        return this.renderKittyImage(media, maxWidth)
      case 'iterm2':
        return this.renderITerm2Image(media, maxWidth)
      case 'sixel':
        return this.renderSixelImage(media, maxWidth)
      case 'ascii':
        return this.renderASCIIThumbnail(media, maxWidth)
      case 'http':
        return this.renderHTTPMode(media)
      case 'indicator':
      default:
        return this.renderMediaIndicator(media)
    }
  }
  
  async renderHTTPMode(media: MediaAttachment): Promise<string[]> {
    try {
      // Start media server if not running
      const serverUrl = await mediaServer.start()
      
      const icon = this.getMediaIcon(media.type)
      const filename = media.filename || "media"
      const size = this.formatFileSize(media.filesize)
      
      return [
        `${icon} ${filename} (${size})`,
        `📱 View in browser: ${serverUrl}`,
        `['space' to open]`
      ]
    } catch (err) {
      return this.renderMediaIndicator(media)
    }
  }

  async openMedia(filePath: string): Promise<void> {
    const platform = process.platform
    let command: string

    if (platform === 'darwin') {
      command = `open "${filePath}"`
    } else if (platform === 'win32') {
      command = `start "" "${filePath}"`
    } else {
      command = `xdg-open "${filePath}"`
    }

    try {
      await execAsync(command)
    } catch (err) {
      console.error("Failed to open media:", err)
    }
  }

  private getExtension(mimetype: string): string {
    const parts = mimetype.split('/')
    return parts[1] || 'bin'
  }
}
