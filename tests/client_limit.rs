//! --client-rate / --client-ip-header: relayed wrapper-lite requests are limited per client IP,
//! /status is not counted, and requests over the limit never reach wrapper-lite.
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use am_hook::state::{AppState, Config};
use axum::Router;

fn config(wrapper_url: String, ip_header: Option<&str>) -> Config {
    Config {
        wrapper_url,
        amp_keepalive: Duration::ZERO,
        amp_cache_mb: 0,
        wrapper_rate: 0,
        wrapper_concurrency: 0,
        wrapper_auth: None,
        wrapper_relay: true,
        wrapper_hint: None,
        client_rate: 2,
        client_concurrency: 0,
        amp_only: false,
        amp_proxy: None,
        amp_client_rate: 0,
        amp_client_concurrency: 0,
        client_ip_header: ip_header.map(str::to_owned),
    }
}

/// 与 main.rs 相同，带上对端地址
async fn serve_app(state: AppState) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = am_hook::router(Arc::new(state)).into_make_service_with_connect_info::<SocketAddr>();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

/// 假的 wrapper-lite：记录收到的请求数
async fn fake_wrapper(calls: Arc<AtomicUsize>) -> String {
    let app = Router::new().fallback(move || {
        calls.fetch_add(1, Ordering::SeqCst);
        async { r#"{"code":0,"data":{"m3u8":"https://aod.itunes.apple.com/x.m3u8","regions":["us"]},"msg":"SUCCESS"}"# }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

#[tokio::test]
async fn relayed_requests_are_limited_per_client_ip() {
    let calls = Arc::new(AtomicUsize::new(0));
    let app = serve_app(AppState::with_config(config(fake_wrapper(calls.clone()).await, Some("x-real-ip")))).await;
    let client = reqwest::Client::new();
    let song = |ip: &str| client.get(format!("{app}/parse/song/1440833098")).header("x-real-ip", ip).send();

    assert_eq!(song("198.51.100.1").await.unwrap().status(), 200);
    assert_eq!(song("198.51.100.1").await.unwrap().status(), 200);
    let limited = song("198.51.100.1").await.unwrap();
    assert_eq!(limited.status(), 429);
    let retry_after: u64 = limited.headers()["retry-after"].to_str().unwrap().parse().unwrap();
    assert!((59..=60).contains(&retry_after), "{retry_after}");
    assert_eq!(calls.load(Ordering::SeqCst), 2, "the limited request did not reach wrapper-lite");

    // 其他 IP 不受影响；/status 不计入
    assert_eq!(song("198.51.100.2").await.unwrap().status(), 200);
    for _ in 0..3 {
        let status = client.get(format!("{app}/status")).header("x-real-ip", "198.51.100.1").send().await.unwrap();
        assert_eq!(status.status(), 200);
    }
}

/// /status 不计入按 IP 限流，改由共用缓存挡住：多少客户端、刷得多快都只请求一次 wrapper-lite
#[tokio::test]
async fn status_is_shared_across_clients() {
    let calls = Arc::new(AtomicUsize::new(0));
    let app = serve_app(AppState::with_config(config(fake_wrapper(calls.clone()).await, Some("x-real-ip")))).await;
    let client = reqwest::Client::new();
    let status = |i: usize| client.get(format!("{app}/status")).header("x-real-ip", format!("198.51.100.{i}")).send();

    let burst = futures::future::join_all((0..30).map(status)).await;
    for _ in 0..5 {
        assert_eq!(status(99).await.unwrap().status(), 200);
    }
    for response in burst {
        let body: serde_json::Value = response.unwrap().json().await.unwrap();
        assert_eq!(body["regions"], serde_json::json!(["us"]));
    }
    assert_eq!(calls.load(Ordering::SeqCst), 1, "one wrapper-lite /status for all clients");
}

/// --client-concurrency：同一 IP 超出的请求排队（不返回错误），其他 IP 不受影响
#[tokio::test]
async fn client_concurrency_queues_per_ip() {
    let active = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let (a, p) = (active.clone(), peak.clone());
    let wrapper = Router::new().fallback(move || {
        let (active, peak) = (a.clone(), p.clone());
        async move {
            peak.fetch_max(active.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(200)).await;
            active.fetch_sub(1, Ordering::SeqCst);
            r#"{"code":0,"data":{"m3u8":"https://aod.itunes.apple.com/x.m3u8"},"msg":"SUCCESS"}"#
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let wrapper_url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, wrapper).await.unwrap() });

    let mut config = config(wrapper_url, Some("x-real-ip"));
    config.client_rate = 0;
    config.client_concurrency = 1;
    let app = serve_app(AppState::with_config(config)).await;
    let client = reqwest::Client::new();
    let song = |ip: &'static str| client.get(format!("{app}/parse/song/1440833098")).header("x-real-ip", ip).send();

    // 同一 IP 的 3 个请求依次处理
    let start = std::time::Instant::now();
    let same = futures::future::join_all([song("198.51.100.1"), song("198.51.100.1"), song("198.51.100.1")]).await;
    assert!(same.iter().all(|r| r.as_ref().unwrap().status() == 200), "queued, not rejected");
    assert!(start.elapsed() >= Duration::from_millis(600));
    assert_eq!(peak.swap(0, Ordering::SeqCst), 1);

    // 不同 IP 同时处理
    let start = std::time::Instant::now();
    let different = futures::future::join_all([song("198.51.100.1"), song("198.51.100.2"), song("198.51.100.3")]).await;
    assert!(different.iter().all(|r| r.as_ref().unwrap().status() == 200));
    assert!(start.elapsed() < Duration::from_millis(500));
    assert_eq!(peak.load(Ordering::SeqCst), 3);
}

/// --amp-client-rate：amp-api 代理另有一套按 IP 的限额，与 wrapper-lite 的互不影响；/station/token 不计入。
/// 无效的地区在本地就返回 400（不请求 Apple），用来计数
#[tokio::test]
async fn amp_proxy_is_limited_per_client_ip() {
    let calls = Arc::new(AtomicUsize::new(0));
    let mut config = config(fake_wrapper(calls).await, Some("x-real-ip"));
    config.amp_client_rate = 2;
    let app = serve_app(AppState::with_config(config)).await;
    let client = reqwest::Client::new();
    let amp = |ip: &str| client.get(format!("{app}/amp/v1/recommendations/XX")).header("x-real-ip", ip).send();

    assert_eq!(amp("198.51.100.1").await.unwrap().status(), 400);
    assert_eq!(amp("198.51.100.1").await.unwrap().status(), 400);
    let limited = amp("198.51.100.1").await.unwrap();
    assert_eq!(limited.status(), 429);
    assert!(limited.headers().contains_key("retry-after"));
    assert_eq!(amp("198.51.100.2").await.unwrap().status(), 400, "other IPs unaffected");
    let token = client.delete(format!("{app}/station/token")).header("x-real-ip", "198.51.100.1").send().await.unwrap();
    assert_eq!(token.status(), 204, "/station/token not counted");
    // wrapper-lite 的限额独立计算
    let song = client.get(format!("{app}/parse/song/1440833098")).header("x-real-ip", "198.51.100.1").send().await.unwrap();
    assert_eq!(song.status(), 200);
}

#[tokio::test]
async fn without_ip_header_the_peer_address_is_used() {
    let calls = Arc::new(AtomicUsize::new(0));
    let app = serve_app(AppState::with_config(config(fake_wrapper(calls).await, None))).await;
    let client = reqwest::Client::new();
    // 没有配置 --client-ip-header 时，客户端传来的请求头不能绕过限制
    for (ip, expected) in [("198.51.100.1", 200), ("198.51.100.2", 200), ("198.51.100.3", 429)] {
        let response = client.get(format!("{app}/parse/song/1440833098")).header("x-real-ip", ip).send().await.unwrap();
        assert_eq!(response.status(), expected, "{ip}");
    }
}
