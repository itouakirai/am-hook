//! 内嵌的前端资源（`src/ui/`）。
//!
//! 新增页面资源只需要在 [`ASSETS`] 里加一行：路由由 [`router`](crate::router) 按表注册，
//! 不需要再写 handler。页面加载的是带内容哈希的地址（长期缓存），原地址以 `no-cache` + 内容 ETag 提供（见 [`Served`]）。

use std::collections::HashMap;
use std::ops::Range;
use std::sync::LazyLock;

use axum::body::Body;
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, ETAG, IF_NONE_MATCH};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use bytes::Bytes;
use regex::Regex;

const HTML: &str = "text/html; charset=utf-8";
const JS: &str = "text/javascript; charset=utf-8";
const CSS: &str = "text/css; charset=utf-8";
const WASM: &str = "application/wasm";
const BIN: &str = "application/octet-stream";

/// 一个内嵌资源：对外地址、`Content-Type` 与编译进二进制的内容
pub struct Asset {
    pub url: &'static str,
    pub mime: &'static str,
    pub body: &'static [u8],
}

/// `asset!("/对外地址", MIME, "src/ui/ 下的文件")`
macro_rules! asset {
    ($url:literal, $mime:expr, $file:literal) => {
        Asset { url: $url, mime: $mime, body: include_bytes!(concat!("ui/", $file)) }
    };
}

/// 单页应用外壳：所有页面地址（首页、歌曲 / MV / 专辑 / 歌单 / 艺人页、编辑页、资料库）都返回它，
/// 页面视图（`/assets/views/`）由前端路由（app.mjs）切换，播放条与歌词界面常驻，站内跳转时播放不中断
pub static APP_HTML: Asset = asset!("/", HTML, "app.html");

