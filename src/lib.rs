pub mod amp;
pub mod assets;
pub mod cli;
pub mod handlers;
pub mod limit;
pub mod log;
pub mod links;
pub mod security;
pub mod state;
pub mod updater;
pub mod wrapper;

use std::sync::Arc;

use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::Router;

use crate::state::AppState;

/// amp-api 代理与电台接口：按客户端 IP 限流（--amp-client-rate），上游 429 后的冷却在 amp.rs。
/// `/amp/health` 供负载均衡做健康检查，不计入限流
fn apple_routes(state: &Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/amp/v1/catalog/*path", get(amp::catalog_handler))
        .route("/amp/v1/editorial/*path", get(amp::editorial_handler))
        .route("/amp/v1/recommendations/:cc", get(amp::recommendations_handler))
        .route("/amp/v1/storefronts", get(amp::storefronts_handler))
        // 电台（wrapper-lite 没有这些接口）：带页面传来的 media-user-token 请求 amp-api 与 Apple 的 license 服务器
        // 页面把 media-user-token 存进 HttpOnly cookie（POST）或清除（DELETE）
        .route("/station/token", post(amp::station_token_handler).delete(amp::station_token_clear_handler))
        .route("/station/assets", get(amp::station_assets_handler))
        .route("/station/next-tracks/:id", post(amp::station_next_tracks_handler))
        .route("/station/storefront", get(amp::station_storefront_handler))
        .route("/station/catalog/*path", get(amp::station_catalog_handler))
        .route("/station/recent", get(amp::station_recent_handler))
        // 「为你推荐」（官网 /{cc}/home）与区块的「查看全部」
        .route("/station/recommendations", get(amp::station_recommendations_handler))
        .route("/station/recommendations/:id/see-all", get(amp::station_recommendation_see_all_handler))
        .route("/station/license", post(amp::station_license_handler))
        .route_layer(axum::middleware::from_fn_with_state(state.clone(), limit::limit_amp_clients))
        .route("/amp/health", get(amp::health_handler))
}

/// `--amp-only`：只提供 amp-api 代理与电台接口（amp 代理集群的节点，由前面的反向代理按路径分流），
/// 不提供页面与静态资源、不转发 wrapper-lite；其余路径 404
fn amp_only_router(state: Arc<AppState>) -> Router {
    apple_routes(&state)
        .fallback(handlers::not_found_handler)
        .layer(axum::middleware::from_fn(security::headers))
        .layer(axum::middleware::from_fn_with_state(state.clone(), log::access_log))
        .with_state(state)
}

/// 首页与解析接口优先，歌曲 / MV / 专辑 / 歌单 / 艺人 / 电台页、编辑页（room / multi-room / grouping / curator）、广播、资料库页统一由 fallback 分流
pub fn router(state: Arc<AppState>) -> Router {
    if state.config.amp_only {
        return amp_only_router(state);
    }
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
    let apple = apple_routes(&state);
    router
        .merge(relay)
        .merge(apple)
        .route(assets::HOST_JS, get(handlers::host_js_handler))
        .route("/", get(handlers::app_handler))
        // 「新发现」（官网 /{cc}/new，这里跟随主地区）
        .route("/new", get(handlers::app_handler))
        // 浏览器直连本地 wrapper-lite 时，MV master 仍由服务端获取
        .route("/parse/mv-master", get(handlers::mv_master_url_handler))
        .fallback(handlers::fallback_handler)
        // CSP、nosniff 等安全响应头（见 security.rs），所有响应都带
        .layer(axum::middleware::from_fn(security::headers))
        .layer(axum::middleware::from_fn_with_state(state.clone(), log::access_log))
        .with_state(state)
}
