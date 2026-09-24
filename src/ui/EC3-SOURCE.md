# EC-3 decoder provenance

`ec3.wasm` and `ec3-runtime.mjs` are split from the size-optimized WebAssembly
build shipped in `@mediabunny/ac3` version 1.59.1. The runtime's embedded binary
was moved into a separate file by `scripts/extract-ec3.mjs`; no decoder logic
was changed. The upstream bridge source is
[`packages/ac3/src/bridge.c`](https://github.com/Vanilagy/mediabunny/blob/main/packages/ac3/src/bridge.c),
and the package build instructions are in its
[`README`](https://github.com/Vanilagy/mediabunny/blob/main/packages/ac3/README.md).
The package's MPL-2.0 license is copied in `EC3-LICENSE.txt`. The build also
contains FFmpeg's AC-3/E-AC-3 decoder; FFmpeg source and license information
are available from [FFmpeg](https://ffmpeg.org/legal.html).

To reproduce the two assets, unpack `@mediabunny/ac3@1.59.1` and run:

```sh
node scripts/extract-ec3.mjs package/dist/modules/build/ac3.js
```

The 594,237-byte WASM and 20 KB runtime are fetched only when this playback
mode is selected. The browser outputs the decoder's 5.1 or 7.1 PCM channel bed
through Web Audio; Atmos object rendering is not performed.
