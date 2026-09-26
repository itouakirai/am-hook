# am-hook

[中文](README.zh-CN.md) | English

An Apple Music FairPlay HLS decryption tool written in Rust. By default **decryption happens entirely in the browser**: the server only provides the master m3u8 and per-track decryption templates, while the browser fetches audio straight from Apple's CDN and decrypts it with WebAssembly in Web Workers, so no media traffic goes through the server. When external tools such as VLC or IDM need decrypted URLs, start the server with `--hook` to enable the server-side decrypting proxy.

## How It Works

### Browser-side decryption (default)

Server endpoints:

| Endpoint | Description |
|---|---|
| `GET /parse/<adamId>` | Fetches the master m3u8 via wrapper-lite and returns its variants |
| `GET /key?adamId=<adamId>&uri=<skd-uri>` | Relays the track decryption template JSON from wrapper-lite `/key` |
| `GET /lyrics/<adamId>` | Fetches TTML lyrics from wrapper-lite `/lyrics` and returns the XML unchanged; 404 when the song has none |
| `/assets/hook.wasm`, `/assets/flac.wasm`, etc. | Pages, scripts and on-demand WASM modules (embedded in the binary, `no-cache` + ETag) |

In the browser (`src/ui/decrypt.js`):

1. The media m3u8 is fetched directly from `aod.itunes.apple.com` (the CDN allows CORS and Range requests) and parsed into the init segment, fragment byte ranges and the key used by each fragment.
2. The first fragment uses the fixed template embedded in the wasm (`skd://itunes.apple.com/P000000000/s1/e1`); the rest use the track template from `/key`.
3. Fragments are fetched from the CDN with Range requests and decrypted in place by a Worker pool (one `hook.wasm` instance per Worker). The decryption code is shared with the server (`crates/am-mp4`), so the output is byte-identical to `--hook` mode.
4. **Playback**: decrypted fragments feed MSE when the original codec is supported. If ALAC is unavailable but FLAC-in-MP4 MSE is supported, a separate `flac.wasm` is loaded on demand to losslessly convert ALAC packets to FLAC frames and remux them into small fMP4 fragments. EC-3 uses MSE when supported, otherwise the on-demand `ec3.wasm` decoder and Web Audio for 5.1/7.1 PCM. Both EC-3 paths decrypt in the browser and work without `--hook`. PCM playback does not render Atmos objects or provide the full spatial audio experience. Seeking jumps to the matching source fragment.
5. **Download**: 4 lanes fetch and decrypt concurrently and write each result at its original offset into an OPFS (Origin Private File System) temporary file. The finished disk-backed file is handed to the browser to save, so even large files use little memory. Without OPFS it falls back to in-memory Blobs.

> OPFS is only available in a secure context: HTTPS, or `localhost` / `127.0.0.1`. When the UI is opened over `http://<LAN IP>`, downloads fall back to memory and large files use more RAM. Playback is unaffected.

Both browser `hook.wasm` and server `--hook` repair identifiable ALAC end-tag damage after decryption (for example, song `1691044818`). The init segment's track and sample description identify complete uncompressed mono/stereo packets; a missing or damaged 3-bit `TYPE_END` is restored to `111`. PCM, sample lengths and Range offsets stay unchanged, so playback and downloads both benefit. Compressed packets, truncated PCM and packets without room for the tag are left untouched; FLAC transcoding retains its fallback that can append a missing tag byte.

### Server-side decrypting proxy (`--hook`)

With `--hook`, the server also serves these proxy URLs (they return 404 otherwise):

```
http://<host>:8888/https://aod.itunes.apple.com/itunes-assets/...
```

This is a **URL-prefix proxy** (like cors-anywhere): the client appends the CDN URL it wants to am-hook's address, and am-hook fetches, decrypts and returns it. It is not a reverse proxy (the client, not the proxy, chooses the upstream), nor an HTTP forward proxy that has to be configured in the OS or player; it is just a plain HTTP URL, which is why it can be handed directly to VLC, IDM and similar tools.

Only URLs containing `aod.itunes.apple.com/itunes-assets/` are handled. They are classified by filename:

