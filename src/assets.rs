//! 内嵌的前端资源（`web/`）。
//!
//! 对外地址与源文件一一对应：`web/<path>` 就是 `/assets/<path>`（外壳 `web/app.html` 是 `/`）。
//! 新增页面资源只需要在 [`ASSETS`] 里加一行 `asset!("<path>")`：路由由 [`router`](crate::router) 按表注册，
//! `Content-Type` 按扩展名决定，不需要再写 handler。`web/` 下没登记的文件（除说明文档外）会让测试失败。
//! 页面加载的是带内容哈希的地址（长期缓存），原地址以 `no-cache` + 内容 ETag 提供（见 [`Served`]）。
//! 文本与 wasm 按 `Accept-Encoding` 以 brotli / gzip 压缩提供，压缩结果每个资源只算一次（启动后在后台预先算好，见 [`warm`]）。

use std::collections::HashMap;
use std::io::Write;
use std::ops::Range;
use std::sync::{Arc, LazyLock, OnceLock};

use axum::body::Body;
use axum::http::header::{ACCEPT_ENCODING, CACHE_CONTROL, CONTENT_ENCODING, CONTENT_TYPE, ETAG, IF_NONE_MATCH, VARY};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use bytes::Bytes;
use regex::Regex;

const HTML: &str = "text/html; charset=utf-8";
const JS: &str = "text/javascript; charset=utf-8";
const CSS: &str = "text/css; charset=utf-8";
const WASM: &str = "application/wasm";
const MANIFEST: &str = "application/manifest+json";
const PNG: &str = "image/png";
const SVG: &str = "image/svg+xml";
const BIN: &str = "application/octet-stream";

/// 一个内嵌资源：对外地址、`Content-Type` 与编译进二进制的内容
pub struct Asset {
    pub url: &'static str,
    pub mime: &'static str,
    pub body: &'static [u8],
}

const fn ends_with(s: &str, suffix: &str) -> bool {
    let (s, suffix) = (s.as_bytes(), suffix.as_bytes());
    if s.len() < suffix.len() {
        return false;
    }
    let mut i = 0;
    while i < suffix.len() {
        if s[s.len() - suffix.len() + i] != suffix[i] {
            return false;
        }
        i += 1;
    }
    true
}

/// 按扩展名决定 `Content-Type`（scripts/build-static.mjs 不需要它：静态托管平台自己按扩展名判断）
const fn mime_of(file: &str) -> &'static str {
    if ends_with(file, ".html") {
        HTML
    } else if ends_with(file, ".js") || ends_with(file, ".mjs") {
        JS
    } else if ends_with(file, ".css") {
        CSS
    } else if ends_with(file, ".wasm") {
        WASM
    } else if ends_with(file, ".webmanifest") {
        MANIFEST
    } else if ends_with(file, ".png") {
        PNG
    } else if ends_with(file, ".svg") {
        SVG
    } else {
        BIN
    }
}

/// `asset!("web/ 下的路径")`：对外地址为 `/assets/<路径>`
macro_rules! asset {
    ($file:literal) => {
        Asset { url: concat!("/assets/", $file), mime: mime_of($file), body: include_bytes!(concat!("../web/", $file)) }
    };
}

/// 单页应用外壳：所有页面地址（首页、歌曲 / MV / 专辑 / 歌单 / 艺人页、编辑页、资料库）都返回它，
/// 页面视图（`/assets/views/`）由前端路由（app.mjs）切换，播放条与歌词界面常驻，站内跳转时播放不中断
pub static APP_HTML: Asset = Asset { url: "/", mime: HTML, body: include_bytes!("../web/app.html") };

