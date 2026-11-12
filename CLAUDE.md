# am-hook 维护手册

Apple Music 网页播放器与下载器：Rust 小服务端（或一个 serverless 函数）+ 大浏览器应用。服务端只转发 wrapper-lite 与代理 amp-api，
媒体由浏览器直接从 Apple CDN 获取并在 Worker 里用 wasm 解密。完整说明在 `docs/`：功能 → 文件的对照见
[docs/architecture.zh-CN.md](docs/architecture.zh-CN.md#功能地图)，测试与构建见 [docs/development.zh-CN.md](docs/development.zh-CN.md)。

## 布局速查

| 目录 | 内容 |
|---|---|
| `src/` | 服务端：`lib.rs` 路由 → `handlers.rs`（页面外壳、wrapper-lite 转发）/ `amp.rs`（曲库代理、电台）/ `assets.rs`（内嵌前端） |
| `web/` | 浏览器应用，按功能分目录：`player/` `decrypt/` `media/` `flac/` `ec3/` `joc/` `mv/` `download/` `lyrics/` `views/`，根目录是外壳与全局服务 |
| `crates/` | wasm 与媒体核心：`am-mp4`/`am-wasm`/`temari`（FairPlay）、`am-media`(-wasm)（PlayReady/Widevine/CENC/defrag）、`am-alac`、`am-flac-wasm`、`joc-core`/`joc-wasm` |
| `serverless/` `api/` | serverless 后端，`core.mjs` 是 `amp.rs` + `handlers.rs` 的 JS 对应实现 |
| `tests/` | `*.rs`（cargo）、`unit/`（Node，CI）、`ui/`（Playwright 离线）、`live/`（需真实环境）、`support/`、`run.mjs` |
| `vendor/` `scripts/` | 生成 `web/` 文件的第三方源码与构建脚本 |

**地址 = 路径**：`/assets/<p>` 就是 `web/<p>`；页面实际加载的是 `/assets/h/<p 去扩展名>.<16 位 hash>.<扩展名>`。
报错堆栈或网络面板里的地址去掉 `h/` 与 hash 就是源文件。

## 按症状定位

| 症状 | 先看 |
|---|---|
| 资源 404、模块加载失败、改了前端不生效 | `src/assets.rs` 的 `ASSETS`（文件要登记）；前端改动要**重新编译并重启**二进制（`include_bytes!`），`cargo test -p am-hook --lib assets` |
| 服务端日志看不懂 / 想看静态资源请求 | `src/log.rs`（`describe` 分类）；`RUST_LOG=am_hook=debug` |
| 选错音质 / 播放模式 | `web/player/player.js` 顶部：`detectModes`、`pickPlayable`、`rankVariant`；用户设置在 `prefs.mjs` 的 `playback` |
| 播放卡顿、缓冲、跳转 | `player.js` 的 `MseEngine`（`AHEAD_SECONDS` 等常量在文件头）；PCM 路径 `PcmEngine`；重试 `scheduleRetry` |
| 歌曲解密失败 / 杂音 | `web/decrypt/decrypt.js`（m3u8、预取密钥 vs `/key` 模板）→ `handlers.rs::key_handler` → `wrapper.rs`；解密本体 `crates/am-mp4` |
| 拿不到 master / wrapper-lite 报错、429 | `web/wrapper.js`（`songMaster`、`throttle`）；服务端 `handlers.rs`、`wrapper.rs`、`limit.rs` |
| 没有 master 的歌（AAC-LC） | `wrapper.js` 的 `songMaster` → `media/` → `crates/am-media/src/widevine.rs` |
| ALAC 帧尾、ALAC 检测 | `crates/am-alac`、`web/alac-check.mjs`、`views/alac-check-dialog.mjs`、`crates/am-flac-wasm/src/analysis.rs` |
| 全景声 / JOC / 双耳 | `web/joc/`、`player.js` 的 `JocEngine`/`JocLiveEngine`；DSP 在 `crates/joc-core` |
| AutoMix / 交叉淡化 | 规划 `web/player/automix.js`（纯函数，`tests/unit/automix.cjs`），执行 `player.js` 的 `Mixer`/`Voice` |
| MV 播放 / 下载 / 字幕 | `web/mv/engine.mjs`、`mv/hls.mjs`、`mv/captions.mjs`；Worker `media/`；Rust `crates/am-media`；服务端 `/parse/mv*` |
| 电台 / 广播 | `web/station.mjs`（token、license 格式）、`mv/radio.mjs`（HLS）、`views/station.mjs`；服务端 `amp.rs` 的 `station_*` |
| 曲库页面空白、搜索无结果 | `amp.rs`（developer token 抓取、缓存）或 `serverless/core.mjs`；页面 `web/views/<页面>.mjs` |
| 歌词 | `web/lyrics/panel.mjs`（接播放器）、`ttml.mjs`、`fonts.mjs`；服务端 `handlers.rs::lyrics_handler` |
| 下载文件名、标签、ZIP | `web/download/`（`naming.mjs`、`mp4-tags.mjs`、`zip.mjs`）；调度 `downloads.mjs`；下载中心 `center.mjs` |
| 资料库 / 歌单 | `web/library.mjs`（IndexedDB 与导入导出）、`views/library*.mjs` |
| 设置项与默认值 | `web/prefs.mjs` 的 `DEFAULTS` / `OPTIONS`；设置页 `views/settings.mjs`；导航选择面板 `pickers.mjs` |
| 界面文字 | `web/i18n.js`（中英文两份，键名相同） |
| serverless 部署行为不同 | `serverless/core.mjs`、`vercel.json` 的 rewrites、`scripts/build-static.mjs` |

`player.js` 是一个 IIFE（约 3900 行），用 `grep -n "^  class " web/player/player.js` 看结构：
`FlacTranscoder` `Ec3Decoder` `JocDecoder`（解码 Worker 的包装）→ `PcmEngine` → `JocEngine` → `JocLiveEngine`，
`MseEngine`，`AudioClock` `Voice` `Mixer`（过渡），`AmPlayer`（队列、播放条界面，约占后一半）。

## 必须遵守

- **不要运行 `cargo fmt`**：仓库不是 rustfmt 风格，会改写所有文件。
- 新前端文件：放进 `web/<区域>/`，在 `ASSETS` 加 `asset!("<区域>/<文件>")`；引用只用字符串字面量（相对路径或 `/assets/...`），
  不用模板或拼接，否则换不成哈希地址。测试会抓漏登记、断掉的相对 import 与未哈希的引用。
- 经典脚本（`app.html` 按顺序加载 `i18n.js` `host.js` `wrapper.js` `decrypt/decrypt.js` `player/automix.js` `player/player.js`）
  挂全局：`AmI18n` `AM_HOOK_HOST` `AmWrapper` `AmDecrypt` `AmAutomix` `AmHook`；ES 模块从 `window` 取。
  同一模块经两个地址（哈希与原地址）加载会得到两个实例：页面里的测试要 import 哈希地址。
- 改了 `crates/` 中 wasm 相关 crate：运行 `scripts/build-wasm.sh`（需要 `wasm-opt`），提交 `web/` 下更新的 `.wasm`。
- `crates/joc-core` 与 `tests/unit/joc_wasm.mjs` 按参考实现**逐位**比对 SHA-256：不要改变浮点运算顺序。
- 服务端接口改动要同时改 `src/`（`handlers.rs`/`amp.rs`）与 `serverless/core.mjs`，`tests/unit/serverless.mjs` 覆盖后者。
- 界面文字中英文都要有；README 与 `docs/` 中英文两份同步更新（`release.zh-CN.md` 只有中文）。
- 代码注释用中文；提交信息用英文 conventional 格式（`feat(lyrics): …`、`fix(player): …`），功能提交不改 CHANGELOG，
  发布时统一写（见 [docs/release.zh-CN.md](docs/release.zh-CN.md)）。

## 验证

```sh
cargo test --workspace                                   # 含资源表、serverless 产物一致性
cargo clippy --workspace --all-targets -- -D warnings    # CI 的 stable 可能更新
node tests/run.mjs unit                                  # CI 同款
node tests/run.mjs ui [过滤]                             # Playwright + Chrome，离线 fixture
node tests/run.mjs live [过滤]                           # AM_HOOK_URL 指向运行中的 am-hook
```

前端改动至少跑 `cargo test -p am-hook --lib assets` 与相关的 `ui` 测试；行为改动在真实页面上验证（启动二进制、用 Playwright 打开页面）。
