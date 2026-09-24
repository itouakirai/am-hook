use std::sync::Arc;

use clap::Parser;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

use am_hook::cli::Cli;
use am_hook::state::AppState;
use am_hook::{monitor, router};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| "am_hook=info".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let cli = Cli::parse();
    let listen_addr = cli.resolve_listen_addr()?;
    info!(
        listen = %listen_addr, wrapper = %cli.wrapper_url, cache_ttl = cli.cache_ttl,
        cache_mb = cli.lru_cache_mb, prefetch = cli.prefetch, "Starting am-hook"
    );

    let state = Arc::new(AppState::with_config(cli.config(), cli.lru_cache_mb));
    // 预热内嵌模板，避免首个请求时解析
    am_hook::embedded_template::get_fixed_template();
    tokio::spawn(monitor::run_background_monitor(state.clone()));

    let listener = tokio::net::TcpListener::bind(listen_addr).await?;
    info!("am-hook listening on http://{listen_addr}");
    axum::serve(listener, router(state)).await?;
    Ok(())
}
