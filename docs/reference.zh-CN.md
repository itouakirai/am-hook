# 参考

中文 | [English](reference.md)

## 命令行参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `-l, --listen <ADDR>` | `0.0.0.0:8888` | 监听地址 |
| `-p, --port <PORT>` | 可选 | 设置时覆盖 `--listen` 中的端口 |
| `-w, --wrapper-url <URL>` | `http://127.0.0.1:12340` | wrapper-lite 密钥服务地址 |
| `--wrapper-rate <N>` | `24` | 每秒发往 wrapper-lite 的最大请求数（任意 1 秒内，超出的请求按顺序排队）。0 不限 |
| `--wrapper-concurrency <N>` | `24` | 同时进行的 wrapper-lite 请求上限。0 不限。wrapper-lite 运行在 QEMU 中、负载高时请求超时的话可调低（如 `8`） |
| `--wrapper-auth <VALUE>` | 不发送 | wrapper-lite 请求的 `Authorization` 头。只填 token 时自动加 `Bearer ` 前缀；已带认证方案（`Bearer …`、`Basic …`）则原样发送。也可用环境变量 `AM_HOOK_WRAPPER_AUTH` 设置（不会出现在进程列表中）。以上三项只作用于服务端转发；页面切换为本地 wrapper-lite 时在页面中另行设置 |
| `--client-rate <N>` | `0` | 每个客户端 IP 任意 60 秒内转发 wrapper-lite 的请求上限（不含 `/status`：它由所有客户端共用，每 10 秒最多请求一次 wrapper-lite），免得单个访客用光共用的 wrapper-lite；超出时返回 HTTP 429 与 `Retry-After`。播放一首歌约 3 个请求（master、key、歌词）。0 不限 |
| `--client-concurrency <N>` | `0` | 每个客户端 IP 同时转发 wrapper-lite 的请求上限（不含 `/status`）；超出的请求排队等待而不是失败，免得单个访客突发时占满 `--wrapper-concurrency` 的名额、堵住其他用户。播放一首歌同时需要 3 个（master、key、歌词）。0 不限 |
| `--client-ip-header <NAME>` | TCP 对端地址 | 存放客户端 IP 的请求头，由前面的反向代理设置（如 `X-Real-IP`、`CF-Connecting-IP`；是列表时取第一个）。在反向代理后面时需要设置，否则所有请求的对端都是代理。只有所有请求都经过该代理时才能设置，否则客户端可以伪造 |
| `--local-wrapper-only` | 关闭 | 不转发 wrapper-lite 请求：页面只有本地模式（与 serverless 部署没有设置 `AM_HOOK_WRAPPER_URL` 时相同），转发接口一律返回 501。`--wrapper-url`、`--wrapper-rate`、`--wrapper-concurrency` 改为页面的默认值（只作用于没有保存过设置的访客）；不使用 `--wrapper-auth`，也不会把它交给页面 |
| `--wrapper-hint <TEXT>` | 无 | 显示在本地 wrapper-lite 设置上方的提示，如去哪里申请公共 wrapper-lite 的 token，其中的网址显示为链接。也可用环境变量 `AM_HOOK_WRAPPER_HINT` 设置 |
| `--amp-keepalive <SECONDS>` | `30` | amp-api 连接保活：空闲达到该时长时发送一个轻量请求（0 关闭）。无论是否开启，启动时都会先获取 token 并建立连接 |
| `--amp-cache-mb <MB>` | `32` | amp-api 响应缓存（目录 5 分钟、地区表 24 小时；0 关闭）。相同的并发请求始终只请求一次上游 |
| `--check-update` | 关闭 | 启动时检查 GitHub Releases 上是否有新版本，并写入日志 |
| `--auto-update` | 关闭 | 同 `--check-update`，并下载当前平台的新版二进制替换当前文件（旧文件保留为备份），之后需重启 am-hook。Windows 无法替换正在运行的 exe，日志会列出手动替换的步骤 |

## 服务端接口

