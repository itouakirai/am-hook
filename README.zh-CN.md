# am-hook

中文 | [English](README.md)

一个用 Rust 编写的 Apple Music FairPlay HLS 解密工具。默认模式下，**解密完全在浏览器中完成**：服务端只提供 master m3u8 和轨道解密模板，音频数据由浏览器直接从 Apple CDN 获取，并在 Web Worker 中用 WebAssembly 解密，不消耗服务器流量。需要给 VLC、IDM 等外部工具提供解密地址时，可以用 `--hook` 开启服务端解密代理。

## 工作原理

### 浏览器端解密（默认）

服务端接口：

| 接口 | 说明 |
|---|---|
| `GET /parse/<adamId>` | 通过 wrapper-lite 获取 master m3u8，返回各音质变体 |
| `GET /key?adamId=<adamId>&uri=<skd-uri>` | 转发 wrapper-lite `/key` 返回的轨道解密模板 JSON |
| `/assets/hook.wasm` 等 | 页面、脚本与解密核心（内嵌在二进制中，`no-cache` + ETag） |

浏览器端流程（`src/ui/decrypt.js`）：

1. 直接从 `aod.itunes.apple.com` 获取 media m3u8（CDN 允许跨域和 Range 请求），解析出 init 段、各分片的字节范围，以及每个分片对应的 key。
2. 首个分片使用内嵌在 wasm 中的固定模板（`skd://itunes.apple.com/P000000000/s1/e1`），其余分片使用经 `/key` 获取的轨道模板。
3. 分片用 Range 请求从 CDN 拉取，交给 Worker 池（每个 Worker 一个 `hook.wasm` 实例）原地解密；解密逻辑与服务端共用 `crates/am-mp4`，产物与 `--hook` 模式逐字节一致。
4. **播放**：解密后的分片喂给 MSE，只缓冲当前位置之后约 45 秒，拖动时直接定位到对应分片。
5. **下载**：4 路并发拉取和解密，结果按原始偏移写入 OPFS（Origin Private File System）临时文件，完成后以磁盘文件的形式交给浏览器保存。大文件也只占用少量内存。不支持 OPFS 时退回内存 Blob。

> OPFS 只在安全上下文中可用，也就是 HTTPS 或 `localhost` / `127.0.0.1`。通过 `http://<局域网 IP>` 访问时，下载会退回内存模式，大文件会占用较多内存；播放不受影响。

### 服务端解密代理（`--hook`）

以 `--hook` 启动后，额外提供以下代理地址（未开启时统一返回 404）：

```
http://<host>:8888/https://aod.itunes.apple.com/itunes-assets/...
```

这是一种 **URL 前缀式代理**（与 cors-anywhere 类似）：客户端把要访问的 CDN 地址直接拼在 am-hook 地址后面，am-hook 代为请求、解密后返回。它既不是反向代理（要访问哪个上游由客户端决定，而不是由代理决定），也不是需要在系统或播放器里配置的 HTTP 正向代理，只是一个普通的 HTTP 地址，所以可以直接交给 VLC、IDM 等工具使用。

只处理包含 `aod.itunes.apple.com/itunes-assets/` 的源地址。根据文件名特征分为以下几类：

| 类型 | 文件名特征 | 行为 |
|---|---|---|
| Master m3u8 | `P<数字>_<非A开头>.m3u8` | 原样转发 |
| Media m3u8 | `P<数字>_A<数字>_...m3u8` | 提取元数据，剥离 `#EXT-X-KEY` 行。默认改写为通用播放列表（`EXT-X-VERSION:3`，无 `EXT-X-MAP` / `EXT-X-BYTERANGE`，每段独立 URL），兼容 PotPlayer 等对 fMP4 BYTERANGE 支持不完整的播放器；加 `?hook=byterange` 可保留 Apple 原始写法 |
| Media file | 与 media m3u8 对应，`.m3u8` 替换为 `_m.mp4` | 按范围拉取分片，原地解密 sample，替换加密元数据 box，流式返回 |
| Media segment | media file 的 `_m.mp4` 替换为 `_m_seg<N>.mp4` | init 段 + 第 N 个分片，可单独解码（支持 Range） |

服务端解密流程：

1. media m3u8 请求建立轨道上下文，包含 `adamId`、`skd://` URI、`fileuri`、首个分片范围和全部分片字节范围。
2. 上下文补齐后，后台监控立即向 wrapper-lite 获取该轨道的解密模板。
3. media file 请求将 HTTP Range 映射到分片，只从 CDN 拉取所需字节；最多 `--prefetch` 个分片并发下载，在阻塞线程上用 temari 线程池并行解密 sample，按顺序流式输出。同一分片的并发请求只下载解密一次，结果进入按字节计量的 LRU 缓存。客户端断开时，未完成的拉取随之取消。

两种模式共用的 box 处理：FairPlay 元数据 box（`sinf`、`senc`、`saiz`、`saio`、`pssh`，以及分组类型为 `seig`/`seam` 的 `sgpd`、`sbgp`）替换为等长的 `free` box，字节长度和 Range 偏移保持不变。init 段中的 `enca` box 改写为原始编码（`ec-3`、`mp4a`、`alac` 等）。

## Web 界面

浏览器打开 `http://127.0.0.1:8888/`：

