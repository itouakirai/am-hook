use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::Response;
use serde::Deserialize;
use serde_json::json;
use crate::{assets, log};
use crate::links::{
    is_charts_path, is_editorial_link, is_library_path, is_radio_path, is_settings_path, parse_album_link, parse_artist_link, parse_mv_link,
    parse_playlist_link, parse_post_link, parse_song_link, parse_station_link,
};
use crate::state::AppState;
use crate::wrapper::Lyrics;

/// 站内页面（首页、新发现与歌曲 / MV / 专辑 / 歌单 / 艺人页、编辑页）。与 music.apple.com 相同，整站是单页应用：
/// 所有页面地址都返回同一个外壳（[`assets::APP_HTML`]，资源引用已换成内容哈希地址）。目录数据由前端经 `/amp` 代理获取。
pub async fn app_handler(headers: HeaderMap) -> Response<Body> {
    assets::serve(&headers, &assets::SITE.shell)
}

/// 其余路径：Apple Music 页面路径本身也是 "https://..."（`/` 后拼接官网地址），
/// 歌曲 / MV / post / 专辑 / 歌单 / 艺人 / 电台页、编辑页、广播、资料库页与设置中心都返回单页应用，其他一律 404
pub async fn fallback_handler(uri: Uri, headers: HeaderMap) -> Response<Body> {
    let path = uri.path().strip_prefix('/').unwrap_or(uri.path());
    if parse_song_link(path).is_ok()
        || parse_mv_link(path).is_ok()
        || parse_post_link(path).is_ok()
        || parse_album_link(path).is_ok()
        || parse_playlist_link(path).is_ok()
        || parse_artist_link(path).is_ok()
        || parse_station_link(path).is_ok()
        || is_editorial_link(path)
        || is_charts_path(path)
        || is_library_path(path)
        || is_radio_path(path)
        || is_settings_path(path)
    {
        return app_handler(headers).await;
    }
    // no-store：不存在的内容哈希地址（/assets/h/...，旧页面请求已不存在的版本）也走到这里，
    // 404 被浏览器或 CDN 缓存的话，回滚到该版本后仍会用缓存的 404（与 serverless/core.mjs 的 notFound 相同）
    let response = Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(axum::http::header::CACHE_CONTROL, "no-store")
        .body(Body::from("Not found\n"))
        .unwrap();
    log::note(response, "not found")
}

/// 部署环境（window.AM_HOOK_HOST，见 src/ui/host.js）：服务端是否转发 wrapper-lite、不转发时页面本地模式的默认值，
/// 以及本地设置上方的提示。`--wrapper-auth` 只用于服务端转发，从不交给页面
pub async fn host_js_handler(State(state): State<Arc<AppState>>) -> Response<Body> {
    let config = &state.config;
    let mut host = json!({ "serverWrapper": config.wrapper_relay });
    if !config.wrapper_relay {
        host["wrapper"] = json!({
            "url": config.wrapper_url,
            "rate": config.wrapper_rate,
            "concurrency": config.wrapper_concurrency,
        });
    }
    if let Some(hint) = &config.wrapper_hint {
        host["hint"] = json!(hint);
    }
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "text/javascript; charset=utf-8")
        .header(axum::http::header::CACHE_CONTROL, "no-cache")
        .body(Body::from(format!("window.AM_HOOK_HOST = {host};\n")))
        .unwrap()
}

