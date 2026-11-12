# JOC renderer provenance

`joc.wasm` and `decode-worker.js` (this directory) render E-AC-3 JOC (Dolby Atmos) objects
to stereo in the browser. They come from
[am-hook-joc](https://github.com/TheM14/am-hook-joc) by TheM14, integrated into
this repository:

- `crates/joc-core` (JOC / EMDF / OAMD parsing, object reconstruction, Speaker
  2.0 and binaural rendering) and `crates/joc-wasm` (the C ABI the worker
  calls). The Rust code is a port of the JustOneCacophony reference
  implementation and is available under AGPL-3.0-only or MIT; the MIT text is
  in `crates/joc-core/LICENSE`. `joc.wasm` is built by `scripts/build-wasm.sh`.
- The worker reuses this repository's EC-3 decoder (`web/ec3/ec3.wasm`, see
  [`../ec3/SOURCE.md`](../ec3/SOURCE.md)) for the core channels.

`crates/joc-core/tests/fixture.rs` and `tests/joc_wasm.mjs` check the native
and wasm builds against the reference digests from am-hook-joc on a fixture
that keeps only the real EMDF metadata of an Atmos stream (the audio payload is
zeroed and a synthetic tone bed is supplied by the tests).

## HRTF fields

`hrtf/*.jochrtf` are head-related transfer function fields compiled by
am-hook-joc's `tools/compile_hrtf.py` from the SOFA files of the
[SADIE II database](https://www.york.ac.uk/sadie-project/database.html)
(AudioLab, University of York): the dummy heads D1 and D2 and the subjects
H3-H20. The database is licensed under the Apache License 2.0
(<https://www.apache.org/licenses/LICENSE-2.0>), and the compiled fields remain
under that license.
