pub mod amp;
pub mod assets;
pub mod cli;
pub mod handlers;
pub mod limit;
pub mod log;
pub mod links;
pub mod state;
pub mod updater;
pub mod wrapper;

use std::sync::Arc;

use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::Router;

use crate::state::AppState;

/// 首页与解析接口优先，歌曲 / MV / 专辑 / 歌单 / 艺人 / 电台页、编辑页（room / multi-room / grouping / curator）、广播、资料库页统一由 fallback 分流
pub fn router(state: Arc<AppState>) -> Router {
    // 内嵌前端资源按 assets::ASSETS 表注册（原地址与内容哈希地址），其余是后端接口；
    // host.js 按启动参数生成（见 handlers::host_js_handler）
    let router = assets::SITE.assets.iter().filter(|asset| asset.url != assets::HOST_JS).fold(Router::new(), |router, asset| {
        router.route(&asset.url, get(move |headers: HeaderMap| async move { assets::serve(&headers, asset) }))
    });
    // 转发 wrapper-lite 的接口：--local-wrapper-only 时一律 501，页面改用浏览器直连
    let relay = Router::new()
        .route("/status", get(handlers::status_handler))
        .route("/parse/song/:adam_id", get(handlers::master_handler))
        .route("/parse/mv/:adam_id", get(handlers::mv_master_handler))
        .route("/key", get(handlers::key_handler))
        .route("/mv/webplayback/:adam_id", get(handlers::mv_webplayback_handler))
        .route("/mv/license", post(handlers::mv_license_handler))
        .route("/lyrics/:adam_id", get(handlers::lyrics_handler))
        // 按客户端 IP 限流（--client-rate），在 require_relay 之内
        .route_layer(axum::middleware::from_fn_with_state(state.clone(), limit::limit_clients))
        .route_layer(axum::middleware::from_fn_with_state(state.clone(), handlers::require_relay));
    router
        .merge(relay)
        .route(assets::HOST_JS, get(handlers::host_js_handler))
        .route("/", get(handlers::app_handler))
        // 「新发现」（官网 /{cc}/new，这里跟随主地区）
        .route("/new", get(handlers::app_handler))
        // 浏览器直连本地 wrapper-lite 时，MV master 仍由服务端获取
        .route("/parse/mv-master", get(handlers::mv_master_url_handler))
        .route("/amp/v1/catalog/*path", get(amp::catalog_handler))
        .route("/amp/v1/editorial/*path", get(amp::editorial_handler))
        .route("/amp/v1/storefronts", get(amp::storefronts_handler))
        // 电台（wrapper-lite 没有这些接口）：带页面传来的 media-user-token 请求 amp-api 与 Apple 的 license 服务器
        .route("/station/assets", get(amp::station_assets_handler))
        .route("/station/next-tracks/:id", post(amp::station_next_tracks_handler))
        .route("/station/storefront", get(amp::station_storefront_handler))
        .route("/station/catalog/*path", get(amp::station_catalog_handler))
        .route("/station/recent", get(amp::station_recent_handler))
        .route("/station/license", post(amp::station_license_handler))
        .fallback(handlers::fallback_handler)
        .layer(axum::middleware::from_fn(log::access_log))
        .with_state(state)
}
