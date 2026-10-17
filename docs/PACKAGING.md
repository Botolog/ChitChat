# Packaging & Distribution

This document describes how ChitChat is built and shipped — both as a
standalone Bun executable and as a snap — and, in particular, how the bundled
Chromium used by WhatsApp (via `whatsapp-web.js` → Puppeteer) is packaged.

## Standalone executable

`bun build` compiles the app into a single binary:

```bash
bun run build          # -> build/chitchat
./build/chitchat --help
```

The underlying command (see `package.json` / `build.sh`) is:

```bash
bun build src/index.ts \
  --compile --minify --sourcemap \
  --target=bun \
  --external @aws-sdk/client-s3 \
  --outfile build/chitchat
```

The compiled binary still needs a Chromium/Chrome build available at runtime for
WhatsApp (see below).

## Snap

`snapcraft.yaml` builds `chitchat` on `core22` for `amd64` and `arm64`.

| Property | Value |
|----------|-------|
| Confinement | `strict` |
| Grade | `stable` |
| Command | `bin/chitchat` (launcher wrapper) |
| Plugs | `network`, `network-bind`, `home`, `browser-support` |

Build locally with `snapcraft` (`bun run build:snap` / `build:snap-clean`, or
`snapcraft pack --destructive-mode` in CI):

```bash
snapcraft pack --destructive-mode
```

`ci-local.sh` runs the full local pipeline (Bun build → executable smoke test →
snap build → install/verify → remove).

### Why the bundle is self-contained

`grade: stable` + `confinement: strict` is required because the Snap Store
rejects `devmode`/`devel` revisions from the `stable` and `candidate` channels
(they may only go to `edge`/`beta`). Bundling Chromium and using the
`browser-support` plug means strict confinement is sufficient, so there is no
reason to ship a `devmode` snap — end users install it like any other snap, with
no `--classic` or `--devmode` flag.

### The launcher wrapper

`apps.chitchat.command` is validated by Snapcraft and may only contain
alphanumerics, spaces and `/ . _ # : $ -`. A shell invocation such as
`bin/sh -c 'cd $SNAP_USER_COMMON && exec $SNAP/.bun/bin/bun ... "$@"'` therefore
fails project validation before the build starts. The app is launched through a
small wrapper script (`bin/chitchat`, written during `override-build`) that *can*
contain quotes and forwarding. `snap run chitchat` executes it directly, so
arguments (`chitchat --demo`) are forwarded verbatim.

### How Chromium is shipped

`whatsapp-web.js` drives a real Chromium through Puppeteer. Puppeteer refuses to
launch unless it can find the **exact** Chrome build that the installed
`puppeteer`/`puppeteer-core` version expects (see
`node_modules/puppeteer-core/lib/cjs/puppeteer/revisions.js`).

Earlier packaging failed because:

1. The browser was downloaded into the part's install directory but silently
   dropped by a `stage:` whitelist on that part.
2. A hard-coded Chromium revision did not match the installed Puppeteer.
3. Obsolete variables were set (`PUPPETEER_SKIP_CHROMIUM_DOWNLOAD`, removed in
   Puppeteer v22) and a stale `PUPPETEER_EXECUTABLE_PATH` pointed at a path that
   was never shipped.

The build now lets Puppeteer install its own browser into the snap, so the two
can never drift apart again:

```sh
export PUPPETEER_CACHE_DIR="$CRAFT_PART_INSTALL/puppeteer-browsers"
export PUPPETEER_SKIP_CHROME_HEADLESS_SHELL_DOWNLOAD=true   # we only need full Chrome
bun node_modules/puppeteer/install.mjs
```

The build then **verifies** that a `chrome` binary exists and fails loudly if it
does not. At runtime the app points Puppeteer at that read-only cache and
disables downloads:

```yaml
environment:
  HOME: $SNAP_USER_COMMON
  TMPDIR: $SNAP_USER_COMMON/tmp
  PUPPETEER_TMP_DIR: $SNAP_USER_COMMON/tmp
  CHITCHAT_DATA_DIR: $SNAP_USER_COMMON
  NODE_PATH: $SNAP/app/node_modules
  PUPPETEER_CACHE_DIR: $SNAP/puppeteer-browsers
  PUPPETEER_SKIP_DOWNLOAD: "true"
```

