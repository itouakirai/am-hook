use std::sync::Arc;
use std::time::Duration;

use tracing::{info, warn};

use crate::state::{AppState, Track};
use crate::wrapper::fetch_key_template;

/// adamId 与 uri 补齐后立即向 wrapper-lite 请求模板（去重，失败按退避重试）
pub fn ensure_template(state: &Arc<AppState>, track: &Arc<Track>) {
    if !track.begin_fetch() {
        return;
    }
    let state = state.clone();
    let track = track.clone();
    tokio::spawn(async move {
        match fetch_key_template(&state.http_client, &state.config.wrapper_url, &track.adam_id, &track.uri).await {
            Ok(tmpl) => {
                track.set_template(tmpl);
                track.end_fetch(true);
                info!(adam_id = %track.adam_id, fileuri = %track.fileuri, "Decryption template ready");
            }
            Err(e) => {
                let retry_in = track.end_fetch(false);
                warn!(adam_id = %track.adam_id, uri = %track.uri, error = %e, ?retry_in, "Template fetch failed");
            }
        }
    });
}

/// 全局监控：为缺模板的轨道补拉（含失败重试），并按 TTL 淘汰长期未访问的轨道。
/// 新轨道在创建时已立即触发拉取，这里只负责兜底，因此 1s 周期足够。
pub async fn run_background_monitor(state: Arc<AppState>) {
    let mut ticker = tokio::time::interval(Duration::from_secs(1));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        ticker.tick().await;
        for track in state.tracks() {
            ensure_template(&state, &track);
        }
        let evicted = state.evict_expired();
        if evicted > 0 {
            info!(evicted, "Evicted expired track contexts");
        }
    }
}
