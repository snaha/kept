# Navidrome grid frontend

Svelte 5 + Vite, no backend. Talks to Navidrome's Subsonic API straight from the browser.

    pnpm install
    pnpm dev        # http://localhost:5173 (or the next free port)
    pnpm build      # static files in dist/

Log in with your Navidrome URL (default http://localhost:4533), username and password.

## Browsing

Full-width grid of covers styled as glossy vinyl-paper sleeves, over a black vinyl surface that scrolls with
the cards. The top bar fades in as the mouse approaches the top of the window. The menu in its corner switches
between two control sets: *Layout* (columns 1–10, gap, "motion")
and *Look* (background material: vinyl, speaker grille, speaker cone, fabric). Everything is remembered.

Settings → Appearance → Only show albums with cover hides albums without cover art; it is off by default.
Indexing refreshes the library even when a scan finishes between status polls;
an empty desktop library shows its selected folder, and indexing failures appear in the library status.

| Key | Action |
|---|---|
| `1`–`6` | switch views: albums A–Z, recent, random, starred, artists, playlists |
| `space` | play / pause |
| `←` `→` | previous / next track |
| `Esc` | reload the current view |
| `?` | show / hide this key list |

Click a cover to play the album or playlist; click an artist to see their albums.

## Phones

Mobile browsers keep their own address bar and toolbar around the page. For a full-screen app, add it to the
home screen: Safari *Share → Add to Home Screen*, Android Chrome or Firefox *menu → Add to Home screen /
Install*. The manifest makes it launch standalone with a black status bar and the app icon. A share link
opened this way keeps its login.

## Player

The bottom bar shows the playing song with a seekable progress line. The shuffle button next to play loads a
fresh queue of 50 random songs. Clicking the cover slides up the song list of the current album; click a song
to jump to it. Close it with the chevron at the top (keeps the top bar
hidden until the next interaction) or by clicking the cover again. OS media keys work through MediaSession,
and plays are scrobbled to Navidrome after half the track.

## Sharing

Admins see a share icon in the bottom bar. It opens an overlay with a QR code; a phone on the same network
scans it and the app opens logged in as a separate non-admin `share` user (created on first use). The link
carries the account in the URL fragment (`#u=share&p=…&s=<server>`), so anyone holding it keeps access until
the share user's password is changed. Navidrome has no Subsonic endpoints for user management, so the share
user is managed through Navidrome's native `/api/user` endpoint with a token from `/auth/login`.

## Visualizer

The waveform icon in the bottom bar opens a full-screen Milkdrop visualizer (Butterchurn). Presets cycle
automatically every 15 seconds; every key press below flashes the preset name bottom-left, automatic changes do not. Closing: `Esc`, a click,
or leaving full screen. While it is open it owns the keyboard, so `space` does not pause playback there.

| Key | Action |
|---|---|
| `space` | next preset, smooth blend |
| `H` | next preset, hard cut |
| `backspace` | previous preset |
| `R` or `scroll lock` | toggle automatic cycling (lock the current preset) |
| `T` | song title animation |
| `Esc` | close |

## Component tests and browser support

Run `pnpm test:unit` for browser component/rune regressions using the same Svelte
Vite plugin as production. Use `pnpm exec playwright install chromium` once if the
Vitest browser provider cannot find Chromium, or set `MUSIC_TEST_BROWSER` to an
installed executable. Application journeys continue to use `tests/agent/README.md`.

The syntax baseline is Chromium 111, Firefox 114 and Safari 16.4. Queue popovers
and Settings focus checks have capability fallbacks; Vite does not polyfill DOM
APIs. See `../docs/core-reliability.md` for state ownership and provider contracts.
