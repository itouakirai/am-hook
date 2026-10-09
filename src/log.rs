//! 运行输出：日志初始化、启动摘要与请求日志。
//!
//! 每个请求在响应后输出一行：`状态码 方法 分类 要点 · 备注 · 耗时`。
//! 高频且无信息量的请求（静态资源、页面轮询的 /status、输入联想）降为 debug，
//! 需要时用 `RUST_LOG=am_hook=debug` 查看。

use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::Response;
use regex::Regex;
use tracing::{debug, info, warn, Level};
use tracing_subscriber::fmt::time::ChronoLocal;

use crate::links::{new_section, page_kinds};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

use crate::state::{AppState, Config};

pub fn init() {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| "am_hook=info".into()))
        .with(
            tracing_subscriber::fmt::layer()
                .with_target(false)
                .with_timer(ChronoLocal::new("%m-%d %H:%M:%S".into())),
        )
        .init();
}

/// 处理函数附加到响应上的补充说明（如音质数量、wrapper-lite 状态），由请求日志一并输出
#[derive(Clone)]
pub struct LogNote(pub String);

/// 给响应附加 [`LogNote`]
pub fn note<B>(mut response: Response<B>, note: impl Into<String>) -> Response<B> {
    response.extensions_mut().insert(LogNote(note.into()));
    response
}

/// 请求日志中间件
pub async fn access_log(request: Request, next: Next) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let query = request.uri().query().unwrap_or_default().to_owned();
    let started = Instant::now();

    let mut response = next.run(request).await;

    let elapsed = started.elapsed();
    let status = response.status();
    let note = response.extensions_mut().remove::<LogNote>().map(|n| n.0);
    let entry = describe(&path, &query);
    let mut line = format!("{} {:<4} {:<9} {}", status.as_u16(), method.as_str(), entry.kind, entry.detail);
    if let Some(note) = note.filter(|n| !n.is_empty()) {
        line.push_str(" · ");
        line.push_str(&note);
    }
    line.push_str(" · ");
    line.push_str(&format_elapsed(elapsed));

    match level(status, entry.quiet) {
        Level::WARN => warn!("{line}"),
        Level::INFO => info!("{line}"),
        _ => debug!("{line}"),
    }
    response
}

/// 5xx 与非 404 的 4xx 为 warn；quiet 请求（含 favicon 等无关路径）的 4xx 仍只在 debug 输出
fn level(status: StatusCode, quiet: bool) -> Level {
    if status.is_server_error() || (!quiet && status.is_client_error() && status != StatusCode::NOT_FOUND) {
        Level::WARN
    } else if quiet {
        Level::DEBUG
    } else {
        Level::INFO
    }
}

struct Entry {
    kind: &'static str,
    detail: String,
    /// 仅在 debug 级别输出
    quiet: bool,
}

impl Entry {
    fn new(kind: &'static str, detail: impl Into<String>) -> Self {
        Self { kind, detail: detail.into(), quiet: false }
    }

    fn quiet(mut self) -> Self {
        self.quiet = true;
        self
    }
}

static PAGE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"^/https:/{1,2}music\.apple\.com/([a-z]{2})/(",
        page_kinds!(),
        r")/(?:[^/?#]+/)?([^/?#]+?)/?$"
    ))
    .unwrap()
});

static LIBRARY_PAGE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^/library(?:/(recently-added|albums|songs|music-videos|all-playlists|favorite-songs|artists|playlist|playlist-folder)(?:/([^/?#]+))?)?/?$").unwrap()
});

static NEW_PAGE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(r"^/(?:https://music\.apple\.com/([a-z]{2})/)?(", new_section!(), r")/?$")).unwrap()
});

/// 只记录定位页面数据所需的参数，省略冗长的 fields/include 等字段。
fn data_detail(rest: &str, query: &str) -> String {
    let mut detail = rest.to_owned();
    for key in ["name", "types", "with", "chart", "genre", "ids", "ids[curators]", "ids[apple-curators]", "offset", "limit"] {
        if let Some(value) = query_param(query, key).filter(|v| !v.is_empty()) {
            detail.push_str(&format!(" {key} {value}"));
        }
    }
    detail
}