`PUPPETEER_CACHE_DIR` is honored by Puppeteer's path resolution, so no
`PUPPETEER_EXECUTABLE_PATH` is needed. If one *is* set from the outside, the app
ignores it when the file does not exist (see `resolveExecutablePath()` in
`src/services/whatsapp.ts`).

> The `chitchat` part intentionally does **not** set `stage:`. That key is a
> whitelist applied to the part's whole install directory, so listing anything
> would drop the bundled browser (`puppeteer-browsers/`) and every library from
> `stage-packages`. Leaving it unset stages all of `$CRAFT_PART_INSTALL`.

### Writable working directory

`$SNAP` is read-only (squashfs), but the app writes relative to
`process.cwd()`. The launcher (`bin/chitchat`) therefore creates the writable
scratch directories and runs the app from `$SNAP_USER_COMMON`:

- `.wwebjs_auth/` – WhatsApp session (`LocalAuth`)
- `.media-cache/` – downloaded media
- `.chitchat-settings.json`, `.chitchat-keybindings.json`
- `.slack-tokens.json`
- `chitchat.log`, `whatsapp.log`, `slack.log`

### Directory layout after install

```
$SNAP/                              # read-only
├── app/
│   ├── src/
│   └── node_modules/
├── bin/chitchat                    # launcher wrapper
├── .bun/bin/bun
└── puppeteer-browsers/             # bundled Chrome (exact Puppeteer revision)
    └── chrome/linux-<ver>/chrome-linux64/chrome

$SNAP_USER_COMMON/                  # writable (CWD)
├── tmp/
├── .wwebjs_auth/
├── .media-cache/
├── .chitchat-settings.json
└── *.log
```

## Release pipeline

`.github/workflows/release.yml` chains three reusable workflows:

1. `build-bun.yml` – `bun install --frozen-lockfile`, compile the executable,
   upload it as an artifact.
2. `build-snap.yml` – build the snap (`snapcraft pack --destructive-mode`) and
   verify it installs.
3. `publish-snap.yml` – `snapcraft upload --release=<channel>` using the
   `SNAPCRAFT_TOKEN` secret. The channel defaults to `stable`; `edge`/`beta` may
   be selected manually.

## Debugging a launch failure

If WhatsApp still fails to initialize:

1. Restart the app with Chromium logging enabled (read at startup):

   ```sh
   CHITCHAT_PUPPETEER_DUMPIO=1 chitchat
   ```

   Chromium's stdout/stderr are piped into the app output. (Snap apps inherit
   the caller's environment, but `export CHITCHAT_PUPPETEER_DUMPIO=1` before
   `chitchat` is the reliable form.)

2. Inspect `~/snap/chitchat/common/whatsapp.log`. The logger serializes
   plain-object errors instead of printing `[object Object]`.

3. Verify that Chrome is present inside the snap and that it starts:

   ```sh
   snap run --shell chitchat
   find "$SNAP/puppeteer-browsers" -name chrome
   "$SNAP/puppeteer-browsers"/chrome/*/chrome-linux64/chrome --version
   ```

   If `chrome --version` reports missing shared libraries, add the
   corresponding package to `stage-packages` in `snapcraft.yaml`.

4. Confirm the interfaces are connected:

   ```sh
   snap connections chitchat
   ```

   `browser-support` must be connected for Chromium to create its sandbox (the
   app also passes `--no-sandbox`, which is normal inside a snap).

## References

- Puppeteer configuration: https://pptr.dev/guides/configuration
- Puppeteer browser management: https://pptr.dev/guides/browser-management
- Snapcraft `parts.<part>.stage`: https://snapcraft.io/docs/snapcraft-yaml
- Snap environment variables: https://snapcraft.io/docs/environment-variables
- Snap interfaces: https://snapcraft.io/docs/interface-management
