# am-media

Browser media core, compiled by `crates/am-media-wasm` to `web/media/media.wasm`
(`scripts/build-wasm.sh`) and run only in a Web Worker (`web/media/media-worker.js`).
The Rust server does not link it.

- `playready`: builds PlayReady license challenges and extracts the content key
  from XMR licenses, with the bundled default device.
- `widevine`: builds Widevine license requests (SignedLicenseRequest) and
  extracts content keys from SignedLicense responses, with the reference
  downloader's built-in device (`default_widevine_device.b64`, a pywidevine
  `.wvd` v2 file). Used for songs that only have the AAC-LC web playback stream.
- `cenc::decrypt_fragment_in_place`: length-preserving CENC/CBCS decryption for
  byte-range songs (encryption boxes become `free` boxes of the same size);
  linked into `hook.wasm` (`crates/am-wasm`) as `hook_decrypt_cenc`.
- `cenc`, `mv`: decrypt CENC/CBCS fragments, normalize decode timestamps, map
  track IDs and merge the video and audio initialization segments for muxing.
- `c608`: rewrites malformed closed-caption samples in place (Apple starts the
  c608 track with an all-zero sample, which recent FFmpeg rejects and mpv then
  treats as a fatal read error) as same-size `cdat` atoms of CEA-608 null pairs.
- `defrag`: converts a fragmented MP4 into a progressive MP4 (`ftyp`, `moov`,
  `mdat`). Only sample tables are held in memory; sample data is copied from
  the input through `readahead`, which serves the parser's small reads from a
  read-ahead window and passes chunk copies through at their exact size.
  - MV layout (`Options::mv`, MV downloads): the reference `mv.Mux` output,
    `isom` brands (`isom`, 0x200, `isom iso4`) with the song layout below.
  - Song layout (`Options::song`, song downloads): the reference
    `DefragmentMP4` of `internal/app/rip.go`, with the tag-compatible ftyp
    (`M4A `, 1, `M4A  mp42 isom iso5`), one chunk per source `trun` and
    tracks written one after another.

No transcoding or tag writing is done. The worker talks to OPFS through
synchronous access handles, or to in-memory stand-ins when OPFS is unavailable;
randomness and file IO are host imports, so no wasm-bindgen glue is needed.

MV downloads hold a Web Lock named after their `am-hook-mv-<uuid>` OPFS files
until they are disposed. When the MV page loads and before each download, any
such file whose lock is not held (tab closed or crashed, worker killed during
defrag) is deleted. Without Web Locks, only files untouched for 24 hours are.

## History and sources

This crate replaces a Go core (`browser/mvcore`, built with Go 1.22 into a 5.7 MB
`mv-core.wasm`). During the port every output was compared byte for byte with
the Go core on real MVs (license key extraction, cbcs decryption with caption
repair, muxing, both defragment layouts) and the song layout with the upstream
`DefragmentMP4` on real ALAC and AAC songs.

- `playready` is a port of puppyready (<https://git.gay/itouakirai/puppyready>,
  commit `17be0787ee7f02f27b71a99ac3d40ab2bd61ec04`, including its default
  device), itself a focused Go port of pyplayready's `Device`, `PSSH` and `Cdm`.
  Its README attributes the implementation to pyplayready and describes upstream
  licensing; the repository does not supply a separate license file.
- `widevine` is a port of `internal/widevine-rip/cdm`, `key` and `pssh.go` of
  apple-music-downloader (commit `487f705cdb693b194fe8dfedafd1064ea6570d05`),
  including its built-in device, without privacy mode. Protobuf messages are
  encoded and decoded by hand (field numbers from its `wv_proto2.pb.go`).
- Decryption and box handling reproduce the behaviour of
  `github.com/itouakirai/mp4ff` (`DecryptInit`, `DecryptFragment`,
  `Fragment.Encode`), which the Go core used (MIT, a fork of Eyevinn/mp4ff).
- Workflow reference: `internal/app/mv.go`, `internal/playready-rip/run.go`,
  `internal/widevine-rip/decrypt.go` and `internal/media/mv/mux.go` in
  <https://github.com/itouakirai/apple-music-downloader>, commit
  `487f705cdb693b194fe8dfedafd1064ea6570d05`. The wrapper uses only PlayReady.
- `defrag` is adapted from `internal/media/defrag/defrag.go` of the same
  repository, with file-system IO replaced by positional reads and a sequential sink.
- The Apple Music reference page uses MusicKit's `apple-music-video-player`.
  The MV page uses the browser's native accessible video controls and
  independent layout; no Apple player scripts are redistributed.

## Validation

`cargo test -p am-media` covers box round trips, CENC and CBCS decryption of
synthetic fragments, caption repair, both defragment layouts, read-ahead, AES-CMAC
(RFC 4493), XMR license decryption, the Widevine license round trip (request
signature, session key, key unwrapping) and in-place CENC/CBCS decryption. `node tests/mv_hls.cjs` and
`cargo test --test mv_api` are further offline checks.
`tests/mv_live.cjs` is an opt-in real browser test and writes a downloaded MP4
under `target/`. It checks playback, seeking, cancellation, OPFS cleanup and
that media URLs go directly to Apple. Use `ffprobe` / `ffmpeg` on the resulting
file to verify its streams and decodability.
