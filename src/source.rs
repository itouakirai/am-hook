//! 源地址规整与分类（纯函数，无 IO）

use std::sync::LazyLock;

use regex::Regex;

pub const WHITELIST: &str = "aod.itunes.apple.com/itunes-assets/";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    /// `P<数字>_<非A开头>.m3u8`：原样返回
    MasterPlaylist,
    /// `P<数字>_A<数字>_<...>.m3u8`：解析并去除加密标记
    MediaPlaylist,
    /// media m3u8 的 `.m3u8` 换成 `_m.mp4`：解密后返回
    MediaFile,
    /// 白名单内的其他文件：透传
    Other,
}

static MASTER_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^P\d+_[^A].*\.m3u8$").unwrap());
static MEDIA_M3U8_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^P\d+_A\d+_.+\.m3u8$").unwrap());
static MEDIA_FILE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^P\d+_A\d+_.+_m\.mp4$").unwrap());

pub fn classify(filename: &str) -> SourceKind {
    if MASTER_RE.is_match(filename) {
        SourceKind::MasterPlaylist
    } else if MEDIA_M3U8_RE.is_match(filename) {
        SourceKind::MediaPlaylist
    } else if MEDIA_FILE_RE.is_match(filename) {
        SourceKind::MediaFile
    } else {
        SourceKind::Other
    }
}

/// 规整协议前缀：部分客户端会把 `https://` 折叠成 `https:/`
pub fn normalize_url(raw: &str) -> String {
    if raw.starts_with("https://") || raw.starts_with("http://") {
        raw.to_string()
    } else if let Some(rest) = raw.strip_prefix("https:/") {
        format!("https://{rest}")
    } else if let Some(rest) = raw.strip_prefix("http:/") {
        format!("http://{rest}")
    } else if raw.starts_with("aod.itunes.apple.com") {
        format!("https://{raw}")
    } else {
        raw.to_string()
    }
}

/// URL 最后一段（不含 query）
pub fn filename(url: &str) -> &str {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    path.rsplit('/').next().unwrap_or(path)
}

/// media file URL -> 对应的 media m3u8 URL（只替换文件名末尾的 `_m.mp4`）
pub fn media_file_to_playlist_url(url: &str) -> String {
    let (path, query) = match url.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (url, None),
    };
    let path = match path.strip_suffix("_m.mp4") {
        Some(stem) => format!("{stem}.m3u8"),
        None => path.to_string(),
    };
    match query {
        Some(q) => format!("{path}?{q}"),
        None => path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify() {
        assert_eq!(classify("P1263211745_default.m3u8"), SourceKind::MasterPlaylist);
        assert_eq!(classify("P1263211745_A1468058171_audio_en_gr2768_mp4a-A6.m3u8"), SourceKind::MediaPlaylist);
        assert_eq!(classify("P1263211745_A1468058171_audio_en_gr2768_mp4a-A6_m.mp4"), SourceKind::MediaFile);
        assert_eq!(classify("cover.jpg"), SourceKind::Other);
    }

    #[test]
    fn test_normalize_url() {
        assert_eq!(normalize_url("https:/aod.itunes.apple.com/test"), "https://aod.itunes.apple.com/test");
        assert_eq!(normalize_url("http:/aod.itunes.apple.com/test"), "http://aod.itunes.apple.com/test");
        assert_eq!(normalize_url("aod.itunes.apple.com/test"), "https://aod.itunes.apple.com/test");
        assert_eq!(normalize_url("https://aod.itunes.apple.com/test"), "https://aod.itunes.apple.com/test");
    }

    #[test]
    fn test_url_helpers() {
        assert_eq!(filename("https://a/b/P1_A2_x_m.mp4?t=1"), "P1_A2_x_m.mp4");
        assert_eq!(media_file_to_playlist_url("https://a/b/P1_A2_x_m.mp4?t=1"), "https://a/b/P1_A2_x.m3u8?t=1");
        assert_eq!(media_file_to_playlist_url("https://a/_m.mp4/P1_A2_x_m.mp4"), "https://a/_m.mp4/P1_A2_x.m3u8");
    }
}
