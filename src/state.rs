use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use lru::LruCache;
use temari::rounds::Template;
use tokio::sync::{watch, OnceCell};

/// m3u8 中一个 BYTERANGE 段。`Track::segments[0]` 是 EXT-X-MAP 的 init 段，
/// `[1]` 是第一个 frag（即 range1，使用内嵌固定模板），其余使用轨道模板。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Segment {
    pub offset: u64,
    pub length: u64,
}

impl Segment {
    pub fn end(&self) -> u64 {
        self.offset + self.length
    }
}

#[derive(Default)]
struct FetchState {
    in_flight: bool,
    failures: u32,
    retry_at_ms: u64,
}

/// 一个 media 轨道的上下文（对应一条 media m3u8 / media file）。
pub struct Track {
    pub adam_id: String,
    pub uri: String,
    pub fileuri: Arc<str>,
    pub range1: String,
    pub segments: Vec<Segment>,
    pub total_size: u64,
    template: watch::Sender<Option<Arc<Template>>>,
    fetch: Mutex<FetchState>,
    last_accessed_ms: AtomicU64,
}

impl Track {
    pub fn new(adam_id: String, uri: String, fileuri: String, range1: String, segments: Vec<Segment>) -> Self {
        let total_size = segments.last().map_or(0, Segment::end);
        Self {
            adam_id,
            uri,
            fileuri: fileuri.into(),
            range1,
            segments,
            total_size,
            template: watch::Sender::new(None),
            fetch: Mutex::default(),
            last_accessed_ms: AtomicU64::new(now_ms()),
        }
    }

    pub fn touch(&self) {
        self.last_accessed_ms.store(now_ms(), Ordering::Relaxed);
    }

    pub fn is_expired(&self, ttl: Duration) -> bool {
        now_ms().saturating_sub(self.last_accessed_ms.load(Ordering::Relaxed)) > ttl.as_millis() as u64
    }

    pub fn template(&self) -> Option<Arc<Template>> {
        self.template.borrow().clone()
    }

    pub fn set_template(&self, template: Template) {
        self.template.send_replace(Some(Arc::new(template)));
    }

    pub async fn wait_template(&self, timeout: Duration) -> Result<Arc<Template>, String> {
        let mut rx = self.template.subscribe();
        let waited = tokio::time::timeout(timeout, async {
            rx.wait_for(Option::is_some).await.map(|t| t.clone().expect("checked by wait_for"))
        })
        .await;
        match waited {
            Ok(Ok(t)) => Ok(t),
            Ok(Err(_)) => Err("template channel closed".into()),
            Err(_) => Err(format!("timed out waiting for decryption template (adamId={})", self.adam_id)),
        }
    }

    /// 是否应当现在发起模板请求；返回 true 时调用方负责之后调用 `end_fetch`。
    pub(crate) fn begin_fetch(&self) -> bool {
        if self.adam_id.is_empty() || self.uri.is_empty() || self.template.borrow().is_some() {
            return false;
        }
        let mut f = self.fetch.lock().unwrap();
        if f.in_flight || now_ms() < f.retry_at_ms {
            return false;
        }
        f.in_flight = true;
        true
    }

    /// 结束一次模板请求；失败时指数退避（1s, 2s, 4s ... 最多 60s）。
    pub(crate) fn end_fetch(&self, ok: bool) -> Duration {
        let mut f = self.fetch.lock().unwrap();
        f.in_flight = false;
        if ok {
            f.failures = 0;
            return Duration::ZERO;
        }
        let backoff = Duration::from_secs((1u64 << f.failures.min(6)).min(60));
        f.failures += 1;
        f.retry_at_ms = now_ms() + backoff.as_millis() as u64;
        backoff
    }

    /// 与字节区间 [start, end]（闭区间）相交的 segment 下标范围。
    pub fn segments_overlapping(&self, start: u64, end: u64) -> std::ops::Range<usize> {
        let lo = self.segments.partition_point(|s| s.end() <= start);
        let hi = self.segments.partition_point(|s| s.offset <= end);
        lo..hi.max(lo)
    }
}

type TrackSlot = Arc<OnceCell<Arc<Track>>>;
pub type SegmentKey = (Arc<str>, usize);

pub struct Config {
    pub wrapper_url: String,
    /// 是否启用服务端解密代理（media m3u8 / media file 地址）
    pub hook: bool,
    pub cache_ttl: Duration,
    /// 单个请求内并发预取的 segment 数
    pub prefetch: usize,
    pub template_timeout: Duration,
}

pub struct AppState {
    pub config: Config,
    pub http_client: reqwest::Client,
    /// fileuri -> 轨道。OnceCell 让并发请求同一轨道时只拉取/解析一次 m3u8。
    tracks: Mutex<HashMap<String, TrackSlot>>,
    pub segments: SegmentCache,
}

impl AppState {
    /// 启用服务端解密的默认配置（测试用）
    pub fn new(wrapper_url: String, cache_ttl_secs: u64, cache_mb: usize) -> Self {
        Self::with_config(
            Config {
                wrapper_url: wrapper_url.trim_end_matches('/').to_string(),
                hook: true,
                cache_ttl: Duration::from_secs(cache_ttl_secs),
                prefetch: 4,
                template_timeout: Duration::from_secs(20),
            },
            cache_mb,
        )
    }

