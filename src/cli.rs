use clap::Parser;
use std::net::SocketAddr;

#[derive(Parser, Debug, Clone)]
#[command(name = "am-hook", author, version, about = "Apple Music FairPlay HLS Decryption Hook Reverse Proxy")]
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

    /// Metadata context TTL in seconds before eviction (default 30 minutes)
    #[arg(long, default_value_t = 1800)]
    pub cache_ttl: i64,

    /// Decrypted fragment in-memory LRU cache capacity in megabytes (default 128MB)
    #[arg(long, default_value_t = 128)]
    pub lru_cache_mb: usize,
}

impl Cli {
    pub fn resolve_listen_addr(&self) -> Result<SocketAddr, String> {
        if let Some(port) = self.port {
            let host = self.listen.split(':').next().unwrap_or("0.0.0.0");
            let addr_str = format!("{}:{}", host, port);
            addr_str.parse().map_err(|e| format!("Invalid address '{addr_str}': {e}"))
        } else {
            self.listen.parse().map_err(|e| format!("Invalid listen address '{}': {e}", self.listen))
        }
    }
}
