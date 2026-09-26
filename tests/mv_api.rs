//! Offline checks for MV control-plane relays and server-side master fetching.
use am_hook::{proxy, state::AppState, ui};
use axum::{
    body::to_bytes,
    extract::{Path, State},
    http::{HeaderMap, Method, StatusCode, Uri},
    routing::{get, post},
    Json, Router,
};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn forwards_mv_requests_without_fetching_media() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mock = Router::new()
        .route("/webplayback", get(|| async { Json(json!({"code":0,"data":{"m3u8":"https://unreachable.invalid/master.m3u8"}})) }))
        .route("/license", post(|Json(v): Json<serde_json::Value>| async move {
            assert_eq!(v, json!({"adamId":"1794822079","challenge":"YQ==","uri":"data:;base64,Yg==","drm-type":"pr"}));
            (StatusCode::FORBIDDEN, Json(json!({"code":403,"msg":"license denied"})))
        }));
    let task = tokio::spawn(async move {
        axum::serve(listener, mock).await.unwrap();
    });
    let state = Arc::new(AppState::new(format!("http://{addr}"), 60, 1));
    let response =
        ui::mv_webplayback_handler(State(state.clone()), Path("1794822079".into())).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    assert!(String::from_utf8_lossy(&body).contains("unreachable.invalid"));
    let request = serde_json::from_value(
        json!({"adamId":"1794822079","challenge":"YQ==","uri":"data:;base64,Yg==","drm-type":"pr"}),
    )
    .unwrap();
    let response = ui::mv_license_handler(State(state.clone()), Json(request)).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = ui::mv_webplayback_handler(State(state.clone()), Path("not-an-id".into())).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let request = serde_json::from_value(
        json!({"adamId":"1","challenge":"YQ==","uri":"data:;base64,Yg==","drm-type":"wv"}),
    )
    .unwrap();
    assert_eq!(
        ui::mv_license_handler(State(state.clone()), Json(request))
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    // AppState::new enables hook; video CDN resources must still be rejected.
    let uri: Uri = "/https://mvod.itunes.apple.com/itunes-assets/test/segment.m4s"
        .parse()
        .unwrap();
    assert_eq!(
        proxy::handle_proxy(State(state), Method::GET, uri, HeaderMap::new())
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    task.abort();
}

#[tokio::test]
async fn parses_mv_master_with_fixed_user_agent() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mock = Router::new()
        .route(
            "/webplayback",
            get(
                move |axum::extract::Query(query): axum::extract::Query<
                    std::collections::HashMap<String, String>,
                >| async move {
                    let path = match query["adamId"].as_str() {
                        "2" => "missing.m3u8",
                        "3" => return Json(json!({"code":1,"msg":"Unavailable MV"})),
                        "4" => return Json(json!({"code":0,"data":{}})),
                        _ => "redirect.m3u8",
                    };
                    Json(json!({"code":0,"data":{"m3u8":format!("http://{addr}/{path}")}}))
                },
            ),
        )
        .route(
            "/redirect.m3u8",
            get(|headers: HeaderMap| async move {
                assert_eq!(headers["user-agent"], "AM");
                axum::response::Redirect::temporary("/cdn/master.m3u8")
            }),
        )
        .route(
            "/cdn/master.m3u8",
            get(|headers: HeaderMap| async move {
                assert_eq!(headers["user-agent"], "AM");
                "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nvideo.m3u8\n"
            }),
        );
    let upstream = tokio::spawn(async move {
        axum::serve(listener, mock).await.unwrap();
    });
    let state = Arc::new(AppState::new(format!("http://{addr}"), 60, 1));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let app_addr = listener.local_addr().unwrap();
    let app = tokio::spawn(async move {
        axum::serve(listener, am_hook::router(state)).await.unwrap();
    });
    let client = reqwest::Client::new();
    let response = client
        .get(format!("http://{app_addr}/parse/mv/1"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["code"], 0);
    assert_eq!(
        body["data"]["masterUrl"],
        format!("http://{addr}/cdn/master.m3u8")
    );
    assert_eq!(
        body["data"]["masterBody"],
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nvideo.m3u8\n"
    );
    for (id, status) in [
        ("2", StatusCode::BAD_GATEWAY),
        ("3", StatusCode::BAD_GATEWAY),
        ("4", StatusCode::BAD_GATEWAY),
        ("invalid", StatusCode::BAD_REQUEST),
    ] {
        let response = client
            .get(format!("http://{app_addr}/parse/mv/{id}"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), status);
    }
    app.abort();
    upstream.abort();
}
