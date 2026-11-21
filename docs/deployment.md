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

- amp-api responses are cached by the platform (Vercel CDN, Cloudflare Cache API; 5 minutes for the catalog, 24 hours for storefronts); there is no connection keep-alive or background warm-up, and the first catalog request of a new instance scrapes the developer token first, which takes a few seconds. An HTTP 429 from Apple pauses forwarding to that host with the same cooldown as the binary, but only within one instance; there is no per-client limit (use the platform's rate limiting).
- No command-line options, request log or auto-update.
- On Vercel, page paths are matched by the rewrite rules in `vercel.json`, which are looser than the binary: invalid paths under `/library/…`, `/new/…` and `/https://music.apple.com/<cc>/…` get the app shell instead of a 404.

## amp Proxy Cluster

Apple rate-limits amp-api (catalog, search, stations) by IP. To spread that load, run extra binaries on machines with other IPs as **amp-only nodes** and let the reverse proxy in front send `/amp/` and `/station/` to them; everything else (pages, assets, wrapper-lite relay) stays on the main am-hook.

- `am-hook --amp-only` serves only `/amp/*`, `/station/*` and `/amp/health`; every other path is 404. It never loads or compresses the frontend assets, so it idles at roughly half the memory of a full instance (about 11 MB vs 24 MB on Windows). Lower `--amp-cache-mb` to save more.
- Each node keeps its own developer token, response cache and 429 cooldown; while cooling down it answers 429 at once, so the reverse proxy can move the request to another node.
- `GET /amp/health` is 200 while the node has a token and is not cooling down, 503 otherwise (body `{ok, token, cooldown, proxy}`), for load balancers with active health checks.
- Station requests carry the visitor's media-user-token cookie; route by path on the same site so the cookie is sent, and serve nodes only from the reverse proxy (bind them to a private address or firewall them).
- A node can itself go out through `--amp-proxy`, so one machine can provide several IPs.
- Behind the reverse proxy, give the nodes `--client-ip-header X-Real-IP` if you use `--amp-client-rate` / `--amp-client-concurrency`.

nginx example (the main am-hook on `127.0.0.1:8080`, two nodes):

```nginx
upstream am_hook { server 127.0.0.1:8080; }
upstream amp_nodes {
    server 10.0.0.2:8080;
    server 10.0.0.3:8080;
}
server {
    # ...listen / TLS...
    location ~ ^/(amp|station)/ {
        proxy_pass http://amp_nodes;
        proxy_set_header X-Real-IP $remote_addr;
        # a node that answers 429 (cooling down) or is down: try the next one (GET only, by default)
        proxy_next_upstream error timeout http_429;
    }
    location / {
        proxy_pass http://am_hook;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Nodes are started with `am-hook --amp-only --listen 0.0.0.0:8080 --client-ip-header X-Real-IP` (add `--amp-proxy socks5h://…` to send through a proxy).

## Using a local wrapper-lite

The "wrapper-lite" setting at the bottom of the navigation switches between two modes (saved in the browser):

- **Server** (default): wrapper-lite requests are relayed by am-hook; rate, concurrency and `Authorization` come from the `--wrapper-*` options. Not offered on a [serverless deployment](#serverless-deployment-vercel--cloudflare) without `AM_HOOK_WRAPPER_URL`, or by a binary started with `--local-wrapper-only`.
- **Local**: the browser requests your own wrapper-lite directly (`/status`, `/m3u8`, `/key`, `/lyrics`, `/webplayback`, `/license`). The panel sets its URL, max requests per second, max concurrent requests and `Authorization` (same rules as `--wrapper-auth`). The limits apply to the current page only. The URL may carry credentials (such as `https://<token>@host`); as with `--wrapper-url`, they are sent as `Authorization: Basic …`, and a separately set `Authorization` takes precedence.
  - The requests are cross-origin: the wrapper-lite must allow CORS (send `Access-Control-Allow-Origin`, and allow the `Authorization` header in preflights if one is set), or install a browser extension that lifts CORS restrictions.
  - MV master playlists are still fetched by am-hook with `User-Agent: AM`; the other MV requests (`/webplayback`, `/license`) go to the local wrapper-lite.
  - When the page is public and the wrapper-lite is on this machine (`127.0.0.1`, `localhost`) or the LAN (private IPs, `*.local`), Chrome asks for Local Network Access permission. Requests declare `targetAddressSpace`, so an HTTPS page may then reach an `http://` wrapper-lite. While the permission is still "Ask" the page does not contact the wrapper-lite on load (the status reads "Needs permission"); click "Save and check" in the panel and allow the prompt. If it was blocked, allow "Local network" in the site settings.
