import { createHash } from "node:crypto"
import { existsSync, rmSync } from "node:fs"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

/**
 * Default on-disk location for cached media. The directory is created lazily on
 * the first write; importing this module performs **no** filesystem I/O.
 */
const DEFAULT_CACHE_DIR = resolve(process.cwd(), ".media-cache")

/** Extensions we may append to a cached file, derived from its MIME type. */
const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "audio/webm": ".webm",
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
}

/** Extensions probed when a MIME type is unknown/absent. */
const PROBE_EXTENSIONS: string[] = [
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".mp4",
  ".webm",
  ".mov",
  ".mp3",
  ".ogg",
  ".wav",
  ".pdf",
  ".doc",
  ".docx",
  "",
]

/** Options accepted by {@link MediaCache}. */
export interface MediaCacheOptions {
  /** Directory used to store cached files. Defaults to `<cwd>/.media-cache`. */
  directory?: string
  /** Maximum number of files kept in the in-memory index before LRU eviction. */
  maxEntries?: number
}

/**
 * On-disk + in-memory cache for downloaded chat media.
 *
 * Design notes (PLAN §4.6 / M4):
 * - Constructing the cache does **not** touch the filesystem.
 * - Writes are async and atomic (`tmp` file + `rename`).
 * - Filenames are deterministic SHA-1 hashes of a logical key, so they can
 *   never contain path separators or traversal sequences.
 * - A bounded, LRU-ish in-memory index keeps lookups fast without unbounded
 *   memory growth.
 *
 * Two key shapes are supported for backwards compatibility:
 * - **Message-id based (preferred):** `get(messageId, mimetype)` /
 *   `cache(messageId, data, mimetype)` — the frozen `MediaAttachment.messageId`
 *   contract used by the renderer.
 * - **Legacy chat/file based:** `get(chatName, filename, timestamp, mimetype)` /
 *   `cache(chatName, filename, timestamp, data, mimetype)`.
 */
export class MediaCache {
  private readonly cacheDir: string
  private readonly maxEntries: number
  /** Logical key -> absolute file path. Insertion order tracks recency (LRU). */
  private readonly index = new Map<string, string>()

  constructor(options: MediaCacheOptions = {}) {
    this.cacheDir = options.directory ? resolve(options.directory) : DEFAULT_CACHE_DIR
    this.maxEntries = options.maxEntries ?? 512
  }

  /** Absolute path of the directory backing this cache. */
  getCacheDir(): string {
    return this.cacheDir
  }

  /**
   * Look up a cached file.
   *
   * @param messageId Message id whose media should be resolved.
   * @param mimetype  Optional MIME type used to derive the file extension.
   * @returns The absolute file path, or `null` when not cached.
   */
  get(messageId: string, mimetype?: string): string | null
  /**
   * Look up a cached file using the legacy chat/file/timestamp key.
   *
   * @returns The absolute file path, or `null` when not cached.
   */
  get(chatName: string, filename: string, timestamp: number, mimetype: string): string | null
  get(...args: unknown[]): string | null {
    const { key, mimetype } = resolveKey(args)
    const cached = this.index.get(key)
    if (cached && existsSync(cached)) {
      this.touch(key, cached)
      return cached
    }

    const extension = mimetype ? this.getExtensionFromMimetype(mimetype) : undefined
    const candidates = extension !== undefined ? [extension] : PROBE_EXTENSIONS
    for (const ext of candidates) {
      const filePath = this.pathFor(key, ext)
      if (existsSync(filePath)) {
        this.touch(key, filePath)
        return filePath
      }
    }
    return null
  }

  /**
   * Whether media for the given key is already cached.
   *
   * @param messageId Message id whose media should be checked.
   * @param mimetype  Optional MIME type used to derive the file extension.
   */
  has(messageId: string, mimetype?: string): boolean
  /** Legacy key variant of {@link has}. */
  has(chatName: string, filename: string, timestamp: number, mimetype: string): boolean
  has(...args: unknown[]): boolean {
    return this.get(...(args as [string, string, number, string])) !== null
  }