/// 按路径归类请求，取出日志要点
fn describe(path: &str, query: &str) -> Entry {
    if let Some(file) = path.strip_prefix("/assets/") {
        return Entry::new("asset", file).quiet();
    }
    if let Some(caps) = NEW_PAGE_RE.captures(path) {
        let mut detail = caps[2].to_owned();
        if let Some(cc) = caps.get(1) {
            detail.push_str(&format!(" {}", cc.as_str().to_uppercase()));
        }
        if let Some(genre) = query_param(query, "genreId").filter(|v| !v.is_empty()) {
            detail.push_str(&format!(" genre {genre}"));
        }
        return Entry::new("page", detail);
    }
    // 资料库页：数据只在浏览器中，服务端只返回单页应用
    if let Some(caps) = LIBRARY_PAGE_RE.captures(path) {
        let mut detail = String::from("library");
        for part in [caps.get(1), caps.get(2)].into_iter().flatten() {
            detail.push('/');
            detail.push_str(part.as_str());
        }
        return Entry::new("page", detail);
    }
    if let Some(caps) = PAGE_RE.captures(path) {
        let kind = match &caps[2] {
            "music-video" => "MV",
            other => other,
        };
        // 单页应用：只有整页加载（打开、刷新）时请求页面，站内跳转不再请求
        return Entry::new("page", format!("{kind} {} {}", caps[1].to_uppercase(), &caps[3]));
    }
    match path {
        "/" => return Entry::new("page", "home"),
        "/status" => return Entry::new("status", "wrapper-lite").quiet(),
        "/key" => return Entry::new("key", format!("adamId {}", query_param(query, "adamId").unwrap_or_default())),
        "/mv/license" => return Entry::new("mv", "license"),
        "/amp/v1/storefronts" => return Entry::new("catalog", "storefronts"),
        _ => {}
    }
    if let Some(id) = path.strip_prefix("/parse/song/") {
        return Entry::new("song", format!("master {id}"));
    }
    if let Some(id) = path.strip_prefix("/parse/mv/") {
        return Entry::new("mv", format!("master {id}"));
    }
    if let Some(id) = path.strip_prefix("/mv/webplayback/") {
        return Entry::new("mv", format!("webplayback {id}"));
    }
    if let Some(id) = path.strip_prefix("/lyrics/") {
        return Entry::new("lyrics", id);
    }
    if let Some(rest) = path.strip_prefix("/amp/v1/catalog/") {
        let term = query_param(query, "term").unwrap_or_default();
        if let Some(cc) = rest.strip_suffix("/search/suggestions") {
            return Entry::new("search", format!("suggest {} {term:?}", cc.to_uppercase())).quiet();
        }
        if let Some(cc) = rest.strip_suffix("/search") {
            let offset = query_param(query, "offset").map(|o| format!(" offset {o}")).unwrap_or_default();
            return Entry::new("search", format!("{} {term:?}{offset}", cc.to_uppercase()));
        }
        let kind = if rest.split('/').nth(1) == Some("charts") { "charts" } else { "catalog" };
        return Entry::new(kind, data_detail(rest, query));
    }
    if let Some(rest) = path.strip_prefix("/amp/v1/editorial/") {
        return Entry::new("editorial", data_detail(rest, query));
    }
    Entry::new("other", path).quiet()
}

/// 取查询参数并做百分号解码（`+` 视为空格）
fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        (decode_query(name) == key).then(|| decode_query(value))
    })
}

fn decode_query(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => match std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                Some(b) => {
                    out.push(b);
                    i += 2;
                }
                None => out.push(b'%'),
            },
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn format_elapsed(elapsed: Duration) -> String {
    let ms = elapsed.as_secs_f64() * 1000.0;
    if ms >= 1000.0 {
        format!("{:.2} s", ms / 1000.0)
    } else if ms >= 10.0 {
        format!("{ms:.0} ms")
    } else {
        format!("{ms:.1} ms")
    }
}

