//! wrapper-lite 客户端。所有对 wrapper-lite 的请求都经 [`Wrapper::send`] 发出：
//! 限制并发数与每秒请求数（wrapper-lite 可能有调用频率限制），并附带可选的 `Authorization` 请求头。
//! 排队情况记在 [`QueueStats`] 与 [`QUEUE_WAIT`] 中，由命令行日志输出（见 `log.rs`）。

use std::cell::Cell;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use reqwest::header::{HeaderValue, AUTHORIZATION, RETRY_AFTER};
use reqwest::{Client, Method, RequestBuilder, StatusCode};
use serde::Deserialize;
use serde_json::value::RawValue;
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;

use crate::state::Config;

const RATE_WINDOW: Duration = Duration::from_secs(1);
/// 排队至少这么久才算被限制（忽略取锁等瞬时等待）
pub const QUEUED_MIN: Duration = Duration::from_millis(10);
/// 已发出但没有正常结束（超时、读响应出错、客户端断开使请求被取消）的请求，wrapper-lite 上可能仍在处理：
/// 并发名额再保留这么久才归还，免得 wrapper-lite 实际的并发超过 `--wrapper-concurrency`
const ABANDONED_HOLD: Duration = Duration::from_secs(30);

tokio::task_local! {
    /// 当前 HTTP 请求累计的 wrapper-lite 排队时间，由请求日志中间件设置并输出
    pub static QUEUE_WAIT: Cell<QueueWait>;
}

/// 一个请求排队等待的时间：等并发名额与等速率配额分开计
#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct QueueWait {
    pub concurrency: Duration,
    pub rate: Duration,
}

impl QueueWait {
    pub fn total(&self) -> Duration {
        self.concurrency + self.rate
    }
}

/// 规范化 `Authorization` 取值：空值表示不发送；只有 token 时补上 `Bearer `，已带认证方案（含空白）时原样使用
pub fn normalize_authorization(raw: &str) -> Result<Option<String>, String> {
    let value = raw.trim();
    if value.is_empty() {
        return Ok(None);
    }
    let value = if value.contains(char::is_whitespace) { value.to_owned() } else { format!("Bearer {value}") };
    HeaderValue::from_str(&value).map_err(|_| "wrapper-lite authorization contains invalid header characters".to_owned())?;
    Ok(Some(value))
}

/// wrapper-lite 的完整响应（响应体读完后才释放并发名额，见 [`Slot`]）
pub struct Reply {
    pub status: StatusCode,
    pub body: Bytes,
    /// 上游的 `Retry-After`（限流时给出），转发给浏览器让它按此退避
    pub retry_after: Option<HeaderValue>,
}

impl Reply {
    pub fn json<'a, T: Deserialize<'a>>(&'a self) -> serde_json::Result<T> {
        serde_json::from_slice(&self.body)
    }
}

pub struct Wrapper {
    pub url: String,
    client: Client,
    authorization: Option<HeaderValue>,
    concurrency: Option<Arc<Semaphore>>,
    rate: Option<RateLimit>,
    stats: QueueStats,
    /// 见 [`ABANDONED_HOLD`]；测试中改短
    abandoned_hold: Duration,
}

