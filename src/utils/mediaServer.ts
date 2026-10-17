import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { readFile, readdir, stat } from "node:fs/promises"
import { extname, join, resolve, sep } from "node:path"
import { mediaCache } from "./mediaCache"
import { logger } from "./logger"

/** Loopback only — never expose cached media to the network (PLAN M1). */
const BIND_HOST = "127.0.0.1"
/** How long to wait for in-flight connections to drain on `stop()`. */
const CLOSE_GRACE_MS = 2000

/** Construction options for {@link MediaServer}. */
export interface MediaServerOptions {
  /** Preferred TCP port. Defaults to `8765`; bumped when already in use. */
  port?: number
  /** Directory to serve. Defaults to {@link mediaCache}'s cache directory. */
  directory?: string
  /** Maximum number of consecutive `EADDRINUSE` retries. Defaults to `10`. */
  maxRetries?: number
}

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
}

/**
 * Local HTTP gallery + media file server.
 *
 * Hardened per PLAN M1: binds to `127.0.0.1`, rejects any request path that
 * escapes the media directory (including percent-encoded traversal), HTML-escapes
 * all dynamic gallery text, exposes a `stop()` that closes the server and clears
 * timers, and performs no filesystem work at import time.
 */
export class MediaServer {
  private server: Server | null = null
  private url: string | null = null
  private port: number
  private startPromise: Promise<string> | null = null
  private readonly timers = new Set<NodeJS.Timeout>()
  private readonly maxRetries: number

  constructor(private readonly options: MediaServerOptions = {}) {
    this.port = options.port ?? 8765
    this.maxRetries = options.maxRetries ?? 10
  }

  /** Absolute directory served by this instance. */
  private get mediaDir(): string {
    return this.options.directory ? resolve(this.options.directory) : mediaCache.getCacheDir()
  }

  /**
   * Start the server (idempotent). Resolves with the loopback base URL.
   *
   * @returns Base URL, e.g. `http://127.0.0.1:8765`.
   */
  start(): Promise<string> {
    if (this.server && this.url) return Promise.resolve(this.url)
    if (this.startPromise) return this.startPromise

    this.startPromise = this.listenWithRetry(this.port, this.maxRetries).finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  /**
   * Stop the server and clear all timers (idempotent). Safe to call multiple
   * times and to call `start()` again afterwards.
   */
  async stop(): Promise<void> {
    this.clearTimers()

    const server = this.server
    this.server = null
    this.url = null

    if (!server) return

    await new Promise<void>((resolveClose) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        if (timer) {
          clearTimeout(timer)
          this.timers.delete(timer)
        }
        resolveClose()
      }

      const timer = setTimeout(finish, CLOSE_GRACE_MS)
      timer.unref?.()
      this.timers.add(timer)

      server.close(() => finish())
      // Drop lingering keep-alive sockets so close() resolves promptly.
      server.closeAllConnections?.()
    })

