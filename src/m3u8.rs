use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;

static SONG_LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^https://music\.apple\.com/[a-z]{2}/song/[^/?#]+/([0-9]+)(?:[/?#]|$)").unwrap());
static MV_LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^https://music\.apple\.com/[a-z]{2}/music-video/[^/?#]+/([0-9]+)(?:[/?#]|$)").unwrap());
/// 艺人上传的视频（官网 post 页，amp-api 的 uploaded-videos），通常没有 slug
static POST_LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^https://music\.apple\.com/[a-z]{2}/post/(?:[^/?#]+/)?([0-9]+)(?:[/?#]|$)").unwrap());
/// 专辑链接的 slug 可省略（music.apple.com/cn/album/1561058084 也有效）
static ALBUM_LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^https://music\.apple\.com/[a-z]{2}/album/(?:[^/?#]+/)?([0-9]+)(?:[/?#]|$)").unwrap());
/// 歌单 ID 形如 `pl.<hex>`（编辑歌单）或 `pl.u-<id>`（用户公开歌单），slug 同样可省略
static PLAYLIST_LINK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^https://music\.apple\.com/[a-z]{2}/playlist/(?:[^/?#]+/)?(pl\.[0-9A-Za-z_-]+)(?:[/?#]|$)").unwrap()
});
/// 艺人链接的 slug 同样可省略（music.apple.com/cn/artist/159260351 也有效）
static ARTIST_LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^https://music\.apple\.com/[a-z]{2}/artist/(?:[^/?#]+/)?([0-9]+)(?:[/?#]|$)").unwrap());
/// 编辑页（与 music.apple.com 的路由相同）：新发现 `/new`、排行榜 `/new/top-charts[/<kind>]`、room、multi-room、grouping 与 curator（slug 可省略）
static EDITORIAL_LINK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^https://music\.apple\.com/[a-z]{2}/(?:new(?:/top-charts(?:/(?:songs|playlists|albums|music-videos|city-charts|daily-global-top-charts))?)?/?(?:[?#]|$)|(?:room|multi-room|grouping)/[0-9]+(?:[/?#]|$)|curator/(?:[^/?#]+/)?[0-9]+(?:[/?#]|$))").unwrap()
});
/// 跟随主地区的排行榜（`/new/top-charts[/<kind>]`，不含开头的 `/`）
static CHARTS_PATH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^new/top-charts(?:/(?:songs|playlists|albums|music-videos|city-charts|daily-global-top-charts))?/?$").unwrap()
});
/// 资料库与本地歌单（与 music.apple.com 的 `/library/...` 相同，数据只保存在浏览器中，不含开头的 `/`）：
/// `library`、各分类、`library/artists/<名称>`、`library/playlist/p.<id>`、`library/favorite-songs` 与 `library/playlist-folder/f.<id>`
static LIBRARY_PATH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^library(?:/(?:recently-added|albums|songs|music-videos|all-playlists|favorite-songs|artists(?:/[^/?#]+)?|playlist/p\.[0-9A-Za-z_-]+|playlist-folder/f\.[0-9A-Za-z_-]+))?/?$").unwrap()
});
static ATTR_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"([A-Z0-9-]+)=("[^"]*"|[^,\r\n]+)"#).unwrap());

#[derive(Debug, Clone, serde::Serialize)]
pub struct MasterVariant {
    pub uri: String,
    pub file_uri: String,
    pub group_id: String,
    pub audio: String,
    pub codecs: Option<String>,
    /// AVERAGE-BANDWIDTH（缺省取 BANDWIDTH），bit/s
    pub bandwidth: Option<u64>,
    pub channels: Option<String>,
    pub sample_rate: Option<u32>,
    pub bit_depth: Option<u32>,
}

#[derive(Default)]
struct AudioGroup {
    name: String,
    channels: Option<String>,
    sample_rate: Option<u32>,
    bit_depth: Option<u32>,
}

pub fn parse_song_link(url: &str) -> Result<String, String> {
    SONG_LINK_RE
        .captures(url.trim())
        .map(|caps| caps[1].to_string())
        .ok_or_else(|| format!("Only Apple Music song links are supported: {url}"))
}

pub fn parse_mv_link(url: &str) -> Result<String, String> {
    MV_LINK_RE
        .captures(url.trim())
        .map(|caps| caps[1].to_string())
        .ok_or_else(|| format!("Only Apple Music music-video links are supported: {url}"))
}

pub fn parse_post_link(url: &str) -> Result<String, String> {
    POST_LINK_RE
        .captures(url.trim())
        .map(|caps| caps[1].to_string())
        .ok_or_else(|| format!("Only Apple Music post links are supported: {url}"))
}

pub fn parse_album_link(url: &str) -> Result<String, String> {
    ALBUM_LINK_RE
        .captures(url.trim())
        .map(|caps| caps[1].to_string())
        .ok_or_else(|| format!("Only Apple Music album links are supported: {url}"))
}

pub fn parse_playlist_link(url: &str) -> Result<String, String> {
    PLAYLIST_LINK_RE
        .captures(url.trim())
        .map(|caps| caps[1].to_string())
        .ok_or_else(|| format!("Only Apple Music playlist links are supported: {url}"))
}

pub fn parse_artist_link(url: &str) -> Result<String, String> {
    ARTIST_LINK_RE
        .captures(url.trim())
        .map(|caps| caps[1].to_string())
        .ok_or_else(|| format!("Only Apple Music artist links are supported: {url}"))
}

/// 是否为编辑页地址（新发现 / room / multi-room / grouping / curator），这些页面同样返回单页应用
pub fn is_editorial_link(url: &str) -> bool {
    EDITORIAL_LINK_RE.is_match(url.trim())
}

/// 是否为跟随主地区的排行榜路径（`new/top-charts`、`new/top-charts/songs` 等），同样返回单页应用
pub fn is_charts_path(path: &str) -> bool {
    CHARTS_PATH_RE.is_match(path)
}

/// 是否为资料库路径（`library/songs`、`library/playlist/p.xxx` 等），同样返回单页应用
pub fn is_library_path(path: &str) -> bool {
    LIBRARY_PATH_RE.is_match(path)
}

fn parse_attributes(input: &str) -> HashMap<&str, &str> {
    ATTR_RE
        .captures_iter(input)
        .map(|caps| {
            let (k, v) = (caps.get(1).unwrap().as_str(), caps.get(2).unwrap().as_str());
            (k, v.strip_prefix('"').and_then(|v| v.strip_suffix('"')).unwrap_or(v))
        })
        .collect()
}

pub fn parse_master_variants(content: &str) -> Result<Vec<MasterVariant>, String> {
    let mut audio_groups = HashMap::<String, AudioGroup>::new();
    let mut current_stream: Option<HashMap<&str, &str>> = None;
    let mut variants = Vec::new();

    for line in content.lines().map(str::trim) {
        if let Some(attrs) = line.strip_prefix("#EXT-X-MEDIA:") {
            let attrs = parse_attributes(attrs);
            if attrs.get("TYPE") == Some(&"AUDIO") {
                if let Some(group_id) = attrs.get("GROUP-ID") {
                    audio_groups.insert(
                        group_id.to_string(),
                        AudioGroup {
                            name: attrs.get("NAME").unwrap_or(&"").to_string(),
                            channels: attrs.get("CHANNELS").map(|s| s.to_string()),
                            sample_rate: attrs.get("SAMPLE-RATE").and_then(|s| s.parse().ok()),
                            bit_depth: attrs.get("BIT-DEPTH").and_then(|s| s.parse().ok()),
                        },
                    );
                }
            }
        } else if let Some(attrs) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            current_stream = Some(parse_attributes(attrs));
        } else if !line.is_empty() && !line.starts_with('#') && line.ends_with(".m3u8") {
            let attrs = current_stream.take().unwrap_or_default();
            let group_id = attrs.get("AUDIO").unwrap_or(&"").to_string();
            let group = audio_groups.get(&group_id);
            variants.push(MasterVariant {
                uri: line.to_string(),
                file_uri: media_playlist_to_file(line),
                audio: group.map(|g| g.name.clone()).unwrap_or_default(),
                channels: group.and_then(|g| g.channels.clone()),
                sample_rate: group.and_then(|g| g.sample_rate),
                bit_depth: group.and_then(|g| g.bit_depth),
                group_id,
                codecs: attrs.get("CODECS").map(|s| s.to_string()),
                bandwidth: attrs
                    .get("AVERAGE-BANDWIDTH")
                    .or_else(|| attrs.get("BANDWIDTH"))
                    .and_then(|s| s.parse().ok()),
            });
        }
    }

    if variants.is_empty() {
        return Err("No variants found in master m3u8".to_string());
    }
    Ok(variants)
}

/// `xxx.m3u8` -> `xxx_m.mp4`
pub fn media_playlist_to_file(name: &str) -> String {
    match name.strip_suffix(".m3u8") {
        Some(stem) => format!("{stem}_m.mp4"),
        None => name.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_song_link() {
        assert_eq!(
            parse_song_link("https://music.apple.com/us/song/%E9%A3%9E%E8%88%9E/1797679527").unwrap(),
            "1797679527"
        );
        assert_eq!(parse_song_link("https://music.apple.com/us/song/name/123?l=zh-CN").unwrap(), "123");
        assert!(parse_song_link("https://music.apple.com/us/album/name/123").is_err());
        assert!(parse_song_link("http://music.apple.com/us/song/name/123").is_err());
    }

    #[test]
    fn test_parse_mv_link() {
        assert_eq!(
            parse_mv_link("https://music.apple.com/cn/music-video/super-bowl-lix-halftime-show-live/1836358807").unwrap(),
            "1836358807"
        );
        assert_eq!(parse_mv_link("https://music.apple.com/us/music-video/_/123?l=zh-CN").unwrap(), "123");
        assert!(parse_mv_link("https://music.apple.com/us/song/name/123").is_err());
        assert!(parse_mv_link("https://music.apple.com/us/music-video/123").is_err());
        assert_eq!(parse_post_link("https://music.apple.com/cn/post/6814689986").unwrap(), "6814689986");
        assert_eq!(parse_post_link("https://music.apple.com/us/post/_/6814689986?l=en").unwrap(), "6814689986");
        assert!(parse_post_link("https://music.apple.com/us/post/abc").is_err());
    }

    #[test]
    fn test_parse_album_link() {
        assert_eq!(
            parse_album_link("https://music.apple.com/cn/album/justice-triple-chucks-deluxe-deluxe-video-version/1561058084").unwrap(),
            "1561058084"
        );
        assert_eq!(parse_album_link("https://music.apple.com/cn/album/1561058084").unwrap(), "1561058084");
        assert_eq!(parse_album_link("https://music.apple.com/us/album/lover/1468058165?i=1468058171").unwrap(), "1468058165");
        assert!(parse_album_link("https://music.apple.com/us/song/name/123").is_err());
        assert!(parse_album_link("https://music.apple.com/us/album/name/abc").is_err());
    }

    #[test]
    fn test_parse_playlist_link() {
        assert_eq!(
            parse_playlist_link(
                "https://music.apple.com/cn/playlist/%E6%AF%8F%E5%91%A8%E7%83%AD%E9%97%A8-100-%E9%A6%96-%E5%85%A8%E7%90%83/pl.921750b485a6496ea58b16d46c097557"
            )
            .unwrap(),
            "pl.921750b485a6496ea58b16d46c097557"
        );
        assert_eq!(
            parse_playlist_link("https://music.apple.com/us/playlist/pl.921750b485a6496ea58b16d46c097557").unwrap(),
            "pl.921750b485a6496ea58b16d46c097557"
        );
        assert_eq!(parse_playlist_link("https://music.apple.com/us/playlist/mix/pl.u-AkAmPlyUxqvoZ7?l=en").unwrap(), "pl.u-AkAmPlyUxqvoZ7");
        assert!(parse_playlist_link("https://music.apple.com/us/album/name/123").is_err());
        assert!(parse_playlist_link("https://music.apple.com/us/playlist/name/123").is_err());
    }

    #[test]
    fn test_parse_artist_link() {
        assert_eq!(parse_artist_link("https://music.apple.com/cn/artist/taylor-swift/159260351").unwrap(), "159260351");
        assert_eq!(parse_artist_link("https://music.apple.com/us/artist/159260351").unwrap(), "159260351");
        assert_eq!(parse_artist_link("https://music.apple.com/us/artist/the-weeknd/479756766?l=en").unwrap(), "479756766");
        assert!(parse_artist_link("https://music.apple.com/us/album/name/123").is_err());
        assert!(parse_artist_link("https://music.apple.com/us/artist/name/abc").is_err());
    }

    #[test]
    fn test_is_editorial_link() {
        assert!(is_editorial_link("https://music.apple.com/cn/new"));
        assert!(is_editorial_link("https://music.apple.com/us/new?l=en"));
        assert!(is_editorial_link("https://music.apple.com/cn/room/6818358937"));
        assert!(is_editorial_link("https://music.apple.com/us/multi-room/1532467784"));
        assert!(is_editorial_link("https://music.apple.com/cn/grouping/170872"));
        assert!(is_editorial_link("https://music.apple.com/cn/curator/apple-music-%E4%B8%8D%E6%8F%92%E7%94%B5/1019400049"));
        assert!(is_editorial_link("https://music.apple.com/us/curator/1019400049"));
        assert!(is_editorial_link("https://music.apple.com/us/new/top-charts"));
        assert!(is_editorial_link("https://music.apple.com/cn/new/top-charts/songs?genreId=14"));
        assert!(is_editorial_link("https://music.apple.com/cn/new/top-charts/daily-global-top-charts"));
        assert!(!is_editorial_link("https://music.apple.com/cn/new/top-charts/stations"));
        assert!(!is_editorial_link("https://music.apple.com/us/new/other"));
        assert!(is_charts_path("new/top-charts"));
        assert!(is_charts_path("new/top-charts/music-videos"));
        assert!(!is_charts_path("new/top-charts/x"));
        assert!(!is_charts_path("top-charts"));
        assert!(is_library_path("library"));
        assert!(is_library_path("library/songs"));
        assert!(is_library_path("library/all-playlists/"));
        assert!(is_library_path("library/artists/Taylor%20Swift"));
        assert!(is_library_path("library/playlist/p.A1b2_c3-d4"));
        assert!(!is_library_path("library/playlist/pl.123"));
        assert!(is_library_path("library/favorite-songs"));
        assert!(is_library_path("library/playlist-folder/f.Ab3_x"));
        assert!(!is_library_path("library/playlist-folder/p.Ab3"));
        assert!(!is_library_path("library/other"));
        assert!(!is_library_path("library/artists/a/b"));
        assert!(!is_editorial_link("https://music.apple.com/us/room/abc"));
        assert!(!is_editorial_link("https://music.apple.com/us/curator/name"));
        assert!(!is_editorial_link("https://music.apple.com/us/album/name/123"));
    }

    #[test]
    fn test_parse_master_variants() {
        let content = r#"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-alac",NAME="songEnhanced",CHANNELS="2",SAMPLE-RATE=44100,BIT-DEPTH=24
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=1673776,BANDWIDTH=1788592,CODECS="alac",AUDIO="audio-alac"
P100_A123_audio_alac.m3u8
"#;
        let variants = parse_master_variants(content).unwrap();
        assert_eq!(variants.len(), 1);
        assert_eq!(variants[0].uri, "P100_A123_audio_alac.m3u8");
        assert_eq!(variants[0].file_uri, "P100_A123_audio_alac_m.mp4");
        assert_eq!(variants[0].group_id, "audio-alac");
        assert_eq!(variants[0].audio, "songEnhanced");
        assert_eq!(variants[0].codecs.as_deref(), Some("alac"));
        assert_eq!(variants[0].bandwidth, Some(1673776));
        assert_eq!(variants[0].channels.as_deref(), Some("2"));
        assert_eq!(variants[0].sample_rate, Some(44100));
        assert_eq!(variants[0].bit_depth, Some(24));
    }
}