impl Wrapper {
    /// `config.wrapper_auth` 应已经过 [`normalize_authorization`]
    pub fn new(config: &Config) -> Self {
        // 每个请求使用新连接、不保留空闲连接：wrapper-lite 常经 QEMU 用户态网络转发端口，
        // 空闲的转发连接可能被静默丢弃，复用时请求会一直挂到超时；本机建立连接的开销可以忽略
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(30))
            .tcp_nodelay(true)
            .pool_max_idle_per_host(0)
            .http1_only()
            .no_gzip()
            .no_brotli()
            .build()
            .expect("Failed to build wrapper-lite HTTP client");
        let authorization = config.wrapper_auth.as_deref().and_then(|value| {
            let mut value = HeaderValue::from_str(value).ok()?;
            value.set_sensitive(true);
            Some(value)
        });
        Self {
            url: config.wrapper_url.clone(),
            client,
            authorization,
            concurrency: (config.wrapper_concurrency > 0).then(|| Arc::new(Semaphore::new(config.wrapper_concurrency))),
            rate: (config.wrapper_rate > 0).then(|| RateLimit::new(config.wrapper_rate as usize)),
            stats: QueueStats::default(),
            abandoned_hold: ABANDONED_HOLD,
        }
    }

    /// 当前排队情况；`delayed` 与 `longest_wait` 只统计上次调用以来的请求
    pub fn queue_snapshot(&self) -> QueueSnapshot {
        let stats = &self.stats;
        let now = Instant::now();
        let mut recent = stats.recent.lock().unwrap_or_else(|e| e.into_inner());
        while recent.front().is_some_and(|t| now.duration_since(*t) >= RATE_WINDOW) {
            recent.pop_front();
        }
        QueueSnapshot {
            waiting_concurrency: stats.waiting_concurrency.load(Ordering::Relaxed),
            waiting_rate: stats.waiting_rate.load(Ordering::Relaxed),
            in_flight: stats.in_flight.load(Ordering::Relaxed),
            held: stats.held.load(Ordering::Relaxed),
            sent_last_second: recent.iter().filter(|t| now.duration_since(**t) < RATE_WINDOW).count(),
            delayed: stats.delayed.swap(0, Ordering::Relaxed),
            longest_wait: Duration::from_micros(stats.longest_wait_us.swap(0, Ordering::Relaxed)),
        }
    }

    /// `path` 以 `/` 开头，如 `/key`
    pub fn request(&self, method: Method, path: &str) -> RequestBuilder {
        let request = self.client.request(method, format!("{}{path}", self.url));
        match &self.authorization {
            Some(value) => request.header(AUTHORIZATION, value.clone()),
            None => request,
        }
    }

    pub fn get(&self, path: &str) -> RequestBuilder {
        self.request(Method::GET, path)
    }

    pub fn post(&self, path: &str) -> RequestBuilder {
        self.request(Method::POST, path)
    }

    /// 在并发与速率限制内发送请求并读完响应体。先取并发名额再占速率配额，
    /// 使速率按实际发出时间计算（排队等待并发名额的请求不会在名额释放后集中发出）。
    /// 发出后没有正常结束的请求，并发名额按 [`ABANDONED_HOLD`] 延后归还（见 [`Slot`]）。
    pub async fn send(&self, request: RequestBuilder) -> Result<Reply, reqwest::Error> {
        let queued = Instant::now();
        let waiting = Gauge::enter(&self.stats.waiting_concurrency);
        let permit = match &self.concurrency {
            Some(semaphore) => Some(semaphore.clone().acquire_owned().await.expect("wrapper semaphore is never closed")),
            None => None,
        };
        drop(waiting);
        let acquired = Instant::now();
        let sent_at = match &self.rate {
            Some(rate) => {
                let _waiting = Gauge::enter(&self.stats.waiting_rate);
                rate.acquire().await
            }
            None => Instant::now(),
        };
        self.stats.record(sent_at, QueueWait { concurrency: acquired - queued, rate: sent_at.saturating_duration_since(acquired) });
        // 被取消时 slot 随 future 一起丢弃，按未正常结束处理
        let slot = Slot { permit, held: self.stats.held.clone(), hold: self.abandoned_hold };
        let _in_flight = Gauge::enter(&self.stats.in_flight);
        let result = read_reply(request).await;
        // 连接没建立时 wrapper-lite 没收到请求，名额可以马上归还
        if result.as_ref().map_or_else(reqwest::Error::is_connect, |_| true) {
            slot.release();
        }
        result
    }

    /// 从 `/key` 接口获取原始模板 JSON（响应中的 `data` 字段），供浏览器端解密使用
    pub async fn fetch_key_json(&self, adam_id: &str, uri: &str) -> Result<String, String> {
        let request = self.get("/key").query(&[("adamId", adam_id), ("uri", uri)]).timeout(Duration::from_secs(15));
        let reply = self.send(request).await.map_err(|e| format!("Request to wrapper-lite failed: {e}"))?;
        if !reply.status.is_success() {
            return Err(format!("wrapper-lite returned HTTP {}: {}", reply.status, String::from_utf8_lossy(&reply.body)));
        }

        let v: KeyResponse = reply.json().map_err(|e| format!("Failed to parse wrapper-lite JSON: {e}"))?;
        if v.code != 0 {
            return Err(format!("wrapper-lite returned error code {}: {}", v.code, v.msg.as_deref().unwrap_or("unknown error")));
        }
        let data = v.data.ok_or("wrapper-lite response missing 'data' field")?;
        Ok(data.get().to_string())
    }

    /// 从 `/lyrics` 接口获取歌曲的 TTML 歌词（响应中的 `data.lyrics`）。
    /// `language` 为歌曲所在地区的默认语言（如 `zh-Hans-CN`），有值时原样转发
    pub async fn fetch_lyrics(&self, adam_id: &str, language: Option<&str>) -> Result<Lyrics, String> {
        let mut request = self.get("/lyrics").query(&[("adamId", adam_id)]);
        if let Some(language) = language {
            request = request.query(&[("language", language)]);
        }
        let reply = self
            .send(request.timeout(Duration::from_secs(15)))
            .await
            .map_err(|e| format!("Request to wrapper-lite failed: {e}"))?;

        if reply.status == StatusCode::NOT_FOUND {
            return Ok(Lyrics::NotFound);
        }
        if !reply.status.is_success() {
            return Err(format!("wrapper-lite returned HTTP {}: {}", reply.status, String::from_utf8_lossy(&reply.body)));
        }

        let v: LyricsResponse = reply.json().map_err(|e| format!("Failed to parse wrapper-lite JSON: {e}"))?;
        // wrapper-lite 以 HTTP 200 + code 404 表示该歌曲没有歌词
        if v.code == 404 {
            return Ok(Lyrics::NotFound);
        }
        if v.code != 0 {
            return Err(format!("wrapper-lite returned error code {}: {}", v.code, v.msg.as_deref().unwrap_or("unknown error")));
        }
        match v.data.and_then(|data| data.lyrics).filter(|ttml| !ttml.trim().is_empty()) {
            Some(ttml) => Ok(Lyrics::Found(ttml)),
            None => Ok(Lyrics::NotFound),
        }
    }
}

