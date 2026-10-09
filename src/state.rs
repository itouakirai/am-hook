use std::sync::Arc;
use std::time::Duration;

#[derive(Clone)]
pub struct Config {
    pub wrapper_url: String,
    /// amp-api 连接空闲时的保活周期，0 表示不发送保活请求
    pub amp_keepalive: Duration,
    /// amp-api 响应缓存容量（MB），0 表示不缓存
    pub amp_cache_mb: usize,
    /// 每秒发往 wrapper-lite 的最大请求数，0 表示不限
    pub wrapper_rate: u32,
    /// 同时进行的 wrapper-lite 请求上限，0 表示不限
    pub wrapper_concurrency: usize,
    /// wrapper-lite 请求的 `Authorization` 头（已规范化），None 表示不发送
    pub wrapper_auth: Option<String>,
}

pub struct AppState {
    pub config: Config,
    pub http_client: reqwest::Client,
    /// wrapper-lite 客户端（限速、限并发、鉴权）
    pub wrapper: crate::wrapper::Wrapper,
    /// amp-api（Apple Music 目录 / 搜索）代理：专用连接、developer token 与响应缓存
    pub amp: Arc<crate::amp::Amp>,
}

impl AppState {
    /// 默认配置（测试用）
    pub fn new(wrapper_url: String) -> Self {
        Self::with_config(Config {
            wrapper_url: wrapper_url.trim_end_matches('/').to_string(),
            amp_keepalive: Duration::from_secs(30),
            amp_cache_mb: 32,
            wrapper_rate: 24,
            wrapper_concurrency: 24,
            wrapper_auth: None,
        })
    }

    pub fn with_config(config: Config) -> Self {
        // wrapper-lite 与 Apple CDN（master m3u8）：保持 HTTP/1.1、不请求压缩（amp-api 另用专用客户端）
        let http_client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(30))
            .tcp_nodelay(true)
            .pool_max_idle_per_host(32)
            .http1_only()
            .no_gzip()
            .no_brotli()
            .build()
            .expect("Failed to build reqwest HTTP client");
        let amp = Arc::new(crate::amp::Amp::new(config.amp_cache_mb * 1024 * 1024));
        let wrapper = crate::wrapper::Wrapper::new(&config);
        Self { config, http_client, wrapper, amp }
    }
}
