# ChitChat v2 Rewrite Plan

Branch: `rewrite/v2` (based on `master` @ `4326264`)

## 1. Goals

- **Robust, stable, polished** internals: honest types, no `any` leaks, bounded waits,
  lifecycle-safe timers/listeners, atomic config writes, validated inputs.
- **Behavior-preserving TUI**: identical renderable `id`s, layout geometry, key-dispatch
  *order*, and status strings, unless a change fixes a documented bug.
- **Aggressive dependency upgrades** (latest majors), verified by build + demo render.
- **Tests** for all pure logic (`bun:test`).
- **Decompose** the 2733-line `src/index.ts` into focused modules.

## 2. Non-negotiable invariants

1. `bun run src/index.ts --demo` must render the same main menu / service view.
2. Key handling precedence is preserved (key-capture → confirm modal → QR modal → input nav
   → message nav → quit → main menu → settings → tab → chats → quick-select → escape → help
   → refresh → pin/mute/archive).
3. Service `qr`/`authenticated`/`ready`/`message`/`disconnected`/`typing` semantics preserved.
4. The snap build (`snapcraft.yaml`) still works: it copies `src/` + `node_modules/` and runs
   `bun <src/index.ts>`; new files must live under `src/` and be reachable from `src/index.ts`.
5. TypeScript strict passes under TS 7; `bun build --compile` succeeds.

## 3. Target structure

**Files are NOT moved** (to keep the repo continuously compiling during the parallel
phase). `settings.ts`/`keybindings.ts` stay at `src/`; media utilities stay in `src/utils/`.

```
src/
  index.ts                 # entry: --help, arg parsing, bootstrap(), signal wiring
  settings.ts              # rewritten: schema, defaults, validate(), deep-merge, atomic persist
  keybindings.ts           # rewritten: model, defaults, matchesKeybinding() (fixed semantics)
  app/
    bootstrap.ts           # create renderer, build app, wire resize/keys, run loop
    context.ts             # AppContext: renderer + handles + services + config + theme
    state.ts               # AppState (typed) + createInitialState()
    theme.ts               # ThemeManager (current theme, setServiceTheme)
    demo.ts                # DEMO_CHATS / DEMO_MESSAGES fixtures
    signals.ts             # single registration of exit/SIGINT/SIGTERM/uncaught/unhandled
  services/
    types.ts               # ChatData/MessageData/ContactData/MediaAttachment/ConnectionState + MessagingService
    capabilities.ts        # ServiceCapabilities + defaults
    base.ts                # BaseMessagingService (readiness, timers, timeouts, teardown)
    whatsapp.ts
    slack.ts
    registry.ts            # SERVICE metadata + themes (unchanged shape)
    index.ts               # manager: getServiceInstance / destroyService(s) (was already here)
  ui/
    layout.ts              # root boxes + resize handling
    chatList.ts
    messageList.ts
    chatHeader.ts
    inputBar.ts
    statusBar.ts           # includes cancellable transient status helper
    mainMenu.ts            # repurposed: real OpenTUI main menu (was dead string renderer)
    settingsView.ts
    modals/confirmModal.ts
    modals/qrModal.ts
  input/
    dispatcher.ts          # ordered router (the only keypress listener)
    navigation.ts
    messageActions.ts
    mediaActions.ts
    chatActions.ts
  utils/
    logger.ts              # leveled, non-crashing, optional stdout, rotation
    terminalCapabilities.ts
    qr.ts                  # QR -> block-char string via `qrcode` (no ANSI)
    text.ts                # truncate/formatDate/formatFileSize
    mediaCache.ts          # rewritten in place
    mediaRenderer.ts       # rewritten in place
    mediaServer.ts         # rewritten in place
tests/
  *.test.ts                # bun:test unit tests
docs/PLAN.md
```

## 4. Frozen contracts

### 4.1 `src/services/types.ts`

```ts
export type MediaKind = "image" | "video" | "audio" | "sticker" | "document"

export interface MediaAttachment {
  kind: MediaKind
  mimetype: string
  filename: string
  filesize?: number
  /** Message id used to download the media; never a path. */
  messageId: string
}

export interface MessageData {
  id: string
  body: string
  timestamp: number          // unix seconds (float allowed)
  fromMe: boolean
  type: string
  ack?: number
  authorName?: string
  hasMedia: boolean
  media?: MediaAttachment
  isForwarded?: boolean
  forwardingScore?: number
  isStarred?: boolean
  hasQuotedMsg?: boolean
  quotedMsgBody?: string
  quotedMsgId?: string
}

export interface ChatData {
  id: string
  name: string
  isGroup: boolean
  unreadCount: number
  pinned: boolean
  muted: boolean
  archived: boolean
  participantCount?: number
  lastMessage?: { body: string; timestamp: number; fromMe: boolean }
}

export interface ContactData {
  id: string
  name: string
  number: string
  isMyContact: boolean
  isGroup: boolean
  isBlocked: boolean
}

export interface ConnectionState { ready: boolean; hasQr: boolean }
```

