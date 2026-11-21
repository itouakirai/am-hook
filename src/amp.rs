//! Apple Music 目录接口（amp-api）代理。
//!
//! music.apple.com 的搜索页直接请求 `amp-api-edge.music.apple.com/v1/catalog/...`，
//! 需要 `Authorization: Bearer <developer token>`，且只对 `Origin: https://music.apple.com` 放行跨域，
//! 浏览器无法从本站直接调用。这里由服务端代为请求：developer token 取自 music.apple.com
//! 前端脚本中内嵌的 JWT（与网页版相同），缓存后复用，遇到 401/403 时重新获取一次。
//!
//! 为了让页面请求 `/amp` 时立即得到结果，请求路径上尽量不做任何"首次"工作：
//! - 专用 HTTP 客户端：经 ALPN 协商 HTTP/2，所有请求复用一条已握手的连接；浏览器中断请求（如输入联想被新输入取代）
//!   只重置对应 stream，不会像 HTTP/1.1 那样连带关闭连接。启用 gzip / br 压缩传输，空闲连接不主动淘汰，并发送 HTTP/2 PING 保活。
//! - 后台预热（[`run_warmer`]）：启动即获取 token、建立连接并预取地区表；之后连接空闲时定期发送轻量请求保持连接，
//!   token 按 JWT 的 `exp` 在过期前于后台刷新，刷新期间请求继续使用旧 token。
//! - 响应缓存：成功的响应按 URL 缓存（目录 5 分钟、地区表 24 小时，按字节计量的 LRU）。同一 URL 的并发请求共享一次上游请求，
//!   上游请求在独立任务中执行，浏览器中断后仍会完成并写入缓存，紧接着的相同请求直接命中。
//! - 响应头 `Server-Timing` 标明缓存命中情况与上游耗时，可在浏览器开发者工具中查看。
//!
//! 电台（station）与「为你推荐」还需要用户的 media-user-token（wrapper-lite 没有这些接口），由页面存进 HttpOnly cookie
//! （脚本、测试也可以用 `X-Media-User-Token` 请求头），服务端只转发、不保存、不缓存（[`station_assets_handler`] 等）：
//! - 个人 / 编辑电台（`playParams.format = tracks`）的接下来几首：`POST amp-api.music.apple.com/v1/me/stations/next-tracks/<id>`；
//! - 直播电台与广播单集（`format = stream`）的 HLS 地址与 license 服务器：`GET amp-api.music.apple.com/v1/play/assets`；
//! - 它们的 Widevine / PlayReady license：页面按 MusicKit 的格式构造请求体，由服务端带上两个 token 发往 Apple 的 license 服务器；
//! - 「为你推荐」（官网 /{cc}/home）：`GET amp-api.music.apple.com/v1/me/recommendations` 与各区块的 `…/<id>/view/see-all`。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, COOKIE, ORIGIN, SET_COOKIE};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::Response;
use base64::Engine;
use bytes::Bytes;
use futures::future::{BoxFuture, FutureExt, Shared};
use lru::LruCache;
use regex::Regex;
use reqwest::Client;
use serde_json::json;
use tracing::{debug, info, warn};

use crate::log;
use crate::state::AppState;

const WEB_ORIGIN: &str = "https://music.apple.com";
const API_ORIGIN: &str = "https://amp-api-edge.music.apple.com";
/// 带用户 token 的接口（`/v1/me/...`、`/v1/play/assets`）与网页版 MusicKit 一样走 amp-api，不走 edge
const USER_API_ORIGIN: &str = "https://amp-api.music.apple.com";
/// 直接调用接口（脚本、测试）时带 media-user-token 的请求头；页面用 cookie（见 [`station_token_handler`]）
pub const USER_TOKEN_HEADER: &str = "x-media-user-token";
/// 保存 media-user-token 的 HttpOnly cookie：HTTPS 下用 `__Host-` 前缀（要求 Secure、Path=/、不带 Domain），
/// HTTP（局域网直接访问）下用普通名称。与 serverless/core.mjs 相同
pub const USER_TOKEN_COOKIE: &str = "am-mut";
pub const USER_TOKEN_COOKIE_SECURE: &str = "__Host-am-mut";
/// cookie 保存半年（media-user-token 本身的有效期也在这个量级，失效后页面会请用户重填）
const USER_TOKEN_MAX_AGE: u64 = 180 * 24 * 3600;
/// license 请求体（JSON，challenge 为 base64）的上限
const MAX_LICENSE_BODY: usize = 256 * 1024;
/// 网页版每次发布都会换 token，至少按此周期重新抓取；JWT 带 `exp` 时在过期前提前刷新
const TOKEN_TTL: Duration = Duration::from_secs(12 * 3600);
const TOKEN_EXPIRY_MARGIN: Duration = Duration::from_secs(3600);
const MAX_QUERY_LEN: usize = 4096;
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(15);
/// 目录与搜索结果的缓存时间，与返回给浏览器的 `max-age` 一致
const CATALOG_TTL: Duration = Duration::from_secs(300);
/// 地区表几乎不变
const STOREFRONTS_TTL: Duration = Duration::from_secs(24 * 3600);
/// 保活请求：响应很小，同时能验证 token 仍然有效
const PING_PATH: &str = "/v1/storefronts/us";
/// amp-api 拒绝 token（401/403）时，比这更新的 token 不再丢弃重抓：刚抓到的 token 也被拒，多半不是 token 的问题，
/// 每个请求都重抓只会多打 music.apple.com
const TOKEN_MIN_AGE: Duration = Duration::from_secs(30);
/// 上游 429 后的冷却时间：首次 [`COOLDOWN_BASE`]，连续 429 时翻倍，不超过 [`COOLDOWN_MAX`]，另加 0–25% 抖动
const COOLDOWN_BASE: Duration = Duration::from_secs(60);
const COOLDOWN_MAX: Duration = Duration::from_secs(1800);
/// 未开启保活时，后台检查 token 是否需要刷新的周期
const TOKEN_CHECK_INTERVAL: Duration = Duration::from_secs(60);

static SCRIPT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"src="(/assets/index[~-][0-9A-Za-z_-]+\.js)""#).unwrap());
static JWT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"eyJ[0-9A-Za-z_-]{10,}\.eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}").unwrap());

/// amp-api 代理：专用连接、developer token 与响应缓存
pub struct Amp {
    client: Client,
    /// 带用户 token 的请求：不跟随重定向（license 服务器地址来自页面，token 不能被带到别处）
    user_client: Client,
    token: DeveloperToken,
    cache: ResponseCache,
    /// 上游 429 后按主机暂停转发
    cooldown: Cooldown,
    epoch: Instant,
    /// 最近一次 amp-api 请求（含保活）开始的时间（相对 `epoch` 的毫秒数），保活只在连接空闲时发送
    last_request_ms: AtomicU64,
}

