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

    /// URL of wrapper-lite key server
    #[arg(short, long, default_value = "http://127.0.0.1:12340")]
    pub wrapper_url: String,

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
        })
    }
}
