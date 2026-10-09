use std::sync::LazyLock;

use regex::Regex;

// 路径片段的唯一来源：links.rs 用它们判定页面路径，log.rs 用同一份片段给请求归类，增删页面类型只改这里。
/// 排行榜种类（`/new/top-charts/<kind>`）
macro_rules! chart_kinds {
    () => {
        "songs|playlists|albums|music-videos|city-charts|daily-global-top-charts"
    };
}
/// 「新发现」及其排行榜：`new[/top-charts[/<kind>]]`
macro_rules! new_section {
    () => {
        concat!("new(?:/top-charts(?:/(?:", $crate::links::chart_kinds!(), "))?)?")
    };
}
/// 带地区码的单资源页类型（`/{cc}/<kind>/…`）
macro_rules! page_kinds {
    () => {
        "song|album|playlist|artist|music-video|post|room|multi-room|grouping|curator"
    };
}
pub(crate) use {chart_kinds, new_section, page_kinds};

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
    Regex::new(concat!(
        r"^https://music\.apple\.com/[a-z]{2}/(?:",
        new_section!(),
        r"/?(?:[?#]|$)|(?:room|multi-room|grouping)/[0-9]+(?:[/?#]|$)|curator/(?:[^/?#]+/)?[0-9]+(?:[/?#]|$))"
    ))
    .unwrap()
});
/// 跟随主地区的排行榜（`/new/top-charts[/<kind>]`，不含开头的 `/`）
static CHARTS_PATH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(r"^new/top-charts(?:/(?:", chart_kinds!(), r"))?/?$")).unwrap()
});
/// 资料库与本地歌单（与 music.apple.com 的 `/library/...` 相同，数据只保存在浏览器中，不含开头的 `/`）：
/// `library`、各分类、`library/artists/<名称>`、`library/playlist/p.<id>`、`library/favorite-songs` 与 `library/playlist-folder/f.<id>`
static LIBRARY_PATH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^library(?:/(?:recently-added|albums|songs|music-videos|all-playlists|favorite-songs|artists(?:/[^/?#]+)?|playlist/p\.[0-9A-Za-z_-]+|playlist-folder/f\.[0-9A-Za-z_-]+))?/?$").unwrap()
});

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
}
