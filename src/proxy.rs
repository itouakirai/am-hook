use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::header::{self, ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE};
use axum::http::{HeaderMap, HeaderValue, Method, Response, StatusCode, Uri};
use bytes::Bytes;
use futures::stream::{self, StreamExt, TryStreamExt};
use tracing::{debug, info, warn};

use crate::embedded_template::get_fixed_template;
use crate::m3u8::{parse_media_m3u8, parse_song_link, to_compat_playlist};
use crate::monitor::ensure_template;
use crate::mp4::{decrypt_fragment, patch_init_segment};
use crate::source::{self, SourceKind, WHITELIST};
use crate::state::{AppState, Track};
use crate::ui::song_handler;

const M3U8_TYPE: &str = "application/vnd.apple.mpegurl; charset=utf-8";
const BYTERANGE_PARAM: &str = "hook=byterange";

/// 反代入口：`/` 后面是源地址，只处理白名单内的请求，按文件名特征分流
pub async fn handle_proxy(State(state): State<Arc<AppState>>, method: Method, uri: Uri, headers: HeaderMap) -> Response<Body> {
    let path = uri.path().strip_prefix('/').unwrap_or(uri.path());

    // Apple Music 页面路径本身也是 "https://..."，交给 song UI
    if parse_song_link(path).is_ok() {
        return song_handler(uri).await;
    }

    // `hook=byterange` 是给 am-hook 自己的参数（media m3u8 保留原始 BYTERANGE 写法），不转发给 CDN
    let mut byterange = false;
    let query: Vec<&str> = uri
        .query()
        .unwrap_or("")
        .split('&')
        .filter(|p| !p.is_empty())
        .filter(|p| {
            let hit = *p == BYTERANGE_PARAM;
            byterange |= hit;
            !hit
        })
        .collect();
    let mut target = source::normalize_url(path);
    if !query.is_empty() {
        target.push('?');
        target.push_str(&query.join("&"));
    }

    if !target.contains(WHITELIST) {
        warn!(%target, "Rejected request not matching whitelist");
        return text(StatusCode::FORBIDDEN, format!("Only requests containing '{WHITELIST}' are supported.\n"));
    }

    let kind = source::classify(source::filename(&target));
    info!(%method, ?kind, file = source::filename(&target), range = ?headers.get(RANGE), ua = ?headers.get(header::USER_AGENT), "Proxy request");

    match kind {
        SourceKind::MasterPlaylist => forward(&state, method, &target, None, Some(M3U8_TYPE)).await,
        SourceKind::MediaPlaylist => handle_media_m3u8(&state, &target, byterange).await,
        SourceKind::MediaFile => handle_media_file(state, method, target, &headers).await,
        SourceKind::MediaSegment => handle_media_segment(state, method, &target, &headers).await,
        SourceKind::Other => forward(&state, method, &target, headers.get(RANGE), None).await,
    }
}

/// 原样流式转发（master m3u8 与其他白名单文件）
async fn forward(
    state: &AppState,
    method: Method,
    target: &str,
    range: Option<&HeaderValue>,
    content_type: Option<&'static str>,
) -> Response<Body> {
    let mut req = state.http_client.request(method, target);
    if let Some(r) = range {
        req = req.header(RANGE, r);
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => return text(StatusCode::BAD_GATEWAY, format!("Upstream request failed: {e}\n")),
    };

    let mut builder = Response::builder().status(resp.status());
    for name in [CONTENT_TYPE, CONTENT_LENGTH, CONTENT_RANGE, ACCEPT_RANGES, header::LAST_MODIFIED, header::ETAG] {
        if let Some(v) = resp.headers().get(&name) {
            builder = builder.header(name, v);
        }
    }
    if let Some(ct) = content_type {
        builder = builder.header(CONTENT_TYPE, ct);
    }
    builder.body(Body::from_stream(resp.bytes_stream())).unwrap()
}