/// 启动摘要：访问地址、wrapper-lite 与功能入口
pub fn print_banner(listen: SocketAddr, config: &Config) {
    let mut lines = vec![format!("am-hook v{}", env!("CARGO_PKG_VERSION"))];
    let urls = access_urls(listen);
    lines.push(format!("  Web UI        {}", urls[0]));
    for url in &urls[1..] {
        lines.push(format!("                {url}"));
    }
    lines.push(format!("  wrapper-lite  {}", config.wrapper_url));
    let limit = |n: usize, unit: &str| if n == 0 { format!("unlimited {unit}") } else { format!("{n} {unit}") };
    // 只显示认证方案，不输出凭据
    let auth = match config.wrapper_auth.as_deref() {
        Some(value) => format!("{} ***", value.split_whitespace().next().unwrap_or_default()),
        None => "none".to_owned(),
    };
    lines.push(format!(
        "                limit {}, {} · auth {auth}",
        limit(config.wrapper_rate as usize, "req/s"),
        limit(config.wrapper_concurrency, "concurrent")
    ));
    let keepalive = match config.amp_keepalive.as_secs() {
        0 => "keep-alive off".to_owned(),
        secs => format!("keep-alive {secs}s"),
    };
    lines.push(format!("  amp-api       warm connection, {keepalive}, response cache {} MB", config.amp_cache_mb));
    lines.push("  Pages         home & search · new · top charts · song · album · playlist · artist".into());
    lines.push("                music video · post · room · multi-room · grouping · curator".into());
    lines.push("  Features      lyrics · motion artwork · ALAC / FLAC / Dolby Atmos (EC-3) · MV PlayReady".into());
    lines.push("  Verbose log   RUST_LOG=am_hook=debug (assets, status, suggestions)".into());
    let width = lines.iter().map(|l| l.chars().count()).max().unwrap_or(0);
    let rule = "─".repeat(width + 2);
    println!("{rule}");
    for line in &lines {
        println!(" {line}");
    }
    println!("{rule}");
}

/// 监听 0.0.0.0 / :: 时列出本机与局域网地址，便于从其他设备访问
fn access_urls(listen: SocketAddr) -> Vec<String> {
    let port = listen.port();
    let url = |ip: IpAddr| match ip {
        IpAddr::V6(v6) => format!("http://[{v6}]:{port}"),
        IpAddr::V4(v4) => format!("http://{v4}:{port}"),
    };
    if !listen.ip().is_unspecified() {
        return vec![url(listen.ip())];
    }
    let mut urls = vec![format!("http://localhost:{port}")];
    if let Some(ip) = lan_ip() {
        urls.push(format!("{} (LAN)", url(ip)));
    }
    urls
}

/// 本机对外的局域网地址：UDP connect 只选路由、不发送数据
fn lan_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
}

/// 启动后检查 wrapper-lite 是否可用，并输出账号地区
pub async fn check_wrapper(state: Arc<AppState>) {
    let wrapper = &state.wrapper;
    let wrapper_url = &wrapper.url;
    let result = wrapper.send(wrapper.get("/status").timeout(Duration::from_secs(5))).await.map_err(|e| e.to_string());
    let value = match result {
        Ok(reply) => match reply.status.as_u16() {
            401 | 403 => Err(format!("HTTP {} (check --wrapper-auth)", reply.status)),
            _ => reply.json::<serde_json::Value>().map_err(|e| format!("invalid response: {e}")),
        },
        Err(e) => Err(e),
    };
    match value {
        Ok(v) if v.get("code").and_then(serde_json::Value::as_i64) == Some(0) => {
            info!("wrapper-lite online · regions {}", regions_summary(&v));
        }
        Ok(v) => {
            let msg = v.get("msg").and_then(serde_json::Value::as_str).unwrap_or("unknown error");
            warn!("wrapper-lite at {wrapper_url} returned an error: {msg}");
        }
        Err(e) => warn!("wrapper-lite at {wrapper_url} is unreachable: {e}"),
    }
}

