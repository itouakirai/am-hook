# am-hook

[中文](README.zh-CN.md) | English

An Apple Music decryption tool written in Rust, covering songs (FairPlay HLS) and music videos (PlayReady HLS).

By default **decryption happens entirely in the browser**. The server only talks to wrapper-lite (master playlists, decryption templates, licenses). The browser fetches media straight from Apple's CDN and decrypts it with WebAssembly in Web Workers, so no media traffic goes through the server.

![am-hook home page](docs/home.png)

## Quick Start

```sh
cargo build --release

# The browser decrypts; the server only serves playlists, templates and licenses
am-hook --listen 0.0.0.0:8888 --wrapper-url http://127.0.0.1:12340
```

Then open `http://127.0.0.1:8888/` and paste a link. Pages can also be opened directly by putting an Apple Music link after the server address:

| Input on the home page | Page opened |
|---|---|
| `https://music.apple.com/cn/song/<slug>/<id>` | `/https://music.apple.com/cn/song/<slug>/<id>` |
| `https://music.apple.com/cn/album/<slug>/<albumId>?i=<id>` | `/https://music.apple.com/cn/album/<slug>/<albumId>?i=<id>` |
| `https://music.apple.com/cn/music-video/<slug>/<id>` | `/https://music.apple.com/cn/music-video/<slug>/<id>` |
| `https://music.apple.com/cn/post/<id>` | `/https://music.apple.com/cn/post/<id>` |
| `https://music.apple.com/cn/playlist/<slug>/<pl.id>` | `/https://music.apple.com/cn/playlist/<slug>/<pl.id>` |
| `https://music.apple.com/cn/artist/<slug>/<id>` | `/https://music.apple.com/cn/artist/<slug>/<id>` |

For example: `http://127.0.0.1:8888/https://music.apple.com/cn/music-video/super-bowl-lix-halftime-show-live/1836358807`. The country code in the link selects the storefront used for metadata.

### Requirements

