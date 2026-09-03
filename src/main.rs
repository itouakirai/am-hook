pub mod cli;
pub mod embedded_template;
pub mod m3u8;
pub mod monitor;
pub mod mp4;
pub mod proxy;
pub mod state;
pub mod wrapper;

use clap::Parser;
use std::sync::Arc;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

use crate::cli::Cli;
use crate::proxy::handle_proxy;
use crate::state::AppState;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 初始化结构化日志
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| "am_hook=info,tower_http=debug".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let cli = Cli::parse();
    let listen_addr = cli.resolve_listen_addr()?;

    info!(
        listen = %listen_addr,
        wrapper = %cli.wrapper_url,
        cache_ttl = cli.cache_ttl,
        lru_cache_mb = cli.lru_cache_mb,
        "Starting am-hook reverse proxy server"
    );

    let state = Arc::new(AppState::new(
        cli.wrapper_url,
        cli.cache_ttl,
        cli.lru_cache_mb,
    ));

    // 启动后台结构体监控与 TTL 淘汰任务
    tokio::spawn(monitor::run_background_monitor(state.clone()));

    // 构建 Axum 路由（任意路径 fallback 均进入 handle_proxy）
    let app = axum::Router::new()
        .fallback(handle_proxy)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(listen_addr).await?;
    info!("am-hook listening on http://{}", listen_addr);

    axum::serve(listener, app).await?;

    Ok(())
}
