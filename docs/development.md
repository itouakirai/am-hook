# Development

[中文](development.zh-CN.md) | English

See [architecture.md](architecture.md) for how the pieces fit together and where each part of the code lives.

## Building

```sh
cargo build --release
```

The binary is written to `target/release/am-hook` (`am-hook.exe` on Windows). All browser assets, including the prebuilt WASM modules, are committed under `web/` and embedded into the binary, so a normal build needs only Rust. Rebuild the generated assets only after changing their sources:

| Asset (under `web/`) | Source | Rebuild |
|---|---|---|
| `decrypt/hook.wasm`, `flac/flac.wasm`, `media/media.wasm`, `joc/joc.wasm` | `crates/am-wasm`, `crates/am-flac-wasm`, `crates/am-media-wasm`, `crates/joc-wasm` (and the crates they use) | `rustup target add wasm32-unknown-unknown` and [binaryen](https://github.com/WebAssembly/binaryen)'s `wasm-opt` (or `WASM_OPT="npx -y -p binaryen@123.0.0 wasm-opt"`), then `scripts/build-wasm.sh`. `hook.wasm`, `media.wasm` and `joc.wasm` use the `wasm` profile in `Cargo.toml` (size-optimized; temari, AES and joc-core stay at `opt-level` 3 because they are hot paths). Commit only `wasm-opt`-optimized output |
| `mv/cea608.mjs` | `vendor/cea608` | `node scripts/build-cea608.cjs <path-to-typescript-package>` |
| `lyrics/amll-core.mjs`, `lyrics/amll.css` | `@applemusic-like-lyrics/core`, see [vendor/amll](../vendor/amll/README.md) | `node scripts/build-amll.cjs <node_modules>` |
| `ec3/ec3.wasm`, `ec3/runtime.mjs` | `@mediabunny/ac3` 1.59.1 | `node scripts/extract-ec3.mjs`, see [ec3/SOURCE.md](../web/ec3/SOURCE.md) |
| `joc/hrtf/*.jochrtf` | SADIE II SOFA files, compiled by am-hook-joc | Not rebuilt here, see [joc/NOTICE.md](../web/joc/NOTICE.md) |

The serverless build (`node scripts/build-static.mjs [dir] [--cloudflare]`) needs only Node and writes `dist/` from the same asset table.

### Adding a front-end file

1. Put it under `web/<area>/` (see the [layout](architecture.md#source-layout)). Its URL is `/assets/<area>/<file>`: the path under `web/` and the URL are always the same.
2. Add one line `asset!("<area>/<file>")` to `ASSETS` in `src/assets.rs`. The `Content-Type` follows the extension, and the binary and `scripts/build-static.mjs` both read this table.
3. Reference it with a relative import (`'../mv/hls.mjs'`) or its absolute URL (`'/assets/mv/hls.mjs'`) as a plain string literal, never a template or concatenation: references are rewritten to content-hashed URLs at startup, and only literals can be found.

`cargo test` fails when a file under `web/` is not registered, when a relative import points at no asset, or when a reference is left unhashed.

## Testing

| Suite | Command | Needs | CI |
|---|---|---|---|
| Rust | `cargo test --workspace` | nothing | yes |
| Lint | `cargo clippy --workspace --all-targets -- -D warnings` | nothing | yes (newer stable than you may have locally) |
| Node unit | `node tests/run.mjs unit` | Node | yes |
| Browser UI | `node tests/run.mjs ui [filter]` | Playwright + installed Chrome | no |
| Live | `node tests/run.mjs live [filter]` | a running am-hook, wrapper-lite, access to Apple | no |
| Rust live | `cargo test --test e2e_test -- --ignored` | wrapper-lite (`AM_HOOK_WRAPPER`, default `http://127.0.0.1:12340`) | no |

`tests/run.mjs` passes the Playwright package to each browser script: `$PLAYWRIGHT`, else `target/pw/node_modules/playwright-core` when present, else `playwright` from `node_modules`. Live scripts read the server from `AM_HOOK_URL` (default `http://127.0.0.1:8888`; the MV and radio scripts default to `http://127.0.0.1:18888` when it is unset). A filter keeps the files whose name contains it, e.g. `node tests/run.mjs ui library`. Every script can also be run directly: `node tests/ui/library_ui.cjs <playwright>`.

Rust unit tests cover the browser media core (PlayReady and Widevine license decryption, CENC/CBCS including the length-preserving in-place path, caption repair, defragmentation), URL parsing, m3u8 parsing, MP4 box patching (including that the in-place wasm path matches the parallel path), the asset table, cache deduplication and the MV endpoints. `crates/joc-core` checks the JOC renderer bit-exactly against am-hook-joc's reference digests on a fixture of real Atmos metadata (Speaker 2.0, binaural, reset, every HRTF field). Offline integration tests also check that Apple CDN URLs are not proxied.

<details>
<summary><b>tests/unit: offline, Node only</b></summary>

| File | Covers |
|---|---|
| `serverless.mjs` | The serverless backend (Vercel and Cloudflare entries) and the `dist/` layout |
| `alac_check.mjs` | ALAC check: escape-frame end verdicts (including the cases from issue #136), moof / init parsing, the prefetch key in multi-DRM playlists, bandwidth verdicts |
| `joc_wasm.mjs` | `web/joc/joc.wasm` against the same reference digests as `crates/joc-core`, all 20 HRTF fields, an invalid HRTF, and the real-time factor of both modes |
| `automix.cjs` | AutoMix planning from Apple's audio analysis: loudness curves, beats and vocals → overlap, gain and rate |
| `agent_duet.mjs` | Duet sides of TTML lyrics (`duetSides`, matching AMLL line by line) |
| `download_core.mjs` | ZIP / ZIP64, iTunes tags, file name templates, album name suffix, quality choice |
| `throttle.mjs` | Backing off on wrapper-lite rate limiting (429) in `wrapper.js` and the real download scheduler |
| `player_*.cjs` | Player: artwork, buffering windows, playback mode selection, PCM retries |
| `mv_hls.cjs`, `mv_captions.cjs` | MV playlists (links, variants, key rotation, byte ranges) and CEA-608 captions |

</details>

<details>
<summary><b>tests/ui: offline, Playwright + Chrome with local fixtures</b></summary>

These serve `web/` through `tests/support/web.cjs` (the same `/assets/<path>` = `web/<path>` layout as the binary) and fake every backend and Apple response.

| File | Covers |
|---|---|
| `ui_layout.cjs` | Page layout across viewports and languages: forms, overflow, menus, focus, player clearance |
| `lyrics_ui.cjs` | Lyrics view: loading, line tracking, seeking, translation, language, layout |
| `mv_ui.cjs` | MV page: viewports, languages, themes, keyboard selection, audio recommendation, loading errors, post pages |
| `library_ui.cjs` | Library and playlists: add, playlists, reorder, persistence, export / import and file validation, favorites, folders and drag-and-drop, database upgrade |
| `station_ui.cjs` | Radio and station pages: nav position, live shelf and Your Stations, the first media-user-token prompt, next songs and refills, episode and live layouts, Settings |
| `wrapper_local.cjs` | Local wrapper-lite mode: panel validation, direct requests with `Authorization`, limits, song master parsing, MV master via am-hook, local-only hosts |

</details>

<details>
<summary><b>tests/live: a running am-hook, wrapper-lite and Apple access</b></summary>

| File | Covers |
|---|---|
| `mv_live.cjs`, `mv_captions_live.cjs` | MV playback, download and captions |
| `alac_recovery.cjs`, `alac_source_recovery.cjs` | ALAC end-tag repair |
| `alac_check_ui.cjs` | Album page ALAC check: the two damaged frames of Shadows In The Night from issue #136, packaging date, first-15-seconds analysis, copied report, no `/key` request (wrapper-lite not needed) |
| `aac_lc_live.cjs` | A song without a master: AAC-LC variant, Widevine license, playback and seeking in server and local modes, download to `target/` |
| `search_ui.cjs`, `album_ui.cjs`, `playlist_ui.cjs`, `artist_ui.cjs`, `browse_ui.cjs` | Search, album, playlist, artist and browse pages (need access to music.apple.com) |
| `app_ui.cjs` | Single-page app: playback across navigation, queue, Back / Forward, lyrics |
| `download_ui.cjs` | Batch downloads: settings, album ZIP tags / cover / lyrics, folder mode, playlists and .m3u8, music videos, cancel / retry; needs wrapper-lite with the cn region |
| `radio_live.cjs` | Stations: needs a media-user-token from its third argument, `AM_HOOK_MEDIA_USER_TOKEN` or `target/my-media-user-token.txt`; genre and personal stations, Widevine license / playback / seeking / M4A download of an episode, and live radio simulated over its segments |

</details>

## Releasing

See [release.zh-CN.md](release.zh-CN.md) (Chinese).
