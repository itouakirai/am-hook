pub mod amp;
pub mod assets;
pub mod cli;
pub mod log;
pub mod links;
pub mod state;
pub mod ui;
pub mod updater;
pub mod wrapper;

use std::sync::Arc;

use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::Router;

use crate::state::AppState;

/// 首页与解析接口优先，歌曲 / MV / 专辑 / 歌单 / 艺人页、编辑页（room / multi-room / grouping / curator）、资料库页统一由 fallback 分流
pub fn router(state: Arc<AppState>) -> Router {
    // 内嵌前端资源按 assets::ASSETS 表注册，其余是后端接口
    let router = assets::ASSETS.iter().fold(Router::new(), |router, asset| {
        router.route(asset.url, get(move |headers: HeaderMap| async move { assets::serve(&headers, asset) }))
    });
    router
        .route("/", get(ui::app_handler))
        // 「新发现」（官网 /{cc}/new，这里跟随主地区）
        .route("/new", get(ui::app_handler))
        .route("/status", get(ui::status_handler))
        .route("/parse/song/:adam_id", get(ui::master_handler))
        .route("/parse/mv/:adam_id", get(ui::mv_master_handler))
        // 浏览器直连本地 wrapper-lite 时，MV master 仍由服务端获取
        .route("/parse/mv-master", get(ui::mv_master_url_handler))
        .route("/key", get(ui::key_handler))
        .route("/amp/v1/catalog/*path", get(amp::catalog_handler))
        .route("/amp/v1/editorial/*path", get(amp::editorial_handler))
        .route("/amp/v1/storefronts", get(amp::storefronts_handler))
        .route("/mv/webplayback/:adam_id", get(ui::mv_webplayback_handler))
        .route("/mv/license", post(ui::mv_license_handler))
        .route("/lyrics/:adam_id", get(ui::lyrics_handler))
        .fallback(ui::fallback_handler)
        .layer(axum::middleware::from_fn(log::access_log))
        .with_state(state)
}