impl Amp {
    /// `cache_bytes` 为 0 时不缓存响应，但并发的相同请求仍只请求一次上游
    pub fn new(cache_bytes: usize) -> Self {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .tcp_nodelay(true)
            .tcp_keepalive(Duration::from_secs(30))
            .pool_idle_timeout(None)
            .http2_keep_alive_interval(Duration::from_secs(20))
            .http2_keep_alive_timeout(Duration::from_secs(10))
            .http2_keep_alive_while_idle(true)
            .build()
            .expect("Failed to build amp-api HTTP client");
        let user_client = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .tcp_nodelay(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("Failed to build amp-api user HTTP client");
        Self {
            client,
            user_client,
            token: DeveloperToken::default(),
            cache: ResponseCache::new(cache_bytes),
            cooldown: Cooldown::default(),
            epoch: Instant::now(),
            last_request_ms: AtomicU64::new(0),
        }
    }

    fn idle_for(&self) -> Duration {
        let now = self.epoch.elapsed().as_millis() as u64;
        Duration::from_millis(now.saturating_sub(self.last_request_ms.load(Ordering::Relaxed)))
    }

    /// 取得 `url` 的响应：先查缓存，再加入同一 URL 进行中的请求，都没有时在独立任务中发起请求
    async fn fetch(self: &Arc<Self>, url: String, ttl: Duration) -> (Lookup, Result<Arc<Upstream>, String>) {
        if let Some(hit) = self.cache.get(&url) {
            return (Lookup::Hit, Ok(hit));
        }
        let (pending, lookup) = {
            let mut inflight = self.cache.inflight.lock().unwrap();
            match inflight.get(&url) {
                Some(pending) => (pending.clone(), Lookup::Shared),
                None => {
                    let amp = self.clone();
                    let key = url.clone();
                    let task = tokio::spawn(async move {
                        // 持有 inflight 锁期间插入，任务结束（含 panic）时移除，因此不会删掉后来者的条目
                        let _done = InflightGuard(amp.clone(), key.clone());
                        let result = amp.request(&key, ttl).await.map(Arc::new);
                        if let Ok(upstream) = &result {
                            amp.cache.put(&key, upstream.clone());
                        }
                        result
                    });
                    let pending = task
                        .map(|joined| joined.unwrap_or_else(|e| Err(format!("amp-api task failed: {e}"))))
                        .boxed()
                        .shared();
                    inflight.insert(url, pending.clone());
                    (pending, Lookup::Miss)
                }
            }
        };
        (lookup, pending.await)
    }

    /// 带 developer token 请求 amp-api；token 失效（401/403）时重新获取一次（token 刚抓到不久时不重抓）。
    /// 冷却期内（上游刚返回过 429）不请求上游，直接返回本地构造的 429
    async fn request(&self, url: &str, ttl: Duration) -> Result<Upstream, String> {
        let host = host_of(url);
        if let Some(wait) = self.cooldown.remaining(&host, Instant::now()) {
            return Ok(Upstream::rate_limited(wait));
        }
        let mut retried = false;
        loop {
            let token = self.token.get(&self.client).await.map_err(|e| format!("developer token unavailable: {e}"))?;
            self.last_request_ms.store(self.epoch.elapsed().as_millis() as u64, Ordering::Relaxed);
            let started = Instant::now();
            let response = self
                .client
                .get(url)
                .bearer_auth(&*token)
                .header(reqwest::header::ORIGIN, WEB_ORIGIN)
                .header(reqwest::header::REFERER, format!("{WEB_ORIGIN}/"))
                .header(reqwest::header::ACCEPT, "application/json")
                .timeout(UPSTREAM_TIMEOUT)
                .send()
                .await
                .map_err(|e| format!("amp-api request failed: {e}"))?;
            let status = response.status();
            if status.as_u16() == 429 {
                return Ok(self.throttled(&host));
            }
            self.cooldown.clear(&host, Instant::now());
            if matches!(status.as_u16(), 401 | 403) && !retried && self.token.invalidate(&token, Instant::now()) {
                info!(%status, "amp-api rejected the developer token, fetching a new one");
                retried = true;
                continue;
            }
            let version = response.version();
            let body = response.bytes().await.map_err(|e| format!("failed to read amp-api response: {e}"))?;
            return Ok(Upstream {
                status: StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
                body,
                expires_at: Instant::now() + ttl,
                elapsed: started.elapsed(),
                version,
                retry_after: None,
            });
        }
    }

    /// 上游返回 429：Apple 按出口 IP 限流，换 token 无用，继续转发只会延长限流。进入冷却并返回本地构造的 429，
    /// 上游响应体丢弃。amp-api 的 429 不带 `Retry-After`，冷却时间全由本地退避决定
    fn throttled(&self, host: &str) -> Upstream {
        let wait = self.cooldown.strike(host, Instant::now(), jitter());
        warn!(host, cooldown = ?wait, "Apple returned HTTP 429, pausing requests to this host");
        Upstream::rate_limited(wait)
    }
}

impl Amp {
    /// 带 developer token 与用户的 media-user-token 请求（不缓存）。401 / 403 多半是 media-user-token 失效，
    /// 不像目录请求那样换 developer token 重试（后台预热会在 developer token 过期前刷新）。
    /// `license` 为 `Some(renewal)` 时按 MusicKit 的 license 请求发送（`X-Apple-Music-User-Token`，
    /// Widevine 时另带 `X-Apple-Renewal: true`）
    async fn user_request(
        &self,
        method: reqwest::Method,
        url: &str,
        user_token: &str,
        body: Option<Bytes>,
        license: Option<bool>,
    ) -> Result<Upstream, String> {
        let host = host_of(url);
        if let Some(wait) = self.cooldown.remaining(&host, Instant::now()) {
            return Ok(Upstream::rate_limited(wait));
        }
        let token = self.token.get(&self.client).await.map_err(|e| format!("developer token unavailable: {e}"))?;
        let started = Instant::now();
        let mut request = self
            .user_client
            .request(method, url)
            .bearer_auth(&*token)
            .header(reqwest::header::ORIGIN, WEB_ORIGIN)
            .header(reqwest::header::REFERER, format!("{WEB_ORIGIN}/"))
            .header(reqwest::header::ACCEPT, "application/json")
            .timeout(UPSTREAM_TIMEOUT);
        request = match license {
            Some(renewal) => {
                let request = request.header("x-apple-music-user-token", user_token);
                if renewal { request.header("x-apple-renewal", "true") } else { request }
            }
            None => request.header("media-user-token", user_token),
        };
        if let Some(body) = body {
            request = request.header(CONTENT_TYPE, "application/json").body(body);
        }
        let response = request.send().await.map_err(|e| format!("Apple request failed: {e}"))?;
        let status = response.status();
        if status.as_u16() == 429 {
            return Ok(self.throttled(&host));
        }
        self.cooldown.clear(&host, Instant::now());
        let version = response.version();
        let body = response.bytes().await.map_err(|e| format!("failed to read Apple response: {e}"))?;
        Ok(Upstream {
            status: StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            body,
            expires_at: Instant::now(),
            elapsed: started.elapsed(),
            version,
            retry_after: None,
        })
    }
}

/// 缓存查找结果，写入 `Server-Timing`
#[derive(Clone, Copy)]
enum Lookup {
    /// 命中缓存
    Hit,
    /// 加入了同一 URL 进行中的上游请求
    Shared,
    /// 发起了新的上游请求
    Miss,
}

impl Lookup {
    fn as_str(self) -> &'static str {
        match self {
            Lookup::Hit => "hit",
            Lookup::Shared => "shared",
            Lookup::Miss => "miss",
        }
    }
}

