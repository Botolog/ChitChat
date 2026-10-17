# Architecture

ChitChat is a terminal (TUI) messaging client built on
[OpenTUI](https://github.com/sst/opentui) and the
[Bun](https://bun.sh) runtime. This document maps the codebase and the contracts
that hold it together.

## Module map

```
src/
  index.ts        entry point: --help / --demo detection, bootstrap(), fatal handler
  settings.ts     AppSettings schema, defaults, validation, atomic persistence, SETTINGS_PAGES
  keybindings.ts  KeyBindings model, defaults, validation, matchesKeybinding(), formatKeybinding()
  app/
    bootstrap.ts  creates the renderer + AppContext, wires resize/keys/signals, starts the loop
    context.ts    AppContext / AppConfig / Dimensions — the single shared object graph
    state.ts      AppState (plain data) + createInitialState()
    theme.ts      ThemeManager: active palette, setServiceTheme()
    demo.ts       DEMO_CHATS / DEMO_MESSAGES fixtures for --demo
    views.ts      view transitions (main menu ↔ service) and main-menu key handling
    serviceEvents.ts  maps service events (qr/ready/message/…) onto UI updates
    lifecycle.ts  bounded owner of every timer and one-shot disposer
    signals.ts    process signal/error handlers + idempotent terminal cleanup
    shutdown.ts   graceful shutdown: cancel timers, stop media, destroy services, exit
  ui/
    layout.ts         builds every persistent renderable; handles resize
    mainMenu.ts       main menu (real OpenTUI components)
    chatList.ts       chat-list rendering + selection
    messageList.ts    message scroll area, message bubbles, media rendering
    chatHeader.ts     selected-chat header (name + typing/count)
    inputBar.ts       message input area and send wiring
    statusBar.ts      single status line with a cancellable transient revert
    settingsView.ts   settings pages, toggles/selects, keybinding capture
    help.ts           "?" help overlay (printed straight to the console)
    renderable-utils.ts  OpenTUI 0.6 remove-by-id helper
    modals/confirmModal.ts  reusable confirm/key-capture overlay
    modals/qrModal.ts       QR overlay shown during WhatsApp auth
  input/
    dispatcher.ts     the only keypress listener; ordered router (see precedence)
    navigation.ts     input focus, escape handling, reply/enter/edit navigation
    messageActions.ts message navigation + delete/edit/reply actions
    mediaActions.ts   media download/cache/open helpers
    chatActions.ts    chat selection, refresh, pin/mute/archive, quick-select
  services/
    types.ts        shared data contract + MessagingService interface + event names
    capabilities.ts ServiceCapabilities + NO_CAPABILITIES
    base.ts         BaseMessagingService: readiness, QR, timers, timeouts, teardown
    whatsapp.ts     WhatsApp backend (whatsapp-web.js + Puppeteer)
    slack.ts        Slack backend (@slack/web-api + @slack/socket-mode)
    registry.ts     static SERVICE metadata + per-service colour themes
    index.ts        service instance cache: getServiceInstance / destroyService(s)
  utils/
    logger.ts               leveled, non-throwing file logger with rotation
    terminalCapabilities.ts Kitty/iTerm2/Sixel/colour detection + getOptimalDisplayMode()
    qr.ts                   renderQrBlocks(): QR payload -> block-character string
    text.ts                 truncate / formatDate / formatFileSize helpers
    paths.ts                resolveDataPath/resolveLogPath (CHITCHAT_DATA_DIR/LOG_DIR)
    mediaCache.ts           on-disk + in-memory media cache
    mediaRenderer.ts        renders MediaAttachment for the terminal
    mediaServer.ts          loopback HTTP gallery/file server
    profileLock.ts          Chromium SingletonLock recovery + ProfileLockedError
    whatsappTabState.ts     clears WhatsApp Web's cross-window tab mutex before boot
    whatsappChats.ts        in-page chat reader that never lets one bad chat hide the list
    whatsappCompat.ts       runtime shim for the WhatsApp Web build whatsapp-web.js
                            does not support (message-key `$1` rename, throwing
                            model mappers) — installed once WWebJS is injected
  test-whatsapp.ts   standalone WhatsApp/Puppeteer smoke script (`bun run test:whatsapp`)
```

## Application context and state

Everything mutable used to be ~40 free variables inside `main()`. It now lives
in one `AppContext` (`src/app/context.ts`) that modules receive and mutate:

- **`AppContext`** — the long-lived handles: `renderer`, `dims`, `state`,
  `handles` (renderables), `theme`, `config`, `service` (active slot),
  `lifecycle`, `status`, `media` (renderer + server), `confirm`, `qr`, and the
  `shutdown` callback assigned by `bootstrap.ts`.
- **`AppConfig`** — resolved once at bootstrap and treated as read-only:
  `demoMode`, `settings`, `keybindings`, `services`, `termCapabilities`.
- **`AppState`** (`src/app/state.ts`) — plain data only (no renderables, no
  functions) so it can be created before the renderer exists and inspected in
  tests: `view`, `currentServiceId`, `chats`, `messages`, selection indices,
  `focusArea`, `isReady`, reply/edit targets, settings-page cursor, menu cursor
  and key-capture fields.

`Lifecycle` (`src/app/lifecycle.ts`) owns every interval/timeout and disposer so
shutdown can guarantee nothing outlives the process; `createShutdown()`
(`src/app/shutdown.ts`) runs it once, stops the media server, destroys services
and restores the terminal.

## Key dispatch

There is exactly **one** `keypress` listener (`src/input/dispatcher.ts`,
registered in `bootstrap.ts`). It routes each key through a fixed precedence
order; a handler that returns `true` consumes the key and stops dispatch:

1. key-capture (keybinding configuration)
2. confirm modal
3. QR modal (Esc hides it)
4. input navigation
5. message navigation
6. quit
7. main menu
8. escape-to-menu → settings toggle → settings navigation
9. tab (focus cycling)
10. chat-list navigation
11. quick-select (1–9)
12. escape
13. help
14. refresh chats
15. pin/unpin
16. mute/unmute
17. archive

The order is a preserved invariant of the v2 rewrite: reordering it changes
observable behaviour.

## Service contract

`src/services/types.ts` is the single source of truth for data crossing the
service/UI boundary (`ChatData`, `MessageData`, `ContactData`,
`MediaAttachment`, `ConnectionState`). Media is carried as metadata only — the
bytes are downloaded lazily through `downloadMedia` using `messageId`.

`MessagingService` requires:

- identity — `id`, `displayName`
- `capabilities()` — a `ServiceCapabilities` descriptor
- lifecycle — `initialize()`, `isReady()`, `getConnectionState()`, `destroy()`
- data — `getChats()`, `getMessages()`, `sendMessage()`, `markAsRead()`,
  `getContactInfo()`

Everything else is **optional and capability-gated**: `deleteMessage?`,
`editMessage?`, `pinChat?`, `muteChat?`, `archiveChat?`, `downloadMedia?`,
`renderQrCode?`. The UI feature-detects
(`svc.capabilities().editMessage && svc.editMessage?.(...)`) instead of casting
or crashing. `deleteMessage` additionally distinguishes `"none" | "forMe" |
"forEveryone" | "both"`.

`BaseMessagingService` (`src/services/base.ts`) owns the shared lifecycle:

- **readiness** — `ready` flips to `true` exactly once via `markReady(source)`;
  a pending QR is cleared on readiness.
- **`setQr()`** emits `qr` and stores the payload.
- **`track()` / `clearTimers()`** — every subclass timer is registered so
  `destroy()` leaves none behind.
- **`withTimeout(promise, ms, label)`** — bounded wait that always clears its
  timer.
- **`destroy()`** clears timers then calls the subclass `teardown()` hook.

### Events

`src/services/types.ts` names the event payloads: `qr`, `authenticated`,
`ready`, `auth_failure`, `message`, `disconnected`, `typing`, `service_error`.
`service_error` is used instead of the reserved `error` event, because emitting
`error` with no listener throws in Node's `EventEmitter`.
`src/app/serviceEvents.ts` subscribes with **named** handlers and removes exactly
those on teardown (never `removeAllListeners()`).

### Adding a service

1. Create `src/services/<name>.ts` with a class extending
   `BaseMessagingService`; declare `id`, `displayName`, `capabilities()` and
   implement the required methods plus a `teardown()` hook.
2. Normalize provider objects into the shared `types.ts` shapes; never leak
   provider objects to the UI.
3. Emit only the named events; report failures via `service_error`.
4. Add an entry to `SERVICES` in `src/services/registry.ts` (metadata + theme).
5. Wire the id in the `switch` inside `src/services/index.ts`
   (`getServiceInstance`). Unknown/unimplemented ids return `null`, which the UI
   surfaces as a friendly "not available" status.

## Media pipeline

Media flows through three collaborators:

1. **`MediaCache`** (`utils/mediaCache.ts`) — content-addressed by logical key
   (preferred: `msg:<messageId>`; a legacy `chat_file_timestamp` shape is also
   supported). Files are named by SHA-1 hash (path-safe), written atomically
   (`tmp` + `rename`) and tracked in a bounded, LRU-ish in-memory index.
   Construction performs no I/O.
2. **`MediaRenderer`** (`utils/mediaRenderer.ts`) — renders a `MediaAttachment`
   in the configured display mode (`indicator` | `ascii` | `kitty` | `iterm2` |
   `sixel` | `http`). It resolves the cached file via `messageId`; when bytes are
   missing or a helper tool is unavailable it degrades to ASCII/indicator instead
   of throwing. Kitty PNGs are chunked; non-PNG images are sent by file
   reference; iTerm2 uses OSC 1337; Sixel shells out to ImageMagick `convert`.
3. **`MediaServer`** (`utils/mediaServer.ts`) — a loopback-only
   (`127.0.0.1`) HTTP gallery + file server used by HTTP mode. It rejects
   path traversal, HTML-escapes gallery text, exposes `stop()`, and performs no
   filesystem work at import time.

`input/mediaActions.ts` ties it together: `ensureMediaCached()` downloads via the
service and re-caches under the message id; `handleOpenMedia()` either opens the
cached file with the platform handler or, in HTTP mode, starts the gallery
server and opens the browser. `messageList.ts` calls `renderer.render()` for each
message with media.

### QR flow

1. WhatsApp emits `qr`; `BaseMessagingService.setQr()` forwards it.
2. `src/app/serviceEvents.ts` renders it with `utils/qr.ts`
   (`renderQrBlocks()` → half-block characters, no ANSI, no stdout) and shows it
   in the QR modal.
3. On `authenticated` the modal is hidden; on `ready` (or the bounded ~30s
   readiness fallback in `whatsapp.ts`) the app loads chats.

## Conventions

- **Strict TypeScript.** `bun run typecheck` must pass; avoid `any` escapes and
  `as unknown as` casts.
- **`import type`** for type-only imports, so runtime imports stay minimal.
- **No stdout from non-UI modules.** The TUI owns the terminal; only
  `index.ts` (`--help`), `ui/help.ts` and the logger's stderr fallback write to
  the console. Helpers return strings instead of printing.
- **Timers are tracked.** UI timers go through `Lifecycle`/`StatusBar`; service
  timers through `BaseMessagingService.track()`/`withTimeout()`; the media server
  tracks its own. Nothing outlives shutdown.
- **Listeners are named and removed individually.** Never
  `removeAllListeners()` on a service.
- **Logger levels.** `debug < info < warn < error`; `error` always logs. The
  global threshold comes from `settings.logLevel`
  (`Logger.setGlobalLevel`). The logger never throws and rotates at ~5 MB.
- **Config writes are atomic** (`tmp` + `rename`, mode `0o600`) and validated on
  read; unknown keys are dropped and wrong types fall back to defaults.
