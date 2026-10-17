# Keybindings

ChitChat's action keys are fully configurable through a JSON file. Navigation
keys (arrows, `Tab`, `Esc`, `1`–`9`, `Enter`) are fixed.

## Configuration file

Keybindings live in `.chitchat-keybindings.json`, resolved relative to the
current working directory. Set `CHITCHAT_KEYBINDINGS_PATH` to use a different
location.

The file is created on the first save (Reset or capturing a new key) and written
atomically with mode `0o600`. On load it is validated against the defaults:
unknown fields are dropped, wrong types fall back per field, and modifiers are
only trusted when explicitly `true`.

## Binding format

```json
{
  "quit": {
    "key": "q",
    "ctrl": true,
    "description": "Quit application"
  }
}
```

- `key` (string, required) — the key name.
- `ctrl`, `shift`, `alt` (boolean, optional) — modifiers.
- `description` (string) — shown in the settings UI and help.

**Modifier semantics:** matching is exact. A modifier listed (or `true`) in the
binding **must** be pressed, and every modifier **not** listed **must not** be
pressed. A plain key never matches a `Ctrl`/`Shift`/`Alt` combination, and vice
versa.

### Key names

- Letters/numbers/punctuation: `"a"`, `"1"`, `"?"`, `"/"`, …
- Special keys: `"return"`, `"escape"`, `"space"`, `"backspace"`, `"delete"`,
  `"insert"`, `"tab"`
- Arrows: `"up"`, `"down"`, `"left"`, `"right"`
- Function keys: `"f1"`, `"f2"`, …

Displayed names are prettified (`return` → `Enter`, `escape` → `Esc`,
`delete` → `Del`, `up` → `↑`, and so on).

## Default keybindings

Global:

| Action | Key | Description |
|--------|-----|-------------|
| `quit` | `Ctrl+Q` | Quit application |
| `settings` | `F2` | Open settings |
| `help` | `?` | Toggle help |

Chat list:

| Action | Key | Description |
|--------|-----|-------------|
| `refreshChats` | `Ctrl+R` | Refresh chat list |
| `pinChat` | `Ctrl+P` | Pin/unpin chat |
| `muteChat` | `Ctrl+M` | Mute/unmute chat |
| `archiveChat` | `Ctrl+A` | Archive chat |

Message actions:

| Action | Key | Description |
|--------|-----|-------------|
| `jumpToReply` | `Space` | Jump to replied message |
| `setReplyReference` | `R` | Set as reply reference |
| `openMedia` | `Enter` | Open media |
| `deleteMessageForMe` | `Backspace` | Delete message for me |
| `deleteMessageForEveryone` | `Delete` | Delete message for everyone |
| `editMessage` | `Insert` | Edit message |

Actions are only available for messages where the backend reports the matching
capability (see the table in the [README](README.md#supported-services)).

## Non-configurable keys

| Key | Context | Action |
|-----|---------|--------|
| `↑` / `↓` | Main menu | Move selection |
| `Enter` | Main menu | Open the selected service / item |
| `Q` | Main menu | Quit |
| `↑` / `↓` | Chat list | Move selection |
| `1`–`9` | Service view | Quick-select a chat by index |
| `Tab` | Service view | Cycle focus between panels |
| `↑` | Input | Move focus into the message list |
| `↓` | Input | Scroll to the newest message |
| `Enter` | Input | Send the message |
| `Esc` | Service view | Return to the chat list / main menu |
| `Y` / `N` / `Esc` | Confirm modal | Yes / No / Cancel |
| `Ctrl+C` | Anywhere | Quit |

> The media indicator line reads `['space' to open]`, but the default open-media
> binding is `Enter` (with `Space` bound to *jump to reply*). Change either key
> below if you prefer the hint's wording.

## Customizing

### In the app (recommended)

1. Press `F2` to open settings, then `Tab` to the **Keybindings** page.
2. Move to an action and press `Enter` to start capture.
3. Press the desired key combination. `Esc` cancels.
4. The new binding is saved immediately and applied to the running app.

### By editing the file

Edit `.chitchat-keybindings.json` and restart the app:

```json
{
  "setReplyReference": { "key": "r", "ctrl": true, "description": "Set as reply reference" },
  "openMedia": { "key": "m", "description": "Open media" },
  "messageUp": { "key": "k", "description": "Previous message" }
}
```

The file does not need every action: missing actions fall back to their
defaults.

## Notes & troubleshooting

- **Reload:** hand-edited files require a restart; changes made through the
  settings UI apply immediately.
- **Reset:** delete `.chitchat-keybindings.json` (or use Settings → Actions →
  Reset to Defaults) to restore the defaults.
- **Conflicts:** avoid assigning the same combination to two actions active in
  the same context — the first dispatcher stage wins (see the precedence order in
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#key-dispatch)).
- **Terminal limits:** some combinations (e.g. `Ctrl+Enter`) are not reported by
  every terminal. If a binding does not fire, try a different combination.
- **Diagnostics:** keybinding load/save and key-capture events are written to the
  log file. Verify your JSON syntax first.
