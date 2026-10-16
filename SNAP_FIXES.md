# Snap Packaging Notes

This document explains how ChitChat runs inside its snap and, in particular,
how the bundled Chromium used by WhatsApp (via `whatsapp-web.js` → Puppeteer)
is shipped.

## Why WhatsApp failed to start

`whatsapp-web.js` drives a real Chromium through Puppeteer. Puppeteer refuses
to launch unless it can find the **exact** Chrome build that the installed
`puppeteer`/`puppeteer-core` version expects (see
`node_modules/puppeteer-core/lib/cjs/puppeteer/revisions.js`). For the
`puppeteer` version currently pinned by `whatsapp-web.js` that revision is
Chrome **144.0.7559.96**.

The previous snap packaging had three problems:

1. **The browser was never actually shipped.**
   The `chitchat` part downloaded Chromium into
   `$CRAFT_PART_INSTALL/chromium/`, but the part also declared

   ```yaml
   stage:
     - app/
   ```

   `stage` is a *whitelist* applied to the part's whole install directory: when
   it is set, only the listed paths are copied into the final snap. Because
   `chromium/` (and, in fact, every library from `stage-packages`, which also
   live in the install directory) was not listed, it was silently dropped, so
   `$SNAP/chromium/chrome-linux/chrome` did not exist at runtime. The fix is to
   **not set `stage` on this part at all** — then everything in
   `$CRAFT_PART_INSTALL` is staged.

2. **The bundled revision did not match Puppeteer.**
   The build hard-coded Chromium `131.0.6778.204`, while the installed
   Puppeteer expects `144.0.7559.96`. This is what produced the
   `Could not find Chrome (ver. 144...)` message.

3. **Obsolete environment variables / paths.**
   `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` was removed from Puppeteer in v22 (the
   current name is `PUPPETEER_SKIP_DOWNLOAD`), and
   `PUPPETEER_EXECUTABLE_PATH` pointed at a `$SNAP/...` path that was never
   shipped. A stale `PUPPETEER_EXECUTABLE_PATH` makes launch fail before
   Puppeteer ever looks at its cache.

## Passing the release pipeline

Two properties are required for the `release.yml` pipeline to publish
successfully (it targets the `stable` channel by default):

- **`grade: stable` and `confinement: strict`.** The Snap Store rejects
  `devmode`/`devel` revisions from the `stable` and `candidate` channels (they
  may only go to `edge`/`beta`). Bundling Chrome and using the
  `browser-support` plug means strict confinement is sufficient, so there is no
  reason to ship a `devmode` snap.
- **`command: bin/chitchat`.** `apps.<name>.command` is validated by Snapcraft
  and may only contain alphanumerics, spaces and `/ . _ # : $ -`. A shell
  invocation such as
  `bin/sh -c 'cd $SNAP_USER_COMMON && exec $SNAP/.bun/bin/bun ... "$@"'`
  therefore fails project validation before the build even starts. Because the
  command string cannot contain quotes, redirections or `"$@"`, the module is
  launched through a small wrapper script (`bin/chitchat`, created in
  `override-build`) that *can* contain them.

The wrapper lives inside the snap and is executed directly by
`snap run chitchat`, so arguments (`chitchat --demo`) are forwarded verbatim.

## How the browser is shipped now

During the build we let Puppeteer install its own browser into the snap:

```sh
export PUPPETEER_CACHE_DIR="$CRAFT_PART_INSTALL/puppeteer-browsers"
export PUPPETEER_SKIP_CHROME_HEADLESS_SHELL_DOWNLOAD=true   # we only need full Chrome
bun node_modules/puppeteer/install.mjs
```

Because the installer reads the revision from the installed package, the
browser and Puppeteer can never drift apart again. The build then *verifies*
that a `chrome` binary exists and fails loudly if it does not.

At runtime the app points Puppeteer at that read-only cache and disables
downloads:

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
`PUPPETEER_EXECUTABLE_PATH` is needed. If one *is* set from the outside, the
application ignores it when the file does not exist (see
`resolveExecutablePath()` in `src/services/whatsapp.ts`).

## Writable working directory

The launcher wrapper (`bin/chitchat`) creates the writable scratch dirs and
runs the app from `$SNAP_USER_COMMON`, because the app writes relative to
`process.cwd()`:

- `.wwebjs_auth/` – WhatsApp session (`LocalAuth`)
- `.media-cache/` – downloaded media
- `.chitchat-settings.json`, `.chitchat-keybindings.json`
- `.slack-tokens.json`
- `chitchat.log`, `whatsapp.log`, `slack.log`

`$SNAP` is read-only (squashfs), which is why the app must not run from there.

## Directory layout after install

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

## Debugging a launch failure

If WhatsApp still fails to initialize:

1. Restart the app with Chromium logging enabled (the app reads the env var at
   startup):

   ```sh
   CHITCHAT_PUPPETEER_DUMPIO=1 chitchat
   ```

   Chromium's stdout/stderr will be piped into the app output. (Snap apps
   inherit the caller's environment, but `export CHITCHAT_PUPPETEER_DUMPIO=1`
   before `chitchat` is the reliable form.)

2. Inspect `~/snap/chitchat/common/whatsapp.log`. The logger now serializes
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

   `browser-support` must be connected for Chromium to create its sandbox
   (the app also passes `--no-sandbox`, which is normal inside a snap).

## References

- Puppeteer configuration: https://pptr.dev/guides/configuration
- Puppeteer browser management: https://pptr.dev/guides/browser-management
- Snapcraft `parts.<part>.stage`: https://snapcraft.io/docs/snapcraft-yaml
- Snap environment variables: https://snapcraft.io/docs/environment-variables
- Snap interfaces: https://snapcraft.io/docs/interface-management
