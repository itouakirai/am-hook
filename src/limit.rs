//! 按客户端 IP 限制转发 wrapper-lite 的请求：wrapper-lite 的额度由所有用户共用，
//! 免得单个用户（如批量扒取整个艺人）用光或长时间占满。
//! - `--client-rate`：任意 60 秒内的请求数，超出时返回 429（管一段时间内的总量）
//! - `--client-concurrency`：同时在处理的请求数，超出的排队（管同一时刻占多少全局名额，突发时不堵住其他用户）
//!
//! 客户端 IP 取自 `--client-ip-header`（由前面的反向代理设置），没有设置或请求中没有该请求头时用 TCP 对端地址。

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::header::{CONTENT_TYPE, RETRY_AFTER};
use axum::http::{HeaderMap, HeaderName, Response, StatusCode};
use axum::middleware::Next;
use serde_json::json;
use tokio::sync::Semaphore;
use tokio::time::Instant;

use crate::state::AppState;
use crate::wrapper::QUEUED_MIN;

const WINDOW: Duration = Duration::from_secs(60);

/// 每个 IP 的滑动窗口（任意 60 秒内最多 `per_minute` 个请求，被拒绝的请求不计入）与并发名额
pub struct ClientLimit {
    per_minute: usize,
    concurrency: usize,
    header: Option<HeaderName>,
    inner: Mutex<Windows>,
}

struct Windows {
    sent: HashMap<IpAddr, VecDeque<Instant>>,
    slots: HashMap<IpAddr, Arc<Semaphore>>,
    /// 上次清理的时间：移除窗口已过期、名额无人占用或等待的 IP，免得出现过的 IP 一直占着内存
    swept: Instant,
}

impl ClientLimit {
    /// `per_minute`、`concurrency` 为 0 时不限；`header` 应已经过 [`parse_ip_header`]
    pub fn new(per_minute: u32, concurrency: usize, header: Option<&str>) -> Self {
        Self {
            per_minute: per_minute as usize,
            concurrency,
            header: header.and_then(|name| HeaderName::from_bytes(name.as_bytes()).ok()),
            inner: Mutex::new(Windows { sent: HashMap::new(), slots: HashMap::new(), swept: Instant::now() }),
        }
    }

    fn enabled(&self) -> bool {
        self.per_minute > 0 || self.concurrency > 0
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Windows> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        if now.duration_since(inner.swept) >= WINDOW {
            inner.sent.retain(|_, sent| sent.back().is_some_and(|t| now.duration_since(*t) < WINDOW));
            // 只剩表中这一个引用时，没有请求占用或等待该 IP 的名额
            inner.slots.retain(|_, slots| Arc::strong_count(slots) > 1);
            inner.swept = now;
        }
        inner
    }

    /// 该 IP 的并发名额，未限制时为 None
    fn slots(&self, ip: IpAddr) -> Option<Arc<Semaphore>> {
        (self.concurrency > 0).then(|| self.lock().slots.entry(ip).or_insert_with(|| Arc::new(Semaphore::new(self.concurrency))).clone())
    }

    /// 请求头中的 IP（取第一个逗号前的部分）优先，否则为 TCP 对端地址
    pub fn client_ip(&self, headers: &HeaderMap, peer: Option<SocketAddr>) -> Option<IpAddr> {
        let from_header = self.header.as_ref().and_then(|name| headers.get(name)).and_then(|value| {
            value.to_str().ok()?.split(',').next()?.trim().parse().ok()
        });
        from_header.or(peer.map(|addr| addr.ip()))
    }

    /// 计入一个请求；超出时返回还要等多久才有配额
    pub fn check(&self, ip: IpAddr) -> Result<(), Duration> {
        if self.per_minute == 0 {
            return Ok(());
        }
        let now = Instant::now();
        let mut inner = self.lock();
        let sent = inner.sent.entry(ip).or_default();
        while sent.front().is_some_and(|t| now.duration_since(*t) >= WINDOW) {
            sent.pop_front();
        }
        if sent.len() >= self.per_minute {
            return Err(*sent.front().expect("window is full") + WINDOW - now);
        }
        sent.push_back(now);
        Ok(())
    }
}

/// 校验 `--client-ip-header`，返回小写的请求头名；空值表示不使用
pub fn parse_ip_header(raw: &str) -> Result<Option<String>, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Ok(None);
    }
    HeaderName::from_bytes(name.as_bytes())
        .map(|name| Some(name.as_str().to_owned()))
        .map_err(|_| format!("Invalid --client-ip-header '{name}'"))
}

