# CHANGELOG

## v0.6.8 (2026-11-09)

### New
- ✨ Drop the EP / Single suffix from album names (settings → Downloads → Tags, off by default): "Wake Me Up - Single" becomes "Wake Me Up" in the album and sort tags, `{album}` in file name templates, and album folder / ZIP names alike; only a trailing `EP` / `Single` separated by " - " is removed, so names such as "夏のせい ep" and playlist names are kept
- ✨ A "Same as source" cover format (PNG for PNG / TIFF sources, otherwise JPEG) and an original-size option (0x0ss) for both embedded and saved covers; the cover settings are now two cards, "Embed in tracks" and "Save as file", each with its own switch, format and size, and a preview of the requested URL
- ✨ JPEG covers are requested at quality 100 (`bb-100.jpg`) instead of the default ~85%

### Fixes
- 🐛 Choosing the PNG cover format still downloaded JPEG for most songs and albums, whose artwork URL template hardcodes `.jpg`: the trailing extension is now replaced with the chosen format
- 🐛 Windows Explorer showed neither tags nor duration for downloaded ALAC files: the leftover `free` box in the audio sample entry after decryption is removed

## v0.6.7 (2026-11-05)

### New
- ✨ AutoMix song transitions (settings → Playback → "Song transitions": Off / AutoMix (default) / Crossfade 1–12 s, plus an AutoMix switch next to the Playing Next title): each transition is planned from Apple Music's audio analysis (loudness curve, beats and bars, BPM, vocals), trimming leading / trailing silence, bringing the next song in during the outro and never overlapping vocals; with close tempos it lines up bars, and `<audio>` playback is time-stretched during the overlap (pitch preserved) before easing back. Albums played in order and songs without an analysis stay gapless; works with MSE, FLAC, EC-3 and JOC, and is unavailable where the audio volume is read-only (iOS Safari)

### Fixes
- 🐛 Lyrics no longer run ahead of spatial audio (Dolby Atmos and its AAC binaural / stereo downmix versions): they are delayed by the `<audio lyricOffset role="spatial"/>` in Apple's TTML (0.93 s for Message In A Bottle (Taylor's Version)), and clicking a line seeks to the matching position; LRC embedded or saved with these downloads is delayed too, while saved TTML is kept as is

## v0.6.6 (2026-11-04)

### New
- ✨ The settings center is split into General / Playback / Downloads tabs (the URL hash remembers the tab, and a hash pointing at a section opens its tab)
- ✨ Separate playback quality for Wi-Fi and cellular: High Efficiency (HE-AAC), High Quality (AAC 256), Lossless (ALAC up to 24/48 kHz) and Hi-Res Lossless (ALAC up to 24/192 kHz), falling back a tier when a song lacks it; a separate Dolby Atmos option (auto / always / off) decides whether Atmos comes first, with auto keeping the old behaviour (preferred while JOC object rendering is on). Changes apply from the next song, and an already prepared gapless next track is re-prepared
- ✨ "ALAC / AAC volume" (settings → JOC object rendering, -20–0 dB, default 0): Atmos mixes are usually quieter than stereo masters, so moving from an Atmos song to ALAC / AAC no longer jumps in loudness. It attenuates only the `<audio>` element for non-EC-3 tracks, so it never clips, and the volume slider keeps its value

### Fixes
- 🐛 Dolby Atmos played through EC-3 or JOC object rendering now retries automatically after a segment or key load error (it used to stop until you pressed play), at the same pace as the other playback modes: 3 s doubling, stopping after 5 tries with "Retry now". On a segment or key error the buffered audio keeps playing and playback only waits once it runs out, resuming on recovery; decoder errors and failed seeks restart from the current position

### Changed
- ⚡ The song master m3u8, MV master and MV `/webplayback` and `/license` requests time out after 15 s instead of 30 s, matching the key and lyrics requests, so errors show sooner

## v0.6.5 (2026-10-30)

