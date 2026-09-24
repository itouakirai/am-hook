use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::Response;
use serde::Deserialize;
use serde_json::json;
use tracing::warn;

use crate::m3u8::{parse_master_variants, parse_song_link};
use crate::state::AppState;
use crate::wrapper::fetch_key_json;

#[derive(Deserialize)]
pub struct ParseRequest {
    pub url: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
}

pub async fn home_handler(headers: HeaderMap) -> Response<Body> {
    static_response(&headers, "text/html; charset=utf-8", include_bytes!("ui/home.html"))
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
    match fetch_key_json(&state.http_client, &state.config.wrapper_url, &query.adam_id, &query.uri).await {
        Ok(data) => Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, "application/json; charset=utf-8")
            .header(axum::http::header::CACHE_CONTROL, "private, max-age=3600")
            .body(Body::from(data))
            .unwrap_or_else(|error| internal_error(&format!("failed to build response: {error}"))),
        Err(error) => {
            warn!(adam_id = %query.adam_id, uri = %query.uri, %error, "Template fetch for browser failed");
            json_response(StatusCode::BAD_GATEWAY, json!({ "code": 1, "msg": error }))
        }
    }
}

pub async fn status_handler(State(state): State<Arc<AppState>>) -> Response<Body> {
    let wrapper_url = format!("{}/status", state.config.wrapper_url);
    let mut body = json!({
        "code": 1,
        "msg": "wrapper-lite unavailable",
        "regions": [],
        "wrapperUrl": state.config.wrapper_url,
        "hook": state.config.hook,
    });
    let mut status = StatusCode::BAD_GATEWAY;

    match state.http_client.get(&wrapper_url).send().await {
        Ok(resp) => {
            if let Ok(value) = resp.json::<serde_json::Value>().await {
                if value.get("code").and_then(serde_json::Value::as_i64) == Some(0) {
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
        Err(error) => warn!(error = %error, "wrapper-lite status request failed"),
    }

    json_response(status, body)
}

pub async fn parse_handler(
    State(_state): State<Arc<AppState>>,
    uri: Uri,
    headers: HeaderMap,
    form: axum::Form<ParseRequest>,
) -> Response<Body> {
    let Some(song_url) = form.url.as_deref().map(str::trim).filter(|v| !v.is_empty()) else {
        return bad_request("url is required");
    };

    let adam_id = match parse_song_link(song_url) {
        Ok(adam_id) => adam_id,
        Err(error) => return bad_request(&error),
    };

    let base_url = form
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .or_else(|| base_url_from_headers(&headers));
    let mut target = match base_url.as_deref().filter(|value| !value.is_empty()) {
        Some(base_url) => format!("{base_url}/parse/{adam_id}"),
        None => format!("/parse/{adam_id}"),
    };
    if let Some(query) = uri.query() {
        target.push('?');
        target.push_str(query);
    }

    match Response::builder()
        .status(StatusCode::SEE_OTHER)
        .header(axum::http::header::LOCATION, target)
        .body(Body::empty())
    {
        Ok(response) => response,
        Err(error) => internal_error(&format!("failed to build redirect: {error}")),
    }
}

pub async fn master_handler(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(adam_id): axum::extract::Path<String>,
) -> Response<Body> {
    if parse_song_link(&adam_id).is_err() && !adam_id.chars().all(|c| c.is_ascii_digit()) {
        return bad_request("Invalid song URL or adamId");
    }

    let wrapper_url = format!("{}/m3u8", state.config.wrapper_url);
    let response = state
        .http_client
        .get(&wrapper_url)
        .query(&[("adamId", adam_id.as_str())])
        .send()
        .await;

    let response = match response {
        Ok(response) => response,
        Err(error) => {
            warn!(error = %error, "wrapper-lite m3u8 request failed");
            return internal_error("failed to fetch master m3u8 from wrapper-lite");
        }
    };

    let payload = match response.json::<serde_json::Value>().await {
        Ok(value) => value,
        Err(error) => {
            warn!(error = %error, "failed to decode wrapper-lite response");
            return internal_error("invalid response from wrapper-lite");
        }
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
        Err(error) => {
            warn!(error = %error, url = %master_url, "failed to fetch master m3u8");
            return internal_error("failed to fetch master m3u8 from Apple");
        }
    };
    let master_body = match master_response.text().await {
        Ok(text) => text,
        Err(error) => {
            warn!(error = %error, "failed to read master m3u8 body");
            return internal_error("failed to read master m3u8");
        }
    };

    let variants = match parse_master_variants(&master_body) {
        Ok(variants) => variants,
        Err(error) => {
            warn!(error = %error, "failed to parse master m3u8");
            return internal_error(&error);
        }
    };

    json_response(
        StatusCode::OK,
        json!({
            "adamId": adam_id,
            "masterUrl": master_url,
            "variants": variants,
            // 为 true 时前端额外提供服务端解密地址（VLC / IDM / 原生 HLS）
            "hook": state.config.hook,
        }),
    )
}

pub async fn song_handler(uri: Uri, headers: &HeaderMap) -> Response<Body> {
    let path = uri.path();
    if parse_song_link(path.strip_prefix('/').unwrap_or(path)).is_err() {
        return bad_request("Only Apple Music song links are supported");
    }
    static_response(headers, "text/html; charset=utf-8", include_bytes!("ui/song.html"))
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
    json_response(
        StatusCode::BAD_REQUEST,
        json!({ "code": 1, "msg": message }),
    )
}

fn internal_error(message: &str) -> Response<Body> {
    json_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({ "code": 1, "msg": message }),
    )
}

fn base_url_from_headers(headers: &HeaderMap) -> Option<String> {
    let authority = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .or_else(|| headers.get("x-forwarded-host").and_then(|v| v.to_str().ok()))?;
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .unwrap_or("http");

    Some(format!("{scheme}://{authority}"))
}
