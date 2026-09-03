use std::sync::Arc;
use std::time::Duration;
use axum::body::Body;
use axum::extract::State;
use axum::http::header::{ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE};
use axum::http::{HeaderMap, Method, Response, StatusCode, Uri};
use bytes::Bytes;
use futures::stream::{self, StreamExt};
use regex::Regex;
use tracing::{error, info, warn};

use crate::embedded_template::get_fixed_template;
use crate::m3u8::parse_and_clean_media_m3u8;
use crate::mp4::{decrypt_fragment, patch_init_segment};
use crate::state::{AppState, TrackContext};

/// 主入口路由处理器：截取 / 后的源地址并校验白名单，根据特征分流处理
pub async fn handle_proxy(
    State(state): State<Arc<AppState>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> Response<Body> {
    let raw_path = uri.path();
    let raw_target = raw_path.strip_prefix('/').unwrap_or(raw_path);

    // 1. 规整化 URL 并附加 query 参数
    let mut target_url = normalize_upstream_url(raw_target);
    if let Some(q) = uri.query() {
        target_url = format!("{target_url}?{q}");
    }

    // 2. 白名单检查：只处理源地址里有 aod.itunes.apple.com/itunes-assets/ 字符的请求
    if !target_url.contains("aod.itunes.apple.com/itunes-assets/") {
        warn!(target_url = %target_url, "Rejected request not matching whitelist");
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(Body::from("Only requests containing 'aod.itunes.apple.com/itunes-assets/' are supported.\n"))
            .unwrap();
    }

    // 3. 提取文件名以进行正则分类
    let filename = match extract_filename(&target_url) {
        Some(f) => f,
        None => {
            return Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .body(Body::from("Could not extract filename from source URL\n"))
                .unwrap();
        }
    };

    info!(method = %method, filename = %filename, "Routing upstream request");

    // 4. 正则特征分流
    // Type 1: Master m3u8 (最末段为 "P" + 一段数字 + "_" + 非A开头的一段字符 + ".m3u8")
    let master_re = Regex::new(r"^P\d+_[^A].*\.m3u8$").unwrap();
    // Type 2: Media m3u8 (最末段为 "P" + 一段数字 + "_A" + 一段数字 + "_" + 一段字符 + ".m3u8")
    let media_m3u8_re = Regex::new(r"^P\d+_A\d+_.*\.m3u8$").unwrap();
    // Type 3: Media file (将 media m3u8 末尾的 ".m3u8" 替换为 "_m.mp4")
    let media_file_re = Regex::new(r"^P\d+_A\d+_.*_m\.mp4$").unwrap();

    if master_re.is_match(&filename) {
        handle_master_m3u8(state, target_url).await
    } else if media_m3u8_re.is_match(&filename) {
        handle_media_m3u8(state, target_url).await
    } else if media_file_re.is_match(&filename) {
        handle_media_file(state, method, target_url, filename, headers).await
    } else {
        // 其他文件原样反代转发
        handle_passthrough(state, method, target_url).await
    }
}

/// 规整客户端传入的 URL 协议前缀
fn normalize_upstream_url(raw: &str) -> String {
    if raw.starts_with("https://") || raw.starts_with("http://") {
        raw.to_string()
    } else if raw.starts_with("https:/") {
        format!("https://{}", &raw[7..])
    } else if raw.starts_with("http:/") {
        format!("http://{}", &raw[6..])
    } else if raw.starts_with("aod.itunes.apple.com") {
        format!("https://{}", raw)
    } else {
        raw.to_string()
    }
}

fn extract_filename(url: &str) -> Option<String> {
    let path = url.split('?').next().unwrap_or(url);
    path.rsplit('/').next().map(|s| s.to_string())
}

/// Type 1: Master m3u8 — 原样转发并返回
async fn handle_master_m3u8(state: Arc<AppState>, target_url: String) -> Response<Body> {
    info!(url = %target_url, "Handling Master m3u8 (pass-through)");
    match state.http_client.get(&target_url).send().await {
        Ok(resp) => {
            let status = resp.status();
            let body = resp.bytes().await.unwrap_or_default();
            Response::builder()
                .status(status)
                .header(CONTENT_TYPE, "application/vnd.apple.mpegurl; charset=utf-8")
                .body(Body::from(body))
                .unwrap()
        }
        Err(e) => {
            error!(url = %target_url, error = %e, "Failed to fetch master m3u8");
            Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(Body::from(format!("Failed to fetch upstream master m3u8: {e}\n")))
                .unwrap()
        }
    }
}

/// Type 2: Media m3u8 — 解析提取上下文并清除所有加密元数据
async fn handle_media_m3u8(state: Arc<AppState>, target_url: String) -> Response<Body> {
    info!(url = %target_url, "Handling Media m3u8");
    let resp = match state.http_client.get(&target_url).send().await {
        Ok(r) => r,
        Err(e) => {
            error!(url = %target_url, error = %e, "Failed to fetch media m3u8");
            return Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(Body::from(format!("Failed to fetch upstream media m3u8: {e}\n")))
                .unwrap();
        }
    };

    let raw_text = match resp.text().await {
        Ok(t) => t,
        Err(e) => {
            return Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(Body::from(format!("Failed to read upstream m3u8 body: {e}\n")))
                .unwrap();
        }
    };

    match parse_and_clean_media_m3u8(&target_url, &raw_text) {
        Ok((parsed, cleaned_m3u8)) => {
            info!(
                adam_id = %parsed.adam_id,
                fileuri = %parsed.fileuri,
                uri = %parsed.uri,
                range1 = %parsed.range1,
                total_size = %parsed.total_size,
                "Media m3u8 parsed successfully"
            );

            // 存入或更新上下文
            let track = Arc::new(TrackContext::new(
                parsed.adam_id,
                parsed.uri,
                parsed.fileuri.clone(),
                parsed.range1,
                parsed.init_range,
                parsed.fragments,
                parsed.total_size,
            ));
            state.insert_track(track.clone());
            crate::monitor::trigger_template_fetch(&state, &track);

            Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, "application/vnd.apple.mpegurl; charset=utf-8")
                .body(Body::from(cleaned_m3u8))
                .unwrap()
        }
        Err(e) => {
            error!(error = %e, "Failed to parse media m3u8");
            Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Body::from(format!("Failed to parse media m3u8: {e}\n")))
                .unwrap()
        }
    }
}