async fn read_reply(request: RequestBuilder) -> Result<Reply, reqwest::Error> {
    let response = request.send().await?;
    let status = response.status();
    let retry_after = response.headers().get(RETRY_AFTER).cloned();
    let body = response.bytes().await?;
    Ok(Reply { status, body, retry_after })
}

/// 已发出请求占用的并发名额：[`Slot::release`] 立即归还；未调用就被丢弃（请求出错或被取消）时
/// 由后台任务再保留 `hold` 后归还，期间计入 [`QueueStats::held`]
struct Slot {
    permit: Option<OwnedSemaphorePermit>,
    held: Arc<AtomicUsize>,
    hold: Duration,
}

impl Slot {
    fn release(mut self) {
        self.permit = None;
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        let Some(permit) = self.permit.take() else { return };
        // 运行时已关闭时没有后续请求，直接归还
        let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
        let (held, hold) = (self.held.clone(), self.hold);
        held.fetch_add(1, Ordering::Relaxed);
        runtime.spawn(async move {
            tokio::time::sleep(hold).await;
            held.fetch_sub(1, Ordering::Relaxed);
            drop(permit);
        });
    }
}

/// 排队计数。等待中的请求被取消时由 [`Gauge`] 归还计数
#[derive(Default)]
struct QueueStats {
    waiting_concurrency: AtomicUsize,
    waiting_rate: AtomicUsize,
    in_flight: AtomicUsize,
    /// 没有正常结束、并发名额仍被保留的请求数（见 [`Slot`]）
    held: Arc<AtomicUsize>,
    /// 排队超过 [`QUEUED_MIN`] 的请求数
    delayed: AtomicU64,
    longest_wait_us: AtomicU64,
    /// 最近 1 秒内发出请求的时间
    recent: std::sync::Mutex<VecDeque<Instant>>,
}

