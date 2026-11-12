# AMLL lyric player

The lyrics view uses [Apple Music-like Lyrics](https://github.com/amll-dev/applemusic-like-lyrics)
(`@applemusic-like-lyrics/core`, version in `VERSION`, AGPL-3.0-only, see `LICENSE`):
`DomLyricPlayer` renders the lyrics, and `BackgroundRender` + `MeshGradientRenderer` draw
the flowing artwork background.

`scripts/build-amll.cjs` bundles `entry.mjs` with esbuild into `web/lyrics/amll-core.mjs`
and copies the package stylesheet to `web/lyrics/amll.css`. Its dependencies are bundled
too (gl-matrix MIT, bezier-easing MIT, @ungap/structured-clone ISC, deep-freeze public domain).
Pixi is only needed by AMLL's `PixiRenderer`, which is not used, so `pixi-stub.mjs` replaces
it and nothing from Pixi ends up in the bundle. Rebuild with:

    npm i --legacy-peer-deps @applemusic-like-lyrics/core@$(cat vendor/amll/VERSION) esbuild
    node scripts/build-amll.cjs node_modules

The full-screen player's layout, icons and animations follow AMLL's
[`react-full`](https://github.com/amll-dev/applemusic-like-lyrics/tree/main/packages/react-full) package
(same license). It is not bundled, since it needs React, framer-motion and jotai: `web/lyrics/panel.mjs` carries its SVG
icons and reimplements the horizontal/vertical layouts, the spring transitions (sampled into CSS `linear()` easings),
the bouncing slider, media-button and thumb animations in plain DOM; the styles are the "全屏播放界面" section of `web/app.css`.

The app does not need Node at runtime. Apple TTML is still parsed by `web/lyrics/ttml.mjs`
(translations and pronunciations come from the iTunes metadata); `panel.mjs` converts that
model to AMLL `LyricLine`s.
