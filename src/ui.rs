use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::Response;
use serde::Deserialize;
use serde_json::json;
use crate::log;
use crate::m3u8::{
    is_charts_path, is_editorial_link, is_library_path, parse_album_link, parse_artist_link, parse_master_variants, parse_mv_link,
    parse_playlist_link, parse_post_link, parse_song_link,
};
use crate::state::AppState;
use crate::wrapper::Lyrics;

/// 站内页面（首页、新发现与歌曲 / MV / 专辑 / 歌单 / 艺人页、编辑页）。与 music.apple.com 相同，整站是单页应用：
/// 所有页面地址都返回 app.html，页面视图（/assets/views/）由前端路由（app.mjs）切换，
/// 播放条与歌词界面常驻，站内跳转时播放不中断。目录数据由前端经 `/amp` 代理获取。
pub async fn app_handler(headers: HeaderMap) -> Response<Body> {
    static_response(&headers, "text/html; charset=utf-8", include_bytes!("ui/app.html"))
}

/// 其余路径：Apple Music 页面路径本身也是 "https://..."（`/` 后拼接官网地址），
/// 歌曲 / MV / post / 专辑 / 歌单 / 艺人页、编辑页与资料库页都返回单页应用，其他一律 404
pub async fn fallback_handler(uri: Uri, headers: HeaderMap) -> Response<Body> {
    let path = uri.path().strip_prefix('/').unwrap_or(uri.path());
    if parse_song_link(path).is_ok()
        || parse_mv_link(path).is_ok()
        || parse_post_link(path).is_ok()
        || parse_album_link(path).is_ok()
        || parse_playlist_link(path).is_ok()
        || parse_artist_link(path).is_ok()
        || is_editorial_link(path)
        || is_charts_path(path)
        || is_library_path(path)
    {
        return app_handler(headers).await;
    }
    let response = Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from("Not found\n"))
        .unwrap();
    log::note(response, "not found")
}

/// 前端路由
pub async fn app_js_handler(headers: HeaderMap) -> Response<Body> {
    static_response(&headers, "text/javascript; charset=utf-8", include_bytes!("ui/app.mjs"))
}

/// 主地区与曲库语言的选择面板
pub async fn settings_js_handler(headers: HeaderMap) -> Response<Body> {
    static_response(&headers, "text/javascript; charset=utf-8", include_bytes!("ui/settings.mjs"))
}

/// 资料库与歌单的存储（浏览器 IndexedDB，服务端不保存任何资料库数据）
pub async fn library_js_handler(headers: HeaderMap) -> Response<Body> {
    static_response(&headers, "text/javascript; charset=utf-8", include_bytes!("ui/library.mjs"))
}

/// 页面视图（src/ui/views/）：`<name>.html` 为页面内容，`<name>.mjs` 为页面脚本（导出 mount，见 app.mjs）
pub async fn view_asset_handler(
    headers: HeaderMap,
    axum::extract::Path(file): axum::extract::Path<String>,
) -> Response<Body> {
    const JS: &str = "text/javascript; charset=utf-8";
    const HTML: &str = "text/html; charset=utf-8";
    let (content_type, body): (&'static str, &'static [u8]) = match file.as_str() {
        "home.html" => (HTML, include_bytes!("ui/views/home.html")),
        "home.mjs" => (JS, include_bytes!("ui/views/home.mjs")),
        "song.html" => (HTML, include_bytes!("ui/views/song.html")),
        "song.mjs" => (JS, include_bytes!("ui/views/song.mjs")),
        "mv.html" => (HTML, include_bytes!("ui/views/mv.html")),
        "mv.mjs" => (JS, include_bytes!("ui/views/mv.mjs")),
        "album.html" => (HTML, include_bytes!("ui/views/album.html")),
        "album.mjs" => (JS, include_bytes!("ui/views/album.mjs")),
        "playlist.html" => (HTML, include_bytes!("ui/views/playlist.html")),
        "playlist.mjs" => (JS, include_bytes!("ui/views/playlist.mjs")),
        "artist.html" => (HTML, include_bytes!("ui/views/artist.html")),
        "artist.mjs" => (JS, include_bytes!("ui/views/artist.mjs")),
        // 编辑页：新发现、room、multi-room、grouping 与 curator 共用（与官网一样由 editorial-elements 区块组成）
        "browse.html" => (HTML, include_bytes!("ui/views/browse.html")),
        "browse.mjs" => (JS, include_bytes!("ui/views/browse.mjs")),
        "browse.css" => ("text/css; charset=utf-8", include_bytes!("ui/views/browse.css")),
        // 各页面共用的条目操作（封面悬停按钮、「更多」菜单）
        "actions.mjs" => (JS, include_bytes!("ui/views/actions.mjs")),
        // 专辑页与歌单页共用的头部（主题色、动态封面）
        "detail-header.mjs" => (JS, include_bytes!("ui/views/detail-header.mjs")),
        // 资料库（最近添加、艺人、专辑、歌曲、音乐视频、全部歌单）与本地歌单页
        "library.html" => (HTML, include_bytes!("ui/views/library.html")),
        "library.mjs" => (JS, include_bytes!("ui/views/library.mjs")),
        "library.css" => ("text/css; charset=utf-8", include_bytes!("ui/views/library.css")),
        "library-playlist.html" => (HTML, include_bytes!("ui/views/library-playlist.html")),
        "library-playlist.mjs" => (JS, include_bytes!("ui/views/library-playlist.mjs")),
        // 资料库的对话框、歌单封面拼图、导入与导出（导航与各页面共用）
        "library-ui.mjs" => (JS, include_bytes!("ui/views/library-ui.mjs")),
        _ => return json_response(StatusCode::NOT_FOUND, json!({ "code": 1, "msg": "Not found" })),
    };
    static_response(&headers, content_type, body)
}

