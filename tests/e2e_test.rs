//! 在线端到端测试默认忽略：cargo test --test e2e_test -- --ignored
//! 需要 wrapper-lite（默认 http://127.0.0.1:12340，可用 AM_HOOK_WRAPPER 覆盖）

use std::sync::Arc;

use axum::body::to_bytes;
use axum::http::StatusCode;
use axum::response::Response;

use am_hook::state::AppState;

fn new_state() -> Arc<AppState> {
    let wrapper = std::env::var("AM_HOOK_WRAPPER").unwrap_or_else(|_| "http://127.0.0.1:12340".into());
    Arc::new(AppState::new(wrapper))
}

async fn body(resp: Response) -> bytes::Bytes {
    to_bytes(resp.into_body(), usize::MAX).await.unwrap()
}

#[tokio::test]
#[ignore = "requires live wrapper-lite; run locally with --ignored"]
async fn test_lyrics_e2e() {
    // wrapper-lite /lyrics 的 TTML 原样返回；没有歌词的歌曲为 404，非法 ID 为 400
    use am_hook::ui::{lyrics_handler, LyricsQuery};
    use axum::extract::{Path, Query, State};
    // 不传 language：由 wrapper-lite 按歌曲所在地区的默认语言返回
    let no_language = || Query(LyricsQuery { language: None });
    let state = new_state();
    let resp = lyrics_handler(State(state.clone()), Path("6796864754".into()), no_language()).await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert!(resp.headers()["content-type"].to_str().unwrap().starts_with("application/ttml+xml"));
    let ttml = String::from_utf8(body(resp).await.to_vec()).unwrap();
    assert!(ttml.starts_with("<tt ") && ttml.contains("itunes:timing=\"Word\""));

    let resp = lyrics_handler(State(state.clone()), Path("1".into()), no_language()).await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    let resp = lyrics_handler(State(state), Path("abc".into()), no_language()).await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}