/// 一次上游响应
struct Upstream {
    status: StatusCode,
    body: Bytes,
    expires_at: Instant,
    elapsed: Duration,
    version: reqwest::Version,
    /// 本地构造的 429：还要等多久（写入 `Retry-After`）
    retry_after: Option<Duration>,
}

impl Upstream {
    /// 冷却期内代替上游返回的 429（不缓存）
    fn rate_limited(wait: Duration) -> Self {
        let secs = retry_after_secs(wait);
        let body = json!({ "code": 1, "msg": format!("Apple rate limited this server; retry in {secs} s") });
        Upstream {
            status: StatusCode::TOO_MANY_REQUESTS,
            body: Bytes::from(body.to_string()),
            expires_at: Instant::now(),
            elapsed: Duration::ZERO,
            version: reqwest::Version::HTTP_11,
            retry_after: Some(wait),
        }
    }
}

fn retry_after_secs(wait: Duration) -> u64 {
    wait.as_secs_f64().ceil().max(1.0) as u64
}

fn host_of(url: &str) -> String {
    reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_default()
}

/// [0, 1) 的随机数（每个 `RandomState` 的种子不同），用于退避抖动
fn jitter() -> f64 {
    use std::hash::{BuildHasher, Hasher};
    let bits = std::collections::hash_map::RandomState::new().build_hasher().finish();
    (bits >> 11) as f64 / (1u64 << 53) as f64
}

type Pending = Shared<BoxFuture<'static, Result<Arc<Upstream>, String>>>;

/// 成功响应的按字节计量 LRU 缓存 + 同一 URL 进行中的请求
struct ResponseCache {
    lru: Mutex<(LruCache<String, Arc<Upstream>>, usize)>,
    capacity: usize,
    inflight: Mutex<HashMap<String, Pending>>,
}

impl ResponseCache {
    fn new(capacity: usize) -> Self {
        Self { lru: Mutex::new((LruCache::unbounded(), 0)), capacity, inflight: Mutex::default() }
    }

    fn get(&self, url: &str) -> Option<Arc<Upstream>> {
        let mut guard = self.lru.lock().unwrap();
        let (lru, used) = &mut *guard;
        let entry = lru.get(url)?.clone();
        if entry.expires_at > Instant::now() {
            return Some(entry);
        }
        lru.pop(url);
        *used -= entry.body.len();
        None
    }

    fn put(&self, url: &str, upstream: Arc<Upstream>) {
        if !upstream.status.is_success() || upstream.body.len() > self.capacity {
            return;
        }
        let mut guard = self.lru.lock().unwrap();
        let (lru, used) = &mut *guard;
        *used += upstream.body.len();
        if let Some(old) = lru.put(url.to_owned(), upstream) {
            *used -= old.body.len();
        }
        while *used > self.capacity {
            match lru.pop_lru() {
                Some((_, old)) => *used -= old.body.len(),
                None => break,
            }
        }
    }
}

struct InflightGuard(Arc<Amp>, String);

impl Drop for InflightGuard {
    fn drop(&mut self) {
        self.0.cache.inflight.lock().unwrap().remove(&self.1);
    }
}

/// 上游 429 后按主机暂停转发：冷却期内直接返回本地的 429，不再请求该主机。冷却期间仍在途的请求陆续返回 429 只算一次；
/// 冷却结束后再遇到 429 时退避翻倍，收到非 429 响应后归零。
/// 抖动避免冷却结束时所有浏览器按同一 `Retry-After` 同时重试。
#[derive(Default)]
struct Cooldown {
    hosts: Mutex<HashMap<String, HostCooldown>>,
}

struct HostCooldown {
    until: Instant,
    strikes: u32,
}

impl Cooldown {
    fn remaining(&self, host: &str, now: Instant) -> Option<Duration> {
        let until = self.hosts.lock().unwrap().get(host)?.until;
        (until > now).then(|| until - now)
    }

    /// 记一次 429，返回冷却时间；`jitter` 在 [0, 1)
    fn strike(&self, host: &str, now: Instant, jitter: f64) -> Duration {
        let mut hosts = self.hosts.lock().unwrap();
        let entry = hosts.entry(host.to_owned()).or_insert(HostCooldown { until: now, strikes: 0 });
        if entry.until > now {
            return entry.until - now;
        }
        entry.strikes = (entry.strikes + 1).min(16);
        let base = COOLDOWN_BASE.saturating_mul(1 << (entry.strikes - 1)).min(COOLDOWN_MAX);
        let wait = base + base.mul_f64(jitter.clamp(0.0, 1.0) * 0.25);
        entry.until = now + wait;
        wait
    }

    /// 上游正常响应：冷却已结束时清除退避等级（冷却前发出、之后才返回的请求不算）
    fn clear(&self, host: &str, now: Instant) {
        let mut hosts = self.hosts.lock().unwrap();
        if hosts.get(host).is_some_and(|e| e.until <= now) {
            hosts.remove(host);
        }
    }
}

struct Token {
    value: Arc<str>,
    refresh_at: Instant,
    fetched_at: Instant,
}

/// 缓存的 developer token。抓取过程持有锁，并发请求只会抓取一次；后台刷新期间请求继续使用旧 token。
#[derive(Default)]
struct DeveloperToken {
    current: RwLock<Option<Token>>,
    fetching: tokio::sync::Mutex<()>,
}

impl DeveloperToken {
    /// 已有 token 时直接返回（即使到了刷新时间，刷新由后台完成，过期则由 401 触发重新获取）
    async fn get(&self, client: &Client) -> Result<Arc<str>, String> {
        if let Some(token) = self.cached() {
            return Ok(token);
        }
        let _fetching = self.fetching.lock().await;
        if let Some(token) = self.cached() {
            return Ok(token);
        }
        self.fetch(client).await
    }

    fn cached(&self) -> Option<Arc<str>> {
        self.current.read().unwrap().as_ref().map(|t| t.value.clone())
    }

    fn needs_refresh(&self) -> bool {
        self.current.read().unwrap().as_ref().is_none_or(|t| Instant::now() >= t.refresh_at)
    }

    /// 后台刷新；其他请求在此期间继续使用旧 token
    async fn refresh(&self, client: &Client) -> Result<(), String> {
        let _fetching = self.fetching.lock().await;
        if self.needs_refresh() {
            self.fetch(client).await?;
        }
        Ok(())
    }

    /// 调用方需持有 `fetching`
    async fn fetch(&self, client: &Client) -> Result<Arc<str>, String> {
        let value: Arc<str> = fetch_developer_token(client).await?.into();
        let now_unix = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
        let refresh_in = refresh_delay(&value, now_unix);
        info!(refresh_in = %format!("{} min", refresh_in.as_secs() / 60), "Fetched Apple Music web developer token");
        *self.current.write().unwrap() = Some(Token { value: value.clone(), refresh_at: Instant::now() + refresh_in, fetched_at: Instant::now() });
        Ok(value)
    }

    /// 丢弃失效的 token，返回是否值得用新 token 重试：缓存已被其他请求换成新 token（或已丢弃）时为 true；
    /// 被拒的正是缓存中的 token 时，只有抓到超过 [`TOKEN_MIN_AGE`] 才丢弃，否则保留并返回 false
    fn invalidate(&self, token: &str, now: Instant) -> bool {
        let mut current = self.current.write().unwrap();
        match current.as_ref() {
            Some(t) if &*t.value == token => {
                if now.duration_since(t.fetched_at) < TOKEN_MIN_AGE {
                    return false;
                }
                *current = None;
                true
            }
            _ => true,
        }
    }
}