/// 转发 wrapper-lite 接口的中间件。`/status`（所有客户端共用缓存，见 handlers.rs）不限
pub async fn limit_clients(State(state): State<Arc<AppState>>, request: Request, next: Next) -> Response<Body> {
    let limit = &state.client_limit;
    if !limit.enabled() || request.uri().path() == "/status" {
        return next.run(request).await;
    }
    let peer = request.extensions().get::<ConnectInfo<SocketAddr>>().map(|info| info.0);
    // 识别不出客户端时（没有对端地址，如测试中直接调用 router）不限
    let Some(ip) = limit.client_ip(request.headers(), peer) else {
        return next.run(request).await;
    };
    match limit.check(ip) {
        Ok(()) => {
            let Some(slots) = limit.slots(ip) else {
                return next.run(request).await;
            };
            // 处理函数返回前已读完 wrapper-lite 的响应，名额占到这里为止；被取消时随 future 一起归还
            let queued = Instant::now();
            let _permit = slots.acquire_owned().await.expect("client semaphore is never closed");
            let waited = queued.elapsed();
            let mut response = next.run(request).await;
            if waited >= QUEUED_MIN {
                let queued = format!("QUEUED {} by client concurrency", crate::log::format_elapsed(waited));
                let note = match response.extensions_mut().remove::<crate::log::LogNote>() {
                    Some(crate::log::LogNote(note)) if !note.is_empty() => format!("{note} · {queued}"),
                    _ => queued,
                };
                response = crate::log::note(response, note);
            }
            response
        }
        Err(wait) => {
            let retry_after = wait.as_secs_f64().ceil().max(1.0) as u64;
            let body = json!({ "code": 1, "msg": format!("Too many requests; retry in {retry_after} s") });
            let response = Response::builder()
                .status(StatusCode::TOO_MANY_REQUESTS)
                .header(CONTENT_TYPE, "application/json; charset=utf-8")
                .header(RETRY_AFTER, retry_after)
                .body(Body::from(body.to_string()))
                .expect("static response parts are valid");
            crate::log::note(response, format!("client {ip} over {}/min", limit.per_minute))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn test_sliding_window_per_ip() {
        let limit = ClientLimit::new(3, 0, None);
        let (a, b): (IpAddr, IpAddr) = ("203.0.113.1".parse().unwrap(), "203.0.113.2".parse().unwrap());
        for _ in 0..3 {
            limit.check(a).unwrap();
            tokio::time::advance(Duration::from_secs(10)).await;
        }
        // 第一个请求在 0 s，30 s 时还要等 30 s；被拒绝的请求不计入
        assert_eq!(limit.check(a), Err(Duration::from_secs(30)));
        assert_eq!(limit.check(a), Err(Duration::from_secs(30)));
        limit.check(b).unwrap();

        tokio::time::advance(Duration::from_secs(30)).await;
        limit.check(a).unwrap();
        assert_eq!(limit.check(a), Err(Duration::from_secs(10)));

        // 窗口全部过期的 IP 在清理时移除
        tokio::time::advance(Duration::from_secs(120)).await;
        limit.check(b).unwrap();
        assert_eq!(limit.inner.lock().unwrap().sent.len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn test_slots_per_ip_and_sweep() {
        let limit = ClientLimit::new(0, 2, None);
        let (a, b): (IpAddr, IpAddr) = ("203.0.113.1".parse().unwrap(), "203.0.113.2".parse().unwrap());
        assert!(limit.check(a).is_ok(), "--client-rate 0 never rejects");
        let held = limit.slots(a).unwrap().acquire_owned().await.unwrap();
        assert!(Arc::ptr_eq(&limit.slots(a).unwrap(), &limit.slots(a).unwrap()), "one semaphore per IP");
        assert_eq!(limit.slots(a).unwrap().available_permits(), 1);
        assert_eq!(limit.slots(b).unwrap().available_permits(), 2);

        // 清理时只保留仍有名额被占用的 IP
        tokio::time::advance(WINDOW).await;
        drop(limit.slots(a));
        assert_eq!(limit.inner.lock().unwrap().slots.keys().collect::<Vec<_>>(), [&a]);
        drop(held);
        tokio::time::advance(WINDOW).await;
        drop(limit.slots(b));
        assert_eq!(limit.inner.lock().unwrap().slots.keys().collect::<Vec<_>>(), [&b], "a swept, b just added");
        assert!(ClientLimit::new(5, 0, None).slots(a).is_none());
    }

    #[test]
    fn test_client_ip() {
        let peer: SocketAddr = "127.0.0.1:5000".parse().unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("cf-connecting-ip", "198.51.100.7".parse().unwrap());
        headers.insert("x-forwarded-for", "198.51.100.8, 10.0.0.1".parse().unwrap());

        // 没有配置请求头时不信任客户端传来的值
        assert_eq!(ClientLimit::new(1, 0, None).client_ip(&headers, Some(peer)), Some(peer.ip()));
        let cf = ClientLimit::new(1, 0, Some("cf-connecting-ip"));
        assert_eq!(cf.client_ip(&headers, Some(peer)), "198.51.100.7".parse().ok());
        let xff = ClientLimit::new(1, 0, Some("x-forwarded-for"));
        assert_eq!(xff.client_ip(&headers, Some(peer)), "198.51.100.8".parse().ok());
        // 请求头缺失或不是 IP 时退回对端地址
        assert_eq!(cf.client_ip(&HeaderMap::new(), Some(peer)), Some(peer.ip()));
        headers.insert("cf-connecting-ip", "not-an-ip".parse().unwrap());
        assert_eq!(cf.client_ip(&headers, Some(peer)), Some(peer.ip()));
        assert_eq!(cf.client_ip(&HeaderMap::new(), None), None);
    }

    #[test]
    fn test_parse_ip_header() {
        assert_eq!(parse_ip_header(" ").unwrap(), None);
        assert_eq!(parse_ip_header("CF-Connecting-IP").unwrap().as_deref(), Some("cf-connecting-ip"));
        assert!(parse_ip_header("bad header").is_err());
    }
}