/// 专辑动态封面播放（editorialVideo 的 HLS，MSE 播放）
pub async fn motion_art_handler(headers: HeaderMap) -> Response<Body> {
    static_response(&headers, "text/javascript; charset=utf-8", include_bytes!("ui/motion-art.mjs"))
}

pub async fn mv_asset_handler(
    headers: HeaderMap,
    axum::extract::Path(file): axum::extract::Path<String>,
) -> Response<Body> {
    let (mime, body): (&str, &[u8]) = match file.as_str() {
        "hls.mjs" => ("text/javascript", include_bytes!("ui/mv-hls.mjs")),
        "engine.mjs" => ("text/javascript", include_bytes!("ui/mv-engine.mjs")),
        "captions.mjs" => ("text/javascript", include_bytes!("ui/mv-captions.mjs")),
        "cea608.mjs" => ("text/javascript", include_bytes!("ui/mv-cea608.mjs")),
        "style.css" => ("text/css", include_bytes!("ui/mv.css")),
        _ => return bad_request("Unknown MV asset"),
    };
    static_response(&headers, mime, body)
}

/// Relay the original wrapper-lite webplayback response.
pub async fn mv_webplayback_handler(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response<Body> {
    if id.is_empty() || id.len() > 20 || !id.bytes().all(|b| b.is_ascii_digit()) {
        return bad_request("Invalid adamId");
    }
    mv_forward(&state, state.wrapper.get("/webplayback").query(&[("adamId", id)])).await
}

/// Fetch the MV master on the server so its User-Agent is not controlled by the browser.
pub async fn mv_master_handler(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response<Body> {
    let response = mv_webplayback_handler(State(state.clone()), axum::extract::Path(id)).await;
    if !response.status().is_success() {
        return response;
    }
    let payload = match axum::body::to_bytes(response.into_body(), 1024 * 1024).await {
        Ok(body) => serde_json::from_slice::<serde_json::Value>(&body).ok(),
        Err(_) => None,
    };
    let Some(payload) = payload else {
        return gateway_error("Invalid wrapper-lite response");
    };
    if payload.get("code").and_then(serde_json::Value::as_i64) != Some(0) {
        let msg = payload.get("msg").and_then(serde_json::Value::as_str).unwrap_or("wrapper-lite returned an error").to_owned();
        return log::note(json_response(StatusCode::BAD_GATEWAY, payload), msg);
    }
    let Some(master_url) = payload.pointer("/data/m3u8").and_then(serde_json::Value::as_str).filter(|url| !url.is_empty()) else {
        return gateway_error("Missing MV master URL");
    };
    let response = state.http_client.get(master_url)
        .header(axum::http::header::USER_AGENT, "AM")
        .timeout(std::time::Duration::from_secs(30))
        .send().await.and_then(reqwest::Response::error_for_status);
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            let response = gateway_error("Failed to fetch MV master playlist");
            return log::note(response, format!("Failed to fetch MV master playlist: {error}"));
        }
    };
    // Resolve relative track URLs against the final CDN URL after any redirects.
    let master_url = response.url().to_string();
    let master_body = match response.text().await {
        Ok(body) => body,
        Err(_) => return gateway_error("Failed to read MV master playlist"),
    };
    let mut response = json_response(StatusCode::OK, json!({
        "code": 0, "data": { "masterUrl": master_url, "masterBody": master_body }
    }));
    response.headers_mut().insert(axum::http::header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

#[derive(Deserialize, serde::Serialize)]
pub struct MvLicenseRequest {
    #[serde(rename = "adamId")]
    adam_id: String,
    challenge: String,
    uri: String,
    #[serde(rename = "drm-type")]
    drm_type: String,
}

pub async fn mv_license_handler(
    State(state): State<Arc<AppState>>,
    axum::Json(body): axum::Json<MvLicenseRequest>,
) -> Response<Body> {
    if body.adam_id.is_empty()
        || body.adam_id.len() > 20
        || !body.adam_id.bytes().all(|b| b.is_ascii_digit())
        || body.drm_type != "pr"
        || body.challenge.is_empty()
        || body.challenge.len() > 256 * 1024
        || !body.uri.starts_with("data:")
        || body.uri.len() > 64 * 1024
    {
        return bad_request("Invalid PlayReady license request");
    }
    mv_forward(&state, state.wrapper.post("/license").json(&body)).await
}

async fn mv_forward(state: &AppState, request: reqwest::RequestBuilder) -> Response<Body> {
    match state.wrapper.send(request.timeout(std::time::Duration::from_secs(30))).await {
        Ok(reply) => Response::builder()
            .status(reply.status)
            .header(CONTENT_TYPE, "application/json")
            .header(axum::http::header::CACHE_CONTROL, "no-store")
            .body(Body::from(reply.body))
            .unwrap(),
        Err(error) => log::note(gateway_error("wrapper-lite request failed"), format!("wrapper-lite request failed: {error}")),
    }
}

pub async fn css_handler(headers: HeaderMap) -> Response<Body> {
    static_response(&headers, "text/css; charset=utf-8", include_bytes!("ui/app.css"))
}

pub async fn player_js_handler(headers: HeaderMap) -> Response<Body> {
    static_response(&headers, "text/javascript; charset=utf-8", include_bytes!("ui/player.js"))
}

pub async fn i18n_js_handler(headers: HeaderMap) -> Response<Body> {
    static_response(&headers, "text/javascript; charset=utf-8", include_bytes!("ui/i18n.js"))
}

pub async fn decrypt_js_handler(headers: HeaderMap) -> Response<Body> {
    static_response(&headers, "text/javascript; charset=utf-8", include_bytes!("ui/decrypt.js"))
}

pub async fn worker_js_handler(headers: HeaderMap) -> Response<Body> {
    static_response(&headers, "text/javascript; charset=utf-8", include_bytes!("ui/hook-worker.js"))
}

pub async fn flac_worker_handler(headers: HeaderMap) -> Response<Body> {
    static_response(&headers, "text/javascript; charset=utf-8", include_bytes!("ui/flac-transcode-worker.js"))
}

pub async fn flac_wasm_handler(headers: HeaderMap) -> Response<Body> {
    static_response(&headers, "application/wasm", include_bytes!("ui/flac.wasm"))
}

pub async fn flac_init_handler(headers: HeaderMap) -> Response<Body> {
    static_response(&headers, "application/octet-stream", include_bytes!("ui/flac-init.bin"))
}

pub async fn ec3_worker_handler(headers: HeaderMap) -> Response<Body> {
    static_response(&headers, "text/javascript; charset=utf-8", include_bytes!("ui/ec3-decode-worker.js"))
}

pub async fn ec3_runtime_handler(headers: HeaderMap) -> Response<Body> {
    static_response(&headers, "text/javascript; charset=utf-8", include_bytes!("ui/ec3-runtime.mjs"))
}

pub async fn ec3_wasm_handler(headers: HeaderMap) -> Response<Body> {
    static_response(&headers, "application/wasm", include_bytes!("ui/ec3.wasm"))
}

/// 浏览器端解密核心（crates/am-wasm 编译产物，见 scripts/build-wasm.sh）
pub async fn wasm_handler(headers: HeaderMap) -> Response<Body> {
    static_response(&headers, "application/wasm", include_bytes!("ui/hook.wasm"))
}

/// MV 与歌曲下载共用的媒体 Worker：PlayReady、CENC/CBCS 解密、合并与 defrag
pub async fn media_worker_handler(headers: HeaderMap) -> Response<Body> {
    static_response(&headers, "text/javascript; charset=utf-8", include_bytes!("ui/media-worker.js"))
}

/// 媒体核心（crates/am-media-wasm 编译产物，见 scripts/build-wasm.sh）
pub async fn media_wasm_handler(headers: HeaderMap) -> Response<Body> {
    static_response(&headers, "application/wasm", include_bytes!("ui/media.wasm"))
}

/// 歌词界面（src/ui/lyrics/）：TTML 解析、接入播放器的 panel.mjs、打包好的 AMLL（见 browser/amll）与原来的封面背景（backdrop*.mjs）
pub async fn lyrics_asset_handler(
    headers: HeaderMap,
    axum::extract::Path(file): axum::extract::Path<String>,
) -> Response<Body> {
    const JS: &str = "text/javascript; charset=utf-8";
    let (content_type, body): (&'static str, &'static [u8]) = match file.as_str() {
        "panel.mjs" => (JS, include_bytes!("ui/lyrics/panel.mjs")),
        "ttml.mjs" => (JS, include_bytes!("ui/lyrics/ttml.mjs")),
        "amll-core.mjs" => (JS, include_bytes!("ui/lyrics/amll-core.mjs")),
        "amll.css" => ("text/css; charset=utf-8", include_bytes!("ui/lyrics/amll.css")),
        "backdrop.mjs" => (JS, include_bytes!("ui/lyrics/backdrop.mjs")),
        "backdrop-render.mjs" => (JS, include_bytes!("ui/lyrics/backdrop-render.mjs")),
        "backdrop-worker.mjs" => (JS, include_bytes!("ui/lyrics/backdrop-worker.mjs")),
        _ => return json_response(StatusCode::NOT_FOUND, json!({ "code": 1, "msg": "Not found" })),
    };
    static_response(&headers, content_type, body)
}

#[derive(Deserialize)]
pub struct LyricsQuery {
    /// 歌曲所在地区的默认语言（BCP 47，如 `zh-Hans-CN`），转发给 wrapper-lite
    pub language: Option<String>,
}

/// 歌曲的 TTML 歌词：向 wrapper-lite `/lyrics` 获取后原样返回 XML。没有歌词时返回 404。
pub async fn lyrics_handler(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(adam_id): axum::extract::Path<String>,
    axum::extract::Query(query): axum::extract::Query<LyricsQuery>,
) -> Response<Body> {
    if adam_id.is_empty() || !adam_id.chars().all(|c| c.is_ascii_digit()) {
        return bad_request("Invalid adamId");
    }
    let language = query.language.as_deref().filter(|l| !l.is_empty());
    if language.is_some_and(|l| l.len() > 35 || !l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')) {
        return bad_request("Invalid language");
    }
    match state.wrapper.fetch_lyrics(&adam_id, language).await {
        Ok(Lyrics::Found(ttml)) => Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, "application/ttml+xml; charset=utf-8")
            .header(axum::http::header::CACHE_CONTROL, "private, max-age=3600")
            .body(Body::from(ttml))
            .unwrap_or_else(|error| internal_error(&format!("failed to build response: {error}"))),
        Ok(Lyrics::NotFound) => log::note(
            json_response(StatusCode::NOT_FOUND, json!({ "code": 1, "msg": "lyrics not found" })),
            "no lyrics",
        ),
        Err(error) => gateway_error(&error),
    }
}

#[derive(Deserialize)]
pub struct KeyQuery {
    #[serde(rename = "adamId")]
    pub adam_id: String,
    pub uri: String,
}

/// 浏览器端解密所需的轨道模板：转发 wrapper-lite `/key` 返回的 `data`。
/// 固定 key 的模板已内嵌在 wasm 中，不经过这里。
pub async fn key_handler(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<KeyQuery>,
) -> Response<Body> {
    if query.adam_id.is_empty() || !query.adam_id.chars().all(|c| c.is_ascii_digit()) {
        return bad_request("Invalid adamId");
    }
    if !query.uri.starts_with("skd://") || query.uri == am_mp4::FIXED_KEY_URI {
        return bad_request("Invalid key uri");
    }
    match state.wrapper.fetch_key_json(&query.adam_id, &query.uri).await {
        Ok(data) => Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, "application/json; charset=utf-8")
            .header(axum::http::header::CACHE_CONTROL, "private, max-age=3600")
            .body(Body::from(data))
            .unwrap_or_else(|error| internal_error(&format!("failed to build response: {error}"))),
        Err(error) => gateway_error(&error),
    }
}