Backward-compat: `src/services/types.ts` re-exports from `services/index.ts` so any lingering
`import { ChatData } from "../services/whatsapp"` keeps working during transition.

### 4.2 `src/services/capabilities.ts`

```ts
export interface ServiceCapabilities {
  qrAuth: boolean
  deleteMessage: "none" | "forMe" | "forEveryone" | "both"
  editMessage: boolean
  pin: boolean
  mute: boolean
  archive: boolean
  downloadMedia: boolean
  reply: boolean
}
export const NO_CAPABILITIES: ServiceCapabilities
```

### 4.3 `MessagingService` (in `src/services/types.ts` or `services/index.ts`)

```ts
export interface MessagingService extends EventEmitter {
  readonly id: string
  readonly displayName: string
  capabilities(): ServiceCapabilities
  initialize(): Promise<void>
  isReady(): boolean
  getConnectionState(): ConnectionState
  getChats(): Promise<ChatData[]>
  getMessages(chatId: string, limit?: number): Promise<MessageData[]>
  sendMessage(chatId: string, content: string, options?: { replyTo?: string }): Promise<MessageData | null>
  markAsRead(chatId: string): Promise<void>
  getContactInfo(contactId: string): Promise<ContactData | null>
  destroy(): Promise<void>
  // optional / capability-gated:
  deleteMessage?(messageId: string, chatId: string, forMe: boolean): Promise<boolean>
  editMessage?(messageId: string, chatId: string, newText: string): Promise<boolean>
  pinChat?(chatId: string, pin: boolean): Promise<boolean>
  muteChat?(chatId: string, mute: boolean): Promise<boolean>
  archiveChat?(chatId: string, archive: boolean): Promise<boolean>
  downloadMedia?(messageId: string, chatId: string): Promise<string | null>
  renderQrCode?(qr: string): string
}
```

The UI must feature-detect via `capabilities()` and optional calls (`svc.deleteMessage?.(...)`)
— this replaces the `as unknown as MessagingService` casts.

### 4.4 `BaseMessagingService` (`src/services/base.ts`)

Owns: `ready`, `qrCode`, `markReady(source)`, `isReady()`, `getConnectionState()`,
`withTimeout(promise, ms, label)`, `track(interval)`, `clearTimers()`, and `destroy()` calling
`clearTimers()`. Subclasses implement `initialize/getChats/getMessages/sendMessage/markAsRead/
getContactInfo` and a `teardown()` hook.

### 4.5 Config API (`src/config/settings.ts`, `src/config/keybindings.ts`)

Same exported names as today (`loadSettings`, `getSettings`, `saveSettings`, `updateSetting`,
`getNestedSetting`, `setNestedSetting`, `SETTINGS_PAGES`, `getKeybindingsSettings`,
`loadKeybindings`, `getKeybindings`, `saveKeybindings`, `matchesKeybinding`, `formatKeybinding`)
plus:
- `validateSettings(raw): AppSettings` (deep-merge with defaults, type/enum/range checks).
- `matchesKeybinding`: unspecified modifiers mean **must be off** (fix collision bug).
- atomic writes (`tmp` + `rename`), `mode: 0o600`.

### 4.6 Media API (`src/media/*`)

- `MediaCache`: async fs, LRU-ish in-memory index, `cache/get/has/clear`, no import-time I/O.
- `MediaRenderer(displayMode, logger)`: fixes dead image modes by using `media.messageId` +
  cache lookup; chunked Kitty; correct iTerm2/Sixel; logs via `logger`.
- `MediaServer`: binds `127.0.0.1`, path-traversal containment check, HTML escaping, `stop()`.
- `renderQrCode(qr)` in `utils/qr.ts` (uses `qrcode`, returns block chars, no ANSI).

### 4.7 Logger API (`src/utils/logger.ts`)

Keep `info/warn/error/debug/event(context, msg, data?)`. Add: level filtering from
`settings.logLevel`, never throw on write failure, optional stdout mirror, size-based
rotation, and a `child(context)` helper. Must remain safe to construct at import time.

## 5. Bug fixes (verified during recon)

Services:
- W1 inverted delete-for-me/everyone (`whatsapp.ts`).
- W2 `ready` fallback + bounded `initializeOnce`; clear fallback on `destroy`/`reconnect`.
- W3 route thrown `evaluate` errors into the `client.getChats()` fallback; terminate the
  timeout timer.