pub static ASSETS: &[Asset] = &[
    // 前端路由、设置面板、资料库存储（浏览器 IndexedDB，服务端不保存任何资料库数据）与播放器
    asset!("/assets/app.css", CSS, "app.css"),
    asset!("/assets/app.mjs", JS, "app.mjs"),
    asset!("/assets/settings.mjs", JS, "settings.mjs"),
    asset!("/assets/library.mjs", JS, "library.mjs"),
    asset!("/assets/player.js", JS, "player.js"),
    // 歌曲之间的过渡（AutoMix / 交叉淡化）的规划，按 amp-api 的音频分析
    asset!("/assets/automix.js", JS, "automix.js"),
    asset!("/assets/i18n.js", JS, "i18n.js"),
    // 专辑动态封面播放（editorialVideo 的 HLS，MSE 播放）
    asset!("/assets/motion-art.mjs", JS, "motion-art.mjs"),
    // 部署环境（serverless 部署由函数生成，见 serverless/core.mjs）与 wrapper-lite 客户端：服务端转发或浏览器直连本地 wrapper-lite
    asset!("/assets/host.js", JS, "host.js"),
    asset!("/assets/wrapper.js", JS, "wrapper.js"),
    // 浏览器端解密：主线程入口、Worker 与核心（crates/am-wasm 编译产物，见 scripts/build-wasm.sh）
    asset!("/assets/decrypt.js", JS, "decrypt.js"),
    asset!("/assets/hook-worker.js", JS, "hook-worker.js"),
    asset!("/assets/hook.wasm", WASM, "hook.wasm"),
    // MV 与歌曲下载共用的媒体 Worker：PlayReady、CENC/CBCS 解密、合并与 defrag（crates/am-media-wasm 编译产物）
    asset!("/assets/media-worker.js", JS, "media-worker.js"),
    asset!("/assets/media.wasm", WASM, "media.wasm"),
    // 批量下载（专辑 / 歌单 / 单曲）：下载管理器与下载中心、设置存储、MP4 标签、ZIP、文件名模板与 TTML 转 LRC
    asset!("/assets/downloads.mjs", JS, "downloads.mjs"),
    asset!("/assets/download-center.mjs", JS, "download-center.mjs"),
    asset!("/assets/downloads.css", CSS, "downloads.css"),
    asset!("/assets/prefs.mjs", JS, "prefs.mjs"),
    asset!("/assets/mp4-tags.mjs", JS, "mp4-tags.mjs"),
    asset!("/assets/zip.mjs", JS, "zip.mjs"),
    asset!("/assets/naming.mjs", JS, "naming.mjs"),
    asset!("/assets/lrc.mjs", JS, "lrc.mjs"),
    // 专辑页的 ALAC 检测：原样帧末尾缺陷（只读 moof 与帧尾，不请求 /key）、打包日期，以及第一个分段的实际位深与频宽
    asset!("/assets/alac-check.mjs", JS, "alac-check.mjs"),
    // FLAC 转码与 EC-3 解码
    asset!("/assets/flac-transcode-worker.js", JS, "flac-transcode-worker.js"),
    asset!("/assets/flac.wasm", WASM, "flac.wasm"),
    asset!("/assets/flac-init.bin", BIN, "flac-init.bin"),
    asset!("/assets/ec3-decode-worker.js", JS, "ec3-decode-worker.js"),
    asset!("/assets/ec3-runtime.mjs", JS, "ec3-runtime.mjs"),
    asset!("/assets/ec3.wasm", WASM, "ec3.wasm"),
    // JOC 对象渲染（E-AC-3 Dolby Atmos -> Speaker 2.0 / 双耳）：Worker 与渲染器（crates/joc-wasm 编译产物），
    // 以及双耳用的 HRTF 场（约克大学 SADIE II 数据库，Apache-2.0，见 JOC-NOTICE.md）
    asset!("/assets/joc-decode-worker.js", JS, "joc-decode-worker.js"),
    asset!("/assets/joc.wasm", WASM, "joc.wasm"),
    asset!("/assets/joc-hrtf-D1.jochrtf", BIN, "joc-hrtf-D1.jochrtf"),
    asset!("/assets/joc-hrtf-D2.jochrtf", BIN, "joc-hrtf-D2.jochrtf"),
    asset!("/assets/joc-hrtf-H3.jochrtf", BIN, "joc-hrtf-H3.jochrtf"),
    asset!("/assets/joc-hrtf-H4.jochrtf", BIN, "joc-hrtf-H4.jochrtf"),
    asset!("/assets/joc-hrtf-H5.jochrtf", BIN, "joc-hrtf-H5.jochrtf"),
    asset!("/assets/joc-hrtf-H6.jochrtf", BIN, "joc-hrtf-H6.jochrtf"),
    asset!("/assets/joc-hrtf-H7.jochrtf", BIN, "joc-hrtf-H7.jochrtf"),
    asset!("/assets/joc-hrtf-H8.jochrtf", BIN, "joc-hrtf-H8.jochrtf"),
    asset!("/assets/joc-hrtf-H9.jochrtf", BIN, "joc-hrtf-H9.jochrtf"),
    asset!("/assets/joc-hrtf-H10.jochrtf", BIN, "joc-hrtf-H10.jochrtf"),
    asset!("/assets/joc-hrtf-H11.jochrtf", BIN, "joc-hrtf-H11.jochrtf"),
    asset!("/assets/joc-hrtf-H12.jochrtf", BIN, "joc-hrtf-H12.jochrtf"),
    asset!("/assets/joc-hrtf-H13.jochrtf", BIN, "joc-hrtf-H13.jochrtf"),
    asset!("/assets/joc-hrtf-H14.jochrtf", BIN, "joc-hrtf-H14.jochrtf"),
    asset!("/assets/joc-hrtf-H15.jochrtf", BIN, "joc-hrtf-H15.jochrtf"),
    asset!("/assets/joc-hrtf-H16.jochrtf", BIN, "joc-hrtf-H16.jochrtf"),
    asset!("/assets/joc-hrtf-H17.jochrtf", BIN, "joc-hrtf-H17.jochrtf"),
    asset!("/assets/joc-hrtf-H18.jochrtf", BIN, "joc-hrtf-H18.jochrtf"),
    asset!("/assets/joc-hrtf-H19.jochrtf", BIN, "joc-hrtf-H19.jochrtf"),
    asset!("/assets/joc-hrtf-H20.jochrtf", BIN, "joc-hrtf-H20.jochrtf"),
    // JOC 的低延迟播放输出端（AudioWorklet），与双耳的声场界面（虚拟头部、对象可视化与交互控制，按需加载）
    asset!("/assets/joc-output-worklet.js", JS, "joc-output-worklet.js"),
    asset!("/assets/joc-scene.mjs", JS, "joc-scene.mjs"),
    // MV 播放器
    asset!("/assets/mv/hls.mjs", JS, "mv-hls.mjs"),
    asset!("/assets/mv/engine.mjs", JS, "mv-engine.mjs"),
    asset!("/assets/mv/captions.mjs", JS, "mv-captions.mjs"),
    asset!("/assets/mv/cea608.mjs", JS, "mv-cea608.mjs"),
    asset!("/assets/mv/style.css", CSS, "mv.css"),
    // 电台：直播电台与广播单集的 HLS 播放与下载（与 MV 共用媒体 Worker），以及需要 media-user-token 的接口
    asset!("/assets/mv/radio.mjs", JS, "mv-radio.mjs"),
    asset!("/assets/station.mjs", JS, "station.mjs"),
    // 歌词界面：TTML 解析、接入播放器的 panel.mjs、打包好的 AMLL（见 browser/amll）与封面动态背景（backdrop*.mjs，移植自 YouLyPlus）
    asset!("/assets/lyrics/panel.mjs", JS, "lyrics/panel.mjs"),
    asset!("/assets/lyrics/ttml.mjs", JS, "lyrics/ttml.mjs"),
    asset!("/assets/lyrics/amll-core.mjs", JS, "lyrics/amll-core.mjs"),
    asset!("/assets/lyrics/amll.css", CSS, "lyrics/amll.css"),
    asset!("/assets/lyrics/backdrop.mjs", JS, "lyrics/backdrop.mjs"),
    asset!("/assets/lyrics/backdrop-render.mjs", JS, "lyrics/backdrop-render.mjs"),
    asset!("/assets/lyrics/backdrop-worker.mjs", JS, "lyrics/backdrop-worker.mjs"),
    asset!("/assets/lyrics/pulse.mjs", JS, "lyrics/pulse.mjs"),
    // 歌词字体：字体库（上传 / 网址 / 本机 / 中文网字计划，数据只存在浏览器的 IndexedDB）与中文网字计划的字体目录
    asset!("/assets/lyrics/fonts.mjs", JS, "lyrics/fonts.mjs"),
    asset!("/assets/lyrics/font-catalog.mjs", JS, "lyrics/font-catalog.mjs"),
    // 页面视图：`<name>.html` 为页面内容，`<name>.mjs` 为页面脚本（导出 mount，见 app.mjs）
    asset!("/assets/views/home.html", HTML, "views/home.html"),
    asset!("/assets/views/home.mjs", JS, "views/home.mjs"),
    asset!("/assets/views/song.html", HTML, "views/song.html"),
    asset!("/assets/views/song.mjs", JS, "views/song.mjs"),
    asset!("/assets/views/song.css", CSS, "views/song.css"),
    asset!("/assets/views/mv.html", HTML, "views/mv.html"),
    asset!("/assets/views/mv.mjs", JS, "views/mv.mjs"),
    asset!("/assets/views/album.html", HTML, "views/album.html"),
    asset!("/assets/views/album.mjs", JS, "views/album.mjs"),
    asset!("/assets/views/playlist.html", HTML, "views/playlist.html"),
    asset!("/assets/views/playlist.mjs", JS, "views/playlist.mjs"),
    asset!("/assets/views/artist.html", HTML, "views/artist.html"),
    asset!("/assets/views/artist.mjs", JS, "views/artist.mjs"),
    // 编辑页：新发现、room、multi-room、grouping 与 curator 共用（与官网一样由 editorial-elements 区块组成）
    asset!("/assets/views/browse.html", HTML, "views/browse.html"),
    asset!("/assets/views/browse.mjs", JS, "views/browse.mjs"),
    asset!("/assets/views/browse.css", CSS, "views/browse.css"),
    // 电台页：个人 / 编辑电台（接下来的几首）与直播电台、广播单集（MV 页的布局）
    asset!("/assets/views/station.html", HTML, "views/station.html"),
    asset!("/assets/views/station.mjs", JS, "views/station.mjs"),
    asset!("/assets/views/station.css", CSS, "views/station.css"),
    // 各页面共用的条目操作（封面悬停按钮、「更多」菜单）与专辑 / 歌单页共用的头部（主题色、动态封面）
    asset!("/assets/views/actions.mjs", JS, "views/actions.mjs"),
    asset!("/assets/views/detail-header.mjs", JS, "views/detail-header.mjs"),
    // 资料库（最近添加、艺人、专辑、歌曲、音乐视频、全部歌单）与本地歌单页
    asset!("/assets/views/library.html", HTML, "views/library.html"),
    asset!("/assets/views/library.mjs", JS, "views/library.mjs"),
    asset!("/assets/views/library.css", CSS, "views/library.css"),
    asset!("/assets/views/library-playlist.html", HTML, "views/library-playlist.html"),
    asset!("/assets/views/library-playlist.mjs", JS, "views/library-playlist.mjs"),
    // 资料库的对话框、歌单封面拼图、导入与导出（导航与各页面共用）
    asset!("/assets/views/library-ui.mjs", JS, "views/library-ui.mjs"),
    // 设置中心（下载设置等）与专辑 / 歌单页的下载对话框
    asset!("/assets/views/settings.html", HTML, "views/settings.html"),
    asset!("/assets/views/settings.mjs", JS, "views/settings.mjs"),
    asset!("/assets/views/settings.css", CSS, "views/settings.css"),
    asset!("/assets/views/settings-fonts.mjs", JS, "views/settings-fonts.mjs"),
    asset!("/assets/views/download-dialog.mjs", JS, "views/download-dialog.mjs"),
    // 专辑页的 ALAC 检测对话框（检测逻辑见 /assets/alac-check.mjs）
    asset!("/assets/views/alac-check-dialog.mjs", JS, "views/alac-check-dialog.mjs"),
];