/// 距下次刷新的时间：不超过 [`TOKEN_TTL`]，JWT 带 `exp` 时提前 [`TOKEN_EXPIRY_MARGIN`]，至少 1 分钟
fn refresh_delay(token: &str, now_unix: u64) -> Duration {
    let until_expiry = token_expiry(token)
        .map(|exp| Duration::from_secs(exp.saturating_sub(now_unix)).saturating_sub(TOKEN_EXPIRY_MARGIN));
    until_expiry.map_or(TOKEN_TTL, |d| d.min(TOKEN_TTL)).max(Duration::from_secs(60))
}

/// JWT payload 中的 `exp`（Unix 秒）
fn token_expiry(token: &str) -> Option<u64> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    serde_json::from_slice::<serde_json::Value>(&bytes).ok()?.get("exp")?.as_u64()
}

/// 从 music.apple.com 页面找到主脚本 `index~<hash>.js`，取出其中内嵌的 JWT
async fn fetch_developer_token(client: &Client) -> Result<String, String> {
    let page = fetch_text(client, &format!("{WEB_ORIGIN}/us/browse")).await?;
    let script = extract_script_path(&page).ok_or("main script not found on music.apple.com")?;
    let js = fetch_text(client, &format!("{WEB_ORIGIN}{script}")).await?;
    extract_token(&js).map(str::to_owned).ok_or_else(|| "developer token not found in music.apple.com script".into())
}

async fn fetch_text(client: &Client, url: &str) -> Result<String, String> {
    client
        .get(url)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| format!("request to {url} failed: {e}"))?
        .text()
        .await
        .map_err(|e| format!("failed to read {url}: {e}"))
}

fn extract_script_path(html: &str) -> Option<&str> {
    SCRIPT_RE.captures(html).and_then(|c| c.get(1)).map(|m| m.as_str())
}

/// 脚本里第一个 JWT 即网页版 MusicKit 使用的 developer token
fn extract_token(js: &str) -> Option<&str> {
    JWT_RE.find(js).map(|m| m.as_str())
}

/// 后台预热：启动后立即获取 token、建立到 amp-api 的连接并预取地区表（页面首次加载即会请求它）。
/// 之后每个周期检查 token 是否需要刷新；`keepalive` 非零时，连接空闲超过半个周期就发送一次轻量请求，
/// 保持连接与 TLS 会话，同时尽早发现 token 失效。
pub async fn run_warmer(amp: Arc<Amp>, keepalive: Duration) {
    let started = Instant::now();
    match amp.fetch(api_url("/v1/storefronts", ""), STOREFRONTS_TTL).await.1 {
        Ok(up) if up.status.is_success() => {
            info!(version = ?up.version, elapsed = ?started.elapsed(), "amp-api connection ready");
        }
        Ok(up) => warn!(status = %up.status, "amp-api warm-up request failed"),
        Err(e) => warn!(error = %e, "amp-api warm-up failed"),
    }

    let period = if keepalive.is_zero() { TOKEN_CHECK_INTERVAL } else { keepalive };
    let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut refresh_failing = false;
    loop {
        ticker.tick().await;
        if amp.token.needs_refresh() {
            match amp.token.refresh(&amp.client).await {
                Ok(()) => refresh_failing = false,
                // 持续失败（如断网）时只在第一次告警，之后每个周期静默重试
                Err(e) if !refresh_failing => {
                    refresh_failing = true;
                    warn!(error = %e, "Developer token refresh failed, retrying in the background");
                }
                Err(e) => debug!(error = %e, "Developer token refresh failed"),
            }
        }
        if !keepalive.is_zero() && amp.idle_for() >= keepalive / 2 {
            match amp.request(&api_url(PING_PATH, ""), Duration::ZERO).await {
                Ok(up) => debug!(status = %up.status, version = ?up.version, elapsed = ?up.elapsed, "amp-api keep-alive"),
                Err(e) => debug!(error = %e, "amp-api keep-alive failed"),
            }
        }
    }
}

fn api_url(path: &str, query: &str) -> String {
    api_url_at(API_ORIGIN, path, query)
}

fn api_url_at(origin: &str, path: &str, query: &str) -> String {
    let mut url = format!("{origin}{path}");
    if !query.is_empty() {
        url.push('?');
        url.push_str(query);
    }
    url
}

/// 目录路径只允许 amp-api 资源路径中出现的字符，拒绝 `..`
fn valid_catalog_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 512
        && !path.contains("..")
        && path.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.,:/".contains(&b))
}

/// `GET /amp/v1/catalog/<path>?<query>` → `amp-api-edge.music.apple.com/v1/catalog/<path>?<query>`。
/// 查询参数原样转发，前端可直接请求搜索结果里的 `next` 分页地址（加上 `/amp` 前缀）。
pub async fn catalog_handler(State(state): State<Arc<AppState>>, Path(path): Path<String>, uri: Uri) -> Response<Body> {
    if !valid_catalog_path(&path) {
        return error(StatusCode::BAD_REQUEST, "Invalid catalog path");
    }
    let query = uri.query().unwrap_or_default();
    if query.len() > MAX_QUERY_LEN {
        return error(StatusCode::BAD_REQUEST, "Query too long");
    }
    forward(&state, api_url(&format!("/v1/catalog/{path}"), query), CATALOG_TTL).await
}

/// `GET /amp/v1/editorial/<path>?<query>` → `amp-api-edge.music.apple.com/v1/editorial/<path>?<query>`。
/// music.apple.com 的「新发现」页（groupings?name=music）、分组页（groupings/<id>）、room 与 multi-room 页的编辑内容都在这里，
/// 与目录接口一样按 URL 缓存；分页地址（rooms/<id>/contents?offset=）同样可直接加上 `/amp` 前缀请求。
pub async fn editorial_handler(State(state): State<Arc<AppState>>, Path(path): Path<String>, uri: Uri) -> Response<Body> {
    if !valid_catalog_path(&path) {
        return error(StatusCode::BAD_REQUEST, "Invalid editorial path");
    }
    let query = uri.query().unwrap_or_default();
    if query.len() > MAX_QUERY_LEN {
        return error(StatusCode::BAD_REQUEST, "Query too long");
    }
    forward(&state, api_url(&format!("/v1/editorial/{path}"), query), CATALOG_TTL).await
}

/// 推荐接口只开放地区根路径（`/v1/recommendations/<cc>`），不转发 `personal-recommendation/<id>` 等子路径
fn valid_storefront(cc: &str) -> bool {
    cc.len() == 2 && cc.bytes().all(|b| b.is_ascii_lowercase())
}