/// 全部页面资源，按 `web/` 的目录分组（各目录的职责见 docs/architecture.zh-CN.md）
pub static ASSETS: &[Asset] = &[
    // 外壳与全局服务：前端路由、导航底部的选择面板（主地区 / 曲库语言 / wrapper-lite）、界面文字、设置存储、
    // 资料库存储（浏览器 IndexedDB，服务端不保存任何资料库数据）、部署环境（serverless 部署由函数生成，见
    // serverless/core.mjs）、wrapper-lite 客户端（服务端转发或浏览器直连）、需要 media-user-token 的电台接口、
    // 专辑动态封面（editorialVideo 的 HLS）与 ALAC 检测（原样帧末尾缺陷、打包日期、实际位深与频宽，不请求 /key）
    asset!("app.css"),
    // 安装为应用（PWA）：manifest 与图标（由 favicon 的图形生成，maskable 为满版底色）
    asset!("manifest.webmanifest"),
    asset!("icons/icon.svg"),
    asset!("icons/icon-192.png"),
    asset!("icons/icon-512.png"),
    asset!("icons/icon-maskable-512.png"),
    asset!("app.mjs"),
    asset!("pickers.mjs"),
    asset!("i18n.js"),
    asset!("prefs.mjs"),
    // amp-api 请求与封面地址的公共工具
    asset!("amp.mjs"),
    asset!("library.mjs"),
    asset!("host.js"),
    asset!("wrapper.js"),
    asset!("station.mjs"),
    asset!("motion-art.mjs"),
    asset!("alac-check.mjs"),
    // 播放器（MSE / PCM / JOC 引擎、混音与队列）与歌曲之间的过渡（AutoMix / 交叉淡化）的规划
    asset!("player/player.js"),
    asset!("player/automix.js"),
    // 歌曲的浏览器端解密：主线程入口、Worker 与核心（crates/am-wasm 编译产物，见 scripts/build-wasm.sh）
    asset!("decrypt/decrypt.js"),
    asset!("decrypt/hook-worker.js"),
    asset!("decrypt/hook.wasm"),
    // MV、电台与歌曲下载共用的媒体 Worker：PlayReady / Widevine、CENC/CBCS 解密、合并与 defrag（crates/am-media-wasm 编译产物）
    asset!("media/media-worker.js"),
    asset!("media/media.wasm"),
    // ALAC 转 FLAC 播放（crates/am-flac-wasm），也为 ALAC 检测解码
    asset!("flac/transcode-worker.js"),
    asset!("flac/flac.wasm"),
    asset!("flac/init.bin"),
    // EC-3 解码为 PCM（@mediabunny/ac3，见 ec3/SOURCE.md）
    asset!("ec3/decode-worker.js"),
    asset!("ec3/runtime.mjs"),
    asset!("ec3/ec3.wasm"),
    // JOC 对象渲染（E-AC-3 Dolby Atmos -> Speaker 2.0 / 双耳）：Worker、渲染器（crates/joc-wasm 编译产物）、
    // 低延迟输出端（AudioWorklet）、双耳的声场界面（按需加载），以及双耳用的 HRTF 场
    // （约克大学 SADIE II 数据库，Apache-2.0，见 joc/NOTICE.md）
    asset!("joc/decode-worker.js"),
    asset!("joc/joc.wasm"),
    asset!("joc/output-worklet.js"),
    asset!("joc/scene.mjs"),
    asset!("joc/galaxy-buds.mjs"),
    asset!("joc/tracker-icons/buds-pro.png"),
    asset!("joc/tracker-icons/buds2-pro.png"),
    asset!("joc/tracker-icons/google-g.png"),
    asset!("joc/tracker-icons/NOTICE.md"),
    asset!("joc/tracker-icons/LICENSE.GalaxyBudsClient.txt"),
    asset!("joc/hrtf/D1.jochrtf"),
    asset!("joc/hrtf/D2.jochrtf"),
    asset!("joc/hrtf/H3.jochrtf"),
    asset!("joc/hrtf/H4.jochrtf"),
    asset!("joc/hrtf/H5.jochrtf"),
    asset!("joc/hrtf/H6.jochrtf"),
    asset!("joc/hrtf/H7.jochrtf"),
    asset!("joc/hrtf/H8.jochrtf"),
    asset!("joc/hrtf/H9.jochrtf"),
    asset!("joc/hrtf/H10.jochrtf"),
    asset!("joc/hrtf/H11.jochrtf"),
    asset!("joc/hrtf/H12.jochrtf"),
    asset!("joc/hrtf/H13.jochrtf"),
    asset!("joc/hrtf/H14.jochrtf"),
    asset!("joc/hrtf/H15.jochrtf"),
    asset!("joc/hrtf/H16.jochrtf"),
    asset!("joc/hrtf/H17.jochrtf"),
    asset!("joc/hrtf/H18.jochrtf"),
    asset!("joc/hrtf/H19.jochrtf"),
    asset!("joc/hrtf/H20.jochrtf"),
    // MV 播放器（播放列表与选轨、播放与下载、CEA-608 字幕），以及电台：直播电台与广播单集的 HLS 播放与下载
    asset!("mv/hls.mjs"),
    asset!("mv/engine.mjs"),
    asset!("mv/captions.mjs"),
    asset!("mv/cea608.mjs"),
    asset!("mv/style.css"),
    asset!("mv/radio.mjs"),
    // 批量下载（专辑 / 歌单 / 单曲）：下载管理器与下载中心、MP4 标签、ZIP 与文件名模板
    asset!("download/downloads.mjs"),
    asset!("download/center.mjs"),
    asset!("download/downloads.css"),
    asset!("download/mp4-tags.mjs"),
    asset!("download/zip.mjs"),
    asset!("download/naming.mjs"),
    // 动态封面下载（选清晰度、取分片、改写为普通 MP4）
    asset!("download/motion.mjs"),
    // 歌词界面：TTML 解析与转 LRC、接入播放器的 panel.mjs、打包好的 AMLL（见 vendor/amll）、封面动态背景
    // （backdrop*.mjs，移植自 YouLyPlus）、节拍律动，以及歌词字体库（数据只存在浏览器的 IndexedDB）与中文网字计划的字体目录
    asset!("lyrics/panel.mjs"),
    asset!("lyrics/ttml.mjs"),
    asset!("lyrics/lrc.mjs"),
    asset!("lyrics/amll-core.mjs"),
    asset!("lyrics/amll.css"),
    asset!("lyrics/backdrop.mjs"),
    asset!("lyrics/backdrop-render.mjs"),
    asset!("lyrics/backdrop-worker.mjs"),
    asset!("lyrics/pulse.mjs"),
    asset!("lyrics/fonts.mjs"),
    asset!("lyrics/font-catalog.mjs"),
    // 页面视图：`<name>.html` 为页面内容，`<name>.mjs` 为页面脚本（导出 mount，见 app.mjs），`<name>.css` 为页面样式
    asset!("views/home.html"),
    asset!("views/home.mjs"),
    // 首页的搜索结果与类别浏览，及首页 / 编辑页共用的链接解析
    asset!("views/search-results.mjs"),
    asset!("views/categories.mjs"),
    asset!("views/links.mjs"),
    asset!("views/song.html"),
    asset!("views/song.mjs"),
    asset!("views/song.css"),
    asset!("views/mv.html"),
    asset!("views/mv.mjs"),
    asset!("views/album.html"),
    asset!("views/album.mjs"),
    asset!("views/playlist.html"),
    asset!("views/playlist.mjs"),
    asset!("views/artist.html"),
    asset!("views/artist.mjs"),
    // 编辑页：新发现、广播、room、multi-room、grouping 与 curator 共用（与官网一样由 editorial-elements 区块组成）
    asset!("views/browse.html"),
    asset!("views/browse.mjs"),
    asset!("views/browse.css"),
    // 电台页：个人 / 编辑电台（接下来的几首）与直播电台、广播单集（MV 页的布局）
    asset!("views/station.html"),
    asset!("views/station.mjs"),
    asset!("views/station.css"),
    // 资料库（最近添加、艺人、专辑、歌曲、音乐视频、全部歌单）与本地歌单页
    asset!("views/library.html"),
    asset!("views/library.mjs"),
    asset!("views/library.css"),
    asset!("views/library-playlist.html"),
    asset!("views/library-playlist.mjs"),
    // 设置中心
    asset!("views/settings.html"),
    asset!("views/settings.mjs"),
    asset!("views/settings.css"),
    asset!("views/settings-fonts.mjs"),
    // 各页面共用的部件：条目操作（封面悬停按钮、「更多」菜单）、专辑 / 歌单页的头部（主题色、动态封面）、
    // 资料库的对话框与导入导出、专辑 / 歌单的下载对话框、ALAC 检测对话框、封面右键 / 长按菜单（保存静态与动态封面）
    asset!("views/actions.mjs"),
    asset!("views/artwork-menu.mjs"),
    asset!("views/detail-header.mjs"),
    asset!("views/library-ui.mjs"),
    asset!("views/download-dialog.mjs"),
    asset!("views/alac-check-dialog.mjs"),
];

