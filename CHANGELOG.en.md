# CHANGELOG

## Unreleased

### New
- ✨ The web page can use your own local wrapper-lite: switch the "wrapper-lite" setting at the bottom of the navigation to "Local" and the browser sends wrapper-lite requests itself
  - URL, max requests per second, max concurrent requests and `Authorization` are configurable and saved in the browser
  - The wrapper-lite must allow cross-origin requests, or install a browser extension that lifts CORS restrictions
  - MV master playlists are still fetched by the server with `User-Agent: AM` (new `/parse/mv-master` endpoint) so 4K stays available

### Changed
- The song master m3u8 is now fetched and parsed in the browser; `/parse/song/<adamId>` returns only the master URL (`{"code":0,"data":{"masterUrl":…}}`) instead of `variants`

## v0.2.7 (2026-10-09)

### Removed
- 🗑️ The `--hook` server-side decrypting proxy; decryption now happens only in the browser
  - The `--hook`, `--cache-ttl`, `--lru-cache-mb`, `--prefetch` and `--template-timeout` flags are gone; remove them from startup scripts
  - The song page no longer offers external players, Copy URL or download via server; the built-in player no longer uses native HLS or a direct media file

## v0.2.6 (2026-10-07)

### Bug Fixes
- 🐛 On phones, after tapping the lyrics view the lines above and below the current one stayed unblurred
- 🐛 Visible color banding in the gradients of the classic lyrics background

## v0.2.5 (2026-10-07)

### New Features
- ✨ The lyrics options menu switches the lyrics view's background between AMLL's flowing mesh gradient (default) and the classic background used before AMLL (rotating, twisted and blurred copies of the artwork, modeled on Apple Music Web)
  - The choice is saved in the browser; without WebGL the classic background is used
  - On portrait phone screens the classic background drifts a little faster, closer to how it looks on desktop

## v0.2.4 (2026-10-07)

### New Features
- ✨ On phones, the lyrics view hides the playback controls and the lyrics translation button during playback, and the lyrics extend to the bottom of the screen
  - They hide after 3 seconds without touch or on an upward swipe, and come back on a downward swipe, a tap or when paused
  - While they are hidden, tapping a lyric line only brings them back; tap again to jump to that line

### Bug Fixes
- 🐛 On phones, the left edge of the lyrics did not line up with the artwork above

## v0.2.3 (2026-10-06)

### Bug Fixes
- 🐛 With ALAC-to-FLAC playback, high-bitrate tracks such as 24-bit/96 kHz stalled around 22 seconds until the progress bar was dragged
  - The read-ahead window now follows the measured bitrate, and played audio is removed before appending, so the browser no longer drops unplayed audio to stay within its quota
  - When playback stops with nothing buffered at the play position, it re-buffers from there automatically

## v0.2.2 (2026-10-06)

### New Features
- ✨ The lyrics translation button is now a lyrics options menu
  - Adjust lyrics text size (70%–150%) and font weight (Light to Heavy)
  - Switch the lyrics source between Apple Music and the [AMLL TTML DB](https://amll.dev/reference/http-api/overview): looked up by Apple Music song ID, falling back to Apple Music lyrics for songs it doesn't have; it is only contacted when chosen
  - Download the TTML lyrics being shown
  - Text size, font weight and lyrics source are saved in the browser
- ✨ Read the AMLL TTML DB dialect (inline translations and romanizations, background vocal translations) and credit its lyric authors

### Bug Fixes
- 🐛 Clicking a song on the Favorite Songs page played the wrong track

## v0.2.1 (2026-10-06)

### Bug Fixes
- 🐛 Compare versions numerically; v0.10.0 and later were treated as older releases
- 🐛 Check for updates in the background with timeouts, so an unreachable GitHub no longer delays startup
- 🐛 Report a clear HTTP error on non-2xx responses such as GitHub API rate limiting
- 🐛 `--auto-update` on an unsupported platform now reports an error instead of crashing
- 🐛 On Linux/macOS the executable is replaced atomically; it stays intact if any step fails
- 🐛 The Windows manual update steps name the actual exe file

### Other
- CI runs tests for the whole workspace; end-to-end tests that need the live CDN / wrapper-lite are ignored by default
- Upgraded GitHub Actions to current versions (Node.js 24)

## v0.2.0 (2026-10-05)

### New Features
- ✨ Added auto-update functionality
  - Use `--check-update` to check for updates on startup
  - Use `--auto-update` to automatically download and install the latest version
- 🚀 Added GitHub Actions automated build workflow
  - Automatically builds multi-platform binaries when tags are pushed
  - Supports Windows (x86_64), Linux (x86_64), macOS (x86_64 and aarch64)

### Usage

#### Check for updates
```sh
am-hook --check-update --listen 0.0.0.0:8888 --wrapper-url http://127.0.0.1:12340
```

#### Auto-update
```sh
am-hook --auto-update --listen 0.0.0.0:8888 --wrapper-url http://127.0.0.1:12340
```

### Releasing a new version

1. Update the version number in `Cargo.toml`
2. Create and push a tag:
```sh
git tag v0.2.0
git push origin v0.2.0
```
3. GitHub Actions will automatically build and create a Release

### Notes

- On Windows, since the running executable cannot be replaced, auto-update will download the new version to `am-hook-new.exe`. Manual restart is required to complete the update.
- On Linux and macOS, the executable will be automatically replaced, with the old version backed up as `am-hook-backup`.

---

## v0.1.0

Initial release