- W4 populate real last-message preview + `fromMe` for store chats.
- S1 Slack missing `deleteMessage`/`editMessage` → capability-gated impl (no TypeError).
- S2 Slack `emit("error")` crash → `service_error` (never throw).
- S3 Slack refresh-token loss; atomic 0600 token writes; clear refresh timer on destroy.
- S4 Slack bounded init recursion; wrap socket handlers.

WhatsApp field hardening (reported from a real install):
- W5 "connecting…" forever, socket stuck at `UNLAUNCHED`: WhatsApp Web's
  cross-window tab mutex (`whatsapp-mutex`/`no-takeover`/`local-takeover-ok`) was
  left behind in the profile, so the page showed "WhatsApp is open in another
  window" and never launched its socket. Clear that state in-page before WhatsApp
  boots (`evalOnNewDoc`) and reclaim server-side session conflicts
  (`takeoverOnConflict`). See `src/utils/whatsappTabState.ts`.
- W6 stale Chromium `SingletonLock` after a killed run → "browser is already
  running" (fixed in `src/utils/profileLock.ts`).
- W7 page-state diagnostics (socket state, WhatsApp Web build, tab mutex) on
  every failed attempt, plus `--reset-whatsapp`.

Media:
- M1 path traversal in `MediaServer`; bind `127.0.0.1`.
- M2 image display modes never render (use `messageId`).
- M3 Kitty chunking + format detection.
- M4 `mediaServer.stop()` lifecycle; no import-time `mkdir`.
- M5 HTML escaping in gallery.

Config:
- C1 shallow merge corrupts nested settings → deep merge + validation.
- C2 `matchesKeybinding` modifier wildcard collision.
- C3 non-atomic writes.
- C4 `setNestedSetting` only depth-2.

TUI:
- T1 `.remove(id)` OpenTUI 0.6 migration (find + remove).
- T2 QR modal must restore `settingsBox` visibility.
- T3 confirm modal must reset title/options after key-capture reuse.
- T4 remove duplicate signal handlers / duplicate error handling.
- T5 `removeAllListeners()` on service → remove only our named handlers.
- T6 never-cancelled `setInterval`; never-removed resize listener.
- T7 delete dead code (`funcs.ts`, dead `global_settings` view, unused imports, dead menu
  helpers) — or wire global settings, decision: **remove** the dead view.
- T8 border-char rebuild clamp > 100 rows.
- T9 status `setTimeout` clobbers → cancellable transient status.

## 6. Workstreams (file ownership; disjoint)

| WS | Owner | Files |
|----|-------|-------|
| A  | agent | `src/services/**` |
| B  | agent | `src/media/**`, `src/utils/qr.ts`, `src/utils/terminalCapabilities.ts` |
| C  | agent | `src/config/**` (moved `settings.ts`/`keybindings.ts`) |
| D  | agent | `src/utils/logger.ts`, `src/utils/text.ts`, `src/app/demo.ts` |
| E  | agent | `src/app/**` (except demo), `src/ui/**`, `src/input/**`, `src/index.ts` |
| F  | agent | `tests/**` |
| G  | me    | integration, verification, docs, cleanup, deps |

Agents must not touch `package.json`, `tsconfig.json`, `snapcraft.yaml`, or files outside their
workstream. Frozen contracts in §4 are authoritative.

## 7. Tests (`bun:test`)

- config: deep merge + validation, keybinding matching (modifier semantics), atomic write.
- utils: `qr.renderQrCode` (block chars, dimensions), `text` helpers, logger level filtering.
- media: cache key/roundtrip, server path-traversal rejection, HTML escaping.
- services: pure helpers (message/chat normalizers, capability gating) with mocked clients.

## 8. Verification gates

1. `bun run typecheck` (tsc 7, strict) — 0 errors.
2. `bun test` — all pass.
3. `bun build src/index.ts --compile --target=bun` — succeeds.
4. `--demo` under a PTY renders main menu + service view with no runtime errors.
5. Grep gate: no `require(` in ESM, no `as unknown as MessagingService`, no bare `catch {}`.

## 9. Dependencies (installed)

- `@opentui/core` 0.6.6, `@slack/socket-mode` 3.1.0, `@slack/web-api` 8.2.0, `qrcode` 1.5.4,
  `whatsapp-web.js` 1.34.7, `yargs` 18.2.0.
- dev: `typescript` 7.0.2, `@types/node` 26.6.5, `@types/qrcode` 1.5.6, `@types/yargs` 17.0.35.
- Removed: `qrcode-terminal`, `@types/qrcode-terminal`, `tsx`, `ts-node`, `nodemon`.
