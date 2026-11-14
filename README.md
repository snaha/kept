# Kept

A music player for the collection you already have on your computer. Your albums show up as a wall of covers:
click one to play it, or let the app pick for you. Phones on your home network can join in by
scanning a QR code and play from your library too.

Nothing to set up. The app reads the music in your system's Music folder and keeps its index up to date on its
own. Under the hood it runs [Navidrome](https://www.navidrome.org/), a music server, which the app starts and
stops for you.

## Install

Download the file for your computer from the [latest release](https://github.com/snaha/kept/releases/latest).

| Computer | File |
|---|---|
| Mac with Apple Silicon (M1 or later) | `Kept-<version>-arm64.dmg` |
| Linux, 64-bit PC | `Kept-<version>.AppImage` or `kept-desktop_<version>_amd64.deb` |
| Linux, 64-bit ARM (Raspberry Pi with a 64-bit system) | `Kept-<version>-arm64.AppImage` or `kept-desktop_<version>_arm64.deb` |

Windows and Intel Macs are not supported yet.

### macOS

1. Open the `.dmg` and drag **Kept** onto **Applications**.
2. Open Kept from Applications.

This is a separate app from Apple Music, which stays untouched.

#### Opening the app the first time

**Preview downloads without Apple credentials are clearly labelled “not notarized—Open Anyway required.”** To install a preview you trust:

1. Drag **Kept Preview** to Applications, then open it once.
2. Dismiss the “Apple could not verify” warning.
3. Open **System Settings → Privacy & Security**, choose **Open Anyway** for Kept Preview, and confirm.

The DMG includes these instructions. See [Apple’s guidance](https://support.apple.com/en-us/102445). Do not disable Gatekeeper globally. If macOS reports actual malware or a damaged download, stop and report the build version.

Stable Mac releases require Developer ID signing and Apple notarization. Once the [CI credentials](desktop/README.md#macos) are configured, previews use notarization too; a failed notarization does not fall back to an unnotarized download. Notarized apps may still show the ordinary downloaded-app confirmation.

#### Updating on macOS

Quit the running app with Cmd+Q, then drag the new Kept onto Applications and choose **Replace**. When upgrading from Music, install Kept and remove the old Music app after confirming your library opens. Existing library data and preferences stay in their original folders.

### Linux

**AppImage**, which runs on most distributions:

```
chmod +x Kept-*.AppImage
./Kept-*.AppImage
```

**Debian and Ubuntu**, which also adds Kept to your applications menu:

```
sudo apt install ./kept-desktop_*_amd64.deb
```

## First start

- Fresh startup selects your Music folder and offers **Add music folder**, **Open my library**, or **Explore first**. Added folders are scanned alongside the default folder without moving audio files. Existing installations keep their current library.
- It reads your whole collection the first time. Albums appear while it works, and a counter at the bottom
  shows how many songs it has found. Large collections can take several minutes.
- To play on a phone, choose **Share** on the desktop and scan the QR code with a phone on the same
  home network. HTTP sharing is unencrypted on ordinary Wi-Fi; use a trusted network or Tailscale.
- Ctrl+Q quits the app, or Cmd+Q on macOS.

## Preview builds

Previews have their own library and preferences. You can start fresh, copy an existing Kept profile after quitting it, or continue a previous preview. Settings → Advanced → Library & profile shows the active build and lets you switch profiles or choose a music folder.

A portable download keeps its profiles inside an adjacent `Data` folder. Extract the whole archive and use **Open Kept.command** (Mac) or **Open Kept.sh** (Linux). When upgrading from Music, replace the app and launcher together and keep `Data`. For later updates, keep Data; duplicate the complete folder to compare builds independently.

For publishing branch previews and signing configuration, see the [desktop distribution guide](desktop/README.md#share-a-preview-with-github-actions).

## Troubleshooting

**macOS won't open the app.**
See [Opening the app the first time](#opening-the-app-the-first-time) for old previews and verification failures.

**The AppImage doesn't start on Ubuntu 22.04 or later.**
AppImages need the FUSE 2 library, which newer Ubuntu releases don't install by default. Install it with
`sudo apt install libfuse2` on 22.04, or `sudo apt install libfuse2t64` on 24.04 and later. You can also
start it without FUSE:

```
./Kept-*.AppImage --appimage-extract-and-run
```

**No albums, or some albums are missing.**
While the counter at the bottom is visible, the app is still reading your collection, and albums keep
appearing. Afterwards, check that the files are inside your system's Music folder: the app looks only there.
New files are picked up automatically within an hour.

**A phone can't open the shared link.**
Keep Kept running and connect both devices to the same network. Guest Wi-Fi may isolate devices.
Allow incoming connections to Kept in the Mac firewall. If the Mac changes networks, reopen Share to
get its current address. Tailscale users can connect using the Mac's Tailscale address; see
[phone sharing](frontend/README.md#sharing).

**"Navidrome stopped" appears on start.**
Another copy of the app may still be running. Quit every copy, on macOS also from the Dock, and start it
again. If the message returns, reset the app as described below.

**The visualizer stays black.**
It needs WebGL 2 graphics support. Updating the graphics drivers usually helps, especially on Linux.

**The window has no title bar, or you want to hide it.**
Turn **native window frame** on or off under **Settings → Advanced**, reached from the top-right menu.

**Starting over.**
Quit the app and delete its data folder. It holds only the app's own index, settings and passwords, never
your music files.

The Kept rename deliberately preserves the original `Music` data directories.

| System | Data folder |
|---|---|
| macOS | `~/Library/Application Support/Music/navidrome` |
| Linux | `~/.config/Music/navidrome` |

The next start reads your collection from scratch. Share links and QR codes change, so phones need to scan
the new code.

## Building from source

See [desktop/README.md](desktop/README.md) for the desktop app and [frontend/README.md](frontend/README.md)
for the web frontend.

Run `pnpm --dir desktop validate` for the complete automated build gate, including
the application journey. See [testing](docs/testing.md) for setup and device checks.
