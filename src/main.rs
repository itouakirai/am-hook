pub mod cli;
pub mod embedded_template;
pub mod m3u8;
pub mod monitor;
pub mod mp4;
pub mod proxy;
pub mod state;
pub mod wrapper;
mod ui;

use clap::Parser;
use std::sync::Arc;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

use crate::cli::Cli;
use crate::proxy::handle_proxy;
use crate::state::AppState;
use crate::ui::{home_handler, master_handler, parse_handler, status_handler};

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

    // 构建路由：首页和解析接口优先，song 页与 hook 反代统一由 fallback 分流。
    let app = axum::Router::new()
        .route("/", axum::routing::get(home_handler))
        .route("/status", axum::routing::get(status_handler))
        .route("/parse", axum::routing::post(parse_handler))
        .route("/parse/:adam_id", axum::routing::get(master_handler))
        .fallback(handle_proxy)
        .with_state(state);


    let listener = tokio::net::TcpListener::bind(listen_addr).await?;
    info!("am-hook listening on http://{}", listen_addr);

    axum::serve(listener, app).await?;

    Ok(())
}