  /**
   * Persist media bytes and return the cached file path.
   *
   * @param messageId Message id used as the cache key.
   * @param data      Raw media bytes.
   * @param mimetype  MIME type used to derive the file extension.
   * @param filename  Optional original filename (informational only).
   */
  cache(messageId: string, data: Buffer, mimetype: string, filename?: string): Promise<string>
  /** Legacy key variant of {@link cache}. */
  cache(
    chatName: string,
    filename: string,
    timestamp: number,
    data: Buffer,
    mimetype: string,
  ): Promise<string>
  async cache(...args: unknown[]): Promise<string> {
    const { key, data, mimetype } = resolveCacheArgs(args)
    const extension = this.getExtensionFromMimetype(mimetype)
    const filePath = this.pathFor(key, extension)

    await mkdir(this.cacheDir, { recursive: true })

    const tmpPath = join(
      this.cacheDir,
      `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    )
    await writeFile(tmpPath, data)
    await rename(tmpPath, filePath)

    this.touch(key, filePath)
    this.evictIfNeeded()
    return filePath
  }

  /**
   * Remove every cached file and reset the in-memory index.
   *
   * Kept synchronous to preserve the existing `mediaCache.clear()` call site.
   * All errors are swallowed: a failed cleanup must never crash the TUI.
   */
  clear(): void {
    this.index.clear()
    try {
      rmSync(this.cacheDir, { recursive: true, force: true })
    } catch {
      // Best effort only.
    }
  }

  /** Alias of {@link clear} for call sites that prefer the explicit name. */
  clearCache(): void {
    this.clear()
  }

  /** Async variant of {@link clear}, useful when a caller can await cleanup. */
  async clearAsync(): Promise<void> {
    this.index.clear()
    try {
      await rm(this.cacheDir, { recursive: true, force: true })
    } catch {
      // Best effort only.
    }
  }

  /** Number of entries currently held in the in-memory index. */
  size(): number {
    return this.index.size
  }

  /** Move an entry to the most-recently-used end of the index. */
  private touch(key: string, filePath: string): void {
    this.index.delete(key)
    this.index.set(key, filePath)
  }

  /** Drop the oldest entries (and their files) once the bound is exceeded. */
  private evictIfNeeded(): void {
    while (this.index.size > this.maxEntries) {
      const oldest = this.index.keys().next()
      if (oldest.done) return
      const key = oldest.value
      const path = this.index.get(key)
      this.index.delete(key)
      if (path) {
        void rm(path, { force: true }).catch(() => {
          // Best effort only.
        })
      }
    }
  }

  /** Deterministic, path-safe absolute path for a key + extension. */
  private pathFor(key: string, extension: string): string {
    const hash = createHash("sha1").update(key).digest("hex")
    return join(this.cacheDir, `${hash}${extension}`)
  }

  private getExtensionFromMimetype(mimetype: string): string {
    return MIME_EXTENSIONS[mimetype] ?? ""
  }
}

/** Resolve the legacy vs. message-id `get`/`has` argument shapes. */
function resolveKey(args: unknown[]): { key: string; mimetype?: string } {
  if (args.length >= 3) {
    const [chatName, filename, timestamp, mimetype] = args as [string, string, number, string]
    return { key: `${chatName}_${filename}_${timestamp}`, mimetype }
  }
  const [messageId, mimetype] = args as [string, string | undefined]
  return { key: `msg:${messageId}`, mimetype }
}

/** Resolve the legacy vs. message-id `cache` argument shapes. */
function resolveCacheArgs(args: unknown[]): { key: string; data: Buffer; mimetype: string } {
  if (typeof args[1] === "string") {
    const [chatName, filename, timestamp, data, mimetype] = args as [
      string,
      string,
      number,
      Buffer,
      string,
    ]
    return { key: `${chatName}_${filename}_${timestamp}`, data, mimetype }
  }
  const [messageId, data, mimetype] = args as [string, Buffer, string]
  return { key: `msg:${messageId}`, data, mimetype }
}

/**
 * Shared singleton cache used across the application. Constructing it performs
 * no I/O, so importing this module is safe at startup.
 */
export const mediaCache = new MediaCache()
