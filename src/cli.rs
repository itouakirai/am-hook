use std::net::SocketAddr;
use std::time::Duration;

use clap::Parser;

use crate::state::Config;

#[derive(Parser, Debug, Clone)]
#[command(name = "am-hook", author, version, about = "Apple Music FairPlay HLS decryption: browser-side by default, optional server-side decrypting proxy (--hook)")]
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

    /// Enable server-side decryption: serve decrypted media m3u8 / media file URLs
    /// (for VLC, IDM, etc.). Off by default to save server bandwidth; the web UI
    /// then decrypts in the browser and the server only provides master m3u8 and
    /// decryption templates.
    #[arg(long)]
    pub hook: bool,

    /// Track context TTL in seconds since last access before eviction
    #[arg(long, default_value_t = 1800)]
    pub cache_ttl: u64,

    /// Decrypted segment in-memory LRU cache capacity in megabytes
    #[arg(long, default_value_t = 128)]
    pub lru_cache_mb: usize,

    /// Segments fetched and decrypted concurrently ahead of the one being sent
    #[arg(long, default_value_t = 4)]
    pub prefetch: usize,

    /// Seconds to wait for a track's decryption template before failing
    #[arg(long, default_value_t = 20)]
    pub template_timeout: u64,
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

    pub fn config(&self) -> Config {
        Config {
            wrapper_url: self.wrapper_url.trim_end_matches('/').to_string(),
            hook: self.hook,
            cache_ttl: Duration::from_secs(self.cache_ttl),
            prefetch: self.prefetch.max(1),
            template_timeout: Duration::from_secs(self.template_timeout),
        }
    }
}
