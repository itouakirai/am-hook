# 部署

中文 | [English](deployment.md)

[快速开始](../README.zh-CN.md#快速开始)中的二进制功能最完整：转发 wrapper-lite 时可以限速限并发（见[命令行参数](reference.zh-CN.md#命令行参数)），通过普通的 `http://<局域网 IP>` 也能使用。下面的方式不需要二进制。

## Serverless 部署（Vercel / Cloudflare）

不想运行二进制的话，可以把同一套页面部署到 serverless 平台：静态资源由平台托管，后端只剩一个函数（amp-api 目录代理、MV master 获取与电台接口）。两个平台任选其一：

| 平台 | 一键部署 | 命令行 |
|---|---|---|
| Vercel | [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fitouakirai%2Fam-hook) | `npx vercel --prod` |
| Cloudflare Workers | [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/itouakirai/am-hook) | `npx wrangler deploy` |

部署 fork 时把按钮链接里的仓库地址换成自己的。构建只需要 Node（`node scripts/build-static.mjs` 由 `web/` 生成 `dist/`），不需要 Rust；配置见 [vercel.json](../vercel.json) 与 [wrangler.toml](../wrangler.toml)。

**wrapper-lite**：平台上的函数访问不到你本机的 wrapper-lite，所以默认只有[本地模式](#使用本地-wrapper-lite)——在导航底部的「wrapper-lite」设置里填写自己的 wrapper-lite 地址，请求由浏览器直接发出：

- 页面是 HTTPS 的，浏览器只允许它请求 `http://127.0.0.1` / `http://localhost` 或 HTTPS 地址；`http://<局域网 IP>` 会被当作混合内容拦截（wrapper-lite 在另一台机器上时需要给它加 HTTPS，或改用二进制）。部分浏览器对回环地址也有限制，Chrome 可能会先询问是否允许访问本地网络。
- wrapper-lite 需允许跨源请求（见[使用本地 wrapper-lite](#使用本地-wrapper-lite)）。

也可以让函数转发到一个公网可达的 wrapper-lite，在平台的环境变量里设置（Cloudflare 用 `npx wrangler secret put <名称>`；Vercel 修改后需重新部署）：

| 环境变量 | 说明 |
|---|---|
| `AM_HOOK_WRAPPER_URL` | wrapper-lite 地址。设置后页面默认使用「服务端」模式，与二进制相同；可带用户信息（`https://<token>@host`） |
| `AM_HOOK_WRAPPER_AUTH` | 可选，wrapper-lite 请求的 `Authorization`，规则与 `--wrapper-auth` 相同 |
| `AM_HOOK_WRAPPER_HINT` | 可选，显示在本地 wrapper-lite 设置上方的提示，同 `--wrapper-hint` |

> [!WARNING]
> 设置 `AM_HOOK_WRAPPER_URL` 后，能打开站点的人都能使用你的 wrapper-lite（也就是你的 Apple 账号）。请用平台的访问控制（Vercel Deployment Protection、Cloudflare Access）限制访问。函数实例之间不共享状态，这里没有 `--wrapper-rate` / `--wrapper-concurrency` 那样的限速与限并发。

与二进制的其他区别：

- amp-api 的响应由平台缓存（Vercel CDN、Cloudflare Cache API；目录 5 分钟、地区表 24 小时），没有连接保活与后台预热；新实例的第一个目录请求要先抓取 developer token，会慢几秒。
- 没有命令行参数、请求日志与自动更新。
- Vercel 上页面地址由 `vercel.json` 的改写规则匹配，比二进制宽松：`/library/…`、`/new/…` 与 `/https://music.apple.com/<cc>/…` 下无效的地址也返回页面外壳而不是 404。

## 使用本地 wrapper-lite

导航底部的「wrapper-lite」设置可以在两种方式间切换（保存在浏览器中）：

- **服务端**（默认）：wrapper-lite 请求经 am-hook 转发，限速、限并发与 `Authorization` 由 `--wrapper-*` 参数决定。[Serverless 部署](#serverless-部署vercel--cloudflare)没有设置 `AM_HOOK_WRAPPER_URL`、或二进制以 `--local-wrapper-only` 启动时没有这一项。
- **本地**：浏览器直接请求你自己的 wrapper-lite（`/status`、`/m3u8`、`/key`、`/lyrics`、`/webplayback`、`/license`），在面板中填写地址、每秒请求数上限、同时请求数上限与 `Authorization`（规则与 `--wrapper-auth` 相同）。限制只作用于当前页面。地址可以带用户信息（如 `https://<token>@host`），与 `--wrapper-url` 相同，转为 `Authorization: Basic …` 发送；单独填写的 `Authorization` 优先。
  - 请求是跨源的：wrapper-lite 需允许跨源请求（返回 `Access-Control-Allow-Origin`，填了 `Authorization` 时还需在预检中允许该请求头），或在浏览器中安装解除跨域限制的插件。
  - MV 的 master 播放列表仍由 am-hook 以 `User-Agent: AM` 获取，其余 MV 请求（`/webplayback`、`/license`）直连本地 wrapper-lite。
