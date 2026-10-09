//! wrapper-lite 客户端。所有对 wrapper-lite 的请求都经 [`Wrapper::send`] 发出：
//! 限制并发数与每秒请求数（wrapper-lite 可能有调用频率限制），并附带可选的 `Authorization` 请求头。

use std::collections::VecDeque;
use std::time::Duration;

use bytes::Bytes;
use reqwest::header::{HeaderValue, AUTHORIZATION};
use reqwest::{Client, Method, RequestBuilder, StatusCode};
use serde::Deserialize;
use serde_json::value::RawValue;
use tokio::sync::{Mutex, Semaphore};
use tokio::time::Instant;

use crate::state::Config;

const RATE_WINDOW: Duration = Duration::from_secs(1);

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

/// wrapper-lite 的完整响应（响应体读完后才释放并发名额）
pub struct Reply {
    pub status: StatusCode,
    pub body: Bytes,
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
    concurrency: Option<Semaphore>,
    rate: Option<RateLimit>,
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
            concurrency: (config.wrapper_concurrency > 0).then(|| Semaphore::new(config.wrapper_concurrency)),
            rate: (config.wrapper_rate > 0).then(|| RateLimit::new(config.wrapper_rate as usize)),
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
    pub async fn send(&self, request: RequestBuilder) -> Result<Reply, reqwest::Error> {
        let _permit = match &self.concurrency {
            Some(semaphore) => Some(semaphore.acquire().await.expect("wrapper semaphore is never closed")),
            None => None,
        };
        if let Some(rate) = &self.rate {
            rate.acquire().await;
        }
        let response = request.send().await?;
        let status = response.status();
        let body = response.bytes().await?;
        Ok(Reply { status, body })
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

    async fn acquire(&self) {
        let mut sent = self.sent.lock().await;
        let now = Instant::now();
        while sent.front().is_some_and(|t| now.duration_since(*t) >= RATE_WINDOW) {
            sent.pop_front();
        }
        if sent.len() >= self.per_second {
            let oldest = sent.pop_front().expect("window is full");
            tokio::time::sleep_until(oldest + RATE_WINDOW).await;
        }
        sent.push_back(Instant::now());
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

    fn config(url: String, rate: u32, concurrency: usize, auth: Option<&str>) -> Config {
        Config {
            wrapper_url: url,
            amp_keepalive: Duration::ZERO,
            amp_cache_mb: 0,
            wrapper_rate: rate,
            wrapper_concurrency: concurrency,
            wrapper_auth: auth.map(str::to_owned),
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
}