- Rust 2021 edition toolchain
- A running [wrapper-lite](https://github.com/WorldObservationLog/wrapper) key server (default `http://127.0.0.1:12340`)
- A modern browser with Web Workers and WebAssembly. Playback uses MediaSource (EC-3 PCM fallback uses Web Audio); MV downloads need OPFS.

> OPFS is only available in a secure context: HTTPS, or `localhost` / `127.0.0.1`. Over `http://<LAN IP>`, song downloads fall back to in-memory Blobs (large files use more RAM) and MV downloads are unavailable. Playback is unaffected.

## Serverless Deployment (Vercel / Cloudflare)

If you would rather not run the binary, the same pages can be deployed to a serverless platform: the platform hosts the static assets and the backend shrinks to a single function (the amp-api catalog proxy and the MV master fetch). Pick either platform:

| Platform | One click | CLI |
|---|---|---|
| Vercel | [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fitouakirai%2Fam-hook) | `npx vercel --prod` |
| Cloudflare Workers | [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/itouakirai/am-hook) | `npx wrangler deploy` |

When deploying a fork, replace the repository URL in the button links with your own. The build needs only Node (`node scripts/build-static.mjs` copies `src/ui/` into `dist/`), not Rust; see [vercel.json](vercel.json) and [wrangler.toml](wrangler.toml) for the configuration.

**wrapper-lite**: a function on the platform cannot reach a wrapper-lite on your machine, so by default only the [local mode](#using-a-local-wrapper-lite) is offered. Enter your own wrapper-lite URL in the "wrapper-lite" setting at the bottom of the navigation and the browser sends the requests itself:

- The page is served over HTTPS, so the browser only lets it request `http://127.0.0.1` / `http://localhost` or HTTPS URLs; `http://<LAN IP>` is blocked as mixed content (if wrapper-lite runs on another machine, put it behind HTTPS or use the binary). Some browsers restrict loopback addresses too, and Chrome may first ask for permission to access the local network.
- wrapper-lite must allow cross-origin requests (see [Using a local wrapper-lite](#using-a-local-wrapper-lite)).

Alternatively the function can relay to a publicly reachable wrapper-lite, set through the platform's environment variables (on Cloudflare use `npx wrangler secret put <NAME>`; on Vercel redeploy after changing them):

| Variable | Description |
|---|---|
| `AM_HOOK_WRAPPER_URL` | wrapper-lite URL. When set, pages default to the "Server" mode, like the binary; it may carry credentials (`https://<token>@host`) |
| `AM_HOOK_WRAPPER_AUTH` | Optional `Authorization` for wrapper-lite requests, same rules as `--wrapper-auth` |

> With `AM_HOOK_WRAPPER_URL` set, anyone who can open the site can use your wrapper-lite, that is, your Apple account. Restrict access with the platform's access control (Vercel Deployment Protection, Cloudflare Access). Function instances share no state, so there is no equivalent of `--wrapper-rate` / `--wrapper-concurrency` here.

Other differences from the binary:

- amp-api responses are cached by the platform (Vercel CDN, Cloudflare Cache API; 5 minutes for the catalog, 24 hours for storefronts); there is no connection keep-alive or background warm-up, and the first catalog request of a new instance scrapes the developer token first, which takes a few seconds.
- No command-line options, request log or auto-update.
- On Vercel, page paths are matched by the rewrite rules in `vercel.json`, which are looser than the binary: invalid paths under `/library/…`, `/new/…` and `/https://music.apple.com/<cc>/…` get the app shell instead of a 404.

## Web UI

- Chinese and English UI; the Interface button at the bottom of the navigation switches instantly (remembered; the first visit follows the browser language). Playback and downloads in progress are not interrupted.
- Settings at the bottom of the navigation, saved in localStorage with no expiry:
  - Primary storefront: used for search (and future features). The wrapper-lite account's storefronts are listed first as the best experience, then favorite storefronts (US / CN / JP by default); every other storefront sits under "More storefronts" with a filter, and the star next to each one adds or removes it from favorites. Defaults to the first wrapper-lite storefront.
  - Catalog language (amp-api `l`, independent of the UI language): defaults to each storefront's default language; the choices are only that storefront's `supportedLanguageTags` from `/amp/v1/storefronts`. Chosen per storefront, and also used for lyrics.
- The home page shows wrapper-lite status and your recent searches (click to search again, or remove them one by one); its footer links to this GitHub repository and credits the projects am-hook builds on.
- Search: the home input takes either a link or keywords (the same amp-api requests as music.apple.com). Typing shows suggested terms and direct results; results are grouped into top results, artists, albums, songs, playlists and music videos, with "Load more". Search uses the primary storefront, which can also be changed from the button next to the results. `/` focuses the input; the term is kept in the address bar as `?q=`, so Back / Forward and sharing work. Search lives only on the home page; other pages have a Back button at the top instead, which returns to the previous page (or to the home page when the page was opened directly from a link).
- Persistent player bar: like music.apple.com, the player bar stays at the bottom and playback continues while you move between pages.
  - A queue started on an album, playlist or artist page keeps playing in order after you leave the page, including previous / next from system media controls. Playing a different song on its song page ends the queue; switching quality of the same song keeps it.
  - Like music.apple.com, the whole queue shares one MediaSource: the next song is fetched ahead and appended right after the current one, so the `<audio>` element never stops between songs. Playback continues gaplessly in the background (another app in front, including fullscreen apps) and the Android media notification stays. Songs played with EC-3 PCM still switch when the previous one ends.
  - Transport controls match music.apple.com: shuffle, previous (restarts the song after 3 seconds), play / pause, next, and repeat (off → all → one). Shuffle and repeat are remembered; Shuffle on album, playlist and artist pages turns shuffle on and Play plays in order. Seek back / forward with ← / → or system media controls.
  - Playing Next: the list button on the right of the bar opens the upcoming songs. Click to select, double-click to play, drag a row to reorder; the − on the artwork (on hover) removes a song and Clear empties the rest of the queue. From the keyboard: ↑/↓ select, Enter plays, Delete removes, Alt+↑/↓ moves. On touch screens a tap plays, the handle on the right reorders, and shuffle / repeat sit next to the title.
  - The address bar, page title and browser Back / Forward follow the current page, so links can be shared and a reload stays on the same page.
  - Space and arrow keys control playback on every page. Playing a music video pauses the music and vice versa.
  - How it works: like music.apple.com, the site is a single-page app. Every page URL gets `app.html`, which owns the player bar, audio, decryption workers and lyrics view; a client-side router (`app.mjs`) takes over in-site links, changes the address with `history.pushState` and swaps page views (`src/ui/views/`) without reloading the document. It relies on no request headers, so it works the same over `http://<LAN IP>`.

### Library and Playlists

Like music.apple.com's Library and Playlists, but **stored only in your browser** (IndexedDB). The server keeps no library data and needs no account; nothing leaves the browser except the usual catalog requests.

- Sidebar: a Library group (Recently Added, Artists, Albums, Songs, Music Videos) and a Playlists group (All Playlists, then each playlist; + creates one). Pages live under `/library/...` and survive reloads and shared links (on the same browser).
- Adding: every More menu (search results, shelves, album / playlist / artist / chart rows) has **Add to Library** / **Delete from Library** and an **Add to Playlist** submenu (New Playlist…, then your playlists, most recently changed first). Album and playlist pages have a + button next to Play; song pages have Library and Add to Playlist buttons. As in Apple Music, adding an album adds all its songs and music videos, adding a single song makes its album and artist appear in the library, deleting an album deletes its songs, and adding an Apple Music playlist adds the playlist itself (it still opens the live catalog page). Tracks already in a playlist are skipped.
- Library pages: Songs (play / shuffle the filtered list, sort by title, artist, album, date added or duration; long lists render as you scroll), Albums and Music Videos grids, Artists (list beside the selected artist's albums and songs; on phones the list opens each artist), Recently Added, and All Playlists. Every page has a filter; the sort choice is remembered.
- Playlists (`/library/playlist/p.<id>`): a 2×2 mosaic of the first four album covers, name and description (Edit), play / shuffle, drag the handle to reorder (mouse or touch; ↑ / ↓ on the focused handle), Remove from Playlist, Duplicate, Export and Delete. Playlists keep a snapshot of each track (title, artists, album, artwork, duration), so they open instantly without catalog requests and also hold songs that are not in the library.
- Import / export (the ⋯ menu on library pages): **Export Library** saves `am-hook-library-<date>.json` with every library item and playlist; **Export Playlist** saves one playlist (`<name>.am-hook-playlist.json`) to share. **Import…** reads either file: a whole-library file can be merged (existing items stay, playlists with the same id keep the newer copy) or replace the library; a playlist file is added and opened. Every entry is validated: only `/https://music.apple.com/...` page links and https artwork are kept and invalid entries are skipped, so a shared file cannot inject links or scripts. **Clear Library…** deletes everything after a confirmation.
- Favorites: like Apple Music, songs, music videos, albums, playlists (Apple Music and your own) and artists can be favorited — **Favorite** / **Undo Favorite** in every More menu, and a ☆ next to the + on album and playlist pages, on song pages and in the artist page's action row. Favoriting also adds the item to the library (a favorited artist appears under Artists even without songs). Favorited tracks show a star; Songs, Albums, Artists, Music Videos and All Playlists have a **Favorites** filter. **Favorite Songs** (`/library/favorite-songs`, in the sidebar and first in All Playlists) is an automatic playlist of favorited songs, most recent first; Undo Favorite removes a song, and Save as Playlist copies it into a normal playlist.
- Playlist folders (`/library/playlist-folder/f.<id>`): create them from the + beside Playlists or the ⋯ menu, nest them, and put both your playlists and added Apple Music playlists inside, via **Move to Folder** (More menus and the playlist page) or by dragging a playlist or folder onto a folder in the sidebar (drop on the Playlists heading to move it to the top level). The sidebar lists folders first with expand / collapse (remembered; the folder of the open playlist expands automatically). A folder page shows its path, subfolders and playlists, with New Playlist, New Folder, Rename, Move, Export Folder and Delete Folder. As in Apple Music, deleting a folder deletes everything inside after a confirmation that shows the counts; a folder cannot move into itself or its subfolders.
- Storage notes: data is per browser and per site address (`http://127.0.0.1:8888` and `http://<LAN IP>:8888` are separate libraries); export to move it. Tabs of the same browser stay in sync. If the browser refuses IndexedDB (some private modes), the library works in memory for the session and the library pages say so.

File format (version 1):

```jsonc
{
  "format": "am-hook-library", "version": 1, "exportedAt": "2026-10-04T12:00:00.000Z",
  "items": [   // library: kind song / music-video / album / playlist (Apple Music), addedAt in ms
    { "kind": "song", "id": "1468058171", "country": "cn", "name": "…", "artist": "…", "artists": [{ "name": "…", "href": "/https://music.apple.com/cn/artist/…/159260351" }],
      "album": "…", "albumId": "1468058165", "albumHref": "/https://music.apple.com/cn/album/…/1468058165", "href": "/https://music.apple.com/cn/song/…/1468058171",
      "artwork": "https://…/{w}x{h}bb.jpg", "bgColor": "1d1d1f", "duration": 221000, "explicit": false, "addedAt": 1759579200000 }
  ],
  "playlists": [   // local playlists: tracks are the same snapshots plus uid / addedAt
    { "id": "p.Ab3dE…", "name": "…", "description": "…", "folderId": "f.Xy9…", "favorite": 0, "createdAt": 1759579200000, "updatedAt": 1759579300000, "tracks": [ { "uid": "…", "addedAt": 1759579200000, "kind": "song", "id": "…" } ] }
  ],
  "folders": [   // playlist folders; parentId is empty at the top level
    { "id": "f.Xy9…", "name": "…", "parentId": "", "createdAt": 1759579200000, "updatedAt": 1759579200000 }
  ]
}
```

`favorite` (ms, 0 = not favorited) on items and playlists, `folderId` on playlists and Apple Music playlist items, `folders`, and `artist` items (favorited artists) were added later as optional fields, so the version stays 1: older builds import new files and skip what they do not know. Export Folder writes the folder, its subfolders and their playlists. References to missing folders, and folder cycles, are moved to the top level on import. The browser database moved to version 2 (adds the `folders` store); existing libraries upgrade in place.

### Songs

- Every variant is parsed automatically (lossless ALAC, Dolby Atmos, AAC, HE-AAC, including binaural and downmix versions), with artwork and track info fetched from the Apple Music catalog API (amp-api) via the server's `/amp` proxy.
- Each variant's "more" menu has **Download decrypted file**: decrypted in the browser, with progress and a cancel button. Downloads keep running after you leave the song page and are saved when done; returning to the song page shows their progress again (closing or reloading the tab stops them).
- Built-in player: MSE with browser-side decryption. ALAC plays losslessly via FLAC-in-MP4 when the browser lacks ALAC support. EC-3 falls back to multichannel PCM when MSE is unavailable, with a notice about the spatial-audio limitation. Downloads keep the original codec. Space, arrow keys and system media controls are supported.
- Lyrics: when the playing song has lyrics, a Lyrics button appears on the player bar (available on every page; it switches to the new song's lyrics when the track changes). The view is rendered by [AMLL (Apple Music-like Lyrics)](https://github.com/amll-dev/applemusic-like-lyrics): word- and line-synced highlighting with spring scrolling, background vocals, duets, translation and pronunciation, interlude dots, and click-to-seek. Its flowing background is AMLL's mesh gradient generated from the artwork, or the classic background used before AMLL (rotating, twisted and blurred copies of the artwork, modeled on Apple Music Web; also the fallback without WebGL). Esc closes it. Clicking the artwork, title or empty space on the player bar opens the full-screen player (also for songs without lyrics, which show only the artwork and controls). As on music.apple.com, the title has Favorite (☆) and More buttons (add to library, add to playlist, go to album, copy links), and the Lyrics button in the bottom-right corner (below the controls on phones) shows or hides the lyrics; the buttons are laid out as on music.apple.com — Close at the top left, lyrics translation at the top right, and borderless playback buttons centered in one row, with title and artist on one line each, scrolling when too long; phones follow the site's mobile player: a pull-down handle at the top closes the view, the title row shrinks to a small artwork while lyrics are shown, and only Previous / Play / Next remain at the bottom, above the Lyrics and Playing Next toggles — the queue takes the place of the lyrics, with Shuffle / Repeat next to its title; with lyrics hidden the artwork and controls are centered, and the choice is saved in the browser. The lyrics options button (top right; it used to be only the translation menu) toggles translation and pronunciation, adjusts text size (70%–150%) and font weight (Light to Heavy), switches the lyrics source between Apple Music and the [AMLL TTML DB](https://amll.dev/reference/http-api/overview) (looked up by the Apple Music song ID straight from the browser; songs it doesn't have fall back to Apple Music, and nothing is sent to it unless chosen), switches the background between AMLL's and the classic one, and downloads the TTML being shown. Everything except translation and pronunciation is saved in the browser.

### Music Videos

- Video and audio tracks appear in separate columns. The highest bitrate video and its group's default audio are selected; changing the video updates the recommended audio, and audio can also be chosen manually.
- Playback uses MediaSource with seeking and bounded buffering. Unsupported codecs remain downloadable; pick AVC/AAC for broader playback compatibility.
- Independent CEA-608 caption tracks are decoded into native browser text tracks. The first one is shown by default; use the video's subtitle menu to switch or disable captions.
- Downloads decrypt segment by segment and write time-interleaved fragments to an OPFS temporary file, never holding the whole MV in memory. The Worker then rewrites that file as a standard (progressive) MP4 with `moov` before the media data. Every track is cut into chunks of at most one second and written in time order, so audio, video and captions for the same moment sit together and players can read the file front to back. No transcoding or tag writing is done. Both files exist briefly during this step, so OPFS needs about twice the MV size.
- CEA-608 caption tracks are kept in the download. Apple starts them with a malformed empty sample that recent FFmpeg rejects (mpv-based players stop shortly after starting); it is rewritten as a valid empty caption sample of the same size.
- Completion triggers a save and exposes a "Save MP4" link. Cancellation and failure remove temporary files. Leaving the MV page stops playback, cancels a running download and attempts to remove the finished file. Files left by a closed or crashed tab are removed the next time an MV page is opened (without Web Locks, once they are 24 hours old).
- Artist-uploaded videos (music.apple.com `post` pages, amp-api `uploaded-videos`, linked from New and editorial pages) open in the same page. Like music.apple.com, they need neither wrapper-lite nor decryption: each entry of `assetTokens` is an unencrypted progressive MP4 (H.264 + AAC, `moov` first) that the `<video>` element plays directly. The page lists them by resolution with size and bitrate (from a `HEAD` request); there is no separate audio track. Downloads stream the file into OPFS unchanged (an in-memory Blob without OPFS).

## How It Works

### Songs: browser-side decryption

In the browser (`src/ui/decrypt.js`):

1. With the master m3u8 URL from wrapper-lite, the browser fetches the master directly from the Apple CDN and parses its variants (`src/ui/wrapper.js`).
2. The media m3u8 is fetched directly from `aod.itunes.apple.com` (the CDN allows CORS and Range requests) and parsed into the init segment, fragment byte ranges and the key used by each fragment.
3. The first fragment uses the fixed template embedded in the wasm (`skd://itunes.apple.com/P000000000/s1/e1`); the rest use the track template from `/key`.
4. Fragments are fetched with Range requests and decrypted in place by a Worker pool (one `hook.wasm` instance per Worker). The decryption code lives in `crates/am-mp4`.
5. **Playback**: decrypted fragments feed MSE when the original codec is supported. If ALAC is unavailable but FLAC-in-MP4 is, the on-demand `flac.wasm` losslessly converts ALAC packets to FLAC frames and remuxes them into small fMP4 fragments. EC-3 uses MSE when supported, otherwise the on-demand `ec3.wasm` decoder plays 5.1/7.1 PCM through Web Audio (no Atmos object rendering). Seeking jumps to the matching source fragment.
6. **Download**: 4 lanes fetch and decrypt concurrently and write each result at its original offset into an OPFS temporary file, which is then converted to a progressive MP4 like the reference downloader's `DefragmentMP4` (`M4A ` ftyp, `moov` before the media data) and handed to the browser to save. Without OPFS it falls back to in-memory Blobs.

`hook.wasm` repairs identifiable ALAC end-tag damage after decryption (for example, song `1691044818`). The init segment's track and sample description identify complete uncompressed mono/stereo packets; a missing or damaged 3-bit `TYPE_END` is restored to `111`. PCM, sample lengths and Range offsets stay unchanged. Compressed packets, truncated PCM and packets without room for the tag are left untouched; FLAC transcoding keeps its fallback that can append a missing tag byte.

Box handling: FairPlay metadata boxes (`sinf`, `senc`, `saiz`, `saio`, `pssh`, and `sgpd`/`sbgp` with grouping type `seig`/`seam`) are replaced with equal-length `free` boxes, so byte lengths and Range offsets stay exact. The `enca` box in the init segment is rewritten to the original codec (`ec-3`, `mp4a`, `alac`, etc.).

### Music videos

- `/parse/mv/<adamId>` gets the master URL from wrapper-lite `/webplayback`, fetches it with `User-Agent: AM`, and returns the playlist text and final CDN URL. Browsers cannot change their User-Agent, and other User-Agents may get a master without 4K, so with a local wrapper-lite the master is still fetched by the server (`/parse/mv-master`).
- `/mv/webplayback/<adamId>` and `/mv/license` relay to wrapper-lite `/webplayback` and `/license` (PlayReady only; license errors are shown without falling back to another DRM).
- Track playlists and media segments are fetched by the browser directly from Apple.
- Challenge building, license parsing, CENC/CBCS decryption, caption repair, fragmented MP4 muxing and conversion to a progressive MP4 run in a Worker with `media.wasm` (Rust, see [crates/am-media](crates/am-media/README.md)).
- Live playlists, discontinuities and changing initialization segments are not supported.

### Using a local wrapper-lite

The "wrapper-lite" setting at the bottom of the navigation switches between two modes (saved in the browser):

- **Server** (default): wrapper-lite requests are relayed by am-hook; rate, concurrency and `Authorization` come from the `--wrapper-*` options. Not offered on a [serverless deployment](#serverless-deployment-vercel--cloudflare) without `AM_HOOK_WRAPPER_URL`.
- **Local**: the browser requests your own wrapper-lite directly (`/status`, `/m3u8`, `/key`, `/lyrics`, `/webplayback`, `/license`). The panel sets its URL, max requests per second, max concurrent requests and `Authorization` (same rules as `--wrapper-auth`). The limits apply to the current page only. The URL may carry credentials (such as `https://<token>@host`); as with `--wrapper-url`, they are sent as `Authorization: Basic …`, and a separately set `Authorization` takes precedence.
  - The requests are cross-origin: the wrapper-lite must allow CORS (send `Access-Control-Allow-Origin`, and allow the `Authorization` header in preflights if one is set), or install a browser extension that lifts CORS restrictions.
  - MV master playlists are still fetched by am-hook with `User-Agent: AM`; the other MV requests (`/webplayback`, `/license`) go to the local wrapper-lite.

## Server Endpoints

| Endpoint | Description |
|---|---|
| `GET /` | Home page. It and every page URL below return the single-page app `app.html`; page content is loaded by the front end |
| `GET /https://music.apple.com/<cc>/song/<slug>/<id>` | Song page |
| `GET /https://music.apple.com/<cc>/music-video/<slug>/<id>` | MV page |
| `GET /https://music.apple.com/<cc>/post/<id>` | Artist-uploaded video (MV page) |
| `GET /status` | wrapper-lite status and available regions |
| `GET /parse/song/<adamId>` | Song master m3u8 URL from wrapper-lite `/m3u8` (`{"code":0,"data":{"masterUrl":…}}`); the browser fetches and parses the master |
| `GET /key?adamId=<adamId>&uri=<skd-uri>` | Song track decryption template JSON from wrapper-lite `/key` |
| `GET /lyrics/<adamId>?language=<tag>` | TTML lyrics from wrapper-lite `/lyrics`, XML unchanged; 404 when the song has none. Optional `language` is the catalog language of the song's storefront (the chosen one, or the storefront default such as `zh-Hans-CN`) |
| `GET /parse/mv/<adamId>` | MV master playlist text and final CDN URL |
| `GET /parse/mv-master?url=<master URL>` | Same, for a master URL the page got from a local wrapper-lite; only `apple.com` HTTPS URLs are accepted |
| `GET /https://music.apple.com/<cc>/album/<slug>/<id>` | Album page (motion artwork from `editorialVideo` like music.apple.com — square on wide screens, full-width 3:4 on phones — tracks, playback queue, related shelves; data from the same amp-api `albums` request as music.apple.com). Album links with `?i=` open the album page with that track selected and scrolled into view, like music.apple.com |
| `GET /https://music.apple.com/<cc>/playlist/<slug>/<pl.id>` | Playlist page (editorial and public user playlists: motion artwork like the album page, tracks with artwork / artist / album columns, playback queue, featured-artists and more-by-curator shelves; data from the same amp-api `playlists` request as music.apple.com, fetched through `/amp`) |
| `GET /https://music.apple.com/<cc>/artist/<slug>/<id>` | Artist page (header like music.apple.com: motion video, wide image or circular portrait from the catalog data; latest release, top songs with a playback queue, album / music-video / playlist / similar-artist shelves with See All, bio; data from the same amp-api `artists` request as music.apple.com, fetched through `/amp`). Artist names on song, music-video and album pages (each artist of a multi-artist line separately) and artist shelves link here |
| `GET /library[/<section>]`, `GET /library/artists/<name>`, `GET /library/playlist/p.<id>`, `GET /library/favorite-songs`, `GET /library/playlist-folder/f.<id>` | Library pages (sections `recently-added`, `artists`, `albums`, `songs`, `music-videos`, `all-playlists`), local playlists, Favorite Songs and playlist folders. The server only returns the single-page app; library data lives in the browser's IndexedDB (`src/ui/library.mjs`) |
| `GET /new` | New (the sidebar's New entry): the same editorial sections as music.apple.com/{cc}/new (amp-api `editorial/{cc}/groupings?name=music`) for the primary storefront, reloaded when it changes — hero cards, four-row song shelves, album / playlist / radio / video shelves with the music.apple.com shelf-grid column counts, and the Explore More links; `/https://music.apple.com/<cc>/new` shows a fixed storefront |
| `GET /new/top-charts[/<kind>]` | Top Charts, linked from New's Explore More like music.apple.com/{cc}/new/top-charts (amp-api `catalog/{cc}/charts`, primary storefront): ranked top songs (three rows), city charts, Daily Top 100, and ranked top playlists / albums / music videos. Each ranked chart's See All (`songs`, `playlists`, `albums`, `music-videos`, also `city-charts`, `daily-global-top-charts`) lists the whole chart, paged on scroll — songs as chart rows like the playlist page — and songs / albums / music videos can be filtered by genre (`?genreId=`, genres from `catalog/{cc}/genres`); `/https://music.apple.com/<cc>/new/top-charts[/<kind>]` shows a fixed storefront |
| `GET /https://music.apple.com/<cc>/room/<id>`, `.../multi-room/<id>`, `.../grouping/<id>`, `.../curator/<slug>/<id>` | Editorial pages, routed like music.apple.com: a room is a section's See All (all contents in a grid, paged on scroll); multi-room (`editorial/{cc}/multirooms`, header art + sections), grouping (`editorial/{cc}/groupings/{id}`, e.g. Music Videos and genre pages) and curator (`catalog/{cc}?ids[apple-curators]=`: its grouping's sections, or its playlists) reuse the New layout. Legacy links in editorial data (`collection/...?fcId=`, `viewGrouping?id=`, `viewFeature?id=`) open these pages in app; stations and other content the site cannot open link to Apple Music. Pasting these links on the home page opens them too |
| `GET /amp/v1/catalog/<path>?<query>` | Proxies Apple Music catalog API (`amp-api-edge.music.apple.com/v1/catalog/...`, used by home page search) with the music.apple.com web developer token; query passed through unchanged. Uses a dedicated HTTP/2 connection warmed at startup, caches successful responses, merges identical concurrent requests, and reports `Server-Timing` (`cache;desc=hit/miss/shared`, upstream time) |
| `GET /amp/v1/editorial/<path>?<query>` | Proxies the editorial API (`amp-api-edge.music.apple.com/v1/editorial/...`: groupings, rooms, multirooms; used by New and the editorial pages) like `/amp/v1/catalog`, sharing its connection and cache |
| `GET /amp/v1/storefronts` | All storefronts from amp-api (query passed through to follow `next` paging); pages fetch it once and keep it in localStorage (refreshed in the background after 30 days); it supplies the storefront picker and the catalog language choices (each storefront's `supportedLanguageTags`) (an unsupported `l` silently falls back to the storefront default, e.g. `cn` only supports `zh-Hans-CN` / `en-GB`) |
| `GET /mv/webplayback/<adamId>`, `POST /mv/license` | MV relays to wrapper-lite `/webplayback` and `/license` |
| `/assets/...` | Client-side router, page views (`/assets/views/`), scripts, styles and on-demand WASM modules embedded in the binary (`no-cache` + ETag). `/assets/host.js` tells the page whether the server can relay wrapper-lite (generated by the function on serverless deployments) |

## Command-Line Options

| Flag | Default | Description |
|---|---|---|
| `-l, --listen <ADDR>` | `0.0.0.0:8888` | Listen address |
| `-p, --port <PORT>` | optional | Overrides the port in `--listen` when set |
| `-w, --wrapper-url <URL>` | `http://127.0.0.1:12340` | wrapper-lite key server base URL |
| `--wrapper-rate <N>` | `24` | Max requests per second to wrapper-lite (any 1-second window; extra requests wait in order). 0 = unlimited |
| `--wrapper-concurrency <N>` | `24` | Max concurrent requests to wrapper-lite. 0 = unlimited. Lower it (e.g. `8`) if wrapper-lite runs in QEMU and requests time out under load |
| `--wrapper-auth <VALUE>` | not sent | `Authorization` header for wrapper-lite requests. A bare token is sent as `Bearer <token>`; a value with a scheme (`Bearer …`, `Basic …`) is sent as is. Also read from `AM_HOOK_WRAPPER_AUTH` (keeps it out of the process list). These three apply to server relaying only; a page switched to a local wrapper-lite sets its own |
| `--amp-keepalive <SECONDS>` | `30` | Keeps the amp-api connection warm: after this long idle, sends a tiny request (0 disables). The token is fetched and the connection opened at startup either way |
| `--amp-cache-mb <MB>` | `32` | amp-api response cache (catalog 5 min, storefronts 24 h; 0 disables). Identical concurrent requests always share one upstream request |

## Building

```sh
cargo build --release
```

The binary is written to `target/release/am-hook` (`am-hook.exe` on Windows). All browser assets, including the prebuilt WASM modules, are committed under `src/ui/` and embedded into the binary, so a normal build needs only Rust. Rebuild the assets only after changing their sources:

| Asset | Source | Rebuild |
|---|---|---|
| `hook.wasm`, `flac.wasm`, `media.wasm` | `crates/am-wasm`, `crates/am-flac-wasm`, `crates/am-media-wasm` (and `am-mp4`, `am-alac`, `temari`, `am-media`) | `rustup target add wasm32-unknown-unknown`, then `scripts/build-wasm.sh` |
| `mv-cea608.mjs` | `browser/cea608` | `node scripts/build-cea608.cjs <path-to-typescript-package>` |
| `lyrics/amll-core.mjs`, `lyrics/amll.css` | `@applemusic-like-lyrics/core`, see [browser/amll](browser/amll/README.md) | `node scripts/build-amll.cjs <node_modules>` |
| `ec3.wasm`, `ec3-runtime.mjs` | `@mediabunny/ac3` 1.59.1 | `node scripts/extract-ec3.mjs`, see [EC3-SOURCE.md](src/ui/EC3-SOURCE.md) |

## Testing

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings   # CI runs this too; the workspace is warning-free
```

Unit tests cover the browser media core (PlayReady license decryption, CENC/CBCS, caption repair, defragmentation), URL parsing, m3u8 parsing, MP4 box patching (including that the in-place wasm path matches the parallel path), cache deduplication and the MV endpoints. Offline integration tests also check that Apple CDN URLs are not proxied.

Tests that require the live Apple CDN or wrapper-lite are ignored by default and do not run in GitHub Actions. Run them locally with Apple CDN access and wrapper-lite available (default `http://127.0.0.1:12340`, override with `AM_HOOK_WRAPPER`):

```sh
cargo test --test e2e_test -- --ignored
```

These tests verify lyrics.

Browser-side tests are plain Node scripts:

| Kind | Command |
|---|---|
| Offline, Node only | `node --test tests/player_*.cjs`, `node tests/mv_hls.cjs`, `node tests/mv_captions.cjs`, `node --test tests/serverless.mjs` (the serverless backend and the `dist/` layout; also run in CI) |
| Offline, Playwright + Chrome with local fixtures | `node tests/ui_layout.cjs <playwright>`, `node tests/lyrics_ui.cjs <playwright>`, `node tests/mv_ui.cjs <playwright>`, `node tests/library_ui.cjs <playwright>` (library and playlists: add, playlists, reorder, persistence, export / import and file validation, favorites, folders and drag-and-drop, database upgrade) |
| Live (running am-hook, wrapper-lite, Apple CDN access) | `node tests/mv_live.cjs <playwright> [base]`, `node tests/mv_captions_live.cjs <playwright> [base]`, `node tests/alac_recovery.cjs <playwright>`, `node tests/alac_source_recovery.cjs <playwright>`, `node tests/search_ui.cjs <playwright> [base]`, `node tests/album_ui.cjs <playwright> [base]`, `node tests/playlist_ui.cjs <playwright> [base]`, `node tests/artist_ui.cjs <playwright> [base]`, `node tests/browse_ui.cjs <playwright> [base]` (need access to music.apple.com), `node tests/app_ui.cjs <playwright> [base]` (single-page app: playback across navigation, queue, Back / Forward, lyrics) |

`<playwright>` is the path to a Playwright package; when `[base]` is omitted, the MV live tests default to `http://127.0.0.1:18888` and the others to `AM_HOOK_URL` or `http://127.0.0.1:8888` (the ALAC tests only read `AM_HOOK_URL`).

## Project Layout

```
src/
  cli.rs               CLI argument parsing
  main.rs              Server startup
  lib.rs               Router construction
  assets.rs            Embedded front-end assets: one table (`ASSETS`) drives both the routes and the MIME types; add a browser file by adding one line
  amp.rs               amp-api catalog proxy (fetches and refreshes the music.apple.com web developer token)
  log.rs               Request log
  links.rs             Apple Music link parsing and page-path matching (shared regex fragments; log.rs reuses them to classify requests)
  state.rs             Configuration and shared clients
  wrapper.rs           wrapper-lite client (master m3u8, decryption templates, lyrics)
  ui.rs                Web endpoints (status, parse, templates, lyrics, MV relays; fallback serves the single-page app for Apple Music page paths)
  ui/
    app.html / app.mjs Single-page app: persistent player bar and lyrics view; the client-side router takes over in-site links and swaps page views
    views/             Page views: <name>.html markup, <name>.mjs script (home / song / mv / album / playlist / artist / browse: New and editorial pages, styles in browse.css)
    app.css / mv.css   Styles
    i18n.js            Chinese / English strings; primary storefront and catalog language settings
    settings.mjs       Primary storefront / catalog language picker
    library.mjs        Library and playlist store (IndexedDB, cross-tab sync, import / export format and validation); pages in views/library*.mjs, shared dialogs and menus in views/library-ui.mjs
    player.js          Song player (MSE) and playback queue; page views use the persistent player via scope()
    motion-art.mjs     Motion artwork on album, playlist and artist pages (editorialVideo HLS via MSE)
    decrypt.js         Song decryption: m3u8 parsing, Worker pool, templates, download and OPFS
    hook-worker.js     Worker: wasm decryption and OPFS writes
    hook.wasm          Build output of crates/am-wasm
    flac.wasm / flac-transcode-worker.js / flac-init.bin   ALAC-to-FLAC playback
    ec3.wasm / ec3-runtime.mjs / ec3-decode-worker.js      EC-3 PCM fallback
    lyrics/            Lyrics view (bundled AMLL, see browser/amll; ttml.mjs parses TTML, panel.mjs wires it to the player, backdrop*.mjs draw the classic background)
    mv-hls.mjs / mv-engine.mjs                            MV playlist parsing, playback, download
    media-worker.js / media.wasm                          Worker for MVs and song defragmentation; build output of crates/am-media-wasm
    mv-captions.mjs / mv-cea608.mjs                       CEA-608 captions
crates/
  am-mp4/              ISOBMFF parsing, box patching, sample decryption (shared by server and wasm); embeds the fixed first-fragment template
  am-alac/             Conservative ALAC end-tag repair
  am-wasm/             Browser C ABI exports of am-mp4 (wasm32-unknown-unknown)
  am-flac-wasm/        ALAC packet decoder and FLAC frame writer for the browser
  am-media/            Browser media core: PlayReady, CENC/CBCS, caption repair, MP4 muxing and defragmentation
  am-media-wasm/       Browser C ABI exports of am-media
  temari/              Vendored Temari FairPlay decryption library
browser/
  cea608/              Vendored hls.js CEA-608 parser
  amll/                AMLL lyric player bundle entry and build notes
serverless/
  core.mjs             Serverless backend (amp-api proxy, MV master, optional wrapper-lite relay), the counterpart of amp.rs and ui.rs
  cloudflare.mjs       Cloudflare Worker entry (wrangler.toml)
api/handler.mjs        Vercel Edge Function entry (vercel.json)
scripts/               WASM / asset build scripts; build-static.mjs builds dist/ for serverless deployments from the asset table in assets.rs
tests/                 Rust integration tests and Node browser tests (app.cjs holds the shared page helpers)
```

## License

am-hook is licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (AGPL-3.0-only), because the web UI embeds the AGPL-licensed [AMLL](https://github.com/amll-dev/applemusic-like-lyrics) lyric player. If you run a modified version as a network service, you must offer its users the corresponding source.

Bundled third-party components keep their own licenses: `crates/temari` (MIT), the hls.js CEA-608 parser (Apache-2.0, `browser/cea608/LICENSE`), `@mediabunny/ac3` (MPL-2.0, `src/ui/EC3-LICENSE.txt`) and AMLL with its dependencies (AGPL-3.0-only, `browser/amll`).
