pub mod cli;
pub mod embedded_template;
pub mod m3u8;
pub mod monitor;
pub mod mp4;
pub mod proxy;
pub mod source;
pub mod state;
pub mod ui;
pub mod wrapper;

use std::sync::Arc;

use axum::routing::{get, post};
use axum::Router;

use crate::state::AppState;

/// 首页与解析接口优先，song 页与 hook 反代统一由 fallback 分流
pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(ui::home_handler))
        .route("/status", get(ui::status_handler))
        .route("/parse", post(ui::parse_handler))
        .route("/parse/:adam_id", get(ui::master_handler))
        .route("/assets/app.css", get(ui::css_handler))
        .route("/assets/player.js", get(ui::player_js_handler))
        .fallback(proxy::handle_proxy)
        .with_state(state)
}
