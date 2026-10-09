pub mod amp;
pub mod cli;
pub mod log;
pub mod m3u8;
pub mod state;
pub mod ui;
pub mod updater;
pub mod wrapper;

use std::sync::Arc;

use axum::routing::{get, post};
use axum::Router;

use crate::state::AppState;

/// 首页与解析接口优先，歌曲 / MV / 专辑 / 歌单 / 艺人页、编辑页（room / multi-room / grouping / curator）、资料库页统一由 fallback 分流
pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(ui::app_handler))
        // 「新发现」（官网 /{cc}/new，这里跟随主地区）
        .route("/new", get(ui::app_handler))
        .route("/status", get(ui::status_handler))
        .route("/parse/song/:adam_id", get(ui::master_handler))
        .route("/parse/mv/:adam_id", get(ui::mv_master_handler))
        .route("/key", get(ui::key_handler))
        .route("/amp/v1/catalog/*path", get(amp::catalog_handler))
        .route("/amp/v1/editorial/*path", get(amp::editorial_handler))
        .route("/amp/v1/storefronts", get(amp::storefronts_handler))
        .route("/mv/webplayback/:adam_id", get(ui::mv_webplayback_handler))
        .route("/mv/license", post(ui::mv_license_handler))
        .route("/assets/mv/:file", get(ui::mv_asset_handler))
        .route("/lyrics/:adam_id", get(ui::lyrics_handler))
        .route("/assets/lyrics/:file", get(ui::lyrics_asset_handler))
        .route("/assets/app.css", get(ui::css_handler))
        .route("/assets/app.mjs", get(ui::app_js_handler))
        .route("/assets/settings.mjs", get(ui::settings_js_handler))
        .route("/assets/library.mjs", get(ui::library_js_handler))
        .route("/assets/views/:file", get(ui::view_asset_handler))
        .route("/assets/motion-art.mjs", get(ui::motion_art_handler))
        .route("/assets/player.js", get(ui::player_js_handler))
        .route("/assets/i18n.js", get(ui::i18n_js_handler))
        .route("/assets/decrypt.js", get(ui::decrypt_js_handler))
        .route("/assets/hook-worker.js", get(ui::worker_js_handler))
        .route("/assets/hook.wasm", get(ui::wasm_handler))
        .route("/assets/media-worker.js", get(ui::media_worker_handler))
        .route("/assets/media.wasm", get(ui::media_wasm_handler))
        .route("/assets/flac.wasm", get(ui::flac_wasm_handler))
        .route("/assets/flac-init.bin", get(ui::flac_init_handler))
        .route("/assets/flac-transcode-worker.js", get(ui::flac_worker_handler))
        .route("/assets/ec3-decode-worker.js", get(ui::ec3_worker_handler))
        .route("/assets/ec3-runtime.mjs", get(ui::ec3_runtime_handler))
        .route("/assets/ec3.wasm", get(ui::ec3_wasm_handler))
        .fallback(ui::fallback_handler)
        .layer(axum::middleware::from_fn(log::access_log))
        .with_state(state)
}
