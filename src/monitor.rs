use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tracing::{info, warn};
use crate::state::{AppState, TrackContext};
use crate::wrapper::fetch_key_template;

/// 触发针对指定 TrackContext 的模板异步拉取（通过 is_fetching 防重）
pub fn trigger_template_fetch(state: &Arc<AppState>, track: &Arc<TrackContext>) {
    if track.adam_id.is_empty() || track.uri.is_empty() || track.get_template().is_some() {
        return;
    }
    if track.is_fetching.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return;
    }

    let client = state.http_client.clone();
    let wrapper_url = state.wrapper_url.clone();
    let track_clone = track.clone();

    tokio::spawn(async move {
        match fetch_key_template(&client, &wrapper_url, &track_clone.adam_id, &track_clone.uri).await {
            Ok((raw_json, tmpl)) => {
                info!(
                    adam_id = %track_clone.adam_id,
                    fileuri = %track_clone.fileuri,
                    "Successfully fetched and cached decryption template from wrapper-lite"
                );
                track_clone.set_template(raw_json, tmpl);
                track_clone.is_fetching.store(false, Ordering::SeqCst);
            }
            Err(e) => {
                warn!(
                    adam_id = %track_clone.adam_id,
                    uri = %track_clone.uri,
                    error = %e,
                    "Background template fetch failed"
                );
                track_clone.is_fetching.store(false, Ordering::SeqCst);
            }
        }
    });
}

/// 全局独立运行的监控函数：
/// 1. 实时监控所有结构体，当 adamId 和 uri 非空且未获取模板时，调用 wrapper-lite 获取模板补齐。
/// 2. 检查结构体上次访问时间，超过 cache_ttl 则自动淘汰清理，避免内存泄漏。
pub async fn run_background_monitor(state: Arc<AppState>) {
    let mut ticker = tokio::time::interval(Duration::from_millis(200));
    loop {
        ticker.tick().await;

        // 1. 扫描待补齐模板的结构体
        let pending_fetches: Vec<_> = {
            let map = state.tracks.read().unwrap();
            map.values()
                .filter(|t| !t.adam_id.is_empty() && !t.uri.is_empty() && t.get_template().is_none())
                .cloned()
                .collect()
        };

        for track in pending_fetches {
            trigger_template_fetch(&state, &track);
        }

        // 2. 清理过期未访问的上下文
        {
            let mut map = state.tracks.write().unwrap();
            let before_count = map.len();
            map.retain(|fileuri, track| {
                let expired = track.is_expired(state.cache_ttl);
                if expired {
                    info!(fileuri = %fileuri, "TrackContext expired by TTL and evicted from memory");
                }
                !expired
            });
            let evicted = before_count - map.len();
            if evicted > 0 {
                info!(evicted = evicted, remaining = map.len(), "Context TTL eviction cycle completed");
            }
        }
    }
}