async fn fetch_text(state: &AppState, url: &str) -> Result<String, String> {
    let resp = state.http_client.get(url).send().await.map_err(|e| format!("Failed to fetch {url}: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("Upstream returned HTTP {status} for {url}"));
    }
    resp.text().await.map_err(|e| format!("Failed to read {url}: {e}"))
}

/// 注册（或复用已存在的）轨道并立即触发模板拉取
async fn register_track(state: &Arc<AppState>, track: Track) -> Arc<Track> {
    let fileuri = track.fileuri.clone();
    let track = state
        .get_or_init_track(&fileuri, || async { Ok(track) })
        .await
        .expect("infallible init");
    ensure_template(state, &track);
    track
}

/// Media m3u8：补齐轨道信息，返回去掉加密标记的 m3u8。
/// 默认输出通用写法（每段独立 URL）；`byterange` 时保留原始的 EXT-X-MAP + BYTERANGE 写法。
async fn handle_media_m3u8(state: &Arc<AppState>, target: &str, byterange: bool) -> Response<Body> {
    let raw = match fetch_text(state, target).await {
        Ok(t) => t,
        Err(e) => return text(StatusCode::BAD_GATEWAY, format!("{e}\n")),
    };
    let (track, cleaned) = match parse_media_m3u8(target, &raw) {
        Ok(v) => v,
        Err(e) => return text(StatusCode::BAD_GATEWAY, format!("Failed to parse media m3u8: {e}\n")),
    };
    info!(
        adam_id = %track.adam_id, uri = %track.uri, fileuri = %track.fileuri,
        range1 = %track.range1, segments = track.segments.len(), "Media m3u8 parsed"
    );
    register_track(state, track).await;

    let body = if byterange { cleaned } else { to_compat_playlist(&cleaned) };
    Response::builder().header(CONTENT_TYPE, M3U8_TYPE).body(Body::from(body)).unwrap()
}

/// 取得 media file 对应的轨道：优先内存，其次拉取对应 m3u8 补齐（并发请求只拉一次）
async fn resolve_track(state: &Arc<AppState>, target: &str) -> Result<Arc<Track>, String> {
    let fileuri = source::filename(target);
    let track = state
        .get_or_init_track(fileuri, || async {
            let m3u8_url = source::media_file_to_playlist_url(target);
            info!(%m3u8_url, "Track unknown, fetching media m3u8");
            let raw = fetch_text(state, &m3u8_url).await?;
            Ok(parse_media_m3u8(&m3u8_url, &raw)?.0)
        })
        .await?;
    ensure_template(state, &track);
    Ok(track)
}

/// Media file：按 Range 映射到 segment，拉取、解密并流式返回
async fn handle_media_file(state: Arc<AppState>, method: Method, target: String, headers: &HeaderMap) -> Response<Body> {
    let track = match resolve_track(&state, &target).await {
        Ok(t) => t,
        Err(e) => return text(StatusCode::BAD_GATEWAY, format!("Failed to resolve track: {e}\n")),
    };
    let total = track.total_size;

    let (start, end, partial) = match parse_range(headers.get(RANGE), total) {
        Some(r) => r,
        None => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(CONTENT_RANGE, format!("bytes */{total}"))
                .body(Body::empty())
                .unwrap();
        }
    };

    let mut builder = Response::builder()
        .header(CONTENT_TYPE, "video/mp4")
        .header(ACCEPT_RANGES, "bytes")
        .header(CONTENT_LENGTH, end - start + 1);
    builder = if partial {
        builder.status(StatusCode::PARTIAL_CONTENT).header(CONTENT_RANGE, format!("bytes {start}-{end}/{total}"))
    } else {
        builder.status(StatusCode::OK)
    };
    if method == Method::HEAD {
        return builder.body(Body::empty()).unwrap();
    }

    let segs = track.segments_overlapping(start, end);

    // 首个需要轨道模板的 segment 若就是第一块输出，先等模板就绪，失败时还能返回正常的错误码
    if segs.start >= 2 && track.template().is_none() {
        if let Err(e) = track.wait_template(state.config.template_timeout).await {
            return text(StatusCode::GATEWAY_TIMEOUT, format!("Decryption template not ready: {e}\n"));
        }
    }

    // 播放器逐段请求时，预热下一个 segment
    if partial {
        spawn_readahead(&state, &track, &target, segs.end);
    }

    let prefetch = state.config.prefetch.max(1);
    let body = stream::iter(segs)
        .map(move |idx| {
            let (state, track, target) = (state.clone(), track.clone(), target.clone());
            async move {
                let data = load_segment(&state, &track, &target, idx).await?;
                let seg = track.segments[idx];
                let lo = start.saturating_sub(seg.offset) as usize;
                let hi = ((end + 1).min(seg.end()) - seg.offset) as usize;
                Ok::<_, String>(data.slice(lo..hi))
            }
        })
        // 顺序输出，同时最多并发 prefetch 个 segment；客户端断开时整个流被丢弃，未完成的拉取随之取消
        .buffered(prefetch)
        .inspect_err(|e| warn!(error = %e, "Aborting media file stream"))
        .map_err(std::io::Error::other);

    builder.body(Body::from_stream(body)).unwrap()
}

