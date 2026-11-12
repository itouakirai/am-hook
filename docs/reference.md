# Reference

[中文](reference.zh-CN.md) | English

## Command-Line Options

| Flag | Default | Description |
|---|---|---|
| `-l, --listen <ADDR>` | `0.0.0.0:8888` | Listen address |
| `-p, --port <PORT>` | optional | Overrides the port in `--listen` when set |
| `-w, --wrapper-url <URL>` | `http://127.0.0.1:12340` | wrapper-lite key server base URL |
| `--wrapper-rate <N>` | `24` | Max requests per second to wrapper-lite (any 1-second window; extra requests wait in order). 0 = unlimited |
| `--wrapper-concurrency <N>` | `24` | Max concurrent requests to wrapper-lite. 0 = unlimited. Lower it (e.g. `8`) if wrapper-lite runs in QEMU and requests time out under load |
| `--wrapper-auth <VALUE>` | not sent | `Authorization` header for wrapper-lite requests. A bare token is sent as `Bearer <token>`; a value with a scheme (`Bearer …`, `Basic …`) is sent as is. Also read from `AM_HOOK_WRAPPER_AUTH` (keeps it out of the process list). These three apply to server relaying only; a page switched to a local wrapper-lite sets its own |
| `--client-rate <N>` | `0` | Max relayed wrapper-lite requests per client IP in any 60 seconds (`/status` not counted: it is shared by all clients and asks wrapper-lite at most once per 10 s), so one visitor cannot use up a shared wrapper-lite; further requests get HTTP 429 with `Retry-After`. A played song takes about 3 (master, key, lyrics). 0 = unlimited |
| `--client-concurrency <N>` | `0` | Max wrapper-lite requests relayed at once per client IP (`/status` not counted); further requests wait instead of failing, so one visitor's burst cannot hold every `--wrapper-concurrency` permit and stall everyone else. A played song needs 3 at once (master, key, lyrics). 0 = unlimited |
| `--client-ip-header <NAME>` | TCP peer | Header holding the client IP, set by the reverse proxy in front (e.g. `X-Real-IP`, `CF-Connecting-IP`; the first entry of a list is used). Needed behind a proxy, where every peer is the proxy. Only set it when all requests pass through that proxy, otherwise clients can spoof it |
| `--local-wrapper-only` | off | Never relay wrapper-lite requests: pages only offer the local mode, as on a serverless deployment without `AM_HOOK_WRAPPER_URL`, and the relaying endpoints return 501. `--wrapper-url`, `--wrapper-rate` and `--wrapper-concurrency` become the page defaults for visitors who have not saved their own; `--wrapper-auth` is not used and never sent to pages |
| `--wrapper-hint <TEXT>` | none | Note shown above the local wrapper-lite settings, e.g. where to get a token for a public wrapper-lite. URLs in it become links. Also read from `AM_HOOK_WRAPPER_HINT` |
| `--amp-keepalive <SECONDS>` | `30` | Keeps the amp-api connection warm: after this long idle, sends a tiny request (0 disables). The token is fetched and the connection opened at startup either way |
| `--amp-cache-mb <MB>` | `32` | amp-api response cache (catalog 5 min, storefronts 24 h; 0 disables). Identical concurrent requests always share one upstream request |
| `--check-update` | off | Checks GitHub Releases for a newer version at startup and logs it |
| `--auto-update` | off | Like `--check-update`, and also downloads the new binary for this platform and replaces the current one (the old one is kept as a backup); restart am-hook afterwards. On Windows the running exe cannot be replaced, so the log lists the manual steps |

## Server Endpoints

Page URLs (see [Pages](guide.md#pages)) all return the single-page app `app.html`. The API endpoints are:

| Endpoint | Description |
|---|---|
| `GET /status` | wrapper-lite status and available regions (one result shared by all clients for 10 s) |
| `GET /parse/song/<adamId>` | Song master m3u8 URL from wrapper-lite `/m3u8` (`{"code":0,"data":{"masterUrl":…}}`); the browser fetches and parses the master |
| `GET /key?adamId=<adamId>&uri=<skd-uri>` | Song track decryption template JSON from wrapper-lite `/key` |
| `GET /lyrics/<adamId>?language=<tag>` | TTML lyrics from wrapper-lite `/lyrics`, XML unchanged; 404 when the song has none. Optional `language` is the catalog language of the song's storefront (the chosen one, or the storefront default such as `zh-Hans-CN`) |
| `GET /parse/mv/<adamId>` | MV master playlist text and final CDN URL |
| `GET /parse/mv-master?url=<master URL>` | Same, for a master URL the page got from a local wrapper-lite; only `apple.com` HTTPS URLs are accepted |
| `GET /amp/v1/catalog/<path>?<query>` | Proxies Apple Music catalog API (`amp-api-edge.music.apple.com/v1/catalog/...`, used by home page search) with the music.apple.com web developer token; query passed through unchanged. Uses a dedicated HTTP/2 connection warmed at startup, caches successful responses, merges identical concurrent requests, and reports `Server-Timing` (`cache;desc=hit/miss/shared`, upstream time) |
| `GET /amp/v1/editorial/<path>?<query>` | Proxies the editorial API (`amp-api-edge.music.apple.com/v1/editorial/...`: groupings, rooms, multirooms; used by New and the editorial pages) like `/amp/v1/catalog`, sharing its connection and cache |
| `GET /amp/v1/storefronts` | All storefronts from amp-api (query passed through to follow `next` paging); pages fetch it once and keep it in localStorage (refreshed in the background after 30 days); it supplies the storefront picker and the catalog language choices (each storefront's `supportedLanguageTags`) (an unsupported `l` silently falls back to the storefront default, e.g. `cn` only supports `zh-Hans-CN` / `en-GB`) |
| `GET /mv/webplayback/<adamId>`, `POST /mv/license` | Relays to wrapper-lite `/webplayback` and `/license`: MVs (PlayReady, `drm-type: pr`) and songs without a master m3u8 (AAC-LC media m3u8, Widevine without `drm-type`) |
| `POST /station/next-tracks/ra.<id>`, `GET /station/assets?<playParams>`, `GET /station/catalog/<path>`, `GET /station/recent`, `GET /station/storefront` | Station endpoints: call `amp-api.music.apple.com` (`/v1/me/stations/next-tracks`, `/v1/play/assets`, `/v1/catalog`, `/v1/me/recent/radio-stations`, `/v1/me/storefront`) with the developer token and the media-user-token the page sends in `X-Media-User-Token`; responses are relayed as is and never cached; 401 without a token |
| `POST /station/license` | `{ url, body, renewal }`: POSTs `body` with both tokens to the station's license server (`url` must be an Apple HTTPS URL on a license path MusicKit knows) and relays the response |
| `/assets/...` | Client-side router, page views (`/assets/views/`), scripts, styles and on-demand WASM modules embedded in the binary. Pages load them by content-hashed URLs under `/assets/h/` (cached as `immutable`); the original URLs are served with `no-cache` + ETag. `/assets/host.js` tells the page whether the server can relay wrapper-lite (generated by the function on serverless deployments) |