/// 由部署环境生成的资源（二进制见 handlers::host_js_handler，serverless 部署见 serverless/core.mjs）：不加哈希，也不改写
pub const HOST_JS: &str = "/assets/host.js";
/// 内容哈希地址的前缀；其下的资源内容永不改变，可长期缓存（serverless 部署由 vercel.json / dist/_headers 设置）
pub const HASHED_PREFIX: &str = "/assets/h/";
const IMMUTABLE: &str = "public, max-age=31536000, immutable";

/// 实际对外提供的资源。每个资源有两个地址：
/// - 内容哈希地址（`/assets/h/views/home.<hash>.mjs`）：`immutable`，页面实际加载的都是它；
/// - 原地址：`no-cache` + ETag，供旧页面与外部直接访问。
///
/// 文本资源（HTML / JS / CSS）里对其他资源的引用（`/assets/...` 字面量与 `'./x.mjs'` 相对路径）
/// 都换成对方的哈希地址，哈希按换完后的内容计算：依赖变了，引用它的资源地址也随之改变，
/// 长期缓存的旧文件因此不会指向旧依赖。scripts/build-static.mjs 以同样的规则生成 serverless 部署的 dist/。
pub struct Served {
    pub url: String,
    mime: &'static str,
    body: Bytes,
    etag: String,
    immutable: bool,
    /// 压缩后的内容（同一内容的原地址与哈希地址共用）；不值得压缩的类型为 None
    encoded: Option<Arc<Encoded>>,
}

