# ChitChat

A universal **terminal** messaging client built with [OpenTUI](https://github.com/sst/opentui)
and the [Bun](https://bun.sh) runtime. Open it in any terminal, pick a service
and chat without leaving the shell.

WhatsApp (QR login, powered by `whatsapp-web.js` + Chromium) and Slack
(Socket Mode, `@slack/web-api`/`@slack/socket-mode`) are implemented. Discord and
Telegram appear in the menu but are **not implemented yet** — selecting them
shows a "not available" status. Signal and Matrix are disabled registry
placeholders.

## Features

- Unified TUI: main menu → service view (chat list, message list, input bar).
- WhatsApp via QR-code auth, with live message, typing and disconnect events.
- Slack via Socket Mode with a user token for real-time updates.
- Reply, edit and delete (for me / for everyone) where the backend supports it.
- Pin, mute and archive chats where the backend supports it.
- Media rendering: indicator/ASCII fallbacks, Kitty, iTerm2 and Sixel image
  protocols, plus a local browser gallery (HTTP mode).
- Separate settings and keybinding files, validated and written atomically.
- In-app settings pages (appearance, notifications, privacy, chat, advanced,
  per-service, keybindings) with keybinding capture.
- Structured, leveled, rotating log files — never printed over the TUI.
- `--demo` mode with fixtures for trying the interface without any account.

## Supported services

| Service | Status | Auth | Delete | Edit | Pin/Mute/Archive | Media download | Reply |
|---------|--------|------|--------|------|------------------|----------------|-------|
| WhatsApp | Implemented | QR scan | for me + everyone | ✅ | ✅ | ✅ | ✅ |
| Slack | Implemented | user token + Socket Mode | — | — | — | — | ✅ |
| Discord | Not implemented | — | — | — | — | — | — |
| Telegram | Not implemented | — | — | — | — | — | — |
| Signal | Disabled | — | — | — | — | — | — |

Capabilities are declared per service (`src/services/capabilities.ts`) and the UI
feature-detects before calling optional methods, so unsupported actions are
reported in the status bar rather than crashing.

## Requirements

- **Bun ≥ 1.3**.
- A terminal with **truecolor** support for the best experience (Kitty, WezTerm,
  iTerm2, xterm-256color, etc.). Media modes are auto-detected and degrade to an
  indicator line.
- **Chromium or Chrome** for WhatsApp. Either let Puppeteer use its own
  downloaded browser, or point `PUPPETEER_EXECUTABLE_PATH` at a system Chromium.
  The snap bundles its own Chromium.

## Quick start (from source)

```bash
bun install
bun run start      # launch the TUI
bun run demo       # launch with fixture data, no accounts needed
```

Useful scripts:

```bash
bun run dev        # watch mode (bun --watch run src/index.ts)
bun run typecheck  # tsc --noEmit
bun test           # bun:test unit tests
bun run build      # compile a standalone binary to build/chitchat
```

## Snap

```bash
sudo snap install chitchat --edge
chitchat            # or: chitchat --demo
```

The snap is **strictly confined** and self-contained: it bundles Bun, the source,
`node_modules` and its **own Chromium build** (matched to the Puppeteer revision
`whatsapp-web.js` expects), so there is no need for `--classic` or `--devmode`.
It runs from its writable data directory (`$SNAP_USER_COMMON`), where sessions,
media cache, settings and logs are stored. `edge` receives the newest builds;
`stable`/`candidate` are used for releases.

See [`docs/PACKAGING.md`](docs/PACKAGING.md) for build and packaging details.

## Configuration

Settings and keybindings live in two JSON files, resolved relative to the current
working directory (`$SNAP_USER_COMMON` inside the snap). They are created on the
first save and validated on read — unknown keys are dropped and wrong types fall
back to defaults.

| File | Purpose | Env override |
|------|---------|--------------|
| `.chitchat-settings.json` | app settings (`AppSettings`) | `CHITCHAT_SETTINGS_PATH` |
| `.chitchat-keybindings.json` | keybindings (`KeyBindings`) | `CHITCHAT_KEYBINDINGS_PATH` |

Environment variables:

| Variable | Effect |
|----------|--------|
| `CHITCHAT_SETTINGS_PATH` | Absolute path to the settings file (default `<cwd>/.chitchat-settings.json`). |
| `CHITCHAT_KEYBINDINGS_PATH` | Absolute path to the keybindings file (default `<cwd>/.chitchat-keybindings.json`). |
| `CHITCHAT_LOG_DIR` | Directory for log files (default: the working directory). |
| `CHITCHAT_DATA_DIR` | Writable data directory used by the packaged launcher; the app writes its files relative to the working directory. |
| `CHITCHAT_PUPPETEER_DUMPIO` | Set to `1` to pipe Chromium's stdout/stderr into the app output (debugging). |
| `PUPPETEER_CACHE_DIR` | Puppeteer browser cache location (the snap points this at its bundled Chromium). |
| `PUPPETEER_EXECUTABLE_PATH` | Explicit Chromium/Chrome binary. Ignored if the path does not exist. |

Slack reads credentials from the environment when no saved token is present:
`SLACK_USER_TOKEN` (required), `SLACK_APP_TOKEN` (Socket Mode / live events),
`SLACK_REFRESH_TOKEN`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` (token refresh).
Saved tokens are kept in `.slack-tokens.json` (mode `0o600`).

## Development

```bash
bun run typecheck   # strict TypeScript, must be clean
bun test            # bun:test suite
bun run build       # bun build --compile
```

Architecture and conventions are documented in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Keybindings are listed in
[`KEYBINDINGS.md`](KEYBINDINGS.md) and the media subsystem in
[`MEDIA_SUPPORT.md`](MEDIA_SUPPORT.md).

## Troubleshooting

- **QR code does not show.** The QR is rendered inside a TUI modal
  (`qrcode` → half-block characters). Keep the terminal at a reasonable size and
  wait for the modal to appear; press `Esc` to hide it (it reappears on the next
  `qr` event). If it never appears, check the log file for WhatsApp/Puppeteer
  errors.
- **Stuck on "Authenticated…".** `whatsapp-web.js` sometimes never emits `ready`
  after `authenticated`. ChitChat polls the connection and proceeds automatically
  once it is `CONNECTED`, or after a bounded ~30 s wait. If chats are still
  empty, restart the app.
- **"Could not find Chrome".** Puppeteer could not locate the exact browser
  revision it expects. Install a matching browser, let Puppeteer download one, or
  set `PUPPETEER_EXECUTABLE_PATH` to an existing Chromium/Chrome binary. For the
  snap, see [`docs/PACKAGING.md`](docs/PACKAGING.md).
- **"Session locked by other app" / "browser is already running".** Chromium
  keeps the WhatsApp profile (`<data dir>/.wwebjs_auth/session`) locked while it
  runs. This appears when a *previous* ChitChat was killed before it could close
  its browser, or when a second instance is already using the same profile.
  ChitChat clears a stale lock automatically when the owning process is gone; if
  it is still alive, close the other ChitChat/Chromium and retry. To clean up
  manually (Linux):

  ```sh
  pkill -f 'user-data-dir=.*\.wwebjs_auth'          # stop orphaned Chromium
  rm -f "$DATA_DIR/.wwebjs_auth/session"/Singleton* # drop a stale lock
  ```

  where `$DATA_DIR` is `CHITCHAT_DATA_DIR` (in the snap:
  `~/snap/chitchat/common`). Deleting the whole `session` directory instead
  forces a fresh QR scan.
- **Logs.** Find startup/connection details in `chitchat.log`, `whatsapp.log`
  and `slack.log` (in `CHITCHAT_LOG_DIR`, or `$SNAP_USER_COMMON` in the snap).
  Increase verbosity via Settings → Advanced → Log Level.

## License

ISC