/// wrapper-lite `/status` 中的账号地区，如 `CN, US`
pub fn regions_summary(status: &serde_json::Value) -> String {
    let regions: Vec<String> = status
        .pointer("/data/regions")
        .and_then(serde_json::Value::as_array)
        .map(|list| list.iter().filter_map(serde_json::Value::as_str).map(str::to_uppercase).collect())
        .unwrap_or_default();
    if regions.is_empty() {
        "none".into()
    } else {
        regions.join(", ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_query_param() {
        assert_eq!(query_param("term=taylor+swift&l=en-US", "term").as_deref(), Some("taylor swift"));
        assert_eq!(query_param("l=zh&term=%E5%91%A8%E6%9D%B0%E4%BC%A6", "term").as_deref(), Some("周杰伦"));
        assert_eq!(query_param("termx=1", "term"), None);
        assert_eq!(query_param("term=100%", "term").as_deref(), Some("100%"));
    }

    #[test]
    fn test_describe() {
        let e = describe("/https://music.apple.com/cn/album/lover/1468058165", "");
        assert_eq!((e.kind, e.detail.as_str(), e.quiet), ("page", "album CN 1468058165", false));
        assert_eq!(describe("/https://music.apple.com/cn/song/lover/1468058171", "").detail, "song CN 1468058171");
        let e = describe("/amp/v1/catalog/us/search", "term=a%20b&offset=25");
        assert_eq!(e.detail, "US \"a b\" offset 25");
        assert!(describe("/amp/v1/catalog/us/search/suggestions", "term=a").quiet);
        assert_eq!(describe("/amp/v1/catalog/cn/albums/1", "").kind, "catalog");
        assert!(describe("/assets/player.js", "").quiet);
        assert_eq!(describe("/lyrics/123", "").kind, "lyrics");
    }

    #[test]
    fn new_pages_are_visible() {
        for (path, expected) in [
            ("/new", "new"),
            ("/new/top-charts/", "new/top-charts"),
            ("/new/top-charts/songs", "new/top-charts/songs"),
            ("/https://music.apple.com/cn/new", "new CN"),
            ("/https://music.apple.com/us/new/top-charts/albums/", "new/top-charts/albums US"),
            ("/https://music.apple.com/cn/room/123", "room CN 123"),
            ("/https://music.apple.com/us/multi-room/456", "multi-room US 456"),
            ("/https://music.apple.com/us/grouping/789", "grouping US 789"),
            ("/https://music.apple.com/us/curator/123", "curator US 123"),
            ("/https://music.apple.com/us/curator/apple-music/123", "curator US 123"),
            ("/https://music.apple.com/us/post/123/", "post US 123"),
            ("/https://music.apple.com/us/post/video/123", "post US 123"),
            ("/https://music.apple.com/us/music-video/video/123", "MV US 123"),
        ] {
            let e = describe(path, "");
            assert_eq!((e.kind, e.detail.as_str(), e.quiet), ("page", expected, false), "{path}");
        }
        assert_eq!(describe("/new/top-charts/songs", "genreId=20").detail, "new/top-charts/songs genre 20");
        assert_eq!(describe("/new/top-charts/unknown", "").kind, "other");
        assert_eq!(describe("/library", "").detail, "library");
        assert_eq!(describe("/library/songs", "").detail, "library/songs");
        assert_eq!(describe("/library/playlist/p.abc", "").detail, "library/playlist/p.abc");
        assert_eq!(describe("/library/favorite-songs", "").detail, "library/favorite-songs");
        assert_eq!(describe("/library/playlist-folder/f.abc", "").detail, "library/playlist-folder/f.abc");
    }

    #[test]
    fn page_data_requests_include_context() {
        for (path, query, kind, detail) in [
            ("/amp/v1/editorial/cn/groupings", "name=music&include=contents", "editorial", "cn/groupings name music"),
            ("/amp/v1/editorial/us/rooms/123/contents", "offset=50&limit=25", "editorial", "us/rooms/123/contents offset 50 limit 25"),
            ("/amp/v1/catalog/us/charts", "types=songs%2Calbums&genre=20&offset=50", "charts", "us/charts types songs,albums genre 20 offset 50"),
            ("/amp/v1/catalog/us", "ids%5Bcurators%5D=123&ids%5Bapple-curators%5D=123", "catalog", "us ids[curators] 123 ids[apple-curators] 123"),
            ("/amp/v1/catalog/us/uploaded-videos/123", "token=secret&fields=name", "catalog", "us/uploaded-videos/123"),
        ] {
            let e = describe(path, query);
            assert_eq!((e.kind, e.detail.as_str(), e.quiet), (kind, detail, false));
            assert_eq!(level(StatusCode::OK, e.quiet), Level::INFO);
            assert_eq!(level(StatusCode::BAD_REQUEST, e.quiet), Level::WARN);
        }
        assert_eq!(level(StatusCode::OK, describe("/status", "").quiet), Level::DEBUG);
        assert_eq!(level(StatusCode::BAD_GATEWAY, true), Level::WARN);
    }
}
