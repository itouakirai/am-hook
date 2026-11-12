# 开发

中文 | [English](development.md)

各部分如何协作、代码分别在哪里，见 [architecture.zh-CN.md](architecture.zh-CN.md)。

## 构建

```sh
cargo build --release
```

二进制位于 `target/release/am-hook`（Windows 下为 `am-hook.exe`）。浏览器端资源（包括预编译的 WASM）都提交在 `web/` 下并内嵌进二进制，普通构建只需要 Rust。只有修改对应源码后才需要重新生成：

| 产物（`web/` 下） | 源码 | 重新生成 |
|---|---|---|
| `decrypt/hook.wasm`、`flac/flac.wasm`、`media/media.wasm`、`joc/joc.wasm` | `crates/am-wasm`、`crates/am-flac-wasm`、`crates/am-media-wasm`、`crates/joc-wasm`（及它们用到的 crate） | `rustup target add wasm32-unknown-unknown`，并安装 [binaryen](https://github.com/WebAssembly/binaryen) 的 `wasm-opt`（或 `WASM_OPT="npx -y -p binaryen@123.0.0 wasm-opt"`），然后运行 `scripts/build-wasm.sh`。`hook.wasm`、`media.wasm` 与 `joc.wasm` 使用 `Cargo.toml` 中的 `wasm` profile（按体积优化；temari、AES 与 joc-core 是热点，保持 `opt-level` 3）。只提交经过 `wasm-opt` 优化的产物 |
| `mv/cea608.mjs` | `vendor/cea608` | `node scripts/build-cea608.cjs <typescript 包路径>` |
| `lyrics/amll-core.mjs`、`lyrics/amll.css` | `@applemusic-like-lyrics/core`，见 [vendor/amll](../vendor/amll/README.md) | `node scripts/build-amll.cjs <node_modules 路径>` |
| `ec3/ec3.wasm`、`ec3/runtime.mjs` | `@mediabunny/ac3` 1.59.1 | `node scripts/extract-ec3.mjs`，见 [ec3/SOURCE.md](../web/ec3/SOURCE.md) |
| `joc/hrtf/*.jochrtf` | SADIE II 的 SOFA 文件，由 am-hook-joc 编译 | 本仓库不重新生成，见 [joc/NOTICE.md](../web/joc/NOTICE.md) |

serverless 构建（`node scripts/build-static.mjs [目录] [--cloudflare]`）只需要 Node，按同一张资源表生成 `dist/`。

### 新增前端文件

1. 放在 `web/<区域>/` 下（见[目录结构](architecture.zh-CN.md#目录结构)）。对外地址就是 `/assets/<区域>/<文件>`：`web/` 下的路径与地址始终一致。
2. 在 `src/assets.rs` 的 `ASSETS` 里加一行 `asset!("<区域>/<文件>")`。`Content-Type` 按扩展名决定，二进制与 `scripts/build-static.mjs` 读的都是这张表。
3. 用相对路径（`'../mv/hls.mjs'`）或绝对地址（`'/assets/mv/hls.mjs'`）的字符串字面量引用，不要用模板字符串或拼接：启动时引用会换成带内容哈希的地址，只有字面量能被找到。

`web/` 下有文件没登记、相对引用指向不存在的资源，或者引用没有换成哈希地址时，`cargo test` 会失败。

## 测试

| 测试 | 命令 | 需要 | CI |
|---|---|---|---|
| Rust | `cargo test --workspace` | 无 | 是 |
| Lint | `cargo clippy --workspace --all-targets -- -D warnings` | 无 | 是（CI 的 stable 可能比本地新） |
| Node 单元测试 | `node tests/run.mjs unit` | Node | 是 |
| 浏览器界面 | `node tests/run.mjs ui [过滤]` | Playwright 与已安装的 Chrome | 否 |
| 在线 | `node tests/run.mjs live [过滤]` | 运行中的 am-hook、wrapper-lite，能访问 Apple | 否 |
| Rust 在线 | `cargo test --test e2e_test -- --ignored` | wrapper-lite（`AM_HOOK_WRAPPER`，默认 `http://127.0.0.1:12340`） | 否 |

`tests/run.mjs` 把 Playwright 包路径传给每个浏览器测试：`$PLAYWRIGHT`，否则存在时用 `target/pw/node_modules/playwright-core`，再否则用 `node_modules` 里的 `playwright`。在线测试的服务地址取自 `AM_HOOK_URL`（默认 `http://127.0.0.1:8888`；未设置时 MV 与电台测试默认 `http://127.0.0.1:18888`）。过滤条件保留文件名包含它的测试，例如 `node tests/run.mjs ui library`。每个脚本也可以直接运行：`node tests/ui/library_ui.cjs <playwright>`。

Rust 单元测试覆盖浏览器媒体核心（PlayReady 与 Widevine license 解密、CENC/CBCS（含长度不变的原地解密）、字幕修复、defrag）、URL 解析、m3u8 解析、MP4 box 修补（含 wasm 原地解密路径与并行路径结果一致）、资源表、缓存去重和 MV 接口。`crates/joc-core` 用真实全景声元数据制作的样本逐位比对 am-hook-joc 的参考摘要（Speaker 2.0、双耳、reset、每组 HRTF）。离线集成测试还检查 Apple CDN 地址不会被代理。

<details>
<summary><b>tests/unit：离线，仅需 Node</b></summary>

| 文件 | 覆盖内容 |
|---|---|
| `serverless.mjs` | serverless 后端（Vercel 与 Cloudflare 入口）与 `dist/` 的生成 |
| `alac_check.mjs` | ALAC 检测：原样帧末尾的判定（含 issue #136 中的实例）、moof / init 解析、多 DRM 清单中的预取密钥、频宽结论 |
| `joc_wasm.mjs` | `web/joc/joc.wasm` 与 `crates/joc-core` 相同的参考摘要、20 组 HRTF、无效 HRTF，以及两种模式的实时倍率 |
| `automix.cjs` | 按 Apple 音频分析规划 AutoMix：响度曲线、拍点与人声 → 重叠区间、增益与变速 |
| `agent_duet.mjs` | TTML 歌词的对唱侧（`duetSides`，与 AMLL 逐行一致） |
| `download_core.mjs` | ZIP / ZIP64、iTunes 标签、文件名模板与专辑名后缀、音质选择 |
| `throttle.mjs` | wrapper-lite 限流（429）时 `wrapper.js` 与真实下载调度的退避 |
| `player_*.cjs` | 播放器：封面、缓冲窗口、播放模式选择、PCM 重试 |
| `mv_hls.cjs`、`mv_captions.cjs` | MV 清单（链接、变体、密钥轮换、字节范围）与 CEA-608 字幕 |

</details>

<details>
<summary><b>tests/ui：离线，Playwright + Chrome 与本地 fixture</b></summary>

这些测试经 `tests/support/web.cjs` 提供 `web/`（与二进制相同：`/assets/<路径>` 即 `web/<路径>`），后端与 Apple 的响应全部由 fixture 给出。

| 文件 | 覆盖内容 |
|---|---|
| `ui_layout.cjs` | 不同视口与语言下的页面布局：表单、溢出、菜单、焦点、播放条留白 |
| `lyrics_ui.cjs` | 歌词界面：加载、逐行跟随、跳转、翻译、语言、布局 |
| `mv_ui.cjs` | MV 页：视口、语言、主题、键盘选择、推荐音轨、加载错误、post 页 |
| `library_ui.cjs` | 资料库与歌单：添加、歌单、排序、刷新后保留、导出 / 导入与文件校验、喜爱、文件夹与拖放、数据库升级 |
| `station_ui.cjs` | 广播与电台页：导航位置、直播货架与「你的电台」、首次填写 media-user-token、接下来的几首与续取、单集与直播的布局、设置中心 |
| `wrapper_local.cjs` | 本地 wrapper-lite 模式：面板校验、带 `Authorization` 的直连请求、限速限并发、歌曲 master 解析、MV master 经 am-hook、只允许本地的部署 |

</details>

<details>
<summary><b>tests/live：需运行 am-hook、wrapper-lite 并能访问 Apple</b></summary>

| 文件 | 覆盖内容 |
|---|---|
| `mv_live.cjs`、`mv_captions_live.cjs` | MV 播放、下载与字幕 |
| `alac_recovery.cjs`、`alac_source_recovery.cjs` | ALAC 包尾修复 |
| `alac_check_ui.cjs` | 专辑页 ALAC 检测：issue #136 中 Shadows In The Night 的两个缺陷帧、打包日期、前 15 秒分析、复制报告，且不请求 `/key`（不需要 wrapper-lite） |
| `aac_lc_live.cjs` | 没有 master 的歌曲：AAC-LC 变体、Widevine license、服务端与本地模式下的播放与跳转、下载到 `target/` |
| `search_ui.cjs`、`album_ui.cjs`、`playlist_ui.cjs`、`artist_ui.cjs`、`browse_ui.cjs` | 搜索、专辑、歌单、艺人与浏览页（需能访问 music.apple.com） |
| `app_ui.cjs` | 单页应用：跳转后继续播放、队列、前进 / 后退、歌词 |
| `download_ui.cjs` | 批量下载：设置中心、专辑 ZIP 的标签 / 封面 / 歌词、文件夹模式、歌单与 .m3u8、MV、取消 / 重试；需要 cn 地区的 wrapper-lite |
| `radio_live.cjs` | 电台：需要 media-user-token，取自第三个参数、`AM_HOOK_MEDIA_USER_TOKEN` 或 `target/my-media-user-token.txt`；风格电台与个人电台、广播单集的 Widevine license / 播放 / 跳转 / M4A 下载，以及用单集分片模拟的直播 |

</details>

## 发布

见 [release.zh-CN.md](release.zh-CN.md)。