/// `GET /amp/v1/recommendations/<cc>?<query>` → `amp-api-edge.music.apple.com/v1/recommendations/<cc>?<query>`。
/// music.apple.com 搜索页的「类别浏览」（官网 SearchLandingPageIntent：`name=search-landing`）。
/// 只带 developer token，内容与访问者无关，与目录接口一样按 URL 缓存。
pub async fn recommendations_handler(State(state): State<Arc<AppState>>, Path(cc): Path<String>, uri: Uri) -> Response<Body> {
    if !valid_storefront(&cc) {
        return error(StatusCode::BAD_REQUEST, "Invalid storefront");
    }
    let query = uri.query().unwrap_or_default();
    if query.len() > MAX_QUERY_LEN {
        return error(StatusCode::BAD_REQUEST, "Query too long");
    }
    forward(&state, api_url(&format!("/v1/recommendations/{cc}"), query), CATALOG_TTL).await
}

/// `GET /amp/v1/storefronts?<query>` → 全部地区信息。前端据各地区的 `supportedLanguageTags` 选择 `l`：
/// 地区不支持的语言不会报错，而是静默回退到默认语言（如 cn 只支持 zh-Hans-CN / en-GB，传 en-US 返回中文）。
/// 数据几乎不变，前端取一次后缓存在 localStorage；查询参数原样转发，以便跟随分页 `next`。
pub async fn storefronts_handler(State(state): State<Arc<AppState>>, uri: Uri) -> Response<Body> {
    let query = uri.query().unwrap_or_default();
    if query.len() > MAX_QUERY_LEN {
        return error(StatusCode::BAD_REQUEST, "Query too long");
    }
    forward(&state, api_url("/v1/storefronts", query), STOREFRONTS_TTL).await
}

/* ---------- 电台：需要 media-user-token 的接口 ---------- */

/// 可见 ASCII，且不含 cookie 值里不允许的 `" , ; \\`
fn valid_user_token(token: &str) -> bool {
    !token.is_empty() && token.len() <= 4096 && token.bytes().all(|b| b.is_ascii_graphic() && !b"\",;\\".contains(&b))
}

/// 请求带来的 media-user-token：先取 cookie，没有时取 `X-Media-User-Token` 请求头；缺失或含非法字符时为 None
fn user_token(headers: &HeaderMap) -> Option<&str> {
    let cookie = headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|pair| {
            let (name, value) = pair.trim().split_once('=')?;
            (name == USER_TOKEN_COOKIE_SECURE || name == USER_TOKEN_COOKIE).then_some(value.trim())
        });
    let token = match cookie {
        Some(token) => token,
        None => headers.get(USER_TOKEN_HEADER)?.to_str().ok()?.trim(),
    };
    valid_user_token(token).then_some(token)
}

/// 带 `Sec-Fetch-Site` 时必须是本站页面发起的（其他网站不能替用户换掉或清除 token）
fn same_origin(headers: &HeaderMap) -> bool {
    headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()).is_none_or(|v| v == "same-origin")
}

/// 页面经 HTTPS 打开（直接或经反向代理）：cookie 加 Secure 与 `__Host-` 前缀
fn https_request(headers: &HeaderMap) -> bool {
    let header = |name| headers.get(name).and_then(|v: &axum::http::HeaderValue| v.to_str().ok()).unwrap_or_default();
    header(ORIGIN.as_str()).starts_with("https://") || header("x-forwarded-proto").eq_ignore_ascii_case("https")
}

fn token_cookie(value: &str, max_age: u64, secure: bool) -> String {
    let name = if secure { USER_TOKEN_COOKIE_SECURE } else { USER_TOKEN_COOKIE };
    let secure = if secure { "; Secure" } else { "" };
    format!("{name}={value}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Strict{secure}")
}

fn token_response(cookies: &[String]) -> Response<Body> {
    let mut builder = Response::builder().status(StatusCode::NO_CONTENT).header(CACHE_CONTROL, "no-store");
    for cookie in cookies {
        builder = builder.header(SET_COOKIE, cookie);
    }
    builder.body(Body::empty()).unwrap()
}

#[derive(serde::Deserialize)]
pub struct StationToken {
    token: String,
}

/// `POST /station/token`（`{ "token": "…" }`）：把 media-user-token 存进 HttpOnly cookie，之后的电台请求由浏览器自动带上。
/// token 不再保存在页面脚本能读到的地方；服务端仍然不保存、不记录
pub async fn station_token_handler(headers: HeaderMap, body: Bytes) -> Response<Body> {
    if !same_origin(&headers) {
        return error(StatusCode::FORBIDDEN, "Cross-site request");
    }
    let Ok(request) = serde_json::from_slice::<StationToken>(&body) else {
        return error(StatusCode::BAD_REQUEST, "Invalid token request");
    };
    let token = request.token.trim();
    if !valid_user_token(token) {
        return error(StatusCode::BAD_REQUEST, "Invalid media-user-token");
    }
    token_response(&[token_cookie(token, USER_TOKEN_MAX_AGE, https_request(&headers))])
}

/// `DELETE /station/token`：清除 cookie（两种名称都清；HTTP 下浏览器会忽略带 Secure 的那条，本来也不存在）
pub async fn station_token_clear_handler(headers: HeaderMap) -> Response<Body> {
    if !same_origin(&headers) {
        return error(StatusCode::FORBIDDEN, "Cross-site request");
    }
    token_response(&[token_cookie("", 0, false), token_cookie("", 0, true)])
}

/// 电台 ID：编辑 / 直播电台为 `ra.<数字>`，个人电台为 `ra.u-<…>` 等
pub fn valid_station_id(id: &str) -> bool {
    id.len() > 3
        && id.len() <= 128
        && id.starts_with("ra.")
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

fn missing_user_token() -> Response<Body> {
    error(StatusCode::UNAUTHORIZED, "media-user-token required")
}

/// 原样返回上游的状态码与 JSON，不缓存
async fn forward_user(
    state: &AppState,
    method: reqwest::Method,
    url: String,
    token: &str,
    body: Option<Bytes>,
    license: Option<bool>,
) -> Response<Body> {
    let upstream = match state.amp.user_request(method, &url, token, body, license).await {
        Ok(upstream) => upstream,
        Err(msg) => return error(StatusCode::BAD_GATEWAY, &msg),
    };
    let status = upstream.status;
    let note = if status.is_success() { String::new() } else { api_error_summary(&upstream.body) };
    let response = Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json; charset=utf-8")
        .header(CACHE_CONTROL, "no-store")
        .header("server-timing", format!("upstream;dur={:.1}", upstream.elapsed.as_secs_f64() * 1000.0))
        .body(Body::from(upstream.body))
        .unwrap();
    log::note(with_retry_after(response, upstream.retry_after), note)
}

/// `GET /station/assets?<playParams>` → `amp-api.music.apple.com/v1/play/assets?<playParams>`：
/// 直播电台与广播单集的 HLS 地址与 license 服务器（MusicKit 的 resolveRadioStationAsset，查询参数为 playParams 加 `keyFormat=web`）
pub async fn station_assets_handler(State(state): State<Arc<AppState>>, headers: HeaderMap, uri: Uri) -> Response<Body> {
    let Some(token) = user_token(&headers) else { return missing_user_token() };
    let query = uri.query().unwrap_or_default();
    if query.is_empty() || query.len() > MAX_QUERY_LEN {
        return error(StatusCode::BAD_REQUEST, "Invalid play assets query");
    }
    let url = format!("{USER_API_ORIGIN}/v1/play/assets?{query}");
    forward_user(&state, reqwest::Method::GET, url, token, None, None).await
}

/// `POST /station/next-tracks/<id>?<query>` → `amp-api.music.apple.com/v1/me/stations/next-tracks/<id>`：
/// 个人 / 编辑电台接下来要播放的几首（MusicKit 的 loadStationNextTracks）
pub async fn station_next_tracks_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    uri: Uri,
) -> Response<Body> {
    let Some(token) = user_token(&headers) else { return missing_user_token() };
    if !valid_station_id(&id) {
        return error(StatusCode::BAD_REQUEST, "Invalid station id");
    }
    let query = uri.query().unwrap_or_default();
    if query.len() > MAX_QUERY_LEN {
        return error(StatusCode::BAD_REQUEST, "Query too long");
    }
    let url = api_url_at(USER_API_ORIGIN, &format!("/v1/me/stations/next-tracks/{id}"), query);
    forward_user(&state, reqwest::Method::POST, url, token, None, None).await
}

