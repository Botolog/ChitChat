import "./setup"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MediaServer } from "../src/utils/mediaServer"

/** Bind an ephemeral-ish port and let the server walk forward on collisions. */
function randomPort(): number {
  return 20000 + Math.floor(Math.random() * 30000)
}

async function withServer(
  fn: (ctx: { server: MediaServer; url: string; dir: string }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "chitchat-mediaserver-"))
  writeFileSync(join(dir, "ok.png"), "PNG-CONTENT")
  const server = new MediaServer({ directory: dir, port: randomPort(), maxRetries: 25 })
  try {
    const url = await server.start()
    await fn({ server, url, dir })
  } finally {
    await server.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("MediaServer", () => {
  test("binds loopback (127.0.0.1) not a wildcard address", async () => {
    await withServer(async ({ url }) => {
      expect(url.startsWith("http://127.0.0.1:")).toBe(true)
      expect(url).not.toContain("0.0.0.0")
    })
  })

  test("reports the actual bound port when constructed with port 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chitchat-mediaserver-"))
    const server = new MediaServer({ directory: dir, port: 0 })
    try {
      const url = await server.start()
      expect(url.startsWith("http://127.0.0.1:")).toBe(true)
      expect(url).not.toContain(":0")
      const res = await fetch(url + "/")
      expect(res.status).toBe(200)
      await res.text()
    } finally {
      await server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("isRunning() reflects start()/stop() and stop() is idempotent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chitchat-mediaserver-"))
    const server = new MediaServer({ directory: dir, port: randomPort(), maxRetries: 25 })
    try {
      expect(server.isRunning()).toBe(false)
      await server.start()
      expect(server.isRunning()).toBe(true)
      expect(server.getUrl()).not.toBeNull()

      await server.stop()
      expect(server.isRunning()).toBe(false)
      expect(server.getUrl()).toBeNull()

      await server.stop() // idempotent
      expect(server.isRunning()).toBe(false)
    } finally {
      await server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("start() is idempotent and returns the same URL", async () => {
    await withServer(async ({ server, url }) => {
      expect(await server.start()).toBe(url)
    })
  })

  test("serves a normal file under the directory", async () => {
    await withServer(async ({ url }) => {
      const res = await fetch(`${url}/media/ok.png`)
      expect(res.status).toBe(200)
      expect(await res.text()).toBe("PNG-CONTENT")
      expect(res.headers.get("content-type")).toBe("image/png")
    })
  })

  test("returns 404 for a missing file", async () => {
    await withServer(async ({ url }) => {
      const res = await fetch(`${url}/media/missing.png`)
      expect(res.status).toBe(404)
    })
  })

  test("rejects percent-encoded traversal (..%2f..%2fetc%2fpasswd)", async () => {
    await withServer(async ({ url }) => {
      const res = await fetch(`${url}/media/..%2f..%2fetc%2fpasswd`)
      expect(res.status).not.toBe(200)
      const body = await res.text()
      expect(body).not.toContain("root:")
    })
  })

  test("rejects literal traversal (/media/../../etc/passwd)", async () => {
    await withServer(async ({ url }) => {
      const res = await fetch(`${url}/media/../../etc/passwd`)
      expect(res.status).not.toBe(200)
      expect(await res.text()).not.toContain("root:")
    })
  })

  test("rejects null-byte and backslash smuggling", async () => {
    await withServer(async ({ url }) => {
      const nul = await fetch(`${url}/media/ok.png%00.jpg`)
      expect(nul.status).not.toBe(200)

      const backslash = await fetch(`${url}/media/..%5c..%5cetc%5cpasswd`)
      expect(backslash.status).not.toBe(200)
    })
  })

  test("GET / renders the gallery and HTML-escapes hostile filenames", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chitchat-mediaserver-"))
    writeFileSync(join(dir, "<b>.png"), "x")
    const server = new MediaServer({ directory: dir, port: randomPort(), maxRetries: 25 })
    try {
      const url = await server.start()
      const res = await fetch(`${url}/`)
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain("&lt;b&gt;.png")
      expect(html).not.toContain("<b>.png")
    } finally {
      await server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("non-GET/HEAD methods are rejected with 405", async () => {
    await withServer(async ({ url }) => {
      const res = await fetch(`${url}/media/ok.png`, { method: "POST", body: "x" })
      expect(res.status).toBe(405)
    })
  })

  test("unknown routes return 404", async () => {
    await withServer(async ({ url }) => {
      const res = await fetch(`${url}/nope`)
      expect(res.status).toBe(404)
    })
  })
})