/// 通用 m3u8 的独立分片：init 段 + 第 idx 个 frag 拼接返回，播放器可逐段单独解码
async fn handle_media_segment(state: Arc<AppState>, method: Method, target: &str, headers: &HeaderMap) -> Response<Body> {
    let Some((file_target, idx)) = source::segment_to_media_file_url(target) else {
        return text(StatusCode::NOT_FOUND, "Invalid segment URL\n".into());
    };
    let track = match resolve_track(&state, &file_target).await {
        Ok(t) => t,
        Err(e) => return text(StatusCode::BAD_GATEWAY, format!("Failed to resolve track: {e}\n")),
    };
    if idx == 0 || idx >= track.segments.len() {
        return text(StatusCode::NOT_FOUND, format!("Segment {idx} out of range\n"));
    }

    // box 替换保持字节长度不变，无需解密即可得知总长
    let total = track.segments[0].length + track.segments[idx].length;
    let Some((start, end, partial)) = parse_range(headers.get(RANGE), total) else {
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(CONTENT_RANGE, format!("bytes */{total}"))
            .body(Body::empty())
            .unwrap();
    };

    let mut builder = Response::builder()
        .header(CONTENT_TYPE, "video/mp4")
        .header(ACCEPT_RANGES, "bytes")
        .header(CONTENT_LENGTH, end - start + 1);
    builder = if partial {
        builder.status(StatusCode::PARTIAL_CONTENT).header(CONTENT_RANGE, format!("bytes {start}-{end}/{total}"))
    } else {
        builder.status(StatusCode::OK)
    };
    if method == Method::HEAD {
        return builder.body(Body::empty()).unwrap();
    }

    spawn_readahead(&state, &track, &file_target, idx + 1);
    let loaded = tokio::try_join!(
        load_segment(&state, &track, &file_target, 0),
        load_segment(&state, &track, &file_target, idx)
    );
    let (init, frag) = match loaded {
        Ok(v) => v,
        Err(e) => return text(StatusCode::BAD_GATEWAY, format!("Failed to load segment {idx}: {e}\n")),
    };
    let mut data = Vec::with_capacity(total as usize);
    data.extend_from_slice(&init);
    data.extend_from_slice(&frag);
    let data = Bytes::from(data).slice(start as usize..=end as usize);
    builder.body(Body::from(data)).unwrap()
}

fn spawn_readahead(state: &Arc<AppState>, track: &Arc<Track>, target: &str, idx: usize) {
    if idx >= track.segments.len() || state.segments.contains(&(track.fileuri.clone(), idx)) {
        return;
    }
    let (state, track, target) = (state.clone(), track.clone(), target.to_string());
    tokio::spawn(async move {
        if let Err(e) = load_segment(&state, &track, &target, idx).await {
            debug!(idx, error = %e, "Readahead failed");
        }
    });
}

