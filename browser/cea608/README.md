# Browser CEA-608 decoder

`cea-608-parser.ts` is vendored from video-dev/hls.js at the commit recorded in
`REVISION`, path `src/utils/cea-608-parser.ts`. Its embedded DASH Industry Forum
BSD notice is preserved, alongside the hls.js license in `LICENSE`.

`scripts/build-cea608.cjs` transpiles it to `src/ui/mv-cea608.mjs` (built with
TypeScript 5.6.2). The only runtime
adaptations replace hls.js logging with a no-op and its JSON helper with native
`JSON.stringify`. The caption state machine is unchanged. Rebuild with:

    node scripts/build-cea608.cjs <path-to-typescript-package>

The app does not need Node/TypeScript at runtime. `mv-captions.mjs` reads QuickTime
`c608` / `cdat` / `cdt2` samples from already decrypted MP4 fragments and translates
decoder screens into native `VTTCue` captions. This handles independent CEA-608
tracks, including both fields; it does not implement CEA-708 or video SEI extraction.

Caption labels/languages come from HLS CLOSED-CAPTIONS renditions. The first track
with text is shown by default and can be disabled using the video's native subtitle
menu. Cue times use the same normalized fragment timestamps as video/audio.
