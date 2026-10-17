# Media Support

ChitChat can display and open media attached to messages. Media is represented
as metadata and downloaded lazily; nothing is fetched until it is rendered or
opened.

## Data model

`src/services/types.ts` defines `MediaAttachment`:

```ts
interface MediaAttachment {
  type: "image" | "video" | "audio" | "sticker" | "document"
  mimetype: string
  filename: string
  filesize?: number
  messageId: string   // message that owns the media; used as the cache key
}
```

Messages carry an optional `media` field plus a `hasMedia` flag. The bytes are
**never** carried on the object — the UI downloads them on demand via
`MessagingService.downloadMedia(messageId, chatId)`.

## Media cache

`src/utils/mediaCache.ts` stores downloaded bytes on disk and tracks them in a
bounded in-memory index:

- Default directory `<cwd>/.media-cache`; constructed lazily (no I/O at import).
- Preferred key: `msg:<messageId>`. A legacy `chat_file_timestamp` key shape is
  also supported.
- Filenames are deterministic **SHA-1 hashes** of the key, so they can never
  contain path separators or traversal sequences.
- Writes are atomic (`tmp` file + `rename`).
- An LRU-ish index (default 512 entries) keeps lookups fast and evicts old files.
- `clear()` / `clearAsync()` wipe the cache (wired to Settings → Actions →
  Clear Media Cache).

## Terminal capability detection

`src/utils/terminalCapabilities.ts` inspects `TERM`, `TERM_PROGRAM` and
`COLORTERM` and reports Kitty/iTerm2/Sixel and colour support.
`getOptimalDisplayMode()` picks the best supported mode; the settings value
`auto` resolves through it when a service is entered.

## Display modes

`mediaDisplayMode` selects the renderer used for each attachment:

| Mode | Output | Requires |
|------|--------|----------|
| `auto` | Best mode for the current terminal (resolved at service entry) | — |
| `indicator` | Icon + filename + size + open hint | — |
| `ascii` | ASCII-art preview, then the indicator line | cached image + `jp2a` |
| `kitty` | Inline image (Kitty graphics protocol) | Kitty/WezTerm + cached image |
| `iterm2` | Inline image (OSC 1337) | iTerm2 + cached image |
| `sixel` | Sixel graphics | Sixel terminal + cached image + ImageMagick `convert` |
| `http` | Local browser gallery link | — |

`MediaRenderer` (`src/utils/mediaRenderer.ts`) never throws: if the cached file
is missing or a helper tool is unavailable, every image mode degrades to the
ASCII preview and then to the plain indicator.

Implementation details:

- **Kitty** – PNG data is transmitted inline as base64 in `m=1`/`m=0` chunks of
  4096 bytes (`f=100`, `a=T`); formats Kitty cannot decode inline (JPEG/GIF/
  WebP/BMP) are sent by file reference (`t=f`).
- **iTerm2** – `OSC 1337;File=inline=1;...:<base64>` with the filename and size
  encoded per the specification.
- **Sixel** – `convert <file> -resize <width>x sixel:-`, normalized into a DCS
  sequence terminated with ST.
- **ASCII** – `jp2a --width=<n> --height=20 <file>`, capped to 15 lines.
- All helper processes run with a 5 s timeout and a bounded buffer, so they
  cannot leak or hang the TUI.

## Download and open flow

1. Pressing the open-media key (default `Enter`, see
   [KEYBINDINGS.md](KEYBINDINGS.md)) on a selected message calls
   `handleOpenMedia()` in `src/input/mediaActions.ts`.
2. `ensureMediaCached()` returns the cached path, or downloads via
   `downloadMedia()` and re-caches the bytes under the message id.
3. In HTTP mode the gallery server is started and the browser is opened;
   otherwise the cached file is opened with the platform handler
   (`xdg-open` / `open` / `start`).

`autoDownloadMediaOnEnter` (Settings → Chat) pre-downloads a chat's media when
the chat is opened, so images are ready for inline rendering.

## Local HTTP gallery

`src/utils/mediaServer.ts` is a loopback-only (`127.0.0.1`) server used by HTTP
mode:

- Serves an HTML gallery at `/` and files at `/media/<name>`.
- Starts on port `8765`, walking forward on `EADDRINUSE` (up to 10 retries).
- Rejects path traversal (including percent-encoded forms) with `403`.
- HTML-escapes every dynamic value in the gallery.
- Sends `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`.
- `stop()` closes the server and clears its timers; it performs no filesystem
  work at import time.

## Settings

Stored in `.chitchat-settings.json`:

| Setting | Values | Status |
|---------|--------|--------|
| `mediaDisplayMode` | `auto`, `indicator`, `ascii`, `kitty`, `iterm2`, `sixel`, `http` | Used to pick the renderer |
| `autoDownloadMediaOnEnter` | boolean | Used to pre-download a chat's media |
| `autoDownloadMedia` | `always`, `wifi`, `never` | Persisted |
| `mediaQuality` | `low`, `medium`, `high` | Persisted |
| `showMediaThumbnails` | boolean | Persisted |
| `maxThumbnailSize` | pixels | Persisted |

## Optional external tools

- **`jp2a`** – ASCII-art previews (`apt install jp2a` / `brew install jp2a`).
- **ImageMagick `convert`** – Sixel output (`apt install imagemagick`).

Without them, the corresponding modes simply fall back to the indicator line.

## Backend support

Only backends declaring `downloadMedia` in their capabilities can fetch media —
currently WhatsApp. Messages with media on a backend without download support
still render the indicator, but opening them reports the failure in the status
bar.
