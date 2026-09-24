# am-hook

[中文](README.zh-CN.md) | English

An Apple Music FairPlay HLS decrypting reverse proxy written in Rust. It listens on a local port, wraps upstream Apple Music CDN URLs, strips encryption metadata from HLS playlists, and decrypts FairPlay-protected fMP4 fragments in memory so players and download managers receive clean, playable content.

## How It Works

Requests follow the pattern:

```
http://<host>:8888/https://aod.itunes.apple.com/itunes-assets/...
```

Only URLs containing `aod.itunes.apple.com/itunes-assets/` are handled. Three types are recognized by filename:

| Type | Filename pattern | Behavior |
|---|---|---|
| Master m3u8 | `P<digits>_<not-A-start>.m3u8` | Forwarded unchanged |
| Media m3u8 | `P<digits>_A<digits>_...m3u8` | Metadata extracted, `#EXT-X-KEY` lines stripped. By default rewritten to a generic playlist (`EXT-X-VERSION:3`, no `EXT-X-MAP` / `EXT-X-BYTERANGE`, one URL per segment) for players with weak fMP4 byte-range HLS support such as PotPlayer; append `?hook=byterange` to keep Apple's original layout |
| Media file | Same as media m3u8, `.m3u8` replaced with `_m.mp4` | Fragment bytes fetched by range, samples decrypted in place, metadata boxes neutralized, streamed back |
| Media segment | Media file with `_m.mp4` replaced by `_m_seg<N>.mp4` | Init segment + fragment N, self-contained and independently decodable (Range supported) |

### Decryption Flow

1. A media m3u8 request builds a track context containing `adamId`, `skd://` URI, `fileuri`, the first fragment range, and all fragment byte ranges.
2. A background monitor fetches the track decryption template from wrapper-lite via `GET /key?adamId=<adamId>&uri=<skd-uri>` as soon as the context is complete.
3. The first fragment uses a fixed template embedded in the binary (for `skd://itunes.apple.com/P000000000/s1/e1`); subsequent fragments use the per-track template.
4. Media file requests map HTTP ranges onto fragments and fetch only the needed bytes from the CDN. Up to `--prefetch` fragments are downloaded concurrently and their samples decrypted in parallel on temari's worker pool (off the async runtime), then streamed out in order. Concurrent requests for the same fragment share one download/decrypt, results go into a byte-bounded LRU cache, and the next fragment is warmed up when a player requests fragment by fragment. Pending work is cancelled when the client disconnects.
5. FairPlay metadata boxes (`sinf`, `senc`, `saiz`, `saio`, `pssh`, and `sgpd`/`sbgp` with grouping type `seig`/`seam`) are replaced with equal-length `free` boxes, so byte lengths and HTTP Range offsets stay exact. The `enca` box in the init segment is rewritten to the original codec (`ec-3`, `mp4a`, `alac`, etc.).

## Web UI

Open `http://127.0.0.1:8888/` in a browser:

- Paste a song link, an album share link with `?i=`, or a bare numeric song ID.
- The song page parses every variant automatically (lossless ALAC, Dolby Atmos, AAC, HE-AAC, including binaural and downmix versions) and shows artwork and track info (via `/meta/:adamId`, which proxies the iTunes Lookup API).
- Each variant has an alist-style "more" dropdown: play in VLC (`vlc://<media m3u8 URL>`, the same format alist uses), copy the media m3u8 / media file (IDM) URL, or download the decrypted file. Desktop VLC registers no `vlc://` handler by default, so a protocol handler must be installed separately; the Android / iOS VLC apps handle it directly.
- Built-in web player: uses MSE to load BYTERANGE segments on demand, so seeking jumps straight to the right segment; falls back to native HLS (Safari, which plays ALAC and E-AC-3) or a direct media file source. Codecs the browser cannot play are marked accordingly. Space and arrow keys and system media controls are supported.

## Requirements

- Rust 2021 edition toolchain (`cargo build`)
- A running wrapper-lite key server (default `http://127.0.0.1:12340`)

## Build

```sh
cargo build --release
```

The binary is output to `target/release/am-hook.exe` on Windows.

## Run

```sh
am-hook --listen 0.0.0.0:8888 --wrapper-url http://192.168.31.105:3001
```

All options:

| Flag | Default | Description |
|---|---|---|
| `-l, --listen <ADDR>` | `0.0.0.0:8888` | Listen address |
| `-p, --port <PORT>` | optional | Overrides the port in `--listen` when set |
| `-w, --wrapper-url <URL>` | `http://127.0.0.1:12340` | wrapper-lite key server base URL |
| `--cache-ttl <SECONDS>` | `1800` | Track context TTL before eviction |
| `--lru-cache-mb <MB>` | `128` | Decrypted-fragment LRU cache capacity in MB (byte-accounted) |
| `--prefetch <N>` | `4` | Fragments fetched and decrypted concurrently per request |
| `--template-timeout <SECONDS>` | `20` | How long to wait for a track's decryption template |

## Testing

```sh
cargo test
```

Unit tests cover URL parsing, m3u8 rewriting, MP4 box patching, range parsing and cache deduplication. End-to-end tests run against the live CDN and a wrapper-lite instance (default `http://127.0.0.1:12340`, override with `AM_HOOK_WRAPPER`) and verify that decrypted fragments start with the correct E-AC-3 sync word (`0x0B 0x77`) and that cross-fragment ranges match the full file.

## Project Layout

```
src/
  cli.rs               CLI argument parsing
  main.rs              Server startup
  lib.rs               Router construction
  source.rs            Source URL normalization and classification
  proxy.rs             Request dispatch, range streaming, fragment fetch/decrypt scheduling
  m3u8.rs              HLS playlist parsing and key stripping
  mp4.rs               ISOBMFF parsing, box patching, sample decryption
  state.rs             Track contexts (deduplicated init) and fragment cache
  wrapper.rs           wrapper-lite key fetch client
  monitor.rs           Background template fetch and TTL cleanup
  ui.rs                Web UI endpoints (status, parse, metadata)
  ui/                  Pages, styles and web player (home.html / song.html / app.css / player.js)
  embedded_template.rs Fixed first-fragment template
  fixed_template.json  Embedded template data
crates/temari/         Vendored Temari FairPlay decryption library
tests/e2e_test.rs      End-to-end integration tests
```