/// Type 3: Media file (fMP4) — 支持 Range 分段请求及边解密边流式传输
async fn handle_media_file(
    state: Arc<AppState>,
    method: Method,
    target_url: String,
    fileuri: String,
    headers: HeaderMap,
) -> Response<Body> {
    // 1. 检查或补齐结构体
    let track = match ensure_track_context(state.clone(), &target_url, &fileuri).await {
        Ok(t) => t,
        Err(e) => {
            return Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(Body::from(format!("Failed to resolve track context: {e}\n")))
                .unwrap();
        }
    };

    let total_size = track.total_size;

    // 2. 处理 HEAD 请求
    if method == Method::HEAD {
        return Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, "video/mp4")
            .header(CONTENT_LENGTH, total_size.to_string())
            .header(ACCEPT_RANGES, "bytes")
            .body(Body::empty())
            .unwrap();
    }

    // 3. 解析 Range 请求头
    let (start, end, is_range) = match parse_range_header(headers.get(RANGE), total_size) {
        Ok(res) => res,
        Err(e) => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(CONTENT_RANGE, format!("bytes */{total_size}"))
                .body(Body::from(e))
                .unwrap();
        }
    };

    let content_len = end - start + 1;

    // 4. 定位涉及到的分片
    let covered_frags = get_intersecting_fragments(&track, start, end);
    if covered_frags.is_empty() {
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(CONTENT_RANGE, format!("bytes */{total_size}"))
            .body(Body::from("Range does not match any fragment"))
            .unwrap();
    }

    // 5. 若涉及大于等于 Fragment 2 的分片，确保 Track 模板已准备就绪
    let needs_track_template = covered_frags.iter().any(|(idx, _, _)| *idx >= 2);
    let track_tmpl = if needs_track_template {
        match track.wait_for_template(Duration::from_secs(15)).await {
            Ok(t) => Some(t),
            Err(e) => {
                error!(error = %e, "Timed out waiting for Track decryption template");
                return Response::builder()
                    .status(StatusCode::GATEWAY_TIMEOUT)
                    .body(Body::from(format!("Decryption template not ready: {e}\n")))
                    .unwrap();
            }
        }
    } else {
        None
    };

    // 6. 流式处理各分片（支持用户停止播放时自动取消多余拉取）
    let state_clone = state.clone();
    let target_url_clone = target_url.clone();
    let fileuri_clone = fileuri.clone();

    let stream = stream::iter(covered_frags).then(move |(frag_idx, frag_offset, frag_len)| {
        let state = state_clone.clone();
        let target_url = target_url_clone.clone();
        let fileuri = fileuri_clone.clone();
        let track_tmpl = track_tmpl.clone();

        async move {
            // 提取该 fragment 解密后的内容（优先查 LRU 缓存）
            let frag_data = get_or_decrypt_fragment(
                state,
                &target_url,
                &fileuri,
                frag_idx,
                frag_offset,
                frag_len,
                track_tmpl,
            ).await.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;

            // 计算该分片与请求 [start, end] 交叉切片
            let slice_start = if start > frag_offset { (start - frag_offset) as usize } else { 0 };
            let slice_end = if end < frag_offset + frag_len - 1 {
                (end - frag_offset + 1) as usize
            } else {
                frag_data.len()
            };

            if slice_start < frag_data.len() {
                let clamped_end = slice_end.min(frag_data.len());
                Ok::<Bytes, std::io::Error>(frag_data.slice(slice_start..clamped_end))
            } else {
                Ok(Bytes::new())
            }
        }
    });

    let body = Body::from_stream(stream);

    let mut builder = Response::builder();
    if is_range {
        builder = builder
            .status(StatusCode::PARTIAL_CONTENT)
            .header(CONTENT_RANGE, format!("bytes {start}-{end}/{total_size}"));
    } else {
        builder = builder.status(StatusCode::OK);
    }

    builder
        .header(CONTENT_TYPE, "video/mp4")
        .header(CONTENT_LENGTH, content_len.to_string())
        .header(ACCEPT_RANGES, "bytes")
        .body(body)
        .unwrap()
}