| Type | Filename pattern | Behavior |
|---|---|---|
| Master m3u8 | `P<digits>_<not-A-start>.m3u8` | Forwarded unchanged |
| Media m3u8 | `P<digits>_A<digits>_...m3u8` | Metadata extracted, `#EXT-X-KEY` lines stripped. By default rewritten to a generic playlist (`EXT-X-VERSION:3`, no `EXT-X-MAP` / `EXT-X-BYTERANGE`, one URL per segment) for players with weak fMP4 byte-range HLS support such as PotPlayer; append `?hook=byterange` to keep Apple's original layout |
| Media file | Same as media m3u8, `.m3u8` replaced with `_m.mp4` | Fragment bytes fetched by range, samples decrypted in place, metadata boxes neutralized, streamed back |
| Media segment | Media file with `_m.mp4` replaced by `_m_seg<N>.mp4` | Init segment + fragment N, self-contained and independently decodable (Range supported) |

Server-side flow:

1. A media m3u8 request builds a track context containing `adamId`, `skd://` URI, `fileuri`, the first fragment range, and all fragment byte ranges.
2. A background monitor fetches the track decryption template from wrapper-lite as soon as the context is complete.
3. Media file requests map HTTP ranges onto fragments and fetch only the needed bytes from the CDN. Up to `--prefetch` fragments are downloaded concurrently and their samples decrypted in parallel on temari's worker pool (off the async runtime), then streamed out in order. Concurrent requests for the same fragment share one download/decrypt, and results go into a byte-bounded LRU cache. Pending work is cancelled when the client disconnects.

Box handling shared by both modes: FairPlay metadata boxes (`sinf`, `senc`, `saiz`, `saio`, `pssh`, and `sgpd`/`sbgp` with grouping type `seig`/`seam`) are replaced with equal-length `free` boxes, so byte lengths and Range offsets stay exact. The `enca` box in the init segment is rewritten to the original codec (`ec-3`, `mp4a`, `alac`, etc.).

## Web UI

Open `http://127.0.0.1:8888/` in a browser:

- The UI is available in Chinese and English; the button in the top-right corner switches instantly (the choice is remembered, and the first visit follows the browser language). Playback and downloads in progress are not interrupted.
- Paste a song link, an album share link with `?i=`, or a bare numeric song ID.
- The song page parses every variant automatically (lossless ALAC, Dolby Atmos, AAC, HE-AAC, including binaural and downmix versions) and shows artwork and track info (fetched by the browser directly from the iTunes Lookup API).
- Each variant has a "more" menu:
  - **Download decrypted file**: decrypted in the browser, with progress and a cancel button.
  - `--hook` only: download through the server; an **external players** grid (14 players including VLC, PotPlayer, mpv, IINA, Infuse, nPlayer and MX Player, using the same link schemes as OpenList) that plays any variant from the server-decrypted media m3u8, with players for the current platform first and the rest behind a toggle; and **Copy URL**, choosing between M3U8 (for players) and the media file (for download managers such as IDM). Each player must be installed and register its link scheme; desktop VLC, for example, registers no `vlc://` handler by default, so a protocol handler must be installed separately.
  - The "External player" button at the top of the page opens the player grid for the highest quality.
- Built-in web player: MSE with browser-side decryption, including lossless ALAC-to-FLAC playback when the browser supports FLAC-in-MP4 MSE. EC-3 falls back to multichannel PCM when MSE is unavailable, with a visible notice about its spatial-audio limitation. Downloads retain the original codec. In `--hook` mode, other codecs may use native HLS or a direct media file. Space and arrow keys and system media controls are supported.
- Lyrics view: when a song has lyrics, a Lyrics button appears on the player bar. The view comes from am-ttml: word- and line-synced highlighting, background vocals, duets, translation and pronunciation, instrumental dots, and click-to-seek on any line. Its moving background is generated from the album artwork. Press Esc to close it.

## Requirements

- Rust 2021 edition toolchain (`cargo build`)
- A running wrapper-lite key server (default `http://127.0.0.1:12340`)
- A browser with Web Workers and WebAssembly; MSE is used for native and ALAC-to-FLAC playback, while EC-3 PCM playback requires Web Audio