    logger.info("MediaServer", "Stopped")
  }

  /** Current base URL, or `null` when not running. */
  getUrl(): string | null {
    return this.url
  }

  /** Whether the server is currently listening. */
  isRunning(): boolean {
    return this.server !== null
  }

  /** Bind `port`, walking forward on `EADDRINUSE` up to `remaining` retries. */
  private listenWithRetry(port: number, remaining: number): Promise<string> {
    return new Promise<string>((resolveStart, rejectStart) => {
      const server = createServer((req, res) => {
        void this.handleRequest(req, res)
      })

      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener("listening", onListening)
        if (err.code === "EADDRINUSE" && remaining > 0) {
          try {
            server.close()
          } catch {
            // Never listened; nothing to close.
          }
          this.listenWithRetry(port + 1, remaining - 1).then(resolveStart, rejectStart)
        } else {
          rejectStart(err)
        }
      }

      const onListening = (): void => {
        server.removeListener("error", onError)
        server.on("error", (err) => {
          logger.error("MediaServer", "Server error", err)
        })
        this.server = server
        this.port = port
        this.url = `http://${BIND_HOST}:${port}`
        logger.info("MediaServer", "Started", { url: this.url })
        resolveStart(this.url)
      }

      server.once("error", onError)
      server.once("listening", onListening)
      server.listen(port, BIND_HOST)
    })
  }

  /** Route a single HTTP request. */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const method = req.method ?? "GET"
      if (method !== "GET" && method !== "HEAD") {
        this.send(res, 405, "Method not allowed")
        return
      }

      const url = new URL(req.url ?? "/", `http://${BIND_HOST}`)

      if (url.pathname === "/" || url.pathname === "/index.html") {
        await this.serveGallery(res)
        return
      }

      if (url.pathname.startsWith("/media/")) {
        await this.serveMedia(url.pathname.slice("/media/".length), res)
        return
      }

      this.send(res, 404, "Not found")
    } catch (err) {
      logger.error("MediaServer", "Request failed", err)
      if (res.headersSent) {
        res.end()
      } else {
        this.send(res, 500, "Server error")
      }
    }
  }

  /** Render the escaped HTML gallery listing cached images/videos. */
  private async serveGallery(res: ServerResponse): Promise<void> {
    let names: string[] = []
    try {
      names = await readdir(this.mediaDir)
    } catch {
      names = []
    }

    const items: GalleryItem[] = []
    for (const name of names.filter(isImageOrVideo)) {
      try {
        const info = await stat(join(this.mediaDir, name))
        if (!info.isFile()) continue
        items.push({
          name,
          url: `/media/${encodeURIComponent(name)}`,
          size: info.size,
          kind: isVideo(name) ? "video" : "image",
        })
      } catch {
        // Skip unreadable entries.
      }
    }

    const cards = items
      .map((item) => {
        const url = escapeHtml(item.url)
        const name = escapeHtml(item.name)
        const media =
          item.kind === "image"
            ? `<img src="${url}" alt="${name}" data-url="${url}">`
            : `<video src="${url}" controls></video>`
        return `
      <div class="item">
        ${media}
        <div class="item-info">
          <div class="item-name">${name}</div>
          <div>${(item.size / 1024).toFixed(1)} KB</div>
        </div>
      </div>`
      })
      .join("")

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Media Gallery - ChitChat</title>
  <style>
    body { margin: 0; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0d1117; color: #c9d1d9; }
    h1 { text-align: center; color: #58a6ff; }
    .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 20px; padding: 20px; }
    .item { background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; transition: transform 0.2s; }
    .item:hover { transform: scale(1.05); border-color: #58a6ff; }
    .item img, .item video { width: 100%; height: 200px; object-fit: cover; cursor: pointer; }
    .item-info { padding: 10px; font-size: 12px; color: #8b949e; }
    .item-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 5px; color: #c9d1d9; }
    .modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.9); z-index: 1000; align-items: center; justify-content: center; }
    .modal.active { display: flex; }
    .modal img { max-width: 90%; max-height: 90%; }
    .modal-close { position: absolute; top: 20px; right: 30px; color: white; font-size: 40px; cursor: pointer; }
  </style>
</head>
<body>
  <h1>📁 Media Gallery</h1>
  <div class="gallery">${cards}
  </div>
  <div class="modal" id="modal">
    <span class="modal-close" id="modal-close">&times;</span>
    <img id="modal-img" src="" alt="">
  </div>
  <script>
    const modal = document.getElementById('modal');
    const modalImg = document.getElementById('modal-img');
    document.querySelectorAll('img[data-url]').forEach((img) => {
      img.addEventListener('click', () => { modalImg.src = img.dataset.url; modal.classList.add('active'); });
    });
    const close = () => modal.classList.remove('active');
    modal.addEventListener('click', close);
    document.getElementById('modal-close').addEventListener('click', close);
  </script>
</body>
</html>`

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    res.end(html)
  }

  /** Serve one cached media file, rejecting any traversal attempt. */
  private async serveMedia(rawName: string, res: ServerResponse): Promise<void> {
    const filePath = this.resolveSafePath(rawName)
    if (!filePath) {
      this.send(res, 403, "Forbidden")
      return
    }

    try {
      const info = await stat(filePath)
      if (!info.isFile()) {
        this.send(res, 404, "Not found")
        return
      }
      const data = await readFile(filePath)
      res.writeHead(200, {
        "Content-Type": CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": data.length,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      })
      res.end(data)
    } catch {
      this.send(res, 404, "Not found")
    }
  }

  /**
   * Resolve a request path against the media directory, returning `null` when
   * it escapes that directory (after a single decode) or contains hostile
   * characters.
   */
  private resolveSafePath(encodedRelative: string): string | null {
    let decoded: string
    try {
      decoded = decodeURIComponent(encodedRelative)
    } catch {
      return null
    }

    if (decoded.includes("\0") || decoded.includes("\\")) return null

    const base = resolve(this.mediaDir)
    const target = resolve(base, decoded)
    if (target !== base && !target.startsWith(base + sep)) return null
    return target
  }

  /** Write a small plain-text response. */
  private send(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" })
    res.end(body)
  }

  /** Clear and forget all outstanding timers. */
  private clearTimers(): void {
    for (const timer of this.timers) {
      clearTimeout(timer)
    }
    this.timers.clear()
  }
}

interface GalleryItem {
  name: string
  url: string
  size: number
  kind: "image" | "video"
}

function isVideo(filename: string): boolean {
  return [".mp4", ".webm", ".mov"].includes(extname(filename).toLowerCase())
}

function isImageOrVideo(filename: string): boolean {
  return [
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".mp4",
    ".webm",
    ".mov",
  ].includes(extname(filename).toLowerCase())
}

/** Escape a string for safe interpolation into HTML text or attribute contexts. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;"
      case "<":
        return "&lt;"
      case ">":
        return "&gt;"
      case '"':
        return "&quot;"
      default:
        return "&#39;"
    }
  })
}

/**
 * Shared singleton server. Constructing it performs no I/O (no `mkdir`, no
 * `listen`); the cache directory is only read lazily on the first request.
 */
export const mediaServer = new MediaServer()