### New
- ✨ The full-screen player's backdrop can pulse to the beat (lyrics options → "Pulse to the Beat", off by default): kick and bass onsets are picked up from what is playing, the AMLL mesh gradient swells and turns with them, and the dynamic artwork's layers swell, twist and speed up their orbits as in YouLyPlus. Every playback mode is supported without re-routing playback: EC-3 and JOC are sampled before the volume control, AAC / ALAC through a capture of the `<audio>` element (Chromium browsers; Safari and Firefox get no pulse for these formats). The pulse does not depend on the volume and is delayed by the output latency so it lines up with what you hear
- ✨ Downloaded covers have separate embedded and saved settings: the saved cover file has its own format and size, e.g. a high-quality PNG on disk with a regular JPEG embedded in each track; existing settings carry over to the saved cover

### Changed
- 💄 The full-screen player's classic backdrop (twisted copies of the artwork plus grain) is replaced by a dynamic artwork background ported from [YouLyPlus](https://github.com/ibratabian17/YouLyPlus): three rotating, orbiting copies of the artwork with a Gaussian blur and Apple Music's grading, rendered with WebGL, in a worker where the browser allows; artwork changes crossfade and reduced motion keeps it still. A saved classic choice switches to it
- 🗑️ The "original" cover format is removed: the a5.mzstatic.com original-image links no longer resolve

## v0.6.4 (2026-10-29)