/// 取得解密后的 segment：命中缓存直接返回，否则下载 + 解密（同一 segment 并发只做一次）
async fn load_segment(state: &AppState, track: &Arc<Track>, target: &str, idx: usize) -> Result<Bytes, String> {
    state
        .segments
        .get_or_load((track.fileuri.clone(), idx), || async {
            let seg = track.segments[idx];
            // 下载与等待模板并行
            let (raw, tmpl) = tokio::try_join!(download(state, target, seg.offset, seg.length), async {
                if idx >= 2 {
                    track.wait_template(state.config.template_timeout).await.map(Some)
                } else {
                    Ok(None)
                }
            })?;

            // 解密是 CPU 密集操作（内部用 temari 线程池并行），不能占用 async worker
            let out = tokio::task::spawn_blocking(move || match (idx, tmpl) {
                (0, _) => Ok(patch_init_segment(&raw)),
                (1, _) => decrypt_fragment(&raw, get_fixed_template()),
                (_, Some(t)) => decrypt_fragment(&raw, &t),
                (_, None) => unreachable!("template awaited above"),
            })
            .await
            .map_err(|e| format!("Decrypt task failed: {e}"))??;
            debug!(fileuri = %track.fileuri, idx, bytes = out.len(), "Segment decrypted");
            Ok(Bytes::from(out))
        })
        .await
}

async fn download(state: &AppState, url: &str, offset: u64, length: u64) -> Result<Bytes, String> {
    let resp = state
        .http_client
        .get(url)
        .header(RANGE, format!("bytes={}-{}", offset, offset + length - 1))
        .send()
        .await
        .map_err(|e| format!("Failed to download segment: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("Upstream returned HTTP {status} for segment @{offset}"));
    }
    let mut body = resp.bytes().await.map_err(|e| format!("Failed to read segment: {e}"))?;
    if status == StatusCode::OK && body.len() as u64 > length {
        // 上游忽略了 Range，自行截取
        body = body.slice(offset as usize..(offset + length) as usize);
    }
    if body.len() as u64 != length {
        return Err(format!("Segment @{offset} size mismatch: got {} expected {length}", body.len()));
    }
    Ok(body)
}

/// 解析单段 Range，返回 (start, end 闭区间, 是否部分响应)；不可满足时返回 None。
/// 无法识别或多段的 Range 按规范忽略，返回整个文件。
fn parse_range(header: Option<&HeaderValue>, total: u64) -> Option<(u64, u64, bool)> {
    let full = Some((0, total.saturating_sub(1), false));
    let Some(spec) = header.and_then(|v| v.to_str().ok()).and_then(|s| s.trim().strip_prefix("bytes=")) else {
        return full;
    };
    if spec.contains(',') {
        return full;
    }
    let Some((a, b)) = spec.split_once('-') else { return full };
    let (a, b) = (a.trim(), b.trim());
    if total == 0 {
        return None;
    }
    let (start, end) = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        if n == 0 {
            return None;
        }
        (total.saturating_sub(n), total - 1)
    } else {
        let start: u64 = a.parse().ok()?;
        let end = if b.is_empty() { total - 1 } else { b.parse::<u64>().ok()?.min(total - 1) };
        (start, end)
    };
    (start <= end && start < total).then_some((start, end, true))
}

fn text(status: StatusCode, body: String) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from(body))
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_range() {
        let h = |s: &'static str| HeaderValue::from_static(s);
        assert_eq!(parse_range(Some(&h("bytes=0-499")), 1000), Some((0, 499, true)));
        assert_eq!(parse_range(Some(&h("bytes=500-")), 1000), Some((500, 999, true)));
        assert_eq!(parse_range(Some(&h("bytes=-100")), 1000), Some((900, 999, true)));
        assert_eq!(parse_range(Some(&h("bytes=900-5000")), 1000), Some((900, 999, true)));
        assert_eq!(parse_range(Some(&h("bytes=0-1,5-6")), 1000), Some((0, 999, false)));
        assert_eq!(parse_range(Some(&h("bytes=1000-")), 1000), None);
        assert_eq!(parse_range(Some(&h("bytes=5-2")), 1000), None);
        assert_eq!(parse_range(None, 1000), Some((0, 999, false)));
    }
}