impl QueueStats {
    fn record(&self, sent_at: Instant, wait: QueueWait) {
        {
            let mut recent = self.recent.lock().unwrap_or_else(|e| e.into_inner());
            while recent.front().is_some_and(|t| sent_at.saturating_duration_since(*t) >= RATE_WINDOW) {
                recent.pop_front();
            }
            recent.push_back(sent_at);
        }
        if wait.total() >= QUEUED_MIN {
            self.delayed.fetch_add(1, Ordering::Relaxed);
            self.longest_wait_us.fetch_max(wait.total().as_micros() as u64, Ordering::Relaxed);
        }
        // 不在请求日志中间件内（如启动检查）时没有设置
        let _ = QUEUE_WAIT.try_with(|cell| {
            let mut total = cell.get();
            total.concurrency += wait.concurrency;
            total.rate += wait.rate;
            cell.set(total);
        });
    }
}

/// 进入时加一、离开（含被取消）时减一
struct Gauge<'a>(&'a AtomicUsize);

impl<'a> Gauge<'a> {
    fn enter(count: &'a AtomicUsize) -> Self {
        count.fetch_add(1, Ordering::Relaxed);
        Self(count)
    }
}

impl Drop for Gauge<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

/// [`Wrapper::queue_snapshot`] 的结果
#[derive(Debug, PartialEq)]
pub struct QueueSnapshot {
    /// 等待并发名额的请求数
    pub waiting_concurrency: usize,
    /// 已取得并发名额、等待速率配额的请求数
    pub waiting_rate: usize,
    /// 已发出、尚未读完响应的请求数
    pub in_flight: usize,
    /// 没有正常结束、并发名额仍被保留的请求数
    pub held: usize,
    /// 最近 1 秒内发出的请求数
    pub sent_last_second: usize,
    /// 上次快照以来排队超过 [`QUEUED_MIN`] 的请求数
    pub delayed: u64,
    pub longest_wait: Duration,
}

impl QueueSnapshot {
    pub fn queued(&self) -> usize {
        self.waiting_concurrency + self.waiting_rate
    }
}

/// 滑动窗口限速：任意 1 秒内最多发出 `per_second` 个请求（不像令牌桶那样允许窗口边界处翻倍突发）。
/// 等待者按到达顺序排队。
struct RateLimit {
    per_second: usize,
    sent: Mutex<VecDeque<Instant>>,
}

impl RateLimit {
    fn new(per_second: usize) -> Self {
        Self { per_second, sent: Mutex::new(VecDeque::with_capacity(per_second)) }
    }

    /// 返回占用配额的时间（即请求发出的时间）
    async fn acquire(&self) -> Instant {
        let mut sent = self.sent.lock().await;
        let now = Instant::now();
        while sent.front().is_some_and(|t| now.duration_since(*t) >= RATE_WINDOW) {
            sent.pop_front();
        }
        if sent.len() >= self.per_second {
            // 等到之后才移出：等待中被取消（future 被丢弃）时窗口保持不变，不会多放行一个请求
            let oldest = *sent.front().expect("window is full");
            tokio::time::sleep_until(oldest + RATE_WINDOW).await;
            sent.pop_front();
        }
        let now = Instant::now();
        sent.push_back(now);
        now
    }
}

#[derive(Deserialize)]
struct KeyResponse<'a> {
    code: i64,
    #[serde(default)]
    msg: Option<String>,
    #[serde(borrow)]
    data: Option<&'a RawValue>,
}