/// 按需计算、算一次的压缩结果；压缩后没有明显变小时为 None（照原样提供）
#[derive(Default)]
struct Encoded {
    br: OnceLock<Option<Bytes>>,
    gzip: OnceLock<Option<Bytes>>,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Coding {
    Br,
    Gzip,
}

impl Coding {
    fn name(self) -> &'static str {
        match self {
            Coding::Br => "br",
            Coding::Gzip => "gzip",
        }
    }
}

/// 值得压缩的类型：文本与 wasm（图片、HRTF 等二进制数据压缩收益很小）
fn compressible(mime: &str) -> bool {
    matches!(mime, HTML | JS | CSS | WASM | MANIFEST | SVG)
}

/// 至少省下 1/16 才用压缩版本
fn worth(original: usize, compressed: Vec<u8>) -> Option<Bytes> {
    (compressed.len() + original / 16 < original).then(|| Bytes::from(compressed))
}

fn compress(coding: Coding, body: &[u8]) -> Option<Bytes> {
    match coding {
        Coding::Br => {
            let mut out = Vec::with_capacity(body.len() / 3);
            {
                let mut writer = brotli::CompressorWriter::new(&mut out, 64 * 1024, 11, 22);
                writer.write_all(body).ok()?;
            }
            worth(body.len(), out)
        }
        Coding::Gzip => {
            let mut writer = flate2::write::GzEncoder::new(Vec::with_capacity(body.len() / 3), flate2::Compression::best());
            writer.write_all(body).ok()?;
            worth(body.len(), writer.finish().ok()?)
        }
    }
}

impl Served {
    /// 压缩后的内容（第一次调用时计算）；不压缩时为 None
    fn encoded(&self, coding: Coding) -> Option<&Bytes> {
        let encoded = self.encoded.as_ref()?;
        let cell = match coding {
            Coding::Br => &encoded.br,
            Coding::Gzip => &encoded.gzip,
        };
        cell.get_or_init(|| compress(coding, &self.body)).as_ref()
    }
}

/// 请求接受的压缩方式：优先 brotli，其次 gzip（`q=0` 视为不接受）
fn accepted(headers: &HeaderMap) -> Vec<Coding> {
    let mut codings = Vec::new();
    for value in headers.get_all(ACCEPT_ENCODING).iter().filter_map(|v| v.to_str().ok()) {
        for part in value.split(',') {
            let mut params = part.split(';');
            let name = params.next().unwrap_or_default().trim();
            let refused = params.any(|p| {
                let p = p.trim();
                p.strip_prefix("q=").is_some_and(|q| q.trim().parse::<f32>().is_ok_and(|q| q <= 0.0))
            });
            if refused {
                continue;
            }
            if name.eq_ignore_ascii_case("br") {
                codings.push(Coding::Br);
            } else if name.eq_ignore_ascii_case("gzip") {
                codings.push(Coding::Gzip);
            }
        }
    }
    codings.sort_by_key(|c| *c != Coding::Br);
    codings.dedup();
    codings
}

