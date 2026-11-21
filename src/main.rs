use std::sync::Arc;

use clap::Parser;
use tracing::info;

use am_hook::cli::Cli;
use am_hook::state::AppState;
use am_hook::{amp, assets, log, router, updater};

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

    // 静态资源的 brotli / gzip 压缩在后台线程预先算好（--amp-only 不提供页面，不加载资源）
    if !config.amp_only {
        assets::warm();
    }

    let listener = tokio::net::TcpListener::bind(listen_addr).await?;
    log::print_banner(listen_addr, &config);
    tokio::spawn(log::report_summary());
    if config.wrapper_relay {
        tokio::spawn(log::check_wrapper(state.clone()));
        tokio::spawn(log::report_wrapper_queue(state.clone()));
    }

    // 对端地址供按客户端 IP 限流使用（见 limit.rs）
    axum::serve(listener, router(state).into_make_service_with_connect_info::<std::net::SocketAddr>())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            info!("Shutting down");
        })
        .await?;
    Ok(())
}
