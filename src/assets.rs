//! 内嵌的前端资源（`src/ui/`）。
//!
//! 新增页面资源只需要在 [`ASSETS`] 里加一行：路由由 [`router`](crate::router) 按表注册，
//! 不需要再写 handler。所有资源都以 `no-cache` + 内容 ETag 提供（见 [`serve`]）。

use axum::body::Body;
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, ETAG, IF_NONE_MATCH};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;

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
    // FLAC 转码与 EC-3 解码
    asset!("/assets/flac-transcode-worker.js", JS, "flac-transcode-worker.js"),
    asset!("/assets/flac.wasm", WASM, "flac.wasm"),
    asset!("/assets/flac-init.bin", BIN, "flac-init.bin"),
    asset!("/assets/ec3-decode-worker.js", JS, "ec3-decode-worker.js"),
    asset!("/assets/ec3-runtime.mjs", JS, "ec3-runtime.mjs"),
    asset!("/assets/ec3.wasm", WASM, "ec3.wasm"),
    // MV 播放器
    asset!("/assets/mv/hls.mjs", JS, "mv-hls.mjs"),
    asset!("/assets/mv/engine.mjs", JS, "mv-engine.mjs"),
    asset!("/assets/mv/captions.mjs", JS, "mv-captions.mjs"),
    asset!("/assets/mv/cea608.mjs", JS, "mv-cea608.mjs"),
    asset!("/assets/mv/style.css", CSS, "mv.css"),
    // 歌词界面：TTML 解析、接入播放器的 panel.mjs、打包好的 AMLL（见 browser/amll）与原来的封面背景（backdrop*.mjs）
    asset!("/assets/lyrics/panel.mjs", JS, "lyrics/panel.mjs"),
    asset!("/assets/lyrics/ttml.mjs", JS, "lyrics/ttml.mjs"),
    asset!("/assets/lyrics/amll-core.mjs", JS, "lyrics/amll-core.mjs"),
    asset!("/assets/lyrics/amll.css", CSS, "lyrics/amll.css"),
    asset!("/assets/lyrics/backdrop.mjs", JS, "lyrics/backdrop.mjs"),
    asset!("/assets/lyrics/backdrop-render.mjs", JS, "lyrics/backdrop-render.mjs"),
    asset!("/assets/lyrics/backdrop-worker.mjs", JS, "lyrics/backdrop-worker.mjs"),
    // 页面视图：`<name>.html` 为页面内容，`<name>.mjs` 为页面脚本（导出 mount，见 app.mjs）
    asset!("/assets/views/home.html", HTML, "views/home.html"),
    asset!("/assets/views/home.mjs", JS, "views/home.mjs"),
    asset!("/assets/views/song.html", HTML, "views/song.html"),
    asset!("/assets/views/song.mjs", JS, "views/song.mjs"),
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
];

/// 以 `no-cache` + 内容 ETag 提供资源：每次使用前都向服务器确认（未变化时 304），
/// 升级后页面、decrypt.js、Worker 与 wasm 不会因缓存而版本错配。
pub fn serve(headers: &HeaderMap, asset: &Asset) -> Response<Body> {
    // FNV-1a 64：内容指纹，资源最大只有几百 KB，逐请求计算的开销可以忽略
    let hash = asset.body.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, &b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3));
    let etag = format!("\"{hash:016x}\"");
    let fresh = headers
        .get(IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|t| t.trim() == etag));
    let builder = Response::builder().header(CACHE_CONTROL, "no-cache").header(ETAG, &etag);
    let response = if fresh {
        builder.status(StatusCode::NOT_MODIFIED).body(Body::empty())
    } else {
        builder.status(StatusCode::OK).header(CONTENT_TYPE, asset.mime).body(Body::from(asset.body))
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
        let first = serve(&HeaderMap::new(), &APP_HTML);
        assert_eq!(first.status(), StatusCode::OK);
        let etag = first.headers()[ETAG].clone();
        let mut headers = HeaderMap::new();
        headers.insert(IF_NONE_MATCH, etag);
        assert_eq!(serve(&headers, &APP_HTML).status(), StatusCode::NOT_MODIFIED);
    }
}