pub async fn status_handler(State(state): State<Arc<AppState>>) -> Response<Body> {
    let mut body = json!({
        "code": 1,
        "msg": "wrapper-lite unavailable",
        "regions": [],
        "wrapperUrl": state.config.wrapper_url,
    });
    let mut status = StatusCode::BAD_GATEWAY;
    let mut note = String::from("wrapper-lite unavailable");

    match state.wrapper.send(state.wrapper.get("/status")).await {
        Ok(reply) => {
            if let Ok(value) = reply.json::<serde_json::Value>() {
                if value.get("code").and_then(serde_json::Value::as_i64) == Some(0) {
                    note = format!("regions {}", log::regions_summary(&value));
                    status = StatusCode::OK;
                    body["code"] = json!(0);
                    body["msg"] = value
                        .get("msg")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("SUCCESS")
                        .into();
                    body["regions"] = value
                        .pointer("/data/regions")
                        .cloned()
                        .unwrap_or_else(|| json!([]));
                }
            }
        }
        Err(error) => note = format!("wrapper-lite request failed: {error}"),
    }

    log::note(json_response(status, body), note)
}

pub async fn master_handler(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(adam_id): axum::extract::Path<String>,
) -> Response<Body> {
    if parse_song_link(&adam_id).is_err() && !adam_id.chars().all(|c| c.is_ascii_digit()) {
        return bad_request("Invalid song URL or adamId");
    }

    let reply = state.wrapper.send(state.wrapper.get("/m3u8").query(&[("adamId", adam_id.as_str())])).await;
    let reply = match reply {
        Ok(reply) => reply,
        Err(error) => return upstream_error("failed to fetch master m3u8 from wrapper-lite", error),
    };

    let payload = match reply.json::<serde_json::Value>() {
        Ok(value) => value,
        Err(error) => return upstream_error("invalid response from wrapper-lite", error),
    };

    if payload.get("code").and_then(serde_json::Value::as_i64) != Some(0) {
        let msg = payload
            .get("msg")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("wrapper-lite returned an error");
        return internal_error(msg);
    }

    let master_url = payload
        .pointer("/data/m3u8")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let master_response = state.http_client.get(master_url).send().await;
    let master_response = match master_response {
        Ok(response) => response,
        Err(error) => return upstream_error("failed to fetch master m3u8 from Apple", error),
    };
    let master_body = match master_response.text().await {
        Ok(text) => text,
        Err(error) => return upstream_error("failed to read master m3u8", error),
    };

    let variants = match parse_master_variants(&master_body) {
        Ok(variants) => variants,
        Err(error) => return internal_error(&error),
    };

    let mut codecs: Vec<&str> = variants.iter().filter_map(|v| v.codecs.as_deref()).collect();
    codecs.sort_unstable();
    codecs.dedup();
    let note = format!("{} variants ({})", variants.len(), codecs.join(", "));
    let response = json_response(
        StatusCode::OK,
        json!({
            "adamId": adam_id,
            "masterUrl": master_url,
            "variants": variants,
        }),
    );
    log::note(response, note)
}