/// 获取或从 upstream 下载并解密分片（通过 LRU 缓存优化重复命中）
async fn get_or_decrypt_fragment(
    state: Arc<AppState>,
    target_url: &str,
    fileuri: &str,
    frag_idx: usize,
    frag_offset: u64,
    frag_len: u64,
    track_tmpl: Option<Arc<temari::rounds::Template>>,
) -> Result<Bytes, String> {
    let cache_key = format!("{fileuri}#{frag_offset}#{frag_len}");
    if let Some(cached) = state.get_cached_fragment(&cache_key).await {
        return Ok(cached);
    }

    // 从 upstream 下载该分片
    let frag_end = frag_offset + frag_len - 1;
    let resp = state
        .http_client
        .get(target_url)
        .header(RANGE, format!("bytes={frag_offset}-{frag_end}"))
        .send()
        .await
        .map_err(|e| format!("Failed to download fragment: {e}"))?;

    let raw_bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read fragment bytes: {e}"))?;

    // 解密或处理
    let decrypted_bytes = if frag_idx == 0 {
        // Init segment
        patch_init_segment(&raw_bytes)?
    } else if frag_idx == 1 {
        // Fragment 1: 必须使用内嵌固定模板 (adamId=0, skd://.../P000000000/s1/e1)
        let tmpl = get_fixed_template();
        decrypt_fragment(&raw_bytes, tmpl)?
    } else {
        // Fragment >= 2: 使用对应 Track 模板
        let tmpl = track_tmpl.ok_or_else(|| "Missing track template for frag >= 2".to_string())?;
        decrypt_fragment(&raw_bytes, &tmpl)?
    };

    let out = Bytes::from(decrypted_bytes);
    state.put_cached_fragment(cache_key, out.clone()).await;
    Ok(out)
}

