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
| Media m3u8 | `P<digits>_A<digits>_...m3u8` | Metadata extracted, `#EXT-X-KEY` lines stripped, returned as unencrypted |
| Media file | Same as media m3u8, `.m3u8` replaced with `_m.mp4` | Fragment bytes fetched by range, samples decrypted in place, metadata boxes neutralized, streamed back |

### Decryption Flow

1. A media m3u8 request builds a track context containing `adamId`, `skd://` URI, `fileuri`, the first fragment range, and all fragment byte ranges.
2. A background monitor fetches the track decryption template from wrapper-lite via `GET /key?adamId=<adamId>&uri=<skd-uri>` as soon as the context is complete.
3. The first fragment uses a fixed template embedded in the binary (for `skd://itunes.apple.com/P000000000/s1/e1`); subsequent fragments use the per-track template.
4. Media file requests map HTTP ranges onto fragments, fetch only the needed bytes from the CDN, decrypt samples in place, and cache results in memory.
5. FairPlay metadata boxes (`sinf`, `senc`, `saiz`, `saio`, `sgpd`, `sbgp`) are replaced with equal-length `free` boxes, so byte lengths and HTTP Range offsets stay exact. The `enca` box in the init segment is rewritten to the original codec (`ec-3`, `mp4a`, `alac`, etc.).

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
| `--lru-cache-mb <MB>` | `128` | Decrypted-fragment LRU cache capacity in MB |

## Testing

```sh
cargo test
```

Unit tests cover URL parsing, m3u8 rewriting, and MP4 box patching. End-to-end tests run against a live wrapper-lite instance and verify that decrypted fragments start with the correct E-AC-3 sync word (`0x0B 0x77`).

## Project Layout

```
src/
  cli.rs               CLI argument parsing
  main.rs              Server startup
  proxy.rs             Request routing and range streaming
  m3u8.rs              HLS playlist parsing and key stripping
  mp4.rs               ISOBMFF parsing, box patching, sample decryption
  state.rs             Track contexts and LRU cache
  wrapper.rs           wrapper-lite key fetch client
  monitor.rs           Background template fetch and TTL cleanup
  embedded_template.rs Fixed first-fragment template
  fixed_template.json  Embedded template data
crates/temari/         Vendored Temari FairPlay decryption library
tests/e2e_test.rs      End-to-end integration tests
```