    pub fn with_config(config: Config, cache_mb: usize) -> Self {
        let http_client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(30))
            .tcp_nodelay(true)
            .pool_max_idle_per_host(32)
            .build()
            .expect("Failed to build reqwest HTTP client");
        Self {
            config,
            http_client,
            tracks: Mutex::default(),
            segments: SegmentCache::new(cache_mb.max(16) * 1024 * 1024),
        }
    }

    pub fn get_track(&self, fileuri: &str) -> Option<Arc<Track>> {
        let track = self.tracks.lock().unwrap().get(fileuri)?.get()?.clone();
        track.touch();
        Some(track)
    }

    /// 取得 fileuri 对应的轨道；不存在时用 `init` 构建，并发调用只会执行一次 `init`。
    /// 已存在的轨道会被复用（保留已获取的模板）。
    pub async fn get_or_init_track<F, Fut>(&self, fileuri: &str, init: F) -> Result<Arc<Track>, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Track, String>>,
    {
        let slot = self.tracks.lock().unwrap().entry(fileuri.to_string()).or_default().clone();
        let track = slot.get_or_try_init(|| async { init().await.map(Arc::new) }).await?.clone();
        track.touch();
        Ok(track)
    }

    pub fn tracks(&self) -> Vec<Arc<Track>> {
        self.tracks.lock().unwrap().values().filter_map(|s| s.get().cloned()).collect()
    }

    /// 淘汰超过 TTL 未访问的轨道，以及无人等待且初始化失败的空槽。返回淘汰数量。
    pub fn evict_expired(&self) -> usize {
        let ttl = self.config.cache_ttl;
        let mut map = self.tracks.lock().unwrap();
        let before = map.len();
        map.retain(|_, slot| match slot.get() {
            Some(t) => !t.is_expired(ttl),
            None => Arc::strong_count(slot) > 1,
        });
        before - map.len()
    }
}

/// 已解密 segment 的按字节计量 LRU 缓存 + 同一 segment 并发请求去重。
pub struct SegmentCache {
    lru: Mutex<(LruCache<SegmentKey, Bytes>, usize)>,
    capacity: usize,
    inflight: Mutex<HashMap<SegmentKey, Arc<OnceCell<Bytes>>>>,
}

impl SegmentCache {
    fn new(capacity: usize) -> Self {
        Self {
            lru: Mutex::new((LruCache::unbounded(), 0)),
            capacity,
            inflight: Mutex::default(),
        }
    }

    pub fn get(&self, key: &SegmentKey) -> Option<Bytes> {
        self.lru.lock().unwrap().0.get(key).cloned()
    }

    pub fn contains(&self, key: &SegmentKey) -> bool {
        self.lru.lock().unwrap().0.contains(key) || self.inflight.lock().unwrap().contains_key(key)
    }

    fn put(&self, key: SegmentKey, data: Bytes) {
        if data.len() > self.capacity {
            return;
        }
        let mut guard = self.lru.lock().unwrap();
        let (lru, used) = &mut *guard;
        *used += data.len();
        if let Some(old) = lru.put(key, data) {
            *used -= old.len();
        }
        while *used > self.capacity {
            match lru.pop_lru() {
                Some((_, v)) => *used -= v.len(),
                None => break,
            }
        }
    }

    /// 命中缓存直接返回；否则执行 `load`。同一 key 的并发调用共享一次 `load`，
    /// 若执行 `load` 的请求被取消（客户端断开），由下一个等待者接手。
    pub async fn get_or_load<F, Fut>(&self, key: SegmentKey, load: F) -> Result<Bytes, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Bytes, String>>,
    {
        if let Some(hit) = self.get(&key) {
            return Ok(hit);
        }
        let cell = self.inflight.lock().unwrap().entry(key.clone()).or_default().clone();
        let result = cell.get_or_try_init(load).await.cloned();
        if let Ok(data) = &result {
            self.put(key.clone(), data.clone());
        }
        let mut inflight = self.inflight.lock().unwrap();
        if inflight.get(&key).is_some_and(|c| Arc::ptr_eq(c, &cell)) {
            inflight.remove(&key);
        }
        result
    }
}

static START: LazyLock<Instant> = LazyLock::new(Instant::now);

fn now_ms() -> u64 {
    START.elapsed().as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track() -> Track {
        Track::new(
            "123".into(),
            "skd://test".into(),
            "test_m.mp4".into(),
            "100@10".into(),
            vec![Segment { offset: 0, length: 10 }, Segment { offset: 10, length: 100 }, Segment { offset: 110, length: 50 }],
        )
    }

    #[test]
    fn test_track_basics() {
        let t = track();
        assert_eq!(t.total_size, 160);
        assert!(!t.is_expired(Duration::from_secs(10)));
        assert_eq!(t.segments_overlapping(0, 159), 0..3);
        assert_eq!(t.segments_overlapping(10, 109), 1..2);
        assert_eq!(t.segments_overlapping(9, 10), 0..2);
        assert_eq!(t.segments_overlapping(150, 150), 2..3);
    }

    #[test]
    fn test_fetch_backoff() {
        let t = track();
        assert!(t.begin_fetch());
        assert!(!t.begin_fetch(), "only one fetch in flight");
        assert_eq!(t.end_fetch(false), Duration::from_secs(1));
        assert!(!t.begin_fetch(), "backing off after failure");
    }

    #[tokio::test]
    async fn test_segment_cache_dedup_and_capacity() {
        let cache = SegmentCache::new(10);
        let key: SegmentKey = ("f".into(), 1);
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let load = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(20)).await;
            Ok(Bytes::from_static(b"abcdef"))
        };
        let (a, b) = tokio::join!(cache.get_or_load(key.clone(), load), cache.get_or_load(key.clone(), load));
        assert_eq!(a.unwrap(), b.unwrap());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(cache.get(&key).is_some());

        cache.put(("f".into(), 2), Bytes::from_static(b"123456"));
        assert!(cache.get(&key).is_none(), "oldest entry evicted once over capacity");
    }
}
