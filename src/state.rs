use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use bytes::Bytes;
use lru::LruCache;
use tokio::sync::{watch, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FragmentRange {
    pub offset: u64,
    pub length: u64,
}

pub struct TrackContext {
    pub adam_id: String,
    pub uri: String,
    pub fileuri: String,
    pub range1: String,
    pub init_range: (u64, u64),
    pub fragments: Vec<FragmentRange>,
    pub total_size: u64,
    pub template_tx: watch::Sender<Option<Arc<temari::rounds::Template>>>,
    pub template_rx: watch::Receiver<Option<Arc<temari::rounds::Template>>>,
    pub raw_template_json: RwLock<String>,
    pub last_accessed: AtomicI64,
    pub is_fetching: AtomicBool,
}

impl TrackContext {
    pub fn new(
        adam_id: String,
        uri: String,
        fileuri: String,
        range1: String,
        init_range: (u64, u64),
        fragments: Vec<FragmentRange>,
        total_size: u64,
    ) -> Self {
        let (template_tx, template_rx) = watch::channel(None);
        let now = now_epoch_secs();
        Self {
            adam_id,
            uri,
            fileuri,
            range1,
            init_range,
            fragments,
            total_size,
            template_tx,
            template_rx,
            raw_template_json: RwLock::new(String::new()),
            last_accessed: AtomicI64::new(now),
            is_fetching: AtomicBool::new(false),
        }
    }

    pub fn touch(&self) {
        self.last_accessed.store(now_epoch_secs(), Ordering::Relaxed);
    }

    pub fn is_expired(&self, ttl: i64) -> bool {
        let last = self.last_accessed.load(Ordering::Relaxed);
        now_epoch_secs() - last > ttl
    }

    pub fn set_template(&self, raw_json: String, template: temari::rounds::Template) {
        {
            let mut w = self.raw_template_json.write().unwrap();
            *w = raw_json;
        }
        let _ = self.template_tx.send(Some(Arc::new(template)));
    }

    pub fn get_template(&self) -> Option<Arc<temari::rounds::Template>> {
        self.template_rx.borrow().clone()
    }

    pub async fn wait_for_template(
        &self,
        timeout: Duration,
    ) -> Result<Arc<temari::rounds::Template>, String> {
        if let Some(tmpl) = self.get_template() {
            return Ok(tmpl);
        }
        let mut rx = self.template_rx.clone();
        tokio::select! {
            res = rx.wait_for(|opt| opt.is_some()) => {
                match res {
                    Ok(ref opt) => opt.as_ref().cloned().ok_or_else(|| "Template is None".to_string()),
                    Err(_) => Err("Template watch channel closed".to_string()),
                }
            }
            _ = tokio::time::sleep(timeout) => {
                Err(format!("Timed out waiting for decryption template for adamId={}", self.adam_id))
            }
        }
    }
}

pub struct AppState {
    pub tracks: RwLock<HashMap<String, Arc<TrackContext>>>,
    pub fragment_cache: Mutex<LruCache<String, Bytes>>,
    pub wrapper_url: String,
    pub cache_ttl: i64,
    pub http_client: reqwest::Client,
}

impl AppState {
    pub fn new(wrapper_url: String, cache_ttl: i64, lru_cache_mb: usize) -> Self {
        // Calculate approximate entry capacity: assuming average fragment is ~1.5MB
        let avg_frag_bytes = 1_500_000usize;
        let max_bytes = lru_cache_mb.max(16) * 1024 * 1024;
        let cap_entries = (max_bytes / avg_frag_bytes).max(16);
        let cap = NonZeroUsize::new(cap_entries).unwrap();

        let http_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("Failed to build reqwest HTTP client");

        Self {
            tracks: RwLock::new(HashMap::new()),
            fragment_cache: Mutex::new(LruCache::new(cap)),
            wrapper_url,
            cache_ttl,
            http_client,
        }
    }

    pub fn get_track(&self, fileuri: &str) -> Option<Arc<TrackContext>> {
        let map = self.tracks.read().unwrap();
        if let Some(track) = map.get(fileuri) {
            track.touch();
            Some(track.clone())
        } else {
            None
        }
    }

    pub fn insert_track(&self, track: Arc<TrackContext>) {
        let mut map = self.tracks.write().unwrap();
        map.insert(track.fileuri.clone(), track);
    }

    pub async fn get_cached_fragment(&self, cache_key: &str) -> Option<Bytes> {
        let mut cache = self.fragment_cache.lock().await;
        cache.get(cache_key).cloned()
    }

    pub async fn put_cached_fragment(&self, cache_key: String, data: Bytes) {
        let mut cache = self.fragment_cache.lock().await;
        cache.put(cache_key, data);
    }
}

pub fn now_epoch_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_track_context_touch() {
        let track = TrackContext::new(
            "123".into(),
            "skd://test".into(),
            "test_m.mp4".into(),
            "100@10".into(),
            (0, 10),
            vec![FragmentRange { offset: 10, length: 100 }],
            110,
        );
        assert!(!track.is_expired(10));
        track.touch();
        assert!(!track.is_expired(10));
    }
}