/// 启动后在后台线程把全部资源的压缩结果算好，第一次请求不必等待（brotli 11 级较慢）
pub fn warm() {
    std::thread::Builder::new()
        .name("asset-compress".into())
        .spawn(|| {
            // 原地址与哈希地址共用压缩结果，只算原地址的
            for asset in std::iter::once(&SITE.shell).chain(SITE.assets.iter().filter(|a| !a.immutable)) {
                asset.encoded(Coding::Br);
                asset.encoded(Coding::Gzip);
            }
        })
        .ok();
}

/// 页面外壳（引用已换成哈希地址，本身 `no-cache`）与全部资源路由
pub struct Site {
    pub shell: Served,
    pub assets: Vec<Served>,
}

pub static SITE: LazyLock<Site> = LazyLock::new(build);

/// FNV-1a 64：内容指纹（与 scripts/build-static.mjs 相同）
fn fnv(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, &b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3))
}

/// `/assets/views/home.mjs` → `/assets/h/views/home.<hash>.mjs`
fn hashed_url(url: &str, hash: u64) -> String {
    let rest = &url["/assets/".len()..];
    let name_at = rest.rfind('/').map_or(0, |i| i + 1);
    match rest[name_at..].rfind('.') {
        Some(dot) => format!("{HASHED_PREFIX}{}.{hash:016x}{}", &rest[..name_at + dot], &rest[name_at + dot..]),
        None => format!("{HASHED_PREFIX}{rest}.{hash:016x}"),
    }
}

/// 把相对路径按资源地址解析为站内绝对地址（只处理 `./` 与 `../`）
fn resolve(base: &str, relative: &str) -> String {
    let mut parts: Vec<&str> = base.split('/').collect();
    parts.pop();
    for part in relative.split('/') {
        match part {
            "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    parts.join("/")
}

/// 文本资源中引用其他资源的位置：(要替换的字节范围, 目标资源下标)
fn references(all: &[&Asset], index: &HashMap<&str, usize>, i: usize) -> Vec<(Range<usize>, usize)> {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"/assets/[A-Za-z0-9_./-]+|'(\.\.?/[A-Za-z0-9_./-]+)'|"(\.\.?/[A-Za-z0-9_./-]+)""#).unwrap()
    });
    let asset = all[i];
    let text = match asset.mime {
        HTML | JS | CSS | MANIFEST if asset.url != HOST_JS => std::str::from_utf8(asset.body).unwrap_or(""),
        _ => "",
    };
    RE.captures_iter(text)
        .filter_map(|c| {
            let (range, url) = match c.get(1).or(c.get(2)) {
                Some(relative) => (relative.range(), resolve(asset.url, relative.as_str())),
                None => (c.get(0)?.range(), c[0].to_string()),
            };
            let target = *index.get(url.as_str())?;
            (target != i && url != HOST_JS).then_some((range, target))
        })
        .collect()
}

fn served(url: String, mime: &'static str, body: Bytes, immutable: bool, encoded: Option<Arc<Encoded>>) -> Served {
    let etag = format!("{:016x}", fnv(&body));
    Served { url, mime, body, etag, immutable, encoded }
}

fn encoded_for(mime: &str) -> Option<Arc<Encoded>> {
    compressible(mime).then(|| Arc::new(Encoded::default()))
}