/// 由部署环境生成的资源（二进制见 ui::host_js_handler，serverless 部署见 serverless/core.mjs）：不加哈希，也不改写
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
        HTML | JS | CSS if asset.url != HOST_JS => std::str::from_utf8(asset.body).unwrap_or(""),
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

fn served(url: String, mime: &'static str, body: Bytes, immutable: bool) -> Served {
    let etag = format!("\"{:016x}\"", fnv(&body));
    Served { url, mime, body, etag, immutable }
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
        assets.push(served(asset.url.to_string(), asset.mime, bodies[i].clone(), false));
        if asset.url != HOST_JS {
            assets.push(served(std::mem::take(&mut hashed[i]), asset.mime, bodies[i].clone(), true));
        }
    }
    let shell = served(APP_HTML.url.to_string(), APP_HTML.mime, bodies[0].clone(), false);
    Site { shell, assets }
}

/// 内容哈希地址长期缓存（`immutable`）；其余以 `no-cache` + ETag 提供：每次使用前都向服务器确认（未变化时 304），
/// 升级后页面外壳立即指向新的哈希地址，页面、decrypt.js、Worker 与 wasm 不会因缓存而版本错配。
pub fn serve(headers: &HeaderMap, asset: &Served) -> Response<Body> {
    let fresh = headers
        .get(IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|t| t.trim() == asset.etag));
    let cache = if asset.immutable { IMMUTABLE } else { "no-cache" };
    let builder = Response::builder().header(CACHE_CONTROL, cache).header(ETAG, &asset.etag);
    let response = if fresh {
        builder.status(StatusCode::NOT_MODIFIED).body(Body::empty())
    } else {
        builder.status(StatusCode::OK).header(CONTENT_TYPE, asset.mime).body(Body::from(asset.body.clone()))
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
    fn hashed_urls() {
        assert_eq!(hashed_url("/assets/views/home.mjs", 0xab), "/assets/h/views/home.00000000000000ab.mjs");
        assert_eq!(hashed_url("/assets/app.css", 1), "/assets/h/app.0000000000000001.css");
        assert_eq!(resolve("/assets/views/album.mjs", "../downloads.mjs"), "/assets/downloads.mjs");
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
