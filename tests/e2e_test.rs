//! 端到端测试：需要能访问 Apple CDN 与 wrapper-lite（默认 http://127.0.0.1:12340，可用 AM_HOOK_WRAPPER 覆盖）

use std::sync::Arc;

use axum::body::to_bytes;
use axum::http::header::RANGE;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::Response;

use am_hook::proxy::handle_proxy;
use am_hook::state::AppState;

const BASE: &str = "https://aod.itunes.apple.com/itunes-assets/HLSMusic211/v4/b8/1f/88/b81f88d2-1aaa-9931-89e4-c85f62cc52dd";
const FILEURI: &str = "P1263211745_A1468058171_audio_en_gr2768_mp4a-A6_m.mp4";

fn new_state() -> Arc<AppState> {
    let wrapper = std::env::var("AM_HOOK_WRAPPER").unwrap_or_else(|_| "http://127.0.0.1:12340".into());
    let state = Arc::new(AppState::new(wrapper, 1800, 64));
    tokio::spawn(am_hook::monitor::run_background_monitor(state.clone()));
    state
}

async fn get(state: &Arc<AppState>, path: &str, range: Option<&str>) -> Response {
    let uri: Uri = format!("/{BASE}/{path}").parse().unwrap();
    let mut headers = HeaderMap::new();
    if let Some(r) = range {
        headers.insert(RANGE, format!("bytes={r}").parse().unwrap());
    }
    handle_proxy(axum::extract::State(state.clone()), Method::GET, uri, headers).await
}

async fn body(resp: Response) -> bytes::Bytes {
    to_bytes(resp.into_body(), usize::MAX).await.unwrap()
}

#[tokio::test]
async fn test_whitelist_rejection() {
    let state = new_state();
    let uri: Uri = "/https://evil.example.com/test.m3u8".parse().unwrap();
    let resp = handle_proxy(axum::extract::State(state), Method::GET, uri, HeaderMap::new()).await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn test_master_m3u8_e2e() {
    let state = new_state();
    let resp = get(&state, "P1263211745_default.m3u8", None).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let s = String::from_utf8(body(resp).await.to_vec()).unwrap();
    assert!(s.contains("#EXTM3U") && s.contains("#EXT-X-STREAM-INF"));
}

#[tokio::test]
async fn test_media_m3u8_and_file_e2e() {
    let state = new_state();

    let resp = get(&state, "P1263211745_A1468058171_audio_en_gr2768_mp4a-A6.m3u8?hook=byterange", None).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let m3u8 = String::from_utf8(body(resp).await.to_vec()).unwrap();
    assert!(m3u8.contains("#EXTM3U"));
    assert!(!m3u8.contains("#EXT-X-KEY"));
    assert!(m3u8.contains(FILEURI));

    // 默认是通用写法：无 EXT-X-MAP / BYTERANGE，每段独立 URL
    let compat = String::from_utf8(body(get(&state, "P1263211745_A1468058171_audio_en_gr2768_mp4a-A6.m3u8", None).await).await.to_vec()).unwrap();
    assert!(compat.contains("#EXT-X-VERSION:3"));
    assert!(!compat.contains("#EXT-X-MAP") && !compat.contains("#EXT-X-BYTERANGE") && !compat.contains("#EXT-X-KEY"));
    assert!(compat.contains(&FILEURI.replace("_m.mp4", "_m_seg1.mp4")));

    let track = state.get_track(FILEURI).unwrap();
    assert_eq!(track.adam_id, "1468058171");
    assert_eq!(track.uri, "skd://itunes.apple.com/p1263211745/c6");
    assert_eq!(track.range1, "1441673@1058");

    let init = body(get(&state, FILEURI, Some("0-1057")).await).await;
    assert_eq!(init.len(), 1058);
    assert!(!init.windows(4).any(|w| w == b"enca"));
    assert!(init.windows(4).any(|w| w == b"ec-3"));

    let resp = get(&state, FILEURI, Some("1058-1442730")).await;
    assert_eq!(resp.status(), StatusCode::PARTIAL_CONTENT);
    let frag1 = body(resp).await;
    assert_eq!(frag1.len(), 1441673);
    assert_eq!(&frag1[3977..3979], &[0x0B, 0x77]);
    assert!(!frag1.windows(4).any(|w| w == b"senc"));

    // frag2 使用 wrapper-lite 返回的轨道模板
    let frag2 = body(get(&state, FILEURI, Some("1442731-2884331")).await).await;
    assert_eq!(frag2.len(), 1441601);
    assert_eq!(&frag2[3905..3907], &[0x0B, 0x77]);
    assert!(!frag2.windows(4).any(|w| w == b"senc"));

    // 跨 segment 的任意 Range 必须与整文件对应位置一致
    let full = get(&state, FILEURI, None).await;
    assert_eq!(full.status(), StatusCode::OK);
    let full = body(full).await;
    assert_eq!(full.len() as u64, track.total_size);
    let cross = body(get(&state, FILEURI, Some("1442000-1443000")).await).await;
    assert_eq!(&cross[..], &full[1442000..=1443000]);

    // 独立分片 = init + 对应 frag
    let seg2 = FILEURI.replace("_m.mp4", "_m_seg2.mp4");
    let resp = get(&state, &seg2, None).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let seg = body(resp).await;
    assert_eq!(&seg[..1058], &init[..]);
    assert_eq!(&seg[1058..], &frag2[..]);
    let part = body(get(&state, &seg2, Some("1000-1100")).await).await;
    assert_eq!(&part[..], &seg[1000..=1100]);
    let resp = get(&state, &FILEURI.replace("_m.mp4", "_m_seg99999.mp4"), None).await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_media_file_without_m3u8_first() {
    // 直接请求 media file（IDM 场景），轨道由 m3u8 自动补齐；并发请求共享同一轨道
    let state = new_state();
    let (a, b) = tokio::join!(get(&state, FILEURI, Some("0-1057")), get(&state, FILEURI, Some("-100")));
    assert_eq!(a.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(b.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(body(b).await.len(), 100);
    assert!(state.get_track(FILEURI).is_some());
}
