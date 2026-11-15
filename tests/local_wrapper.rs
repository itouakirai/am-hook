//! --local-wrapper-only: the server never relays wrapper-lite requests, and host.js tells the page
//! to use a browser-side (local) wrapper-lite with the operator's defaults and hint.
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use am_hook::state::{AppState, Config};
use axum::Router;

/// serverless 部署交给页面的版本号（serverless/core.mjs 的 VERSION）与二进制相同；发布时一起改
#[test]
fn serverless_version_matches_cargo() {
    let expected = format!("export const VERSION = '{}';", env!("CARGO_PKG_VERSION"));
    assert!(include_str!("../serverless/core.mjs").contains(&expected), "update serverless/core.mjs: {expected}");
}

async fn serve(app: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

fn config(wrapper_url: String, relay: bool) -> Config {
    Config {
        wrapper_url,
        amp_keepalive: Duration::ZERO,
        amp_cache_mb: 0,
        wrapper_rate: 5,
        wrapper_concurrency: 3,
        wrapper_auth: Some("Bearer operator-secret".into()),
        wrapper_relay: relay,
        wrapper_hint: Some("Get a token at https://token.test".into()),
        client_rate: 0,
        client_concurrency: 0,
        client_ip_header: None,
    }
}

#[tokio::test]
async fn local_wrapper_only_never_relays() {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let wrapper = serve(Router::new().fallback(move || {
        counter.fetch_add(1, Ordering::SeqCst);
        async { axum::Json(serde_json::json!({ "code": 0, "data": { "regions": ["us"] } })) }
    }))
    .await;

    let base = serve(am_hook::router(Arc::new(AppState::with_config(config(wrapper.clone(), false))))).await;
    let client = reqwest::Client::new();

    let host = client.get(format!("{base}/assets/host.js")).send().await.unwrap();
    assert_eq!(host.headers()["content-type"], "text/javascript; charset=utf-8");
    let text = host.text().await.unwrap();
    let json = text.strip_prefix("window.AM_HOOK_HOST = ").and_then(|s| s.strip_suffix(";\n")).unwrap();
    let value: serde_json::Value = serde_json::from_str(json).unwrap();
    assert_eq!(
        value,
        serde_json::json!({
            "serverWrapper": false,
            "version": env!("CARGO_PKG_VERSION"),
            "wrapper": { "url": wrapper, "rate": 5, "concurrency": 3 },
            "hint": "Get a token at https://token.test",
        })
    );
    assert!(!text.contains("operator-secret"), "--wrapper-auth is never sent to pages");

    for path in ["/status", "/key?adamId=1&uri=skd://x", "/lyrics/1", "/parse/song/1", "/parse/mv/1", "/mv/webplayback/1"] {
        let response = client.get(format!("{base}{path}")).send().await.unwrap();
        assert_eq!(response.status(), 501, "{path}");
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["code"], 1, "{path}");
    }
    let license = client.post(format!("{base}/mv/license")).json(&serde_json::json!({})).send().await.unwrap();
    assert_eq!(license.status(), 501);
    assert_eq!(calls.load(Ordering::SeqCst), 0, "wrapper-lite is never contacted");

    // 默认仍转发；host.js 不带本地模式默认值
    let relay = serve(am_hook::router(Arc::new(AppState::with_config(config(wrapper, true))))).await;
    let text = client.get(format!("{relay}/assets/host.js")).send().await.unwrap().text().await.unwrap();
    assert_eq!(
        text,
        format!("window.AM_HOOK_HOST = {{\"hint\":\"Get a token at https://token.test\",\"serverWrapper\":true,\"version\":\"{}\"}};\n", env!("CARGO_PKG_VERSION"))
    );
    assert_eq!(client.get(format!("{relay}/status")).send().await.unwrap().status(), 200);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