## Build

```sh
cargo build --release
```

The binary is output to `target/release/am-hook.exe` on Windows.

The browser decryption core `src/ui/hook.wasm` and ALAC-to-FLAC core `src/ui/flac.wasm` are prebuilt, committed and embedded into the server binary. `flac.wasm` loads only when ALAC conversion is needed. After changing the relevant crates, rebuild and commit the artifacts:

```sh
rustup target add wasm32-unknown-unknown
scripts/build-wasm.sh
# or manually:
cargo build -p am-wasm --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/am_wasm.wasm src/ui/hook.wasm
cargo build -p am-flac-wasm --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/am_flac_wasm.wasm src/ui/flac.wasm
```

## Run

```sh
# Default: the browser decrypts; the server only serves master m3u8 and templates
am-hook --listen 0.0.0.0:8888 --wrapper-url http://127.0.0.1:12340

# Also enable the server-side decrypting proxy (for VLC / IDM; uses server bandwidth)
am-hook --listen 0.0.0.0:8888 --wrapper-url http://127.0.0.1:12340 --hook
```

All options:

| Flag | Default | Description |
|---|---|---|
| `-l, --listen <ADDR>` | `0.0.0.0:8888` | Listen address |
| `-p, --port <PORT>` | optional | Overrides the port in `--listen` when set |
| `-w, --wrapper-url <URL>` | `http://127.0.0.1:12340` | wrapper-lite key server base URL |
| `--hook` | off | Enable the server-side decrypting proxy (media m3u8 / media file URLs) |
| `--cache-ttl <SECONDS>` | `1800` | `--hook`: track context TTL before eviction |
| `--lru-cache-mb <MB>` | `128` | `--hook`: decrypted-fragment LRU cache capacity in MB (byte-accounted) |
| `--prefetch <N>` | `4` | `--hook`: fragments fetched and decrypted concurrently per request |
| `--template-timeout <SECONDS>` | `20` | `--hook`: how long to wait for a track's decryption template |

## Testing

```sh
cargo test --workspace
```

Unit tests cover URL parsing, m3u8 rewriting, MP4 box patching (including that the in-place path used by wasm matches the parallel path), range parsing and cache deduplication. End-to-end tests run against the live CDN and a wrapper-lite instance (default `http://127.0.0.1:12340`, override with `AM_HOOK_WRAPPER`) and verify decrypted fragments, cross-fragment ranges, and that the proxy is refused without `--hook`.

## Project Layout

```
src/
  cli.rs               CLI argument parsing
  main.rs              Server startup
  lib.rs               Router construction
  source.rs            Source URL normalization and classification
  proxy.rs             --hook: request dispatch, range streaming, fragment fetch/decrypt scheduling
  m3u8.rs              HLS playlist parsing and key stripping
  state.rs             Track contexts (deduplicated init) and fragment cache
  wrapper.rs           wrapper-lite client (master m3u8, decryption templates)
  monitor.rs           --hook: background template fetch and TTL cleanup
  ui.rs                Web endpoints (status, parse, templates, static assets)
  ui/
    home.html / song.html / app.css   Pages and styles
    player.js          Web player (MSE)
    lyrics/            Lyrics view (ES modules): panel.mjs wires it to the player; the rest is am-ttml's parser, timeline, view and artwork backdrop
    decrypt.js         Browser decryption: m3u8 parsing, Worker pool, templates, download and OPFS
    hook-worker.js     Worker: wasm decryption and OPFS writes
    hook.wasm          Build output of crates/am-wasm
crates/
  am-mp4/              ISOBMFF parsing, box patching, sample decryption (shared by server and wasm); embeds the fixed first-fragment template
  am-wasm/             C ABI exports of am-mp4 for the browser (wasm32-unknown-unknown)
  temari/              Vendored Temari FairPlay decryption library
scripts/build-wasm.sh  Rebuilds src/ui/hook.wasm
tests/e2e_test.rs      End-to-end integration tests
```