/// wrapper-lite `/lyrics` 的结果：找到时为 TTML 原文
pub enum Lyrics {
    Found(String),
    NotFound,
}

#[derive(Deserialize)]
struct LyricsResponse {
    code: i64,
    #[serde(default)]
    msg: Option<String>,
    #[serde(default)]
    data: Option<LyricsData>,
}

#[derive(Deserialize)]
struct LyricsData {
    #[serde(default)]
    lyrics: Option<String>,
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::*;

    #[test]
    fn test_normalize_authorization() {
        assert_eq!(normalize_authorization("").unwrap(), None);
        assert_eq!(normalize_authorization("  ").unwrap(), None);
        assert_eq!(normalize_authorization("abc.123").unwrap().as_deref(), Some("Bearer abc.123"));
        assert_eq!(normalize_authorization(" Bearer abc ").unwrap().as_deref(), Some("Bearer abc"));
        assert_eq!(normalize_authorization("Basic dXNlcjpwYXNz").unwrap().as_deref(), Some("Basic dXNlcjpwYXNz"));
        assert!(normalize_authorization("bad\ntoken x").is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn test_rate_limit_sliding_window() {
        let limit = RateLimit::new(3);
        let start = Instant::now();
        let mut at = Vec::new();
        for _ in 0..7 {
            limit.acquire().await;
            at.push((Instant::now() - start).as_millis());
        }
        assert_eq!(at, [0, 0, 0, 1000, 1000, 1000, 2000]);

        // 窗口过去后不再等待
        tokio::time::advance(Duration::from_secs(5)).await;
        let before = Instant::now();
        limit.acquire().await;
        assert_eq!(Instant::now(), before);
    }

    /// 等待中被取消（客户端断开、浏览器中止请求）不应让出窗口里的配额
    #[tokio::test(start_paused = true)]
    async fn test_rate_limit_cancelled_waiter() {
        let limit = RateLimit::new(2);
        let start = Instant::now();
        limit.acquire().await;
        limit.acquire().await;
        // 第三个请求排队等到 1000ms，在 500ms 时被取消
        assert!(tokio::time::timeout(Duration::from_millis(500), limit.acquire()).await.is_err());
        limit.acquire().await;
        assert_eq!((Instant::now() - start).as_millis(), 1000, "window still holds 2 requests sent at 0ms");
    }

    fn config(url: String, rate: u32, concurrency: usize, auth: Option<&str>) -> Config {
        Config {
            wrapper_url: url,
            amp_keepalive: Duration::ZERO,
            amp_cache_mb: 0,
            wrapper_rate: rate,
            wrapper_concurrency: concurrency,
            wrapper_auth: auth.map(str::to_owned),
            wrapper_relay: true,
            wrapper_hint: None,
            client_rate: 0,
            client_concurrency: 0,
            client_ip_header: None,
        }
    }

    #[tokio::test]
    async fn test_concurrency_limit_and_authorization() {
        use axum::http::HeaderMap;
        use axum::routing::get;

        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let (a, p) = (active.clone(), peak.clone());
        let app = axum::Router::new().route(
            "/status",
            get(move |headers: HeaderMap| {
                let (active, peak) = (a.clone(), p.clone());
                async move {
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    active.fetch_sub(1, Ordering::SeqCst);
                    headers.get("authorization").map(|v| v.to_str().unwrap().to_owned()).unwrap_or_default()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let wrapper = Wrapper::new(&config(url.clone(), 0, 2, Some("Bearer secret")));
        let replies = futures::future::join_all((0..6).map(|_| wrapper.send(wrapper.get("/status")))).await;
        for reply in replies {
            assert_eq!(reply.unwrap().body, "Bearer secret");
        }
        assert_eq!(peak.load(Ordering::SeqCst), 2, "at most 2 requests in flight");

        let anonymous = Wrapper::new(&config(url, 0, 0, None));
        assert_eq!(anonymous.send(anonymous.get("/status")).await.unwrap().body, "", "no Authorization by default");
    }

    #[tokio::test]
    async fn test_queue_stats_and_wait() {
        let app = axum::Router::new().route("/status", axum::routing::get(|| async { "ok" }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let wrapper = Arc::new(Wrapper::new(&config(url, 2, 0, None)));
        let tasks: Vec<_> = (0..4)
            .map(|_| {
                let wrapper = wrapper.clone();
                tokio::spawn(QUEUE_WAIT.scope(Cell::new(QueueWait::default()), async move {
                    wrapper.send(wrapper.get("/status")).await.unwrap();
                    QUEUE_WAIT.with(Cell::get)
                }))
            })
            .collect();
        tokio::time::sleep(Duration::from_millis(300)).await;
        let s = wrapper.queue_snapshot();
        assert_eq!((s.sent_last_second, s.waiting_rate, s.queued()), (2, 2, 2));

        let mut waits: Vec<_> = futures::future::join_all(tasks).await.into_iter().map(|w| w.unwrap()).collect();
        waits.sort_by_key(QueueWait::total);
        assert!(waits[1].total() < QUEUED_MIN && waits[2].rate >= Duration::from_millis(900), "{waits:?}");
        let s = wrapper.queue_snapshot();
        assert_eq!((s.delayed, s.queued(), s.in_flight), (2, 0, 0));
        assert!(s.longest_wait >= Duration::from_millis(900));
    }

    /// 超时或被取消的请求在 wrapper-lite 上可能仍在处理：名额保留到 abandoned_hold 之后；
    /// 正常结束与连接失败（wrapper-lite 没收到请求）立即归还
    #[tokio::test]
    async fn test_abandoned_request_holds_permit() {
        let app = axum::Router::new()
            .route("/status", axum::routing::get(|| async { "ok" }))
            .route("/slow", axum::routing::get(|| async {
                tokio::time::sleep(Duration::from_secs(5)).await;
                "late"
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let mut wrapper = Wrapper::new(&config(url, 0, 1, None));
        wrapper.abandoned_hold = Duration::from_millis(400);
        let hold = wrapper.abandoned_hold;

        // 正常结束：下一个请求不用等
        wrapper.send(wrapper.get("/status")).await.unwrap();
        let start = Instant::now();
        wrapper.send(wrapper.get("/status")).await.unwrap();
        assert!(start.elapsed() < hold / 2, "released right after a complete reply");
        assert_eq!(wrapper.queue_snapshot().held, 0);

        // 超时
        let start = Instant::now();
        let error = wrapper.send(wrapper.get("/slow").timeout(Duration::from_millis(50))).await.err().unwrap();
        assert!(error.is_timeout());
        assert_eq!(wrapper.queue_snapshot().held, 1);
        wrapper.send(wrapper.get("/status")).await.unwrap();
        assert!(start.elapsed() >= hold, "timed-out request kept the only permit for {hold:?}");
        assert_eq!(wrapper.queue_snapshot().held, 0);

        // 被取消（客户端断开时 handler 的 future 被丢弃）
        let start = Instant::now();
        assert!(tokio::time::timeout(Duration::from_millis(50), wrapper.send(wrapper.get("/slow"))).await.is_err());
        assert_eq!(wrapper.queue_snapshot().held, 1);
        wrapper.send(wrapper.get("/status")).await.unwrap();
        assert!(start.elapsed() >= hold, "cancelled request kept the only permit for {hold:?}");

        // 连接失败
        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let closed_url = format!("http://{}/status", closed.local_addr().unwrap());
        drop(closed);
        let error = wrapper.send(wrapper.client.get(closed_url)).await.err().unwrap();
        assert!(error.is_connect());
        let start = Instant::now();
        wrapper.send(wrapper.get("/status")).await.unwrap();
        assert!(start.elapsed() < hold / 2, "connect failure released the permit at once");
        assert_eq!(wrapper.queue_snapshot().held, 0);
    }
}