### Fixes
- 🐛 Duet lyrics in the full-screen player pick their side line by line as AMLL does: whoever sings first takes the main side (songs where v2 starts used to be mirrored), the same singer keeps the side and a new singer flips it, and chorus lines (v1000) are no longer put on the duet side or break the alternation; the `ttm:agent` declarations in the TTML head are now parsed (#7)
- 🐛 Moving objects in JOC object rendering now follow the reference: OAMD position updates snap to the 32-sample processing block and interpolate over the full ramp, so moving objects no longer trail the reference by up to ~1.3 ms (binaural peak error down from -44 dB to within the -120 dB the reference test allows) (#6)

## v0.6.3 (2026-10-26)

### New
- ✨ Mouse look in the spatial scene's first-person view (desktop): with the pointer locked, moving the mouse turns your head, FPS style; the top bar and controls fade out while locked, and Esc only releases the mouse
- ✨ Glow sticks in the spatial scene's first-person view (desktop): two fists hold sticks that pulse with the LFE level and take the colour of the object under the crosshair; click to wave them forward from the elbow (hold to keep waving), with trails, sparks and a ring on the object you hit; right-click solos the object under the crosshair

### Changed
- ⚡ While the spatial scene covers the full-screen player, the lyrics and backdrop behind it (AMLL or classic) pause and pick up from the current position when it closes, cutting renderer CPU by about 30–40%
- ⚡ Lighter spatial scene drawing: at most 60 frames a second (no longer following high-refresh displays), the floor grid cached in an offscreen canvas, trails stroked in batches and level meters that no longer trigger layout; on a 160 Hz display renderer CPU drops by about two thirds and the GPU process by about 60%. Trails, afterimages and sparks are as long on high-refresh displays as at 60 Hz

## v0.6.2 (2026-10-25)

### Fixes
- 🐛 On Android Chrome, spatial scene controls took about 1 s to be heard: the low-latency JOC playback's AudioContext now uses `latencyHint: 'interactive'`, cutting output latency from ~0.35 s to ~0.04 s and no longer starving (and growing the lead) as the output pulls audio in large blocks, so turning your head is heard after ~0.17 s; other playback methods keep `'playback'`

## v0.6.1 (2026-10-24)

### New
- ✨ Dolby Atmos object rendering (JOC, from [am-hook-joc](https://github.com/TheM14/am-hook-joc)), off by default: pick Speaker 2.0 or Binaural under Settings → JOC object rendering, and E-AC-3 (Dolby Atmos) songs are rendered in the browser, rebuilding 15 objects plus LFE from the stream's JOC and object metadata and rendering them to stereo; Binaural uses the 20 HRTFs of the University of York SADIE II database (D2 by default) with early reflections and a room. Mode, HRTF and output attenuation apply to the playing song at once, also switchable in the full-screen player's quality panel; the player warns once per song if the output clips at the current volume
- ✨ Spatial scene (quality panel → "Spatial scene", binaural): a 3D view of a virtual head among the 15 objects, which move with their live positions and glow with their level. Drag to turn your head and every object's HRTF and room reflections follow the new orientation, audible about 0.15 s later; walk around the room (objects get louder as you approach), first-person view, click an orb to solo / mute it, focus on the objects you face, exaggerate the elevation, tour, or turn with the gyroscope on a phone
- ⚡ With AudioWorklet available (HTTPS or localhost), JOC renders frame by frame along the playback position, only ~0.1 s ahead, so interactive changes take effect at once; otherwise it still renders fragments ahead

## v0.6.0 (2026-10-24)

### New
- ✨ The full-screen player is rebuilt on AMLL react-full: a horizontal layout (cover, title and controls on the left, lyrics on the right, toggles along the bottom; the left column slides to the centre when lyrics are hidden) and a vertical layout (small cover above the lyrics, or a big cover, moving on a spring); react-full icons and press animations for play/pause, previous/next (arrow animation), shuffle, repeat and the lyrics and queue toggles, stretchy progress and volume sliders; slides in and out, drag the handle down to close on touch, click the total time for remaining time, and the queue opens in the lyrics area on desktop too
- ✨ The full-screen player shows a quality badge under the progress bar; click it for the current quality's specs and playback method, plus the song's other qualities to switch to

### Changed
- 💄 The bottom player bar uses the full-screen player's icons (playback controls, shuffle / repeat, lyrics, queue, volume); shuffle and repeat show a filled rounded square when on. The quality badge is no longer shown on the bar
- 💄 The Dolby Atmos quality icon is now the one-line "Dolby Atmos" wordmark, sized to match the other quality icons

## v0.5.9 (2026-10-23)

### New
- ✨ Settings, File names: variables now follow the template being edited and list only the ones it supports (e.g. the playlist folder has just the playlist name, curator and playlist ID), grouped by song / album / quality / playlist / ID with IDs collapsed; the preview warns about unknown variables and ones that don't apply to that template
- ✨ Playback errors show a retry countdown and a "Retry now" button

### Fixes
- 🐛 Segment or key load failures were retried every 3 s forever, and pumps while buffered audio was still playing bypassed the timer: retries now back off 3 / 6 / 12 / 24 / 48 s with jitter and stop after 5 attempts

### Changed
- ♻️ The FairPlay key used for the leading segments (`P000000000/s1/e1`) is now called the prefetch key: it does not always cover only the first segment (some songs switch to the track key at the third). Decryption already followed each segment's own EXT-X-KEY; only names and wording changed (including the ALAC check option)

## v0.5.8 (2026-10-22)

### New
- ✨ Settings: a "Fallback order" list under "Fall back when missing" shows the preferred quality and the qualities tried after it; each can be moved up / down or removed, others added, and "Default" restores the built-in order. Orders are saved per preferred quality, so a quality picked in the download dialog uses its own; an empty order means no fallback
- ✨ The download center shows ALAC check results in full (no truncation; on narrow screens they wrap under the title with the quality), and album / playlist cards show a check summary

### Fixes
- 🐛 Songs without a master only have the Widevine AAC-LC 256 from `/webplayback` (e.g. cn `1569279827`) and were downloaded at AAC 256 whatever the settings: they now follow the same order as other qualities and are downloaded only when AAC 256 is preferred or in the fallback order, otherwise skipped

### Changed
- ⚡ Songs that amp-api marks `hasLyrics: false` no longer request lyrics from wrapper-lite; a failed lyrics fetch (other than 404) is tried up to 3 times, 1 s and 2 s apart, and stops at once when the download is cancelled

## v0.5.7 (2026-10-21)

### New
- ✨ "Check ALAC" can also check the master m3u8 from wrapper-lite: it may be packaged differently from the web API's (amp-api `enhancedHls`) and sometimes has a better ALAC (`1679278167`: 24/48 on the web, also 24/96 via wrapper-lite). The same best ALAC is checked once; different ones are both listed and the better one is marked
- ✨ ALAC check on playlist and song pages and in songs' More menu (albums, playlists, search and more)
- ✨ The song page compares the web API's master with wrapper-lite's, tags qualities only wrapper-lite has and can copy the web master URL
- ✨ Settings: turn off the ALAC END-tag repair of downloads; check ALAC while downloading and write the result to a custom tag (`ALAC_CHECK` by default), also shown in the download center; the check reads the downloaded data itself, with no extra requests

### Changed
- 💄 The check dialog no longer starts by itself: select all, none or some tracks; it shows the region, the album / playlist / song ID, song IDs and the check time; the options are one line of short labels with the explanations under "About", and each source's result is a card

## v0.5.6 (2026-10-20)

### New
- ✨ "Check ALAC" on album pages (the waveform button next to Play and Shuffle): finds the escape frames whose end was overwritten in every track's best ALAC stream ([AppleMusicDecrypt#136](https://github.com/WorldObservationLog/AppleMusicDecrypt/issues/136)), without wrapper-lite and without requesting `/key`
  - The master m3u8 comes from amp-api's `extendedAssetUrls.enhancedHls`; only each segment's moof is downloaded, plus the last 4 bytes (the part cbcs leaves unencrypted) of samples larger than one frame of PCM, about 80 KB for a 16-bit / 44.1 kHz track
  - Tells "END tag missing" (FFmpeg and others drop the frame) from "Hidden damage" (the END tag happens to be `111` but the padding is not zero: it decodes, but the last sample is wrong), lists frame numbers, times and the last 4 bytes, and copies a text report
  - Shows the packaging date (creation time in the init segment's `mvhd`) and the packager version (`swre`)
  - Optionally decrypts the first segment (about 15 s) with the fixed key and decodes it to measure the real bit depth (low bits always zero?) and bandwidth (highest frequency above the quantization noise; a steep drop suggests upsampling or a lossy source), with a spectrum chart

### Changed
- 📝 The README now describes the ALAC end-tag repair accurately: restoring the END tag only stops decoders from dropping the frame; the overwritten last sample cannot be restored

## v0.5.5 (2026-10-19)

### Changed
- 💄 The player bar is rebuilt after music.apple.com as a floating glass pill (56px tall, at most 720px wide): playback controls, an LCD, and actions
  - The LCD has 34px artwork, a two-line marquee and a 2px progress line that expands to 7px with times on hover or drag
  - Volume becomes a speaker button with a slide-out slider; click to mute
  - Playback notices (FLAC transcoding, multichannel PCM) move into a popover behind the mode badge, shown automatically only the first time; playback errors float above the bar
  - Compact mini-player layout at 760px and below
- 💄 The song page is rebuilt after music.apple.com
  - Header: 208px artwork (300px at 1260px and up) with a glow, centred on phones; title, linked artists, album · year · genre and audio-trait badges; the page is tinted with the artwork colour like the album page
  - The Play button turns into Pause while the song plays; a favourite button and a More menu (library, playlists, download, copy links, open in Apple Music) replace the row of buttons
  - The quality list is grouped by format in rounded cards, with rows styled like album track rows; each row has a download button whose progress ring cancels on click; the More menu adds "Copy m3u8 link"; skeleton rows while loading
  - New Credits, Information, Music Videos and More By sections

## v0.5.4 (2026-10-19)

### New
- ✨ Preferred quality adds AAC 128 kbps, AAC Binaural 128 kbps, HE-AAC Binaural 64 kbps, AAC Downmix 128 kbps and HE-AAC Downmix 64 kbps (Apple's masters already carry them; previously the highest bitrate of a kind was always taken), 11 choices in all. The menu in Settings and the download dialog is grouped as Lossless & Dolby Atmos / AAC Stereo / AAC Binaural / AAC Downmix, and the description gives rough file sizes per minute. Each new choice has its own fallback order, e.g. a stereo-only song asked for Binaural 128 gets HE Binaural, then Stereo 128 (#4)
- 📝 README links the Telegram group [@apple_music_alac](https://t.me/apple_music_alac)

### Fixes
- 🐛 Some older music videos (e.g. 1175186184) have media playlists without `EXT-X-KEY` and failed with "No PlayReady media found"; they now play and download

## v0.5.3 (2026-10-19)

### New
- ✨ `--client-concurrency`: max wrapper-lite requests relayed at once per client IP (`/status` not counted); further requests wait instead of failing. Together with the per-minute `--client-rate`, one visitor's burst can no longer hold every `--wrapper-concurrency` permit and stall everyone else. Waiting requests are logged as `QUEUED … by client concurrency`

### Fixes
- 🐛 `/status` is not counted by `--client-rate`, yet a client could keep requesting it and every request reached wrapper-lite, using up `--wrapper-rate` and concurrency permits: all clients now share one result for 10 s and simultaneous requests are merged, so wrapper-lite gets at most one `/status` per 10 s; the upstream `/status` also has a 10 s timeout

## v0.5.2 (2026-10-19)

### New
- ✨ `--client-rate`: max relayed wrapper-lite requests per client IP in any 60 seconds (`/status` not counted); further requests get HTTP 429 with `Retry-After` and never reach wrapper-lite, so one visitor (e.g. batch-downloading whole artists) cannot use up a shared wrapper-lite; rejected requests are logged as `client <ip> over N/min`
- ✨ `--client-ip-header`: take the client IP from a header set by the reverse proxy (e.g. `X-Real-IP`, `CF-Connecting-IP`); the TCP peer address by default

### Fixes
- 🐛 wrapper-lite concurrency limit: a request that timed out, failed while reading the response, or was cancelled (client disconnected) returned its permit at once while wrapper-lite might still be processing it, so under a slow upstream the real concurrency exceeded `--wrapper-concurrency` (a public wrapper-lite then answered `rate limited (concurrency)` and later `banned`). Such permits are now held for 30 more seconds; a complete reply or a connect failure still returns it at once. The `wrapper-lite THROTTLED` line shows the held count

## v0.5.1 (2026-10-19)

### New
- ✨ `--local-wrapper-only`: the binary no longer relays wrapper-lite; pages only connect from the browser (as on a serverless deployment without `AM_HOOK_WRAPPER_URL`), and `--wrapper-url` / `--wrapper-rate` / `--wrapper-concurrency` become the page's local-mode defaults
- ✨ `--wrapper-hint` (`AM_HOOK_WRAPPER_HINT` on serverless): an operator note above the local wrapper-lite settings; URLs in it become links
- ✨ wrapper-lite queueing in the console: while requests wait, a `wrapper-lite THROTTLED` line every second (sent in the last second / limit, in flight, queued), and a summary when the queue empties; queued requests are marked `QUEUED … by rate limit / concurrency limit` in the request log

### Fixes
- 🐛 wrapper-lite rate limit: a queued request cancelled while waiting (browser abort or disconnect) let one extra request through, which could exceed `--wrapper-rate` within that second

## v0.5.0 (2026-10-18)

### New
- ✨ Radio (`/radio`, between Top Charts and Settings in the sidebar and phone menu): the editorial sections of music.apple.com/{cc}/radio, with a LIVE badge and the show on air on the live radio shelf; with a media-user-token, Your Stations (the personal station and recently played) comes first
- ✨ Station pages (`/https://music.apple.com/<cc>/station/<slug>/ra.<id>`); station links on New, editorial pages and Radio open them here:
  - Personal and editorial stations: the playlist track list holding the station's next songs, with a new batch or more on demand; playback fetches the next batch before the queue runs out (new `more` option of `AmPlayer.playQueue`)
  - Episodes (audio or video): the music video layout, with playback, seeking and downloads as M4A / MP4 (tagged with title, show, air date and artwork)
  - Live radio: the music video layout, playing near the live edge with the song on air (ID3 in the segments' emsg) and the schedule
- ✨ Stations need the media-user-token of an Apple Music account (wrapper-lite does not support stations yet): the first station page asks for it (a whole Cookie header also works), checks it and keeps it only in the browser; a rejected token is asked for again, and Settings can change or clear it
- ✨ New station endpoints on the server (binary and serverless): `/station/next-tracks/<id>`, `/station/assets`, `/station/catalog/...`, `/station/recent` and `/station/storefront` call amp-api with the media-user-token (never cached), and `/station/license` sends Widevine / PlayReady license requests shaped as MusicKit does straight to Apple's license servers

### Changed
- The MV engine's download is split into a shared `downloadStreams` (used by MVs and episodes; a single stream keeps its own track)

## v0.4.9 (2026-10-18)

### Bug Fixes
- 🐛 Saving to a folder failed for names that start or end with `~` (e.g. the album "A COMPLETE ~ALL SINGLES~": `Failed to execute 'getDirectoryHandle'`): name sanitizing now follows Chrome's rules, replacing a leading or trailing `~` with the full-width `～` and removing leading and trailing dots and whitespace (including the ideographic space), C1 control characters, format characters (zero-width spaces, direction marks, etc.), noncharacters and lone surrogates; `.lnk` / `.local` / `.{…}` extensions and reserved names such as `clock$`, `desktop.ini`, `thumbs.db` and `COM¹` are renamed too
- 🐛 Saving failed for overly long names: each name is capped at 240 bytes (UTF-8; macOS / Linux allow 255 bytes, which long Japanese titles used to exceed), and the path below the chosen folder at 150 characters with album / playlist folders at 90, to stay within the 260-character Windows path limit (including Chrome's `.crswap` temporary suffix); when over, the longest segment is shortened first
- 🐛 The file name previews in Settings show the shortened result actually used

## v0.4.8 (2026-10-18)

### Bug Fixes
- 🐛 Downloaded songs skipped from about 13 s to 15 s in VLC: Apple Music gives the first ~15 s (prefetch key) and the rest (real key) separate sample descriptions, which are identical once decrypted, but the chunks switch description index at 15 s, so VLC recreates the decoder and drops the ~2 s of audio it had buffered. Defrag now merges identical `stsd` entries so the whole song uses one description index (AAC, ALAC and Atmos alike)

## v0.4.7 (2026-10-15)

### Bug Fixes
- 🐛 `type="replacement"` lyric localizations (e.g. a zh-Hans-CN replacement for zh-Hant lyrics) replace the main lyrics instead of showing as a translation; word-synced lyrics keep the replacement's own word timing, so downloaded word-synced LRC no longer falls back to line-synced
- 🐛 Unsynced lyrics (`timing="None"`) open at the top of the lyrics view instead of scrolling to the end

## v0.4.6 (2026-10-13)

### Bug Fixes
- 🐛 The binary's 404s also carry `no-store` (as on serverless deployments): behind a CDN (such as the Cloudflare proxy), the 404 for a missing content-hashed URL is not cached, so rolling back a version cannot leave the page stuck on a cached 404

## v0.4.5 (2026-10-13)

### Bug Fixes
- 🐛 On serverless deployments, the 404 for a missing content-hashed URL (an old page asking for a version that is gone) also carried `immutable`, so after rolling back to that version browsers kept the cached 404: such requests now reach the function, which returns a `no-store` 404
- 🐛 Vercel deployments no longer expose `/_headers`: `build-static` writes it only with `--cloudflare` (the `wrangler.toml` build command)

## v0.4.4 (2026-10-13)

### Changed
- ⚡ Front-end assets are loaded by content-hashed URLs (`/assets/h/app.<hash>.mjs`) cached as `immutable`, so pages, modules, Workers and wasm are no longer revalidated (304) on every load
  - References between text assets (`/assets/...` and `./x.mjs` relative paths) are rewritten to the hashed URLs by the server and by `build-static`; hashes cover the rewritten content, so a changed dependency also changes the URLs of the assets referencing it
  - The app shell stays `no-cache` and points at the new URLs right after an upgrade; original URLs are still served with `no-cache` + ETag; serverless deployments set the cache headers in `vercel.json` and `dist/_headers` (Cloudflare)
- ⚡ Workers are reused during batch downloads and playback: song defragmentation, OPFS writing, MV download and FLAC transcoding Workers are kept after a job (terminated after 30 s idle) instead of refetching and recompiling `media.wasm` and the others for every song

### Bug Fixes
- 🐛 A transient wrapper-lite `/m3u8` error (such as HTTP 500) during batch downloads downgraded the song to AAC-LC 256: `/webplayback` is now used only when `/m3u8` returns an `.m4p`, and failed requests are reported and retried

## v0.4.3 (2026-10-12)

### New
- ✨ Songs without a master m3u8 (wrapper-lite `/m3u8` only gives an `.m4p`, e.g. `1569279827`) can be played and downloaded: as in apple-music-downloader, they use the AAC-LC 256 stream from `/webplayback` (Widevine)
  - The song page lists the single "AAC · 256 kbps" variant tagged "AAC-LC only"; batch downloads take it whatever the quality settings (marked as a fallback when another quality was preferred)
  - The Widevine license request is built in the media Worker (new `widevine` module in `am-media`, a port of the reference CDM and its built-in device, sharing `media_challenge` / `media_license` with the MV PlayReady path); PlayReady is tried if Widevine fails
  - Fragments are CENC-decrypted in place (same length) by the existing Worker pool, so playback, seeking, downloads and tags follow the song pipeline

### Changed
- `/mv/license` (and the serverless one) also accepts Widevine requests without `drm-type`
- `media_challenge` takes a new first argument selecting the DRM (0 PlayReady, 1 Widevine)
- Smaller wasm: `media.wasm` 465 → 306 KB, `hook.wasm` 242 → 213 KB, `flac.wasm` 45 → 33 KB
  - `hook.wasm` and `media.wasm` use a new `wasm` profile (size-optimized, with the decryption hot spots temari and AES kept at opt-level 3): FairPlay / CENC decryption speed is unchanged, MV decryption in `media.wasm` is about 8% slower
  - The fixed decryption template embedded in `hook.wasm` is binary (`fixed_template.bin`, generated from `fixed_template.json` and checked by a test) instead of 56 KB of base64 JSON
  - `flac.wasm` now goes through wasm-opt too; `scripts/build-wasm.sh` takes the wasm-opt command from `WASM_OPT` and warns when it is missing

## v0.4.2 (2026-10-12)

### New
- ✨ Music videos in albums and playlists can be downloaded with them: the download dialog lists them (checked by default, with a one-click "Skip music videos"), single music videos can be downloaded from their More menu, and progress shows in the download center
  - As in apple-music-downloader, the video (max resolution, 2160p by default) and audio (Atmos → AC-3 → AAC / AC-3 → AAC / AAC only) are picked by the new Music videos group in Settings; files use the album / playlist track templates with an `.mp4` extension
  - Tags follow the reference `writeMVMP4Tags`: title, artist, album (from the album or playlist), disc / track numbers, release date, ISRC, UPC, copyright, label, rating, `PERFORMER` and `RELEASETIME`, with the MV thumbnail as cover art; the media type is Music Video (`stik` 6)
- ✨ The MV page's own download is tagged the same way

### Changed
- MV downloads are no longer time-interleaved: the video track is downloaded before the audio track, and defrag lays the file out like the reference `mv.Mux`, one chunk per trun with tracks one after another (`defrag::Options::mv` only changes the ftyp)
- MV downloads keep 4 segment requests in flight (decryption and writing stay in order) instead of waiting for each segment
- MVs packed into a ZIP get their CRC-32 while defrag writes them, so the file is not read a second time

## v0.4.1 (2026-10-12)

### Changed
- Album, playlist, artist and library playlist headers keep only Shuffle, Play and More: download, favorite, add to library, edit playlist, artist info and the rest moved into the More menu
- More menus now use the music.apple.com amp-contextual-menu style: frosted material, label on the left and icon on the right; on phones a 270px sheet centered at the bottom over a scrim

### Bug Fixes
- 🐛 Shuffle and Download buttons overlapping on album and playlist pages on phones

## v0.4.0 (2026-10-12)

### New
- ✨ Settings (`/settings`, below Top Charts in the sidebar and the phone menu): general and download settings (quality, performance, save mode, file name templates, tags, cover art, lyrics), stored in the browser
- ✨ Batch downloads of albums and playlists: the download button on album and playlist pages picks the quality and tracks; songs, albums and playlists can also be downloaded from every More menu
  - Full iTunes tags, cover art and lyrics (LRC, optionally word-timed, with translation / pronunciation lines), plus optional `cover.jpg` and `.lrc` / `.ttml` files
  - Saved as a ZIP (with ZIP64), into a local folder (File System Access API, optionally skipping existing files) or as separate files; playlists can include an `.m3u8`
- ✨ Download center: stays at the bottom like the player bar with overall progress and speed, and expands to every track's progress with cancel, retry, save again and remove

### Changed
- "Download decrypted file" on the song page now goes through the download manager, so it is tagged with metadata, cover art and lyrics and shows in the download center
- The `media.wasm` defrag can write ilst tags while building `moov` (`media_defrag` takes a tags argument) and computes CRC-32 while writing

## v0.3.2 (2026-10-10)

### New
- ✨ Deployable to a serverless platform (Vercel or Cloudflare Workers) without running the binary; the README has one-click deploy buttons
  - The platform hosts the static assets and the backend is a single function (`serverless/core.mjs`): the amp-api catalog proxy and the MV master fetch; amp-api responses are cached by the platform
  - By default the browser talks to your own wrapper-lite directly (local mode); set the `AM_HOOK_WRAPPER_URL` environment variable (and optionally `AM_HOOK_WRAPPER_AUTH`) to have the function relay instead, without rate or concurrency limits, so restrict access with the platform's access control
  - `node scripts/build-static.mjs` builds `dist/` from the asset table in `src/assets.rs`; the build needs only Node

### Changed
- New `/assets/host.js` tells the page whether the server can relay wrapper-lite; when it cannot, the "wrapper-lite" setting only offers "Local". The binary behaves as before

## v0.3.1 (2026-10-09)

### Changed
- Code quality pass with no functional change: `cargo clippy --workspace --all-targets -- -D warnings` is warning-free and now runs in CI
  - Embedded front-end assets are registered from a single table in `src/assets.rs`; unknown `/assets/views|lyrics|mv/*` paths now return a plain-text 404, and MV JS / CSS responses carry `charset=utf-8`
  - `src/m3u8.rs` is renamed `src/links.rs` (it only handles links and page paths), and shares its path regex fragments with the request log
  - temari's FFI exports are `unsafe extern "C"` with `# Safety` docs (C ABI unchanged)

### Bug Fixes
- 🐛 temari panicked when a `\u` escape in JSON was followed by a multi-byte character (surfaced as NULL over FFI); the escape is now ignored

## v0.3.0 (2026-10-09)

### New
- ✨ The web page can use your own local wrapper-lite: switch the "wrapper-lite" setting at the bottom of the navigation to "Local" and the browser sends wrapper-lite requests itself
  - URL, max requests per second, max concurrent requests and `Authorization` are configurable and saved in the browser
  - The URL may carry credentials (such as `https://<token>@host`), sent as `Authorization: Basic …` as with `--wrapper-url`
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
