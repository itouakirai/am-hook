use std::sync::Arc;
use axum::body::to_bytes;
use axum::http::header::RANGE;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use am_hook::proxy::handle_proxy;
use am_hook::state::AppState;

const TEST_MASTER_URL: &str = "https://aod.itunes.apple.com/itunes-assets/HLSMusic211/v4/b8/1f/88/b81f88d2-1aaa-9931-89e4-c85f62cc52dd/P1263211745_default.m3u8";
const TEST_MEDIA_M3U8_URL: &str = "https://aod.itunes.apple.com/itunes-assets/HLSMusic211/v4/b8/1f/88/b81f88d2-1aaa-9931-89e4-c85f62cc52dd/P1263211745_A1468058171_audio_en_gr2768_mp4a-A6.m3u8";
const TEST_MEDIA_FILE_URL: &str = "https://aod.itunes.apple.com/itunes-assets/HLSMusic211/v4/b8/1f/88/b81f88d2-1aaa-9931-89e4-c85f62cc52dd/P1263211745_A1468058171_audio_en_gr2768_mp4a-A6_m.mp4";

#[tokio::test]
async fn test_whitelist_rejection() {
    let state = Arc::new(AppState::new("http://127.0.0.1:12340".into(), 1800, 64));
    let uri: Uri = "/https://evil.example.com/test.m3u8".parse().unwrap();
    let resp = handle_proxy(
        axum::extract::State(state),
        Method::GET,
        uri,
        HeaderMap::new(),
    ).await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn test_master_m3u8_e2e() {
    let state = Arc::new(AppState::new("http://127.0.0.1:12340".into(), 1800, 64));
    let uri: Uri = format!("/{}", TEST_MASTER_URL).parse().unwrap();
    let resp = handle_proxy(
        axum::extract::State(state),
        Method::GET,
        uri,
        HeaderMap::new(),
    ).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let s = String::from_utf8_lossy(&body);
    assert!(s.contains("#EXTM3U"));
    assert!(s.contains("#EXT-X-STREAM-INF"));
}

#[tokio::test]
async fn test_media_m3u8_and_file_e2e() {
    let state = Arc::new(AppState::new("http://192.168.31.105:3001".into(), 1800, 64));
    tokio::spawn(am_hook::monitor::run_background_monitor(state.clone()));

    let m3u8_uri: Uri = format!("/{}", TEST_MEDIA_M3U8_URL).parse().unwrap();
    let resp_m3u8 = handle_proxy(
        axum::extract::State(state.clone()),
        Method::GET,
        m3u8_uri,
        HeaderMap::new(),
    ).await;
    assert_eq!(resp_m3u8.status(), StatusCode::OK);
    let body_m3u8 = to_bytes(resp_m3u8.into_body(), usize::MAX).await.unwrap();
    let s_m3u8 = String::from_utf8_lossy(&body_m3u8);
    assert!(s_m3u8.contains("#EXTM3U"));
    assert!(!s_m3u8.contains("#EXT-X-KEY"));
    assert!(s_m3u8.contains("P1263211745_A1468058171_audio_en_gr2768_mp4a-A6_m.mp4"));

    let track = state.get_track("P1263211745_A1468058171_audio_en_gr2768_mp4a-A6_m.mp4").unwrap();
    assert_eq!(track.adam_id, "1468058171");
    assert_eq!(track.range1, "1441673@1058");

    let file_uri: Uri = format!("/{}", TEST_MEDIA_FILE_URL).parse().unwrap();
    let mut h_init = HeaderMap::new();
    h_init.insert(RANGE, "bytes=0-1057".parse().unwrap());
    let resp_init = handle_proxy(
        axum::extract::State(state.clone()),
        Method::GET,
        file_uri.clone(),
        h_init,
    ).await;
    assert_eq!(resp_init.status(), StatusCode::PARTIAL_CONTENT);
    let init_bytes = to_bytes(resp_init.into_body(), usize::MAX).await.unwrap();
    assert_eq!(init_bytes.len(), 1058);
    assert!(!init_bytes.windows(4).any(|w| w == b"enca"));
    assert!(init_bytes.windows(4).any(|w| w == b"ec-3"));

    let mut h_frag1 = HeaderMap::new();
    h_frag1.insert(RANGE, "bytes=1058-1442730".parse().unwrap());
    let resp_frag1 = handle_proxy(
        axum::extract::State(state.clone()),
        Method::GET,
        file_uri.clone(),
        h_frag1,
    ).await;
    assert_eq!(resp_frag1.status(), StatusCode::PARTIAL_CONTENT);
    let frag1_bytes = to_bytes(resp_frag1.into_body(), usize::MAX).await.unwrap();
    assert_eq!(frag1_bytes.len(), 1441673);
    assert_eq!(&frag1_bytes[3977..3979], &[0x0B, 0x77]);
    assert!(!frag1_bytes.windows(4).any(|w| w == b"senc"));

    // 4. 请求 Media file 的 Fragment 2 (需要用到 wrapper-lite 获取的 Track 模板)
    let mut h_frag2 = HeaderMap::new();
    h_frag2.insert(RANGE, "bytes=1442731-2884331".parse().unwrap());
    let resp_frag2 = handle_proxy(
        axum::extract::State(state.clone()),
        Method::GET,
        file_uri.clone(),
        h_frag2,
    ).await;
    assert_eq!(resp_frag2.status(), StatusCode::PARTIAL_CONTENT);
    let frag2_bytes = to_bytes(resp_frag2.into_body(), usize::MAX).await.unwrap();
    assert_eq!(frag2_bytes.len(), 1441601);
    // frag2 的 moof 长度通常为 3897，sample 0 起始于 3897 + 8 = 3905
    assert_eq!(&frag2_bytes[3905..3907], &[0x0B, 0x77]);
    assert!(!frag2_bytes.windows(4).any(|w| w == b"senc"));
}