/// `--local-wrapper-only` 时转发 wrapper-lite 的接口一律返回 501（与 serverless 部署没有设置 AM_HOOK_WRAPPER_URL 时相同）
pub async fn require_relay(
    State(state): State<Arc<AppState>>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response<Body> {
    if state.config.wrapper_relay {
        return next.run(request).await;
    }
    let msg = "Server-side wrapper-lite relaying is disabled; use a local wrapper-lite (Settings > wrapper-lite)";
    let body = if request.uri().path() == "/status" {
        json!({ "code": 1, "msg": msg, "regions": [] })
    } else {
        json!({ "code": 1, "msg": msg })
    };
    log::note(json_response(StatusCode::NOT_IMPLEMENTED, body), "wrapper-lite relaying disabled")
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
    fetch_mv_master(&state.http_client, master_url).await
}

#[derive(Deserialize)]
pub struct MvMasterQuery {
    pub url: String,
}

/// 浏览器直连本地 wrapper-lite 时，MV master 地址由页面从 `/webplayback` 取得，仍交给服务端以 `User-Agent: AM` 获取
/// （浏览器无法改 User-Agent，否则可能返回没有 4K 的 master）。只接受 Apple 的 HTTPS 地址，免得被当作任意代理。
pub async fn mv_master_url_handler(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<MvMasterQuery>,
) -> Response<Body> {
    let apple = reqwest::Url::parse(&query.url)
        .ok()
        .is_some_and(|url| crate::state::is_apple_https(&url) && url.path().ends_with(".m3u8"));
    if !apple {
        return bad_request("Invalid MV master URL");
    }
    fetch_mv_master(&state.apple_client, &query.url).await
}

async fn fetch_mv_master(client: &reqwest::Client, master_url: &str) -> Response<Body> {
    let response = client.get(master_url)
        .header(axum::http::header::USER_AGENT, "AM")
        .timeout(std::time::Duration::from_secs(15))
        .send().await.and_then(reqwest::Response::error_for_status);
    let response = match response {
        // 重定向策略遇到非 apple.com 目标会停下并原样返回 3xx，按失败处理
        Ok(response) if response.status().is_redirection() => {
            let response = gateway_error("Failed to fetch MV master playlist");
            return log::note(response, "MV master redirected outside apple.com".to_string());
        }
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
    /// `pr` for PlayReady; absent for Widevine (wrapper-lite's default, used by AAC-LC songs)
    #[serde(rename = "drm-type", default, skip_serializing_if = "Option::is_none")]
    drm_type: Option<String>,
}

/// Relays a PlayReady (MV, `drm-type: pr`) or Widevine (AAC-LC songs without a master, no `drm-type`)
/// license request to wrapper-lite `/license`.
pub async fn mv_license_handler(
    State(state): State<Arc<AppState>>,
    axum::Json(body): axum::Json<MvLicenseRequest>,
) -> Response<Body> {
    if body.adam_id.is_empty()
        || body.adam_id.len() > 20
        || !body.adam_id.bytes().all(|b| b.is_ascii_digit())
        || body.drm_type.as_deref().is_some_and(|t| t != "pr")
        || body.challenge.is_empty()
        || body.challenge.len() > 256 * 1024
        || !body.uri.starts_with("data:")
        || body.uri.len() > 64 * 1024
    {
        return bad_request("Invalid license request");
    }
    mv_forward(&state, state.wrapper.post("/license").json(&body)).await
}

async fn mv_forward(state: &AppState, request: reqwest::RequestBuilder) -> Response<Body> {
    match state.wrapper.send(request.timeout(std::time::Duration::from_secs(15))).await {
        Ok(reply) => with_retry_after(
            Response::builder()
                .status(reply.status)
                .header(CONTENT_TYPE, "application/json")
                .header(axum::http::header::CACHE_CONTROL, "no-store")
                .body(Body::from(reply.body))
                .unwrap(),
            reply.retry_after,
        ),
        Err(error) => log::note(gateway_error("wrapper-lite request failed"), format!("wrapper-lite request failed: {error}")),
    }
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
/// 预取 key 的模板已内嵌在 wasm 中，不经过这里。
pub async fn key_handler(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<KeyQuery>,
) -> Response<Body> {
    if query.adam_id.is_empty() || !query.adam_id.chars().all(|c| c.is_ascii_digit()) {
        return bad_request("Invalid adamId");
    }
    if !query.uri.starts_with("skd://") || query.uri == am_mp4::PREFETCH_KEY_URI {
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

/// `/status` 的结果在所有客户端间共用这么久：页面定时轮询它，不计入按 IP 限流（见 limit.rs），
/// 缓存后不论有多少客户端、刷得多快，wrapper-lite 每个周期最多收到一次 `/status`
const STATUS_TTL: std::time::Duration = std::time::Duration::from_secs(10);

/// 最近一次 `/status` 的结果：取得时间、状态码、响应体与日志备注
#[derive(Default)]
pub struct StatusCache(tokio::sync::Mutex<Option<(tokio::time::Instant, StatusCode, serde_json::Value, String)>>);

pub async fn status_handler(State(state): State<Arc<AppState>>) -> Response<Body> {
    // 持锁请求上游：缓存过期时同时到达的请求等同一次结果
    let mut cached = state.status_cache.0.lock().await;
    if let Some((_, status, body, note)) = cached.as_ref().filter(|(at, ..)| at.elapsed() < STATUS_TTL) {
        return log::note(json_response(*status, body.clone()), format!("{note} · cached"));
    }

    let mut body = json!({
        "code": 1,
        "msg": "wrapper-lite unavailable",
        "regions": [],
        "wrapperUrl": state.config.wrapper_url,
    });
    let mut status = StatusCode::BAD_GATEWAY;
    let mut note = String::from("wrapper-lite unavailable");

    match state.wrapper.send(state.wrapper.get("/status").timeout(std::time::Duration::from_secs(10))).await {
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

    *cached = Some((tokio::time::Instant::now(), status, body.clone(), note.clone()));
    log::note(json_response(status, body), note)
}

/// 歌曲 master m3u8 的地址（wrapper-lite `/m3u8`）。master 由浏览器从 Apple CDN 获取并解析（wrapper.js）
pub async fn master_handler(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(adam_id): axum::extract::Path<String>,
) -> Response<Body> {
    if parse_song_link(&adam_id).is_err() && !adam_id.chars().all(|c| c.is_ascii_digit()) {
        return bad_request("Invalid song URL or adamId");
    }

    let request = state.wrapper.get("/m3u8").query(&[("adamId", adam_id.as_str())]).timeout(std::time::Duration::from_secs(15));
    let reply = state.wrapper.send(request).await;
    let reply = match reply {
        Ok(reply) => reply,
        Err(error) => return upstream_error("failed to fetch master m3u8 from wrapper-lite", error),
    };

    // 限流原样转给浏览器（429 + Retry-After），浏览器据此暂停批量下载；否则会被下面当作无效响应变成 500，看不出是限流
    if reply.status == StatusCode::TOO_MANY_REQUESTS {
        let response = json_response(StatusCode::TOO_MANY_REQUESTS, json!({ "code": 1, "msg": "wrapper-lite rate limited (HTTP 429)" }));
        return log::note(with_retry_after(response, reply.retry_after), "wrapper-lite HTTP 429");
    }

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

    let Some(master_url) = payload.pointer("/data/m3u8").and_then(serde_json::Value::as_str).filter(|url| !url.is_empty()) else {
        return internal_error("wrapper-lite returned no master m3u8 URL");
    };
    json_response(StatusCode::OK, json!({ "code": 0, "data": { "masterUrl": master_url } }))
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
/// 带上 wrapper-lite 给出的 `Retry-After`（限流时），浏览器据此退避
fn with_retry_after(mut response: Response<Body>, retry_after: Option<axum::http::HeaderValue>) -> Response<Body> {
    if let Some(value) = retry_after {
        response.headers_mut().insert(axum::http::header::RETRY_AFTER, value);
    }
    response
}

fn upstream_error(message: &str, error: impl std::fmt::Display) -> Response<Body> {
    log::note(internal_error(message), format!("{message}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn not_found_is_not_cached() {
        // 旧版本的内容哈希地址与其他未知路径：404 不能被浏览器或 CDN 缓存
        for path in ["/assets/h/app.0000000000000000.mjs", "/assets/h/x.0000000000000000.js", "/nope"] {
            let response = fallback_handler(path.parse().unwrap(), HeaderMap::new()).await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
            assert_eq!(response.headers()[axum::http::header::CACHE_CONTROL], "no-store", "{path}");
        }
        // 页面地址仍返回外壳
        for path in ["/library/songs", "/radio", "/https://music.apple.com/us/station/apple-music-1/ra.978194965"] {
            let page = fallback_handler(path.parse().unwrap(), HeaderMap::new()).await;
            assert_eq!(page.status(), StatusCode::OK, "{path}");
        }
    }
}