fn build() -> Site {
    let all: Vec<&Asset> = std::iter::once(&APP_HTML).chain(ASSETS).collect();
    let index: HashMap<&str, usize> = all.iter().enumerate().map(|(i, a)| (a.url, i)).collect();
    let refs: Vec<_> = (0..all.len()).map(|i| references(&all, &index, i)).collect();

    // 依赖在前的顺序（深度优先）；引用成环时无法按内容定哈希，直接报错
    fn visit(i: usize, refs: &[Vec<(Range<usize>, usize)>], state: &mut [u8], order: &mut Vec<usize>, all: &[&Asset]) {
        match state[i] {
            2 => return,
            1 => panic!("asset references form a cycle through {}", all[i].url),
            _ => {}
        }
        state[i] = 1;
        for &(_, target) in &refs[i] {
            visit(target, refs, state, order, all);
        }
        state[i] = 2;
        order.push(i);
    }
    let mut state = vec![0; all.len()];
    let mut order = Vec::with_capacity(all.len());
    for i in 0..all.len() {
        visit(i, &refs, &mut state, &mut order, &all);
    }

    let mut bodies: Vec<Bytes> = vec![Bytes::new(); all.len()];
    let mut hashed: Vec<String> = vec![String::new(); all.len()];
    for i in order {
        let source = all[i].body;
        bodies[i] = if refs[i].is_empty() {
            Bytes::from_static(source)
        } else {
            let mut body = Vec::with_capacity(source.len() + refs[i].len() * 24);
            let mut at = 0;
            for (range, target) in &refs[i] {
                body.extend_from_slice(&source[at..range.start]);
                body.extend_from_slice(hashed[*target].as_bytes());
                at = range.end;
            }
            body.extend_from_slice(&source[at..]);
            Bytes::from(body)
        };
        // 外壳（下标 0）与 host.js 不加哈希
        if i != 0 && all[i].url != HOST_JS {
            hashed[i] = hashed_url(all[i].url, fnv(&bodies[i]));
        }
    }

    let mut assets = Vec::with_capacity(all.len() * 2);
    for (i, asset) in all.iter().enumerate().skip(1) {
        let encoded = encoded_for(asset.mime);
        assets.push(served(asset.url.to_string(), asset.mime, bodies[i].clone(), false, encoded.clone()));
        if asset.url != HOST_JS {
            assets.push(served(std::mem::take(&mut hashed[i]), asset.mime, bodies[i].clone(), true, encoded));
        }
    }
    let shell = served(APP_HTML.url.to_string(), APP_HTML.mime, bodies[0].clone(), false, encoded_for(APP_HTML.mime));
    Site { shell, assets }
}