/// 内嵌静态资源：`no-cache` + 内容 ETag。每次使用前都向服务器确认（未变化时 304），
/// 升级后页面、decrypt.js、Worker 与 wasm 不会因缓存而版本错配。
fn static_response(headers: &HeaderMap, content_type: &'static str, body: &'static [u8]) -> Response<Body> {
    // FNV-1a 64：内容指纹，资源最大只有几百 KB，逐请求计算的开销可以忽略
    let hash = body.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, &b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3));
    let etag = format!("\"{hash:016x}\"");
    let fresh = headers
        .get(axum::http::header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|t| t.trim() == etag));
    let builder = Response::builder()
        .header(axum::http::header::CACHE_CONTROL, "no-cache")
        .header(axum::http::header::ETAG, &etag);
    let response = if fresh {
        builder.status(StatusCode::NOT_MODIFIED).body(Body::empty())
    } else {
        builder.status(StatusCode::OK).header(CONTENT_TYPE, content_type).body(Body::from(body))
    };
    response.unwrap_or_else(|error| internal_error(&format!("failed to build response: {error}")))
}

fn json_response(status: StatusCode, value: serde_json::Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json; charset=utf-8")
        .body(Body::from(value.to_string()))
        .unwrap_or_else(|error| internal_error(&format!("failed to build response: {error}")))
}

fn bad_request(message: &str) -> Response<Body> {
    log::note(json_response(StatusCode::BAD_REQUEST, json!({ "code": 1, "msg": message })), message)
}

fn internal_error(message: &str) -> Response<Body> {
    log::note(json_response(StatusCode::INTERNAL_SERVER_ERROR, json!({ "code": 1, "msg": message })), message)
}

fn gateway_error(message: &str) -> Response<Body> {
    log::note(json_response(StatusCode::BAD_GATEWAY, json!({ "code": 1, "msg": message })), message)
}

/// 上游请求失败：响应只带概要，请求日志中附上具体原因
fn upstream_error(message: &str, error: impl std::fmt::Display) -> Response<Body> {
    log::note(internal_error(message), format!("{message}: {error}"))
}
