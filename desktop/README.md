# Music desktop app

Electron shell that runs a bundled Navidrome in the background and shows the frontend in a
window with the OS's native frame (switchable to frameless under Settings → Advanced; the
window is rebuilt, since a frame can't be added to an open one). Fresh startup selects your system Music folder and offers **Add music folder**, **Open my library**, and **Explore first**. It creates an admin account with a
random password and logs the frontend in silently. Existing installations retain their library and preferences.
Navidrome and a small static server for the frontend listen on all interfaces so
phones on the LAN can open the share QR code; the only protection is the share account's password. Ports are
chosen on first run and reused, so QR codes and bookmarks stay valid across restarts.

    pnpm install            # Electron + electron-builder
    pnpm navidrome          # downloads the navidrome binary for this platform into bin/
    pnpm build:frontend     # builds ../frontend into dist/
    pnpm dev                # runs the app from source
    pnpm dev:hot            # same, with the frontend hot-reloading from a Vite dev server
    pnpm dev:app            # macOS: prepare the repository-local app bundle
    pnpm dist               # all of the above, then AppImage and .deb into release/

`pnpm dev` also builds the frontend into the desktop output folder and builds the sandboxed preload bridge.

Normal Music data remains in `~/.config/Music` on Linux or `~/Library/Application Support/Music` on macOS.
This includes Navidrome's database and `credentials.json`, `music.sqlite` listening history,
and Chromium storage. `profile.json` records the selected music folder and completed setup.
Create a new fresh profile from Settings instead of deleting an existing database. `Ctrl+Q` (`Cmd+Q` on macOS) quits.

## Preview profiles and portable folders

Preview builds use the **Music Preview** application identity and an independent profile by default:
`<appData>/Music Preview/profiles/default`. Later launches continue the last selected preview profile.

- **Fresh**: open the default Music folder, add custom folders alongside it, or explore an empty collection. Remove any unwanted folder before opening. Music scans files in place; audio is not copied.
- **Copy existing**: quit normal Music first, then copy its index, history, tags and preferences into a new preview profile. The copy remains independent.
- **Continue**: Settings → Advanced → Library & profile → Preview profiles switches between saved profiles. Switching restarts the app.
- **Use existing directly**: an advanced option opens normal Music data after a warning. Quit other versions first; preview database changes may not be compatible with older builds. Prefer a copy.

Each profile has a process lock and separate ports. Separate profiles can run together; two processes cannot write one profile.

The desktop renderer uses the stable `app://music/` origin. On the first upgrade, its old localhost-origin preferences, tags, browser history and custom background are migrated inside the same Chromium profile before loading the library UI. A startup screen appears immediately; a failed or timed-out import shows a recoverable notice and retries on the next launch. LAN share links continue to use the HTTP frontend server.

The **portable** archive contains the app, an empty `Data/` folder, a launcher and instructions. Extract everything to a writable directory and use **Open Music.command** on macOS or **Open Music.sh** on Linux. Opening the app directly uses the normal preview location instead of the adjacent Data folder. The Linux launcher uses AppImage extraction mode so FUSE is not required.

Keep `Data/` when replacing the app for an update. Duplicate the complete folder to compare versions with independent state. Audio remains in its original folder; music-folder paths and system permissions may need updating on another computer.

On Linux, replace `Music.AppImage` with the same-named file from the new portable download. When updating an older portable folder with a versioned AppImage filename, replace `Open Music.sh` too and retain `Data/`.

Supported launch options:

```sh
# An independent named profile. Names use letters, digits, underscores and hyphens.
pnpm --dir desktop exec electron . --profile fresh-demo
# Store a collection of profiles beside a portable build.
pnpm --dir desktop exec electron . --data-dir /absolute/path/Data --profile default
# Explicitly open the normal Music profile; quit any other version first.
pnpm --dir desktop exec electron . --use-existing
```

`MUSIC_DATA_DIR` and `MUSIC_PROFILE` provide the equivalent defaults. Flags take precedence.
`--data-dir` names the profiles root; the active folder is `<root>/profiles/<name>`.
Fresh creates a new named folder, never clears an existing profile.

## Share a preview with GitHub Actions

Open **Actions → desktop → Run workflow**, choose a branch, `preview`, and `mac`, `linux` or `both`, and enable **Publish a preview download page**.
The workflow publishes a prerelease named `preview-<commit>-<run>` containing normal and portable packages, instructions and SHA-256 checksums. It does not replace the stable Latest release. Build-only runs retain Actions artifacts. Same-repository pull requests get a comment linking the run's Actions artifacts after checks and both platform builds pass; they are not published as releases. Fork PRs retain artifacts without a comment.

PR downloads use the existing **Music Preview** app identity and profile controls. Use Fresh or separate portable folders to keep experiments independent; normal Music data remains separate. Packaging resolves the app bundle from build metadata, so it does not depend on a hard-coded `Music.app` name.

```sh
gh workflow run desktop.yml --ref jose/core-library -f channel=preview -f platforms=mac -f publish=true
```

Frontend checks, the desktop/frontend test suite, and the synthetic desktop-bridge contract test must pass before packaging. The browser regression runner remains a separate agent-driven check. Only selected platforms must succeed before publication. Stable releases still come from `v*` tags and build both platforms. Build metadata is visible in Settings and stamped into preview filenames. Rerunning publication can resume missing assets without replacing downloads already published for that commit/run.


### Music folders

Settings → Advanced → Library & profile lists all selected music folders and provides Add, Remove, and Replace actions. Changing folders restarts Music into the same profile. Removing a location does not remove its audio files. Nested locations and aliases are deduplicated so the same root is not scanned twice.

Single-folder profiles retain their direct scanner root. Combined collections use stable directory links in the profile’s `music-folders/` directory; no links are written into the original music folders. Navidrome follows these links to scan and stream the originals. Once a profile uses a combined root, it retains that root when locations change. Existing single-folder profile configuration remains supported.

Build locally with `MUSIC_CHANNEL=preview pnpm --dir desktop dist:mac` or `MUSIC_CHANNEL=preview pnpm --dir desktop dist` on Linux. The generated `build-info.json` and `builder-config.json` are ignored; source package metadata is not rewritten.

Builds exist for Linux x86_64 and arm64 and macOS on Apple Silicon. The Linux builds are native: each runs on a runner of its own architecture. Other platforms need their navidrome binary
(`ND_OS` / `ND_ARCH` for `fetch-navidrome.mjs`) and matching `build` targets in `package.json`.

## macOS

Built on a GitHub Actions Apple Silicon runner by `.github/workflows/desktop.yml`.
Without signing secrets, it produces ad-hoc-signed, non-notarized DMG and ZIP packages plus a portable ZIP.
Intel Macs need a separate Electron build target and matching Navidrome binary; they are not included in this workflow.

Opening the non-notarized app the first time, the "damaged" message and updating are covered for users in
the [root README](../README.md#opening-the-app-the-first-time). Builds before 0.1.1 had no app menu, so
`Cmd+Q` did nothing; quit those from the Dock or Activity Monitor.

For Developer ID signing, add repository secrets `CSC_LINK` (base64 Developer ID Application `.p12`) and
`CSC_KEY_PASSWORD`. For notarization, also add `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
`APPLE_TEAM_ID`. With all credentials present, electron-builder signs and notarizes the same packages.
The workflow does not create certificates or an Apple Developer membership. Configure these before wider nontechnical distribution.
