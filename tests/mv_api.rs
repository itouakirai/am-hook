//! Offline checks for MV control-plane relays and server-side master fetching.
use am_hook::{state::AppState, ui};
use axum::{
    body::to_bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, Uri},
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
    let state = Arc::new(AppState::new(format!("http://{addr}")));
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
    // CDN resources are never proxied; decryption happens in the browser.
    for path in [
        "/https://mvod.itunes.apple.com/itunes-assets/test/segment.m4s",
        "/https://aod.itunes.apple.com/itunes-assets/test/P1_A2_audio_m.mp4",
    ] {
        let uri: Uri = path.parse().unwrap();
        assert_eq!(
            ui::fallback_handler(uri, HeaderMap::new()).await.status(),
            StatusCode::NOT_FOUND
        );
    }
    task.abort();
}

#[tokio::test]
async fn song_master_returns_only_the_wrapper_url() {
    // master m3u8 由浏览器获取并解析，服务端只转发 wrapper-lite /m3u8 的地址
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mock = Router::new().route(
        "/m3u8",
        get(|axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String, String>>| async move {
            match query["adamId"].as_str() {
                "1" => Json(json!({"code":0,"data":{"m3u8":"https://unreachable.invalid/P1_default.m3u8"}})),
                "2" => Json(json!({"code":0,"data":{}})),
                _ => Json(json!({"code":1,"msg":"not found"})),
            }
        }),
    );
    let task = tokio::spawn(async move { axum::serve(listener, mock).await.unwrap() });
    let state = Arc::new(AppState::new(format!("http://{addr}")));
    let response = ui::master_handler(State(state.clone()), Path("1".into())).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value = serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(body, json!({"code":0,"data":{"masterUrl":"https://unreachable.invalid/P1_default.m3u8"}}));
    for id in ["2", "3"] {
        let response = ui::master_handler(State(state.clone()), Path(id.into())).await;
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }
    assert_eq!(ui::master_handler(State(state), Path("abc".into())).await.status(), StatusCode::BAD_REQUEST);
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
    let state = Arc::new(AppState::new(format!("http://{addr}")));
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
    // 浏览器直连本地 wrapper-lite 时由页面传来 master 地址：只接受 Apple 的 HTTPS 地址
    for url in [
        format!("http://{addr}/redirect.m3u8"),
        "http://play.itunes.apple.com/master.m3u8".to_owned(),
        "https://example.com/master.m3u8".to_owned(),
        "https://apple.com.example.com/master.m3u8".to_owned(),
        "https://play.itunes.apple.com:8443/master.m3u8".to_owned(),
        // 只接受 .m3u8：看路径而不是整串（查询串里带 .m3u8 也不行）
        "https://play.itunes.apple.com/master.mp4".to_owned(),
        "https://play.itunes.apple.com/master.m3u8/x".to_owned(),
        "https://play.itunes.apple.com/master?f=.m3u8".to_owned(),
        "not a url".to_owned(),
    ] {
        let response = client
            .get(format!("http://{app_addr}/parse/mv-master"))
            .query(&[("url", url.as_str())])
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{url}");
    }
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

#[tokio::test]
async fn apple_client_does_not_follow_redirects_outside_apple() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mock = Router::new()
        .route("/redirect.m3u8", get(|| async { axum::response::Redirect::temporary("/cdn/master.m3u8") }))
        .route("/cdn/master.m3u8", get(|| async { "#EXTM3U\n" }));
    let upstream = tokio::spawn(async move {
        axum::serve(listener, mock).await.unwrap();
    });
    let state = AppState::new(format!("http://{addr}"));
    let url = format!("http://{addr}/redirect.m3u8");
    // 目标不是 apple.com 的 HTTPS 地址：停在 3xx，不跟随
    let response = state.apple_client.get(&url).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(response.url().as_str(), url);
    // 普通 client 照常跟随
    let response = state.http_client.get(&url).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.url().path(), "/cdn/master.m3u8");
    upstream.abort();
}