/// 确保指定 fileuri 的 TrackContext 存在，如果不存在则请求源 .m3u8 进行补齐
async fn ensure_track_context(
    state: Arc<AppState>,
    target_url: &str,
    fileuri: &str,
) -> Result<Arc<TrackContext>, String> {
    if let Some(track) = state.get_track(fileuri) {
        return Ok(track);
    }

    // 将源地址里的 "_m.mp4" 替换为 ".m3u8"
    let m3u8_url = target_url.replace("_m.mp4", ".m3u8");
    info!(m3u8_url = %m3u8_url, "Fetching media m3u8 to populate missing TrackContext");

    let resp = state
        .http_client
        .get(&m3u8_url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch media m3u8 for auto-complete: {e}"))?;

    let text = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read media m3u8 for auto-complete: {e}"))?;

    let (parsed, _) = parse_and_clean_media_m3u8(&m3u8_url, &text)?;
    let track = Arc::new(TrackContext::new(
        parsed.adam_id,
        parsed.uri,
        parsed.fileuri,
        parsed.range1,
        parsed.init_range,
        parsed.fragments,
        parsed.total_size,
    ));
    state.insert_track(track.clone());
    crate::monitor::trigger_template_fetch(&state, &track);
    Ok(track)
}

/// 解析 Range 请求头
fn parse_range_header(range_header: Option<&axum::http::HeaderValue>, total_size: u64) -> Result<(u64, u64, bool), String> {
    let range_str = match range_header.and_then(|v| v.to_str().ok()) {
        Some(s) => s.trim(),
        None => return Ok((0, total_size.saturating_sub(1), false)),
    };

    if !range_str.starts_with("bytes=") {
        return Ok((0, total_size.saturating_sub(1), false));
    }

    let spec = &range_str[6..];
    let parts: Vec<&str> = spec.split('-').collect();
    if parts.len() != 2 {
        return Err("Invalid range format".into());
    }

    if parts[0].is_empty() {
        // 后缀 Range: bytes=-N
        let suffix_len: u64 = parts[1].parse().map_err(|_| "Invalid suffix length")?;
        let start = total_size.saturating_sub(suffix_len);
        let end = total_size.saturating_sub(1);
        Ok((start, end, true))
    } else {
        let start: u64 = parts[0].parse().map_err(|_| "Invalid range start")?;
        let end: u64 = if parts[1].is_empty() {
            total_size.saturating_sub(1)
        } else {
            parts[1].parse().map_err(|_| "Invalid range end")?
        };

        if start >= total_size || start > end {
            return Err(format!("Range start {start} exceeds size {total_size}"));
        }
        let clamped_end = end.min(total_size.saturating_sub(1));
        Ok((start, clamped_end, true))
    }
}

/// 获取给定 Range [start, end] 相交的所有分片信息 (分片索引 0 为 init, 1 为 frag1, >=2 为后续 frag)
fn get_intersecting_fragments(
    track: &TrackContext,
    start: u64,
    end: u64,
) -> Vec<(usize, u64, u64)> {
    let mut list = Vec::new();

    // Check init segment
    let (init_off, init_len) = track.init_range;
    if init_len > 0 {
        let init_end = init_off + init_len - 1;
        if !(end < init_off || start > init_end) {
            list.push((0, init_off, init_len));
        }
    }

    // Check media fragments
    for (i, frag) in track.fragments.iter().enumerate() {
        let frag_idx = i + 1; // 1-based index (1 is frag1)
        let f_off = frag.offset;
        let f_len = frag.length;
        let f_end = f_off + f_len - 1;
        if !(end < f_off || start > f_end) {
            list.push((frag_idx, f_off, f_len));
        }
    }

    list
}

/// 未命中上述类型的其他 URL 原样反向代理
async fn handle_passthrough(state: Arc<AppState>, method: Method, target_url: String) -> Response<Body> {
    let req = state.http_client.request(method, &target_url);
    match req.send().await {
        Ok(resp) => {
            let status = resp.status();
            let headers = resp.headers().clone();
            let mut builder = Response::builder().status(status);
            for (k, v) in headers.iter() {
                builder = builder.header(k, v);
            }
            let body = Body::from_stream(resp.bytes_stream());
            builder.body(body).unwrap()
        }
        Err(e) => Response::builder()
            .status(StatusCode::BAD_GATEWAY)
            .body(Body::from(format!("Passthrough error: {e}\n")))
            .unwrap(),
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_url_classification() {
        let master_re = Regex::new(r"^P\d+_[^A].*\.m3u8$").unwrap();
        let media_m3u8_re = Regex::new(r"^P\d+_A\d+_.*\.m3u8$").unwrap();
        let media_file_re = Regex::new(r"^P\d+_A\d+_.*_m\.mp4$").unwrap();

        let master = "P1263211745_default.m3u8";
        assert!(master_re.is_match(master));
        assert!(!media_m3u8_re.is_match(master));
        assert!(!media_file_re.is_match(master));

        let media_m3u8 = "P1263211745_A1468058171_audio_en_gr2768_mp4a-A6.m3u8";
        assert!(!master_re.is_match(media_m3u8));
        assert!(media_m3u8_re.is_match(media_m3u8));
        assert!(!media_file_re.is_match(media_m3u8));

        let media_file = "P1263211745_A1468058171_audio_en_gr2768_mp4a-A6_m.mp4";
        assert!(!master_re.is_match(media_file));
        assert!(!media_m3u8_re.is_match(media_file));
        assert!(media_file_re.is_match(media_file));
    }

    #[test]
    fn test_normalize_upstream_url() {
        assert_eq!(
            normalize_upstream_url("https:/aod.itunes.apple.com/test"),
            "https://aod.itunes.apple.com/test"
        );
        assert_eq!(
            normalize_upstream_url("http:/aod.itunes.apple.com/test"),
            "http://aod.itunes.apple.com/test"
        );
        assert_eq!(
            normalize_upstream_url("aod.itunes.apple.com/test"),
            "https://aod.itunes.apple.com/test"
        );
        assert_eq!(
            normalize_upstream_url("https://aod.itunes.apple.com/test"),
            "https://aod.itunes.apple.com/test"
        );
    }

    #[test]
    fn test_parse_range_header() {
        let total = 1000;
        let h1 = axum::http::HeaderValue::from_static("bytes=0-499");
        assert_eq!(parse_range_header(Some(&h1), total).unwrap(), (0, 499, true));

        let h2 = axum::http::HeaderValue::from_static("bytes=500-");
        assert_eq!(parse_range_header(Some(&h2), total).unwrap(), (500, 999, true));

        let h3 = axum::http::HeaderValue::from_static("bytes=-100");
        assert_eq!(parse_range_header(Some(&h3), total).unwrap(), (900, 999, true));

        assert_eq!(parse_range_header(None, total).unwrap(), (0, 999, false));
    }
}