页面地址（见[页面一览](guide.zh-CN.md#页面一览)）都返回单页应用 `app.html`。API 接口如下：

| 接口 | 说明 |
|---|---|
| `GET /status` | wrapper-lite 状态与可用地区（所有客户端共用同一结果 10 秒） |
| `GET /parse/song/<adamId>` | 通过 wrapper-lite `/m3u8` 获取歌曲 master m3u8 的地址（`{"code":0,"data":{"masterUrl":…}}`），master 由浏览器获取并解析 |
| `GET /key?adamId=<adamId>&uri=<skd-uri>` | 转发 wrapper-lite `/key` 返回的歌曲轨道解密模板 JSON |
| `GET /lyrics/<adamId>?language=<语言>` | 通过 wrapper-lite `/lyrics` 获取 TTML 歌词，原样返回 XML；没有歌词时返回 404。`language` 可选，为歌曲所在地区的曲库语言（选定的语言，否则为地区默认语言，如 `zh-Hans-CN`） |
| `GET /parse/mv/<adamId>` | MV master 播放列表文本与最终 CDN 地址 |
| `GET /parse/mv-master?url=<master 地址>` | 同上，master 地址由页面从本地 wrapper-lite 取得；只接受 `apple.com` 的 HTTPS 地址 |
| `GET /amp/v1/catalog/<path>?<query>` | 代理 Apple Music 目录接口（`amp-api-edge.music.apple.com/v1/catalog/...`，首页搜索使用），自动附带 music.apple.com 网页版 developer token，查询参数原样转发。使用启动时预热的专用 HTTP/2 连接，缓存成功响应，合并相同的并发请求，并通过 `Server-Timing` 标明缓存命中（`cache;desc=hit/miss/shared`）与上游耗时 |
| `GET /amp/v1/editorial/<path>?<query>` | 代理编辑内容接口（`amp-api-edge.music.apple.com/v1/editorial/...`：groupings、rooms、multirooms，新发现与编辑页使用），方式与 `/amp/v1/catalog` 相同，共用连接与缓存 |
| `GET /amp/v1/storefronts` | amp-api 全部地区信息（查询参数原样转发，以便跟随分页 `next`）；页面只拉取一次并保存在 localStorage（超过 30 天后在后台刷新），用于主地区列表与曲库语言的可选项（各地区的 `supportedLanguageTags`）（地区不支持的 `l` 会被静默回退到默认语言，如 `cn` 只支持 `zh-Hans-CN` / `en-GB`） |
| `GET /mv/webplayback/<adamId>`、`POST /mv/license` | 转发到 wrapper-lite `/webplayback` 与 `/license`：MV（PlayReady，`drm-type: pr`）与没有 master m3u8 的歌曲（AAC-LC 的 media m3u8，Widevine，不带 `drm-type`） |
| `POST /station/next-tracks/ra.<id>`、`GET /station/assets?<playParams>`、`GET /station/catalog/<path>`、`GET /station/recent`、`GET /station/storefront` | 电台接口：带上页面经 `X-Media-User-Token` 传来的 media-user-token 与 developer token 请求 `amp-api.music.apple.com`（`/v1/me/stations/next-tracks`、`/v1/play/assets`、`/v1/catalog`、`/v1/me/recent/radio-stations`、`/v1/me/storefront`），原样返回、不缓存；没有 token 时返回 401 |
| `POST /station/license` | `{ url, body, renewal }`：把 `body` 连同两个 token POST 给电台的 license 服务器（`url` 须为 Apple 的 HTTPS 地址，且是 MusicKit 认识的 license 路径），原样返回响应 |
| `/assets/...` | 内嵌在二进制中的前端路由、页面视图（`/assets/views/`）、脚本、样式与按需加载的 WASM。页面通过 `/assets/h/` 下带内容哈希的地址加载（`immutable` 长期缓存），原地址以 `no-cache` + ETag 提供。`/assets/host.js` 告诉页面服务端能否转发 wrapper-lite（serverless 部署由函数生成） |
