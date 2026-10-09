use std::sync::Arc;

use clap::Parser;
use tracing::info;

use am_hook::cli::Cli;
use am_hook::state::AppState;
use am_hook::{amp, log, router, updater};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    log::init();

    let cli = Cli::parse();

    // 后台检查更新，GitHub 不可达时不拖慢启动
    if cli.auto_update || cli.check_update {
        tokio::spawn(updater::startup_check(cli.auto_update));
    }

    let listen_addr = cli.resolve_listen_addr()?;
    let config = cli.config()?;
    let state = Arc::new(AppState::with_config(config.clone()));
    // 启动即获取 developer token 并建立 amp-api 连接，页面的首个目录 / 搜索请求无需等待
    tokio::spawn(amp::run_warmer(state.amp.clone(), config.amp_keepalive));

    let listener = tokio::net::TcpListener::bind(listen_addr).await?;
    log::print_banner(listen_addr, &config);
    tokio::spawn(log::check_wrapper(state.clone()));

    axum::serve(listener, router(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            info!("Shutting down");
        })
        .await?;
    Ok(())
}
