# Deployment

[中文](deployment.zh-CN.md) | English

The binary from [Quick Start](../README.md#quick-start) is the full-featured option: it relays wrapper-lite with rate limits (see [Command-Line Options](reference.md#command-line-options)) and works over plain `http://<LAN IP>`. The alternatives below need no binary.

## Serverless Deployment (Vercel / Cloudflare)

If you would rather not run the binary, the same pages can be deployed to a serverless platform: the platform hosts the static assets and the backend shrinks to a single function (the amp-api catalog proxy, the MV master fetch and the station endpoints). Pick either platform:

| Platform | One click | CLI |
|---|---|---|
| Vercel | [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fitouakirai%2Fam-hook) | `npx vercel --prod` |
| Cloudflare Workers | [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/itouakirai/am-hook) | `npx wrangler deploy` |

When deploying a fork, replace the repository URL in the button links with your own. The build needs only Node (`node scripts/build-static.mjs` builds `dist/` from `web/`), not Rust; see [vercel.json](../vercel.json) and [wrangler.toml](../wrangler.toml) for the configuration.

**wrapper-lite**: a function on the platform cannot reach a wrapper-lite on your machine, so by default only the [local mode](#using-a-local-wrapper-lite) is offered. Enter your own wrapper-lite URL in the "wrapper-lite" setting at the bottom of the navigation and the browser sends the requests itself:

- The page is served over HTTPS, so the browser only lets it request `http://127.0.0.1` / `http://localhost` or HTTPS URLs; `http://<LAN IP>` is blocked as mixed content (if wrapper-lite runs on another machine, put it behind HTTPS or use the binary). Some browsers restrict loopback addresses too, and Chrome may first ask for permission to access the local network.
- wrapper-lite must allow cross-origin requests (see [Using a local wrapper-lite](#using-a-local-wrapper-lite)).

Alternatively the function can relay to a publicly reachable wrapper-lite, set through the platform's environment variables (on Cloudflare use `npx wrangler secret put <NAME>`; on Vercel redeploy after changing them):

| Variable | Description |
|---|---|
| `AM_HOOK_WRAPPER_URL` | wrapper-lite URL. When set, pages default to the "Server" mode, like the binary; it may carry credentials (`https://<token>@host`) |
| `AM_HOOK_WRAPPER_AUTH` | Optional `Authorization` for wrapper-lite requests, same rules as `--wrapper-auth` |
| `AM_HOOK_WRAPPER_HINT` | Optional note above the local wrapper-lite settings, same as `--wrapper-hint` |

> [!WARNING]
> With `AM_HOOK_WRAPPER_URL` set, anyone who can open the site can use your wrapper-lite, that is, your Apple account. Restrict access with the platform's access control (Vercel Deployment Protection, Cloudflare Access). Function instances share no state, so there is no equivalent of `--wrapper-rate` / `--wrapper-concurrency` here.

Other differences from the binary:

- amp-api responses are cached by the platform (Vercel CDN, Cloudflare Cache API; 5 minutes for the catalog, 24 hours for storefronts); there is no connection keep-alive or background warm-up, and the first catalog request of a new instance scrapes the developer token first, which takes a few seconds.
- No command-line options, request log or auto-update.
- On Vercel, page paths are matched by the rewrite rules in `vercel.json`, which are looser than the binary: invalid paths under `/library/…`, `/new/…` and `/https://music.apple.com/<cc>/…` get the app shell instead of a 404.

## Using a local wrapper-lite

The "wrapper-lite" setting at the bottom of the navigation switches between two modes (saved in the browser):

- **Server** (default): wrapper-lite requests are relayed by am-hook; rate, concurrency and `Authorization` come from the `--wrapper-*` options. Not offered on a [serverless deployment](#serverless-deployment-vercel--cloudflare) without `AM_HOOK_WRAPPER_URL`, or by a binary started with `--local-wrapper-only`.
- **Local**: the browser requests your own wrapper-lite directly (`/status`, `/m3u8`, `/key`, `/lyrics`, `/webplayback`, `/license`). The panel sets its URL, max requests per second, max concurrent requests and `Authorization` (same rules as `--wrapper-auth`). The limits apply to the current page only. The URL may carry credentials (such as `https://<token>@host`); as with `--wrapper-url`, they are sent as `Authorization: Basic …`, and a separately set `Authorization` takes precedence.
  - The requests are cross-origin: the wrapper-lite must allow CORS (send `Access-Control-Allow-Origin`, and allow the `Authorization` header in preflights if one is set), or install a browser extension that lifts CORS restrictions.
  - MV master playlists are still fetched by am-hook with `User-Agent: AM`; the other MV requests (`/webplayback`, `/license`) go to the local wrapper-lite.