/// `GET /station/catalog/<path>?<query>` → `amp-api.music.apple.com/v1/catalog/<path>`（带用户 token，不缓存）：
/// 个人电台（`stations?filter[identity]=personal`，官网 /station/me）等因人而异的目录数据
pub async fn station_catalog_handler(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
    headers: HeaderMap,
    uri: Uri,
) -> Response<Body> {
    let Some(token) = user_token(&headers) else { return missing_user_token() };
    if !valid_catalog_path(&path) {
        return error(StatusCode::BAD_REQUEST, "Invalid catalog path");
    }
    let query = uri.query().unwrap_or_default();
    if query.len() > MAX_QUERY_LEN {
        return error(StatusCode::BAD_REQUEST, "Query too long");
    }
    let url = api_url_at(USER_API_ORIGIN, &format!("/v1/catalog/{path}"), query);
    forward_user(&state, reqwest::Method::GET, url, token, None, None).await
}

/// `GET /station/recent?<query>` → `amp-api.music.apple.com/v1/me/recent/radio-stations`：广播页的「最近播放」（官网 recently-played-radio-shelf）
pub async fn station_recent_handler(State(state): State<Arc<AppState>>, headers: HeaderMap, uri: Uri) -> Response<Body> {
    let Some(token) = user_token(&headers) else { return missing_user_token() };
    let query = uri.query().unwrap_or_default();
    if query.len() > MAX_QUERY_LEN {
        return error(StatusCode::BAD_REQUEST, "Query too long");
    }
    let url = api_url_at(USER_API_ORIGIN, "/v1/me/recent/radio-stations", query);
    forward_user(&state, reqwest::Method::GET, url, token, None, None).await
}

/// 「为你推荐」的推荐 ID（`personal-recommendation` 资源，形如 `7-2Tqlz47h9yro`）
pub fn valid_recommendation_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

/// `GET /station/recommendations?<query>` → `amp-api.music.apple.com/v1/me/recommendations`：
/// 「为你推荐」（官网 /{cc}/home 的 ListenNowPageIntent，`name=listen-now`），内容随账号而定
pub async fn station_recommendations_handler(State(state): State<Arc<AppState>>, headers: HeaderMap, uri: Uri) -> Response<Body> {
    let Some(token) = user_token(&headers) else { return missing_user_token() };
    let query = uri.query().unwrap_or_default();
    if query.len() > MAX_QUERY_LEN {
        return error(StatusCode::BAD_REQUEST, "Query too long");
    }
    let url = api_url_at(USER_API_ORIGIN, "/v1/me/recommendations", query);
    forward_user(&state, reqwest::Method::GET, url, token, None, None).await
}

/// `GET /station/recommendations/<id>/see-all?<query>` → `amp-api.music.apple.com/v1/me/recommendations/<id>/view/see-all`：
/// 「为你推荐」区块的「查看全部」（官网 ListenNowSeeAllPageIntent）
pub async fn station_recommendation_see_all_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    uri: Uri,
) -> Response<Body> {
    let Some(token) = user_token(&headers) else { return missing_user_token() };
    if !valid_recommendation_id(&id) {
        return error(StatusCode::BAD_REQUEST, "Invalid recommendation id");
    }
    let query = uri.query().unwrap_or_default();
    if query.len() > MAX_QUERY_LEN {
        return error(StatusCode::BAD_REQUEST, "Query too long");
    }
    let url = api_url_at(USER_API_ORIGIN, &format!("/v1/me/recommendations/{id}/view/see-all"), query);
    forward_user(&state, reqwest::Method::GET, url, token, None, None).await
}

/// `GET /station/storefront` → `amp-api.music.apple.com/v1/me/storefront`：页面据此检验填入的 media-user-token，并显示账号地区
pub async fn station_storefront_handler(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response<Body> {
    let Some(token) = user_token(&headers) else { return missing_user_token() };
    forward_user(&state, reqwest::Method::GET, format!("{USER_API_ORIGIN}/v1/me/storefront"), token, None, None).await
}

#[derive(serde::Deserialize)]
pub struct StationLicense {
    /// `/v1/play/assets` 返回的 `keyServerUrl`
    url: String,
    /// 原样发给 license 服务器的 JSON（challenge、uri、key-system 等，格式按服务器地址选择，见 station.mjs）
    body: serde_json::Value,
    /// Widevine 的请求（MusicKit 此时带 `X-Apple-Renewal: true`）
    #[serde(default)]
    renewal: bool,
}

/// 电台 license 服务器：Apple 的 HTTPS 地址，路径为 MusicKit 认识的几种 license 接口之一
fn valid_license_url(raw: &str) -> bool {
    const PATHS: [&str; 7] = [
        "/WebObjects/MZPlay.woa/wa/acquireWebPlaybackLicense",
        "/WebObjects/MZPlay.woa/web/radio/versions/1/license",
        "/v1/radio/streaming-key-delivery",
        "/v1/hls/streaming-key-delivery",
        "/WebObjects/MZPlay.woa/wa/fpsRequest",
        "/WebObjects/MZPlayLocal.woa/wa/fpsRequest",
        "/WebObjects/MZPlay.woa/podcast/hls/license/streaming/start",
    ];
    reqwest::Url::parse(raw)
        .ok()
        .is_some_and(|url| crate::state::is_apple_https(&url) && PATHS.iter().any(|p| url.path().ends_with(p)))
}

/// `POST /station/license`：`{ url, body }` → 带 developer token 与 media-user-token 把 `body` POST 给 `url`，原样返回响应。
/// wrapper-lite 的 `/license` 不支持电台的 license，由这里直接请求 Apple
pub async fn station_license_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response<Body> {
    let Some(token) = user_token(&headers) else { return missing_user_token() };
    if body.len() > MAX_LICENSE_BODY {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "License request too large");
    }
    let Ok(request) = serde_json::from_slice::<StationLicense>(&body) else {
        return error(StatusCode::BAD_REQUEST, "Invalid license request");
    };
    if !valid_license_url(&request.url) || !request.body.is_object() {
        return error(StatusCode::BAD_REQUEST, "Invalid license request");
    }
    let payload = Bytes::from(request.body.to_string());
    forward_user(&state, reqwest::Method::POST, request.url, token, Some(payload), Some(request.renewal)).await
}

