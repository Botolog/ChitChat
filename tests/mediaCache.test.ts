import "./setup"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { MediaCache } from "../src/utils/mediaCache"

let dir: string
let cache: MediaCache

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chitchat-mediacache-"))
  cache = new MediaCache({ directory: dir })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function isInside(parent: string, child: string): boolean {
  const base = resolve(parent)
  const target = resolve(child)
  return target === base || target.startsWith(base + sep)
}

describe("MediaCache", () => {
  test("getCacheDir resolves the configured directory", () => {
    expect(cache.getCacheDir()).toBe(resolve(dir))
  })

  test("constructor performs no filesystem I/O", () => {
    const nested = join(dir, "not-created")
    const lazy = new MediaCache({ directory: nested })
    expect(existsSync(nested)).toBe(false)
    expect(lazy.get("missing")).toBeNull()
    expect(existsSync(nested)).toBe(false)
  })

  test("message-id cache() -> get()/has() round-trip", async () => {
    const data = Buffer.from("image-bytes")
    const path = await cache.cache("msg-1", data, "image/png")

    expect(isInside(dir, path)).toBe(true)
    expect(path.endsWith(".png")).toBe(true)
    expect(await readFile(path, "utf-8")).toBe("image-bytes")

    expect(cache.get("msg-1", "image/png")).toBe(path)
    expect(cache.has("msg-1", "image/png")).toBe(true)
  })

  test("message-id get() without a mimetype probes known extensions", async () => {
    const path = await cache.cache("msg-probe", Buffer.from("x"), "image/jpeg")
    expect(cache.get("msg-probe")).toBe(path)
  })

  test("get() returns null for an unknown key", () => {
    expect(cache.get("never-cached")).toBeNull()
    expect(cache.has("never-cached")).toBe(false)
  })

  test("legacy chat/file/timestamp overload round-trips", async () => {
    const data = Buffer.from("legacy")
    const path = await cache.cache("chat-a", "photo.png", 1700000000, data, "image/png")
    expect(await readFile(path, "utf-8")).toBe("legacy")
    expect(cache.get("chat-a", "photo.png", 1700000000, "image/png")).toBe(path)
    expect(cache.has("chat-a", "photo.png", 1700000000, "image/png")).toBe(true)
    // A different timestamp is a different key.
    expect(cache.get("chat-a", "photo.png", 1700000001, "image/png")).toBeNull()
  })

  test("unknown mimetypes cache under an extensionless hashed name", async () => {
    const path = await cache.cache("msg-bin", Buffer.from("bin"), "application/octet-stream")
    expect(path.endsWith(".png") || path.endsWith(".jpg")).toBe(false)
    expect(existsSync(path)).toBe(true)
    expect(cache.get("msg-bin")).toBe(path)
  })

  test("clear() removes files and resets the index", async () => {
    const path = await cache.cache("msg-2", Buffer.from("bye"), "image/png")
    expect(cache.size()).toBe(1)
    expect(existsSync(path)).toBe(true)

    cache.clear()

    expect(cache.size()).toBe(0)
    expect(existsSync(path)).toBe(false)
    expect(cache.get("msg-2")).toBeNull()
    expect(cache.has("msg-2")).toBe(false)
  })

  test("clearCache() is an alias of clear()", async () => {
    await cache.cache("msg-3", Buffer.from("z"), "image/png")
    cache.clearCache()
    expect(cache.size()).toBe(0)
    expect(existsSync(dir)).toBe(false)
  })

  test("clearAsync() removes files and can be awaited", async () => {
    const path = await cache.cache("msg-4", Buffer.from("z"), "image/png")
    await cache.clearAsync()
    expect(existsSync(path)).toBe(false)
    expect(cache.size()).toBe(0)
  })

  test("a message id containing path separators cannot escape the cache dir", async () => {
    const evil = "../../../../etc/passwd"
    const path = await cache.cache(evil, Buffer.from("nope"), "image/png")
    expect(isInside(dir, path)).toBe(true)
    expect(path).not.toContain("..")
    expect(path).not.toBe(resolve("/etc/passwd"))
  })

  test("a legacy filename containing traversal cannot escape the cache dir", async () => {
    const path = await cache.cache("chat", "../../evil.sh", 1, Buffer.from("nope"), "image/png")
    expect(isInside(dir, path)).toBe(true)
    expect(path).not.toContain("..")
  })

  test("a message id containing a dot-dot segment is also hashed safely", async () => {
    const path = await cache.cache("..", Buffer.from("nope"), "image/png")
    expect(isInside(dir, path)).toBe(true)
    expect(resolve(path)).not.toBe(resolve(dir, ".."))
  })

  test("all cached filenames are 40-char sha1 hex plus an extension", async () => {
    const path = await cache.cache("hash-check", Buffer.from("x"), "image/png")
    const name = path.slice(path.lastIndexOf(sep) + 1)
    expect(name).toMatch(/^[0-9a-f]{40}\.png$/)
  })

  test("enforces the in-memory entry bound with LRU-style eviction", async () => {
    const bounded = new MediaCache({ directory: join(dir, "bounded"), maxEntries: 2 })
    const first = await bounded.cache("a", Buffer.from("a"), "image/png")
    await bounded.cache("b", Buffer.from("b"), "image/png")
    await bounded.cache("c", Buffer.from("c"), "image/png")

    expect(bounded.size()).toBeLessThanOrEqual(2)

    // The evicted file is removed asynchronously; poll briefly.
    let gone = false
    for (let i = 0; i < 50 && !gone; i++) {
      gone = !existsSync(first)
      if (!gone) await new Promise((r) => setTimeout(r, 10))
    }
    expect(gone).toBe(true)
    expect(bounded.get("c", "image/png")).not.toBeNull()
  })

  test("re-caching the same key overwrites the file", async () => {
    const first = await cache.cache("dup", Buffer.from("one"), "image/png")
    const second = await cache.cache("dup", Buffer.from("two"), "image/png")
    expect(first).toBe(second)
    expect(cache.size()).toBe(1)
    expect(await readFile(second, "utf-8")).toBe("two")
  })
})
