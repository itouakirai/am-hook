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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_song_link() {
        assert_eq!(
            parse_song_link("https://music.apple.com/us/song/%E9%A3%9E%E8%88%9E/1797679527").unwrap(),
            "1797679527"
        );
        assert_eq!(
            parse_song_link("https://music.apple.com/us/song/name/123?l=zh-CN").unwrap(),
            "123"
        );
        assert!(parse_song_link("https://music.apple.com/us/album/name/123").is_err());
        assert!(parse_song_link("http://music.apple.com/us/song/name/123").is_err());
    }

    #[test]
    fn test_parse_master_variants() {
        let content = r#"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-alac",NAME="songEnhanced",SAMPLE-RATE=44100
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=1,CODECS="alac",AUDIO="audio-alac"
P100_A123_audio_alac.m3u8
"#;
        let variants = parse_master_variants(content).unwrap();
        assert_eq!(variants.len(), 1);
        assert_eq!(variants[0].uri, "P100_A123_audio_alac.m3u8");
        assert_eq!(variants[0].file_uri, "P100_A123_audio_alac_m.mp4");
        assert_eq!(variants[0].group_id, "audio-alac");
        assert_eq!(variants[0].audio, "songEnhanced");
    }
}

#[derive(Deserialize)]
pub struct ParseRequest {
    pub url: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
}

pub async fn home_handler() -> Response<Body> {
    html_response(include_str!("ui/home.html").to_string())
}

pub async fn status_handler(State(state): State<Arc<AppState>>) -> Response<Body> {
    let wrapper_url = format!("{}/status", state.wrapper_url.trim_end_matches('/'));
    let mut body = json!({
        "code": 1,
        "msg": "wrapper-lite unavailable",
        "regions": [],
        "wrapperUrl": state.wrapper_url,
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

    let wrapper_url = format!("{}/m3u8", state.wrapper_url.trim_end_matches('/'));
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
        }),
    )
}

pub async fn song_handler(uri: Uri) -> Response<Body> {
    let path = uri.path();
    if parse_song_link(path.strip_prefix('/').unwrap_or(path)).is_err() {
        return bad_request("Only Apple Music song links are supported");
    }
    html_response(include_str!("ui/song.html").to_string())
}

fn html_response(html: String) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "text/html; charset=utf-8")
        .body(Body::from(html))
        .unwrap_or_else(|error| internal_error(&format!("failed to build response: {error}")))
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