/// 原样返回 amp-api 的状态码与 JSON；成功响应的 `max-age` 为缓存剩余时间
async fn forward(state: &AppState, url: String, ttl: Duration) -> Response<Body> {
    let (lookup, result) = state.amp.fetch(url, ttl).await;
    let upstream = match result {
        Ok(upstream) => upstream,
        Err(msg) => return error(StatusCode::BAD_GATEWAY, &msg),
    };
    let status = upstream.status;
    let cache = if status.is_success() {
        let remaining = upstream.expires_at.saturating_duration_since(Instant::now());
        format!("private, max-age={}", remaining.as_secs())
    } else {
        "no-store".to_owned()
    };
    let mut timing = format!("cache;desc={}", lookup.as_str());
    if !matches!(lookup, Lookup::Hit) {
        timing.push_str(&format!(", upstream;dur={:.1}", upstream.elapsed.as_secs_f64() * 1000.0));
    }
    let note = match lookup {
        _ if !status.is_success() => api_error_summary(&upstream.body),
        Lookup::Hit => "cached".to_owned(),
        _ => String::new(),
    };
    let response = Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json; charset=utf-8")
        .header(CACHE_CONTROL, cache)
        .header("server-timing", timing)
        .body(Body::from(upstream.body.clone()))
        .unwrap();
    log::note(with_retry_after(response, upstream.retry_after), note)
}

fn with_retry_after(mut response: Response<Body>, wait: Option<Duration>) -> Response<Body> {
    if let Some(wait) = wait {
        response.headers_mut().insert(axum::http::header::RETRY_AFTER, retry_after_secs(wait).into());
    }
    response
}

/// amp-api 错误响应 `{"errors":[{"title","detail"}]}` 的首条说明，供请求日志输出
fn api_error_summary(body: &[u8]) -> String {
    let value: serde_json::Value = serde_json::from_slice(body).unwrap_or_default();
    let first = value.pointer("/errors/0");
    let field = |key| first.and_then(|e| e.get(key)).and_then(serde_json::Value::as_str);
    let msg = value.get("msg").and_then(serde_json::Value::as_str);
    field("detail").or_else(|| field("title")).or(msg).unwrap_or_default().to_owned()
}

