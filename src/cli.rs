use std::net::SocketAddr;
use std::time::Duration;

use clap::Parser;

use crate::state::Config;

#[derive(Parser, Debug, Clone)]
#[command(name = "am-hook", author, version, about = "Apple Music FairPlay HLS decryption in the browser")]
pub struct Cli {
    /// Listen address (e.g. 0.0.0.0:8888 or 127.0.0.1:8888)
    #[arg(short, long, default_value = "0.0.0.0:8888")]
    pub listen: String,

    /// Optional port override (overrides port in listen address if specified)
    #[arg(short, long)]
    pub port: Option<u16>,

    /// URL of wrapper-lite key server. With --local-wrapper-only, the address
    /// pre-filled in the page instead (users can change it)
    #[arg(short, long, default_value = "http://127.0.0.1:12340")]
    pub wrapper_url: String,

    /// Do not relay wrapper-lite requests: pages only use a wrapper-lite the browser
    /// connects to directly (Settings > wrapper-lite > Local), like a serverless deployment
    /// without AM_HOOK_WRAPPER_URL. --wrapper-url / --wrapper-rate / --wrapper-concurrency
    /// become the page defaults; --wrapper-auth is not used
    #[arg(long)]
    pub local_wrapper_only: bool,

    /// Note shown above the local wrapper-lite settings in the page, e.g. where to get a
    /// token for a public wrapper-lite. URLs in it become links
    #[arg(long, env = "AM_HOOK_WRAPPER_HINT")]
    pub wrapper_hint: Option<String>,

    /// Max requests per second sent to wrapper-lite (any 1-second window); 0 = unlimited
    #[arg(long, default_value_t = 24)]
    pub wrapper_rate: u32,

    /// Max concurrent requests to wrapper-lite; 0 = unlimited
    #[arg(long, default_value_t = 24)]
    pub wrapper_concurrency: usize,

    /// Authorization header for wrapper-lite requests. A bare token is sent as
    /// "Bearer <token>"; a value with a scheme ("Bearer ...", "Basic ...") is sent as is.
    /// Not sent by default
    #[arg(long, env = "AM_HOOK_WRAPPER_AUTH", hide_env_values = true)]
    pub wrapper_auth: Option<String>,

    /// Max wrapper-lite requests relayed per client IP in any 60 seconds (/status not
    /// counted); further requests get HTTP 429 with Retry-After. 0 = unlimited
    #[arg(long, default_value_t = 0)]
    pub client_rate: u32,

    /// Max wrapper-lite requests relayed at once per client IP (/status not counted);
    /// further requests wait, so one visitor's burst cannot hold every
    /// --wrapper-concurrency permit. 0 = unlimited
    #[arg(long, default_value_t = 0)]
    pub client_concurrency: usize,

    /// Serve only the amp-api proxy (/amp/*, /station/*, /amp/health): no pages, no static
    /// assets, no wrapper-lite relay. For amp proxy cluster nodes behind a reverse proxy that
    /// routes those paths to them; uses less memory (assets are never loaded or compressed)
    #[arg(long)]
    pub amp_only: bool,

    /// Send amp-api / station requests to Apple (and the developer token scrape) through
    /// this proxy: http://, https://, socks5:// or socks5h:// (DNS via the proxy) URL,
    /// optionally with user:pass@. Apple rate-limits by IP, so this moves them to another IP.
    /// Default: direct
    #[arg(long, env = "AM_HOOK_AMP_PROXY", hide_env_values = true)]
    pub amp_proxy: Option<String>,

    /// Max amp-api proxy requests (/amp/*, /station/*; cache hits included) per client IP
    /// in any 60 seconds; further requests get HTTP 429 with Retry-After. Apple rate-limits
    /// this server's IP as a whole, so one visitor's flood would otherwise hit everyone.
    /// 0 = unlimited
    #[arg(long, default_value_t = 0)]
    pub amp_client_rate: u32,

    /// Max amp-api proxy requests handled at once per client IP; further requests wait.
    /// 0 = unlimited
    #[arg(long, default_value_t = 0)]
    pub amp_client_concurrency: usize,

    /// Request header holding the client IP, set by the reverse proxy in front
    /// (e.g. X-Real-IP, CF-Connecting-IP; the first entry of a list is used).
    /// Only set it when every request passes through that proxy, otherwise clients can
    /// spoof it. Default: the TCP peer address
    #[arg(long)]
    pub client_ip_header: Option<String>,

    /// Seconds between keep-alive requests that keep the amp-api (catalog / search)
    /// connection warm while idle; 0 disables them
    #[arg(long, default_value_t = 30)]
    pub amp_keepalive: u64,

    /// amp-api response cache capacity in megabytes; 0 disables caching
    /// (identical concurrent requests are still merged)
    #[arg(long, default_value_t = 32)]
    pub amp_cache_mb: usize,

    /// Check for updates on startup
    #[arg(long)]
    pub check_update: bool,

    /// Automatically download and install updates if available
    #[arg(long)]
    pub auto_update: bool,
}

impl Cli {
    pub fn resolve_listen_addr(&self) -> Result<SocketAddr, String> {
        let mut addr: SocketAddr = self
            .listen
            .parse()
            .map_err(|e| format!("Invalid listen address '{}': {e}", self.listen))?;
        if let Some(port) = self.port {
            addr.set_port(port);
        }
        Ok(addr)
    }

    pub fn config(&self) -> Result<Config, String> {
        let wrapper_auth = match &self.wrapper_auth {
            Some(raw) => crate::wrapper::normalize_authorization(raw)?,
            None => None,
        };
        Ok(Config {
            wrapper_url: self.wrapper_url.trim_end_matches('/').to_string(),
            amp_keepalive: Duration::from_secs(self.amp_keepalive),
            amp_cache_mb: self.amp_cache_mb,
            wrapper_rate: self.wrapper_rate,
            wrapper_concurrency: self.wrapper_concurrency,
            wrapper_auth,
            wrapper_relay: !self.local_wrapper_only && !self.amp_only,
            amp_only: self.amp_only,
            wrapper_hint: self.wrapper_hint.as_deref().map(str::trim).filter(|h| !h.is_empty()).map(str::to_owned),
            client_rate: self.client_rate,
            client_concurrency: self.client_concurrency,
            amp_proxy: match self.amp_proxy.as_deref().map(str::trim) {
                Some(raw) if !raw.is_empty() => Some(crate::amp::parse_proxy(raw)?),
                _ => None,
            },
            amp_client_rate: self.amp_client_rate,
            amp_client_concurrency: self.amp_client_concurrency,
            client_ip_header: match &self.client_ip_header {
                Some(raw) => crate::limit::parse_ip_header(raw)?,
                None => None,
            },
        })
    }
}
