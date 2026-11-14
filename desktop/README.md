# Kept desktop app

Electron shell that runs a bundled Navidrome in the background and shows the frontend in a
window with the OS's native frame (switchable to frameless under Settings → Advanced; the
window is rebuilt, since a frame can't be added to an open one). Fresh startup selects your system Music folder and offers **Add music folder**, **Open my library**, and **Explore first**. It creates an admin account with a
random password and logs the frontend in silently. Existing installations retain their library and preferences.
Navidrome and the small static frontend server listen on the network so phones can use the Share QR code.
Ports are chosen on first run and reused. HTTP is intended for trusted home networks or Tailscale;
ordinary Wi-Fi traffic is unencrypted. See [phone sharing](../frontend/README.md#sharing).

    pnpm install            # Electron + electron-builder
    pnpm navidrome          # downloads the navidrome binary for this platform into bin/
    pnpm build:frontend     # builds ../frontend into dist/
    pnpm dev                # runs the app from source
    pnpm dev:hot            # same, with the frontend hot-reloading from a Vite dev server
    pnpm dev:app            # macOS: prepare the repository-local app bundle
    pnpm dist               # all of the above, then AppImage and .deb into release/

`pnpm dev` also builds the frontend into the desktop output folder and builds the sandboxed preload bridge.

Normal Kept data remains in `~/.config/Music` on Linux or `~/Library/Application Support/Music` on macOS.
These legacy paths, the bundle IDs and the `app://music/` origin are intentionally retained after the Kept rename to preserve upgrades.
This includes Navidrome's database and `credentials.json`, `music.sqlite` listening history,
and Chromium storage. `profile.json` records the selected music folder and completed setup.
Create a new fresh profile from Settings instead of deleting an existing database. `Ctrl+Q` (`Cmd+Q` on macOS) quits.

## Preview profiles and portable folders

Preview builds use the **Kept Preview** application identity and an independent profile by default:
`<appData>/Music Preview/profiles/default`. Later launches continue the last selected preview profile.

- **Fresh**: open the default Music folder, add custom folders alongside it, or explore an empty collection. Remove any unwanted folder before opening. Kept scans files in place; audio is not copied.
- **Copy existing**: quit normal Kept first, then copy its index, history, tags and preferences into a new preview profile. The copy remains independent.
- **Continue**: Settings → Advanced → Library & profile → Preview profiles switches between saved profiles. Switching restarts the app.
- **Use existing directly**: an advanced option opens normal Kept data after a warning. Quit other versions first; preview database changes may not be compatible with older builds. Prefer a copy.

Each profile has a process lock and separate ports. Separate profiles can run together; two processes cannot write one profile.

The desktop renderer uses the stable `app://music/` origin. On the first upgrade, its old localhost-origin preferences, tags, browser history and custom background are migrated inside the same Chromium profile before loading the library UI. A startup screen appears immediately; a failed or timed-out import shows a recoverable notice and retries on the next launch. The HTTP frontend serves phone connections on the home network and remains available for local storage migration.

The **portable** archive contains the app, an empty `Data/` folder, a launcher and instructions. Extract everything to a writable directory and use **Open Kept.command** on macOS or **Open Kept.sh** on Linux. Opening the app directly uses the normal preview location instead of the adjacent Data folder. The Linux launcher uses AppImage extraction mode so FUSE is not required.

Keep `Data/` when replacing the app for an update. Duplicate the complete folder to compare versions with independent state. Audio remains in its original folder; music-folder paths and system permissions may need updating on another computer.

When upgrading a portable Music folder, replace the app and launcher together with Kept and Open Kept from the new archive, retain `Data/`, and remove the old launcher.

On Linux, replace `Kept.AppImage` with the same-named file from the new portable download. When updating an older portable folder with a versioned AppImage filename, replace `Open Kept.sh` too and retain `Data/`.

Supported launch options:

```sh
# An independent named profile. Names use letters, digits, underscores and hyphens.
pnpm --dir desktop exec electron . --profile fresh-demo
# Store a collection of profiles beside a portable build.
pnpm --dir desktop exec electron . --data-dir /absolute/path/Data --profile default
# Explicitly open the normal Kept profile; quit any other version first.
pnpm --dir desktop exec electron . --use-existing
```

`MUSIC_DATA_DIR` and `MUSIC_PROFILE` provide the equivalent defaults. Flags take precedence.
`--data-dir` names the profiles root; the active folder is `<root>/profiles/<name>`.
Fresh creates a new named folder, never clears an existing profile.

## Share a preview with GitHub Actions

Open **Actions → desktop → Run workflow**, choose a branch, `preview`, and `mac`, `linux` or `both`, and enable **Publish a preview download page**.
The workflow publishes a prerelease named `preview-<commit>-<run>` containing normal and portable packages, instructions and SHA-256 checksums. It does not replace the stable Latest release. Build-only runs retain Actions artifacts. Same-repository pull requests get a comment linking the run's Actions artifacts after checks and both platform builds pass; they are not published as releases. Fork PRs run without signing secrets and produce explicitly unnotarized Mac previews.

PR downloads use the existing **Kept Preview** app identity and profile controls. Use Fresh or separate portable folders to keep experiments independent; normal Kept data remains separate. Packaging resolves the app bundle from build metadata, so it does not depend on a hard-coded `Kept.app` name.

```sh
gh workflow run desktop.yml --ref main -f channel=preview -f platforms=mac -f publish=true
```

The shared `pnpm --dir desktop validate` gate must pass before packaging. It includes typechecks, component/desktop/fixture tests, real Navidrome sharing, production builds and the application journey at all four screen sizes. CI saves logs and screenshots on success or failure. See [build validation](../docs/testing.md) for setup, development shortcuts and the remaining device checks. Only selected platforms must succeed before publication. Stable releases still come from `v*` tags and build both platforms. Build metadata is visible in Settings and stamped into preview filenames. Rerunning publication can resume missing assets without replacing downloads already published for that commit/run.


### Music folders

Settings → Advanced → Library & profile lists all selected music folders and provides Add, Remove, and Replace actions. Changing folders restarts Kept into the same profile. Removing a location does not remove its audio files. Nested locations and aliases are deduplicated so the same root is not scanned twice.

Single-folder profiles retain their direct scanner root. Combined collections use stable directory links in the profile’s `music-folders/` directory; no links are written into the original music folders. Navidrome follows these links to scan and stream the originals. Once a profile uses a combined root, it retains that root when locations change. Existing single-folder profile configuration remains supported.

Build locally with `MUSIC_CHANNEL=preview pnpm --dir desktop dist:mac` or `MUSIC_CHANNEL=preview pnpm --dir desktop dist` on Linux. The generated `build-info.json` and `builder-config.json` are ignored; source package metadata is not rewritten.

Builds exist for Linux x86_64 and arm64 and macOS on Apple Silicon. The Linux builds are native: each runs on a runner of its own architecture. Other platforms need their navidrome binary
(`ND_OS` / `ND_ARCH` for `fetch-navidrome.mjs`) and matching `build` targets in `package.json`.

## macOS

**Previews remain available without Apple credentials.** They use an ad-hoc signature, with “not-notarized” in Mac download filenames and the Actions artifact name. The DMG includes a read-me-first notice, and the PR comment, release page and portable README explain **System Settings → Privacy & Security → Open Anyway**. This is a deliberate preview-only exception; it does not remove Apple's verification warning.

Stable Mac downloads require a **Developer ID Application** certificate and Apple notarization. Previews use notarization when complete credentials are present. Partial credentials or failed signing/notarization stop the build instead of downgrading it. Every packaged app passes `codesign --verify --deep --strict`; notarized builds also pass stapled-ticket validation and Gatekeeper assessment. The portable app is copied with macOS metadata preserved and verified again.

To build an unnotarized preview locally: `MUSIC_CHANNEL=preview pnpm --dir desktop dist:mac`. A Mac job reports notarization status only after successful packaging; PR/release notices use that result rather than assuming credentials imply success.

### Configure GitHub Actions once

Apple requires an active Developer Program membership for its notary service. An unexpired certificate in Keychain does not prove the membership is active. If membership has expired, renew it before configuring notarization; see [Apple’s access rules](https://developer.apple.com/help/account/access/resolving-access-issues).

In this repository's **Settings → Secrets and variables → Actions**, configure these encrypted repository secrets:

| Secret | Value |
| --- | --- |
| `CSC_LINK` | Base64-encoded `.p12` export of the Developer ID Application certificate **and its private key** |
| `CSC_KEY_PASSWORD` | Password chosen when exporting that `.p12` |
| `APPLE_ID` | Apple Account email associated with the Developer ID team |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password generated for that account at account.apple.com |
| `APPLE_TEAM_ID` | Team ID associated with the signing certificate |

On a Mac that already has the certificate, export the specific **Developer ID Application** identity from Keychain Access → My Certificates as a password-protected `.p12`. Do not export unrelated identities. Upload secrets through GitHub's secret form or `gh secret set`; never commit the certificate, private key or password. For the certificate alone, `base64 -i /private/path/kept-signing.p12 | gh secret set CSC_LINK --repo snaha/kept` sends it directly without printing it. Enter the other secrets using the interactive `gh secret set NAME --repo snaha/kept` prompts. Remove the temporary export after configuring CI.

Rerun the Mac job after adding the secrets. Old artifacts remain unsigned and must be replaced by the new download. The workflow does not create an Apple Developer membership or signing credentials.

### Build on your own Mac

A local build can use the identity already in your keychain and a notarization credential profile:

```sh
# Interactive prompts store credentials in Keychain; do not put passwords in shell history.
xcrun notarytool store-credentials kept-notary
CSC_NAME='Developer ID Application: Your Name (TEAMID)' APPLE_KEYCHAIN_PROFILE=kept-notary MUSIC_CHANNEL=preview pnpm --dir desktop dist:mac
```

`APPLE_KEYCHAIN` optionally selects the keychain containing that profile. Local packaging also accepts the Apple ID credentials above, or `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` for App Store Connect authentication. Partial credentials fail; a different authentication method is not silently substituted.

For development without distribution credentials, use `pnpm --dir desktop dev:app`. This creates `.local-app/Kept.app` with an ad-hoc signature for this Mac; it is not a download to share. Published builds target Apple Silicon; Intel Macs require a separate Electron target and matching Navidrome binary.

Native release check: download the new DMG through a browser, drag Kept Preview to Applications, and launch it with quarantine intact. An unnotarized preview must show the expected warning and work after the documented Open Anyway approval. A notarized build should show no “Apple could not verify” warning. Verify the existing preview library/settings remain available. Repeat with the extracted portable launcher using its adjacent Data folder. CI checks Gatekeeper and the staple; Finder's first-launch flow still needs this physical-Mac check.