fn error(status: StatusCode, msg: &str) -> Response<Body> {
    let response = Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json; charset=utf-8")
        .header(CACHE_CONTROL, "no-store")
        .body(Body::from(json!({ "code": 1, "msg": msg }).to_string()))
        .unwrap();
    log::note(response, msg)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(*name, value.parse().unwrap());
        }
        map
    }

    #[test]
    fn user_token_from_cookie_or_header() {
        assert_eq!(user_token(&headers(&[("cookie", "theme=dark; __Host-am-mut=0.Abc+/=")])), Some("0.Abc+/="));
        assert_eq!(user_token(&headers(&[("cookie", "am-mut=0.Abc")])), Some("0.Abc"));
        // cookie 优先于请求头
        assert_eq!(user_token(&headers(&[("cookie", "am-mut=0.C"), (USER_TOKEN_HEADER, "0.H")])), Some("0.C"));
        assert_eq!(user_token(&headers(&[(USER_TOKEN_HEADER, "0.H")])), Some("0.H"));
        assert_eq!(user_token(&headers(&[("cookie", "other=1")])), None);
        assert!(!valid_user_token("a;b") && !valid_user_token("a\"b") && !valid_user_token(""));
    }

    #[tokio::test]
    async fn station_token_cookie() {
        let body = Bytes::from_static(br#"{"token":" 0.Abc+/= "}"#);
        let secure = station_token_handler(headers(&[("origin", "https://site.test"), ("sec-fetch-site", "same-origin")]), body.clone()).await;
        assert_eq!(secure.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            secure.headers()[SET_COOKIE],
            format!("__Host-am-mut=0.Abc+/=; Path=/; Max-Age={USER_TOKEN_MAX_AGE}; HttpOnly; SameSite=Strict; Secure")
        );
        let plain = station_token_handler(headers(&[("origin", "http://192.168.1.2:8080")]), body.clone()).await;
        assert!(plain.headers()[SET_COOKIE].to_str().unwrap().starts_with("am-mut=0.Abc+/=; "));
        assert!(!plain.headers()[SET_COOKIE].to_str().unwrap().contains("Secure"));
        let proxied = station_token_handler(headers(&[("x-forwarded-proto", "https")]), body.clone()).await;
        assert!(proxied.headers()[SET_COOKIE].to_str().unwrap().starts_with("__Host-am-mut="));
        let cross = station_token_handler(headers(&[("sec-fetch-site", "cross-site")]), body).await;
        assert_eq!(cross.status(), StatusCode::FORBIDDEN);
        let bad = station_token_handler(HeaderMap::new(), Bytes::from_static(br#"{"token":"a;b"}"#)).await;
        assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
        let cleared = station_token_clear_handler(HeaderMap::new()).await;
        let cookies: Vec<_> = cleared.headers().get_all(SET_COOKIE).iter().map(|v| v.to_str().unwrap().to_owned()).collect();
        assert_eq!(cookies, ["am-mut=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict", "__Host-am-mut=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure"]);
    }

    #[test]
    fn test_extract_script_and_token() {
        let html = r#"<script type="module" crossorigin src="/assets/index~1c4278bfb3.js"></script>
            <script nomodule src="/assets/index-legacy~dc41388d00.js"></script>"#;
        assert_eq!(extract_script_path(html), Some("/assets/index~1c4278bfb3.js"));
        assert_eq!(extract_script_path(r#"<script src="/assets/index-legacy~dc41388d00.js">"#), None);

        let js = r#"const yo="2638.11.0-external",Ua="eyJ0eXAiOiJKV1QiLCJhbGci.eyJpc3MiOiJBTVBXZWJQbGF5.sig_nature-0123",b="eyJzZWNvbmQi.eyJzZWNvbmQiOjF9.abcdefghijkl";"#;
        assert_eq!(extract_token(js), Some("eyJ0eXAiOiJKV1QiLCJhbGci.eyJpc3MiOiJBTVBXZWJQbGF5.sig_nature-0123"));
        assert_eq!(extract_token("no token here"), None);
    }

    #[test]
    fn test_valid_catalog_path() {
        assert!(valid_catalog_path("us/search"));
        assert!(valid_catalog_path("cn/search/suggestions"));
        assert!(valid_catalog_path("us/songs/1468058171"));
        assert!(valid_catalog_path("cn/groupings"));
        assert!(valid_catalog_path("cn/rooms/6818358937/contents"));
        assert!(valid_catalog_path("us/multirooms/1532467784"));
        assert!(!valid_catalog_path(""));
        assert!(!valid_catalog_path("../me/library"));
        assert!(!valid_catalog_path("us/search?x"));
        assert!(!valid_catalog_path("us/%2e%2e/x"));
    }

    #[test]
    fn test_valid_storefront() {
        assert!(valid_storefront("cn"));
        assert!(valid_storefront("us"));
        assert!(!valid_storefront("US"));
        assert!(!valid_storefront("usa"));
        assert!(!valid_storefront("us/personal-recommendation"));
        assert!(!valid_storefront(".."));
    }

    #[test]
    fn test_station_validation() {
        assert!(valid_station_id("ra.978194965"));
        assert!(valid_station_id("ra.u-5e1a0b_x"));
        assert!(!valid_station_id("ra."));
        assert!(!valid_station_id("pl.123"));
        assert!(!valid_station_id("ra.1/../x"));
        assert!(valid_recommendation_id("7-2Tqlz47h9yro"));
        assert!(valid_recommendation_id("19-5PhiYeah6j7F6y52tWymLI"));
        assert!(!valid_recommendation_id(""));
        assert!(!valid_recommendation_id("7-2/../x"));
        assert!(!valid_recommendation_id("a b"));
        assert!(valid_license_url("https://play.itunes.apple.com/WebObjects/MZPlay.woa/web/radio/versions/1/license"));
        assert!(valid_license_url("https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/acquireWebPlaybackLicense"));
        assert!(valid_license_url("https://play.music.apple.com/v1/radio/streaming-key-delivery"));
        assert!(!valid_license_url("https://example.com/v1/radio/streaming-key-delivery"));
        assert!(!valid_license_url("http://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/acquireWebPlaybackLicense"));
        assert!(!valid_license_url("https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/other"));
        let mut headers = HeaderMap::new();
        assert_eq!(user_token(&headers), None);
        headers.insert(USER_TOKEN_HEADER, " 0.Abc+/= ".parse().unwrap());
        assert_eq!(user_token(&headers), Some("0.Abc+/="));
    }

    fn jwt(payload: &str) -> String {
        let encode = |s: &str| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(s);
        format!("{}.{}.signature", encode(r#"{"alg":"ES256"}"#), encode(payload))
    }

    #[test]
    fn test_refresh_delay() {
        let now = 1_000_000;
        assert_eq!(token_expiry(&jwt(r#"{"iss":"x","exp":1003600}"#)), Some(1_003_600));
        // 2 小时后过期：提前 1 小时刷新
        assert_eq!(refresh_delay(&jwt(r#"{"exp":1007200}"#), now), Duration::from_secs(3600));
        // 远期过期：不超过 12 小时
        assert_eq!(refresh_delay(&jwt(r#"{"exp":9000000}"#), now), TOKEN_TTL);
        // 即将或已经过期、没有 exp、无法解析：分别为 1 分钟下限与默认周期
        assert_eq!(refresh_delay(&jwt(r#"{"exp":1000100}"#), now), Duration::from_secs(60));
        assert_eq!(refresh_delay(&jwt(r#"{"iss":"x"}"#), now), TOKEN_TTL);
        assert_eq!(refresh_delay("not-a-jwt", now), TOKEN_TTL);
    }

    fn upstream(status: StatusCode, body: &'static [u8], ttl: Duration) -> Arc<Upstream> {
        Arc::new(Upstream {
            status,
            body: Bytes::from_static(body),
            expires_at: Instant::now() + ttl,
            elapsed: Duration::ZERO,
            version: reqwest::Version::HTTP_2,
            retry_after: None,
        })
    }

    #[test]
    fn test_response_cache() {
        let cache = ResponseCache::new(10);
        cache.put("a", upstream(StatusCode::OK, b"123456", CATALOG_TTL));
        assert!(cache.get("a").is_some());

        cache.put("err", upstream(StatusCode::NOT_FOUND, b"{}", CATALOG_TTL));
        assert!(cache.get("err").is_none(), "only successful responses are cached");

        cache.put("expired", upstream(StatusCode::OK, b"12", Duration::ZERO));
        assert!(cache.get("expired").is_none());
        assert_eq!(cache.lru.lock().unwrap().1, 6, "expired entries are dropped on lookup");

        cache.put("b", upstream(StatusCode::OK, b"abcdef", CATALOG_TTL));
        assert!(cache.get("a").is_none(), "oldest entry evicted once over capacity");
        assert!(cache.get("b").is_some());

        let disabled = ResponseCache::new(0);
        disabled.put("a", upstream(StatusCode::OK, b"1", CATALOG_TTL));
        assert!(disabled.get("a").is_none());
    }

    #[test]
    fn cooldown_backoff() {
        let cd = Cooldown::default();
        let t0 = Instant::now();
        let s = Duration::from_secs;
        assert_eq!(cd.remaining("a", t0), None);
        assert_eq!(cd.strike("a", t0, 0.0), s(60));
        assert_eq!(cd.remaining("a", t0 + s(2)), Some(s(58)));
        assert_eq!(cd.remaining("b", t0), None, "per host");
        // 冷却期内在途请求返回的 429 不再加码
        assert_eq!(cd.strike("a", t0 + s(1), 0.0), s(59));
        // 冷却结束后再次 429：翻倍，抖动最多 +25%
        assert_eq!(cd.strike("a", t0 + s(60), 0.0), s(120));
        assert_eq!(cd.strike("a", t0 + s(180), 0.999_999).as_secs(), 299);
        // 一直 429 时封顶 COOLDOWN_MAX
        let mut now = t0 + s(480);
        for _ in 0..10 {
            now += cd.strike("a", now, 0.0);
        }
        assert_eq!(cd.strike("a", now, 0.0), COOLDOWN_MAX);
        // 冷却期内的正常响应（冷却前发出的请求）不清除；冷却结束后的正常响应清除退避等级
        cd.clear("a", now + s(1));
        assert!(cd.remaining("a", now + s(1)).is_some());
        let after = now + COOLDOWN_MAX;
        cd.clear("a", after);
        assert_eq!(cd.strike("a", after, 0.0), s(60));
        let j = jitter();
        assert!((0.0..1.0).contains(&j));
    }

    /// 上游 429 → 本地 429 + Retry-After，冷却期内的请求不到达上游
    #[tokio::test]
    async fn upstream_429_pauses_forwarding() {
        use std::sync::atomic::AtomicUsize;
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let app = axum::Router::new().fallback(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            async { Response::builder().status(429).body(Body::from("{}")).unwrap() }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1/catalog/us/songs/1", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let amp = Amp::new(0);
        *amp.token.current.write().unwrap() =
            Some(Token { value: "t".into(), refresh_at: Instant::now() + TOKEN_TTL, fetched_at: Instant::now() });
        for _ in 0..3 {
            let up = amp.request(&url, CATALOG_TTL).await.unwrap();
            assert_eq!(up.status, StatusCode::TOO_MANY_REQUESTS);
            let wait = up.retry_after.unwrap();
            assert!(wait > Duration::from_secs(58) && wait <= Duration::from_secs(75), "{wait:?}");
            assert!(api_error_summary(&up.body).contains("retry in"));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn token_invalidate_min_age() {
        let token = DeveloperToken::default();
        let t0 = Instant::now();
        let set = |value: &str| {
            *token.current.write().unwrap() =
                Some(Token { value: value.into(), refresh_at: t0 + TOKEN_TTL, fetched_at: t0 });
        };
        set("old");
        // 刚抓到的 token 被拒：不丢弃、不重试
        assert!(!token.invalidate("old", t0 + Duration::from_secs(1)));
        assert_eq!(token.cached().as_deref(), Some("old"));
        // 抓到已有一阵：丢弃并重试
        assert!(token.invalidate("old", t0 + TOKEN_MIN_AGE));
        assert!(token.cached().is_none());
        // 已被其他请求换成新 token：保留新 token，用它重试
        set("new");
        assert!(token.invalidate("old", t0));
        assert_eq!(token.cached().as_deref(), Some("new"));
    }
}