- 界面支持中文 / English，右上角按钮一键切换（会记住选择；首次访问按浏览器语言决定）。切换时正在进行的播放和下载不受影响。
- 输入 song 链接、带 `?i=` 的专辑分享链接或纯数字歌曲 ID，进入歌曲页。
- 歌曲页自动解析全部音质（无损 ALAC / 杜比全景声 / AAC / HE-AAC，含双耳、缩混版本），显示封面、歌名等信息（由浏览器直接请求 iTunes Lookup）。
- 每个音质的「更多」菜单：
  - **下载解密文件**：在浏览器内解密，显示进度，可随时取消。
  - 仅 `--hook` 模式：通过服务器下载、用 VLC 播放（`vlc://<media m3u8 地址>`，与 alist 格式相同）、复制 media m3u8 / media file（IDM）地址。桌面版 VLC 默认不注册 `vlc://` 协议，需要自行安装协议处理程序；Android / iOS 版 VLC 可以直接唤起。
- 内置在线播放器：用 MSE 加浏览器端解密播放；`--hook` 模式下，不支持 MSE 的编码还可以回退到原生 HLS（Safari，可播 ALAC / E-AC-3）或直连服务端 media file。支持空格 / 方向键和系统媒体控制。

## 环境要求

- Rust 2021 edition 工具链（`cargo build`）
- 运行中的 wrapper-lite 密钥服务（默认 `http://127.0.0.1:12340`）
- 浏览器端需要 Web Worker、WebAssembly 和 MSE（主流浏览器均支持）

## 构建

```sh
cargo build --release
```

Windows 下生成的二进制位于 `target/release/am-hook.exe`。

浏览器端解密核心 `src/ui/hook.wasm` 是预编译好并随仓库提交的，构建服务端时直接内嵌。修改 `crates/am-mp4`、`crates/am-wasm` 或 `crates/temari` 后，需要重新生成并提交它：

```sh
rustup target add wasm32-unknown-unknown
scripts/build-wasm.sh
# 或手动：
cargo build -p am-wasm --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/am_wasm.wasm src/ui/hook.wasm
```

## 运行

```sh
# 默认：浏览器端解密，服务端只提供 master m3u8 与解密模板
am-hook --listen 0.0.0.0:8888 --wrapper-url http://192.168.31.105:3001

# 同时开启服务端解密代理（VLC / IDM 等外部工具使用，消耗服务器流量）
am-hook --listen 0.0.0.0:8888 --wrapper-url http://192.168.31.105:3001 --hook
```

全部参数：

| 参数 | 默认值 | 说明 |
|---|---|---|
| `-l, --listen <ADDR>` | `0.0.0.0:8888` | 监听地址 |
| `-p, --port <PORT>` | 可选 | 设置时覆盖 `--listen` 中的端口 |
| `-w, --wrapper-url <URL>` | `http://127.0.0.1:12340` | wrapper-lite 密钥服务地址 |
| `--hook` | 关闭 | 开启服务端解密代理（media m3u8 / media file 地址） |
| `--cache-ttl <SECONDS>` | `1800` | `--hook`：轨道上下文 TTL 淘汰时间 |
| `--lru-cache-mb <MB>` | `128` | `--hook`：已解密分片的内存 LRU 缓存容量（按字节计） |
| `--prefetch <N>` | `4` | `--hook`：单个请求内并发拉取 / 解密的分片数 |
| `--template-timeout <SECONDS>` | `20` | `--hook`：等待轨道解密模板的超时时间 |

## 测试

```sh
cargo test --workspace
```

单元测试覆盖 URL 解析、m3u8 改写、MP4 box 修补（含 wasm 使用的原地解密路径与并行路径结果一致）、Range 解析和缓存去重。端到端测试连接真实 CDN 与 wrapper-lite（默认 `http://127.0.0.1:12340`，可用环境变量 `AM_HOOK_WRAPPER` 覆盖），验证解密后的分片、跨分片 Range，以及未开启 `--hook` 时代理请求被拒绝。

## 项目结构

```
src/
  cli.rs               命令行参数解析
  main.rs              服务启动
  lib.rs               路由构建
  source.rs            源地址规整与类型识别
  proxy.rs             --hook：请求分流、Range 流式响应、分片拉取与解密调度
  m3u8.rs              HLS 播放列表解析和加密标记剥离
  state.rs             轨道上下文（并发去重）和分片缓存
  wrapper.rs           wrapper-lite 请求客户端（master m3u8、解密模板）
  monitor.rs           --hook：后台模板拉取和 TTL 清理
  ui.rs                Web 接口（状态、解析、模板、静态资源）
  ui/
    home.html / song.html / app.css   页面与样式
    player.js          在线播放器（MSE）
    decrypt.js         浏览器端解密：m3u8 解析、Worker 池、模板、下载与 OPFS
    hook-worker.js     Worker：调用 wasm 解密、写入 OPFS
    hook.wasm          crates/am-wasm 的编译产物
crates/
  am-mp4/              ISOBMFF 解析、box 修补、sample 解密（服务端与 wasm 共用）；内嵌首段固定模板
  am-wasm/             am-mp4 的浏览器端 C ABI 导出（wasm32-unknown-unknown）
  temari/              内置的 Temari FairPlay 解密库
scripts/build-wasm.sh  重新生成 src/ui/hook.wasm
tests/e2e_test.rs      端到端集成测试
```
