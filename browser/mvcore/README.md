# Browser MV core

This module is compiled to `src/ui/mv-core.wasm` and runs only in a Web Worker.
The Rust server does not link it. Go is a build dependency, not a runtime service.
`python scripts/build-mv-wasm.py` rebuilds the WASM and copies the matching Go
runtime. The checked-in assets were built with Go 1.22.1.

The worker builds PlayReady challenges, parses licenses, decrypts CENC/CBCS
fragments, normalizes decode timestamps and merges initialization metadata.
JavaScript downloads CDN resources directly, feeds MediaSource or writes
interleaved fragments to OPFS. Working memory is bounded by current fragments
and the playback buffer. No defragmentation, transcoding or tag writing is done.
Only the two wrapper control requests go through Rust.

## Sources

- Vendored `puppyready/` is unchanged from
  <https://git.gay/itouakirai/puppyready>, commit
  `17be0787ee7f02f27b71a99ac3d40ab2bd61ec04` (including its default device).
  Its README attributes the implementation to pyplayready and describes upstream
  licensing; the repository does not supply a separate license file.
- MP4 encryption/decryption uses `github.com/itouakirai/mp4ff`, pinned in
  `go.mod` / `go.sum`, and its Eyevinn dependencies. Their MIT notices are included.
- Workflow reference: `internal/app/mv.go`, `internal/playready-rip/run.go`,
  `internal/widevine-rip/decrypt.go` and `internal/media/mv/mux.go` in
  <https://github.com/itouakirai/apple-music-downloader>, commit
  `487f705cdb693b194fe8dfedafd1064ea6570d05`. The wrapper uses only PlayReady.
- Go's runtime notice is in `GO-LICENSE`.
- The Apple Music reference page uses MusicKit's `apple-music-video-player`.
  This implementation uses the browser's native accessible video controls and
  independent layout; no Apple player scripts are redistributed.

## Validation

`node tests/mv_hls.cjs` and `cargo test --test mv_api` are offline checks.
`tests/mv_live.cjs` is an opt-in real browser test and writes a downloaded MP4
under `target/`. It checks playback, seeking, cancellation, OPFS cleanup and
that media URLs go directly to Apple. Use `ffprobe` / `ffmpeg` on the resulting
file to verify its streams and decodability.