/// 内容哈希地址长期缓存（`immutable`）；其余以 `no-cache` + ETag 提供：每次使用前都向服务器确认（未变化时 304），
/// 升级后页面外壳立即指向新的哈希地址，页面、decrypt.js、Worker 与 wasm 不会因缓存而版本错配。
/// 压缩版本的 ETag 带上编码名（不同编码是不同的字节，不能共用一个强 ETag）。
pub fn serve(headers: &HeaderMap, asset: &Served) -> Response<Body> {
    let chosen = accepted(headers).into_iter().find_map(|coding| asset.encoded(coding).map(|body| (coding, body)));
    let (etag, body) = match chosen {
        Some((coding, body)) => (format!("\"{}-{}\"", asset.etag, coding.name()), body),
        None => (format!("\"{}\"", asset.etag), &asset.body),
    };
    let fresh = headers
        .get(IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|t| t.trim() == etag));
    let cache = if asset.immutable { IMMUTABLE } else { "no-cache" };
    let mut builder = Response::builder().header(CACHE_CONTROL, cache).header(ETAG, &etag);
    if asset.encoded.is_some() {
        builder = builder.header(VARY, "accept-encoding");
    }
    let response = if fresh {
        builder.status(StatusCode::NOT_MODIFIED).body(Body::empty())
    } else {
        if let Some((coding, _)) = chosen {
            builder = builder.header(CONTENT_ENCODING, coding.name());
        }
        builder.status(StatusCode::OK).header(CONTENT_TYPE, asset.mime).body(Body::from(body.clone()))
    };
    response.expect("static response headers are valid")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn urls_are_unique_and_under_assets() {
        let mut seen = HashSet::new();
        for asset in ASSETS {
            assert!(asset.url.starts_with("/assets/"), "{}", asset.url);
            assert!(seen.insert(asset.url), "duplicate route {}", asset.url);
            assert!(!asset.body.is_empty(), "{} is empty", asset.url);
        }
    }

    #[test]
    fn etag_revalidation() {
        let first = serve(&HeaderMap::new(), &SITE.shell);
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(first.headers()[CACHE_CONTROL], "no-cache");
        let etag = first.headers()[ETAG].clone();
        let mut headers = HeaderMap::new();
        headers.insert(IF_NONE_MATCH, etag);
        assert_eq!(serve(&headers, &SITE.shell).status(), StatusCode::NOT_MODIFIED);
    }

    #[test]
    fn compressed_variants() {
        use std::io::Read;
        let asset = SITE.assets.iter().find(|a| a.url == "/assets/app.css").unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT_ENCODING, "gzip, deflate, br, zstd".parse().unwrap());
        let response = serve(&headers, asset);
        assert_eq!(response.headers()[CONTENT_ENCODING], "br");
        assert_eq!(response.headers()[VARY], "accept-encoding");
        assert!(response.headers()[ETAG].to_str().unwrap().ends_with("-br\""));
        let br = asset.encoded(Coding::Br).unwrap();
        let mut plain = Vec::new();
        brotli::Decompressor::new(&br[..], 4096).read_to_end(&mut plain).unwrap();
        assert_eq!(plain, asset.body);
        let gz = asset.encoded(Coding::Gzip).unwrap();
        let mut plain = Vec::new();
        flate2::read::GzDecoder::new(&gz[..]).read_to_end(&mut plain).unwrap();
        assert_eq!(plain, asset.body);

        headers.insert(ACCEPT_ENCODING, "br;q=0, gzip".parse().unwrap());
        assert_eq!(serve(&headers, asset).headers()[CONTENT_ENCODING], "gzip");
        // 304 用的是对应编码的 ETag
        let etag = serve(&headers, asset).headers()[ETAG].clone();
        headers.insert(IF_NONE_MATCH, etag);
        assert_eq!(serve(&headers, asset).status(), StatusCode::NOT_MODIFIED);
        // 不接受压缩、或不压缩的类型（png）：原样
        let plain = serve(&HeaderMap::new(), asset);
        assert!(plain.headers().get(CONTENT_ENCODING).is_none());
        assert_eq!(accepted(&HeaderMap::new()), vec![]);
        assert!(!compressible(BIN) && !compressible(PNG));
    }

    #[test]
    fn hashed_urls() {
        assert_eq!(hashed_url("/assets/views/home.mjs", 0xab), "/assets/h/views/home.00000000000000ab.mjs");
        assert_eq!(hashed_url("/assets/app.css", 1), "/assets/h/app.0000000000000001.css");
        assert_eq!(resolve("/assets/views/album.mjs", "../download/downloads.mjs"), "/assets/download/downloads.mjs");
        assert_eq!(resolve("/assets/mv/engine.mjs", "./hls.mjs"), "/assets/mv/hls.mjs");

        let mut seen = HashSet::new();
        for asset in &SITE.assets {
            assert!(seen.insert(asset.url.as_str()), "duplicate route {}", asset.url);
            assert_eq!(asset.immutable, asset.url.starts_with(HASHED_PREFIX), "{}", asset.url);
            let response = serve(&HeaderMap::new(), asset);
            assert_eq!(response.headers()[CACHE_CONTROL], if asset.immutable { IMMUTABLE } else { "no-cache" });
        }
        // host.js 由部署环境生成，只有原地址；其余资源两个地址
        assert_eq!(SITE.assets.len(), ASSETS.len() * 2 - 1);
        assert!(!seen.iter().any(|url| url.starts_with(HASHED_PREFIX) && url.contains("/host.")));
    }

    #[test]
    fn mime_by_extension() {
        assert_eq!(mime_of("views/home.html"), HTML);
        assert_eq!(mime_of("player/player.js"), JS);
        assert_eq!(mime_of("mv/engine.mjs"), JS);
        assert_eq!(mime_of("mv/style.css"), CSS);
        assert_eq!(mime_of("decrypt/hook.wasm"), WASM);
        assert_eq!(mime_of("joc/hrtf/D1.jochrtf"), BIN);
        assert_eq!(mime_of("flac/init.bin"), BIN);
    }

    /// web/ 下的文件都要登记在 ASSETS 里（说明文档与许可证除外）：漏登记的文件在二进制与 serverless 部署里都是 404
    #[test]
    fn every_web_file_is_registered() {
        fn walk(dir: &std::path::Path, out: &mut Vec<String>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(&path, out);
                } else {
                    out.push(path.to_string_lossy().replace('\\', "/"));
                }
            }
        }
        let web = concat!(env!("CARGO_MANIFEST_DIR"), "/web");
        let mut files = Vec::new();
        walk(std::path::Path::new(web), &mut files);
        let urls: HashSet<&str> = ASSETS.iter().map(|a| a.url).collect();
        for file in files {
            let rel = &file[web.len() + 1..];
            if rel == "app.html" || rel.ends_with(".md") || rel.ends_with(".txt") {
                continue;
            }
            assert!(urls.contains(format!("/assets/{rel}").as_str()), "web/{rel} is not registered in ASSETS");
        }
    }

    /// 文本资源里的相对引用（`'./x.mjs'`、`"../y.css"`）都要指向登记过的资源：移动文件后漏改的 import 在这里失败，
    /// 而不是在浏览器里才 404
    #[test]
    fn relative_references_resolve() {
        let urls: HashSet<&str> = ASSETS.iter().map(|a| a.url).collect();
        let relative = Regex::new(r#"['"](\.\.?/[A-Za-z0-9_./-]+\.(?:mjs|js|css|html|wasm|bin|jochrtf))['"]"#).unwrap();
        for asset in std::iter::once(&APP_HTML).chain(ASSETS) {
            if ![HTML, JS, CSS].contains(&asset.mime) {
                continue;
            }
            let base = if asset.url == "/" { "/assets/app.html" } else { asset.url };
            for c in relative.captures_iter(std::str::from_utf8(asset.body).unwrap()) {
                let url = resolve(base, &c[1]);
                assert!(urls.contains(url.as_str()), "{}: {} -> {url} is not an asset", asset.url, &c[1]);
            }
        }
    }

    /// 页面加载的文本资源里不能留下未换成哈希地址的引用：同一模块经两个地址加载会得到两个实例
    /// （下载管理器、资料库等状态因此分裂），模板拼接的地址也无法替换
    #[test]
    fn every_reference_is_hashed() {
        let routes: HashSet<&str> = SITE.assets.iter().map(|a| a.url.as_str()).collect();
        let quoted = Regex::new(r#"['"`(](/assets/[^'"`)\s]*)"#).unwrap();
        let relative = Regex::new(r#"['"`](\.\.?/[^'"`\s]*)"#).unwrap();
        for asset in std::iter::once(&SITE.shell).chain(SITE.assets.iter().filter(|a| a.immutable)) {
            if ![HTML, JS, CSS].contains(&asset.mime) {
                continue;
            }
            let text = std::str::from_utf8(&asset.body).unwrap();
            for c in quoted.captures_iter(text) {
                let url = &c[1];
                assert!(url == HOST_JS || (url.starts_with(HASHED_PREFIX) && routes.contains(url)), "{}: {url}", asset.url);
            }
            for c in relative.captures_iter(text) {
                let base = ASSETS.iter().find(|a| asset.url == hashed_url(a.url, fnv(&asset.body))).map_or("/", |a| a.url);
                assert!(!routes.contains(resolve(base, &c[1]).as_str()), "{}: {}", asset.url, &c[1]);
            }
        }
    }

    /// serverless 部署（scripts/build-static.mjs）与二进制提供同样的哈希地址与内容；没有 node 时跳过
    #[test]
    fn build_static_matches() {
        let out = std::env::temp_dir().join(format!("am-hook-dist-{}", std::process::id()));
        let script = concat!(env!("CARGO_MANIFEST_DIR"), "/scripts/build-static.mjs");
        match std::process::Command::new("node").arg(script).arg(&out).output() {
            Ok(result) => assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr)),
            Err(_) => return eprintln!("node not found, skipping"),
        }
        for asset in &SITE.assets {
            if asset.url == HOST_JS {
                continue;
            }
            let built = std::fs::read(out.join(&asset.url[1..])).unwrap_or_else(|e| panic!("{}: {e}", asset.url));
            assert!(built == asset.body, "{} differs", asset.url);
        }
        assert!(std::fs::read(out.join("index.html")).unwrap() == SITE.shell.body);
        std::fs::remove_dir_all(&out).ok();
    }
}
