use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;

use crate::state::{Segment, Track};

/// 首个 frag 使用的固定 key，解析时忽略
const FIXED_KEY_URI: &str = "skd://itunes.apple.com/P000000000/s1/e1";

static SONG_LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^https://music\.apple\.com/[a-z]{2}/song/[^/?#]+/([0-9]+)(?:[/?#]|$)").unwrap());
static ATTR_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"([A-Z0-9-]+)=("[^"]*"|[^,\r\n]+)"#).unwrap());
static ADAM_ID_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"_A(\d+)_").unwrap());

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

/// 解析 `LEN[@OFF]`，缺省 OFF 时接在 `next` 之后
fn parse_byterange(value: &str, next: u64) -> Result<Segment, String> {
    let value = value.trim().trim_matches('"');
    let (len, off) = match value.split_once('@') {
        Some((l, o)) => (l, Some(o)),
        None => (value, None),
    };
    let length = len.parse().map_err(|e| format!("Invalid BYTERANGE length '{value}': {e}"))?;
    let offset = match off {
        Some(o) => o.parse().map_err(|e| format!("Invalid BYTERANGE offset '{value}': {e}"))?,
        None => next,
    };
    Ok(Segment { offset, length })
}

/// 解析 media m3u8：提取 adamId / key uri / fileuri / range1 与全部 segment 字节范围，
/// 同时去掉 `#EXT-X-KEY` / `#EXT-X-SESSION-KEY`，返回 (轨道, 清理后的 m3u8)。
pub fn parse_media_m3u8(source_url: &str, content: &str) -> Result<(Track, String), String> {
    let path = source_url.split('?').next().unwrap_or(source_url);
    let filename = path.rsplit('/').next().unwrap_or(path);
    let adam_id = ADAM_ID_RE
        .captures(filename)
        .map(|c| c[1].to_string())
        .ok_or_else(|| format!("Could not find '_A<digits>_' in source URL: {source_url}"))?;

    let mut uri = None;
    let mut fileuri = None;
    let mut range1 = None;
    let mut segments: Vec<Segment> = Vec::new();
    let mut cleaned = String::with_capacity(content.len());

    for line in content.lines() {
        let trimmed = line.trim();

        if trimmed.starts_with("#EXT-X-KEY:") || trimmed.starts_with("#EXT-X-SESSION-KEY:") {
            let (_, attrs) = trimmed.split_once(':').unwrap();
            let attrs = parse_attributes(attrs);
            if attrs.get("METHOD") == Some(&"SAMPLE-AES") {
                if let Some(u) = attrs.get("URI").filter(|u| **u != FIXED_KEY_URI) {
                    uri.get_or_insert_with(|| u.to_string());
                }
            }
            continue;
        }

        if let Some(attrs) = trimmed.strip_prefix("#EXT-X-MAP:") {
            if !segments.is_empty() {
                return Err("Multiple or late EXT-X-MAP entries are not supported".into());
            }
            let attrs = parse_attributes(attrs);
            fileuri = attrs.get("URI").map(|s| s.to_string());
            let range = attrs.get("BYTERANGE").ok_or("EXT-X-MAP has no BYTERANGE")?;
            segments.push(parse_byterange(range, 0)?);
        } else if let Some(value) = trimmed.strip_prefix("#EXT-X-BYTERANGE:") {
            if segments.is_empty() {
                return Err("EXT-X-BYTERANGE before EXT-X-MAP".into());
            }
            let next = segments.last().map_or(0, Segment::end);
            segments.push(parse_byterange(value, next)?);
            range1.get_or_insert_with(|| value.trim().to_string());
        }

        cleaned.push_str(line);
        cleaned.push('\n');
    }

    let uri = uri.ok_or("Could not find non-fixed SAMPLE-AES key URI in m3u8")?;
    let fileuri = fileuri.ok_or("Could not find EXT-X-MAP URI in m3u8")?;
    let range1 = range1.ok_or("Could not find first EXT-X-BYTERANGE in m3u8")?;

    // media file 按 segment 拼接输出，必须从 0 开始且首尾相接，否则 Content-Length 会失真
    let mut expected = 0;
    for s in &segments {
        if s.offset != expected || s.length == 0 {
            return Err(format!("Segments are not contiguous at offset {} (expected {expected})", s.offset));
        }
        expected = s.end();
    }

    Ok((Track::new(adam_id, uri, fileuri, range1, segments), cleaned))
}

/// 把 `parse_media_m3u8` 清理后的 m3u8 转成通用写法：去掉 EXT-X-MAP / EXT-X-BYTERANGE，
/// 每个 frag 改为独立的 `xxx_m_seg<N>.mp4`（init + 该 frag，可单独解码），版本降到 3。
/// 部分播放器（如 PotPlayer）对 fMP4 + BYTERANGE 支持不完整，只能播第一段。
pub fn to_compat_playlist(cleaned: &str) -> String {
    let mut out = String::with_capacity(cleaned.len());
    let mut idx = 0;
    for line in cleaned.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("#EXT-X-MAP:") || trimmed.starts_with("#EXT-X-BYTERANGE:") {
            continue;
        }
        if trimmed.starts_with("#EXT-X-VERSION:") {
            out.push_str("#EXT-X-VERSION:3");
        } else if !trimmed.is_empty() && !trimmed.starts_with('#') {
            idx += 1;
            let (path, query) = match trimmed.split_once('?') {
                Some((p, q)) => (p, Some(q)),
                None => (trimmed, None),
            };
            match crate::source::media_file_to_segment(path, idx) {
                Some(seg) => {
                    out.push_str(&seg);
                    if let Some(q) = query {
                        out.push('?');
                        out.push_str(q);
                    }
                }
                None => out.push_str(line),
            }
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_to_compat_playlist() {
        let cleaned = "#EXTM3U\n#EXT-X-TARGETDURATION:15\n#EXT-X-VERSION:7\n#EXT-X-MAP:URI=\"t_m.mp4\",BYTERANGE=\"10@0\"\n#EXTINF:14.976,\t\n#EXT-X-BYTERANGE:5@10\nt_m.mp4\n#EXTINF:14.976,\t\n#EXT-X-BYTERANGE:5@15\nt_m.mp4\n#EXT-X-ENDLIST\n";
        assert_eq!(
            to_compat_playlist(cleaned),
            "#EXTM3U\n#EXT-X-TARGETDURATION:15\n#EXT-X-VERSION:3\n#EXTINF:14.976,\t\nt_m_seg1.mp4\n#EXTINF:14.976,\t\nt_m_seg2.mp4\n#EXT-X-ENDLIST\n"
        );
    }

    #[test]
    fn test_parse_media_m3u8() {
        let raw = "#EXTM3U\n#EXT-X-TARGETDURATION:15\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://itunes.apple.com/P000000000/s1/e1\",KEYFORMAT=\"com.apple.streamingkeydelivery\"\n#EXT-X-MAP:URI=\"test_m.mp4\",BYTERANGE=\"1058@0\"\n#EXTINF:15,\n#EXT-X-BYTERANGE:1441673@1058\ntest_m.mp4\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://itunes.apple.com/p1263211745/c6\",KEYFORMAT=\"com.apple.streamingkeydelivery\"\n#EXTINF:15,\n#EXT-X-BYTERANGE:1441601\ntest_m.mp4\n#EXT-X-ENDLIST\n";
        let url = "https://aod.itunes.apple.com/itunes-assets/v4/P1263211745_A1468058171_audio.m3u8";
        let (track, cleaned) = parse_media_m3u8(url, raw).unwrap();
        assert_eq!(track.adam_id, "1468058171");
        assert_eq!(track.uri, "skd://itunes.apple.com/p1263211745/c6");
        assert_eq!(&*track.fileuri, "test_m.mp4");
        assert_eq!(track.range1, "1441673@1058");
        assert_eq!(
            track.segments,
            vec![
                Segment { offset: 0, length: 1058 },
                Segment { offset: 1058, length: 1441673 },
                Segment { offset: 1442731, length: 1441601 },
            ]
        );
        assert_eq!(track.total_size, 1442731 + 1441601);
        assert!(!cleaned.contains("#EXT-X-KEY"));
        assert!(cleaned.contains("#EXT-X-MAP:URI="));
        assert_eq!(cleaned.lines().count(), raw.lines().count() - 2);
    }

    #[test]
    fn test_parse_media_m3u8_rejects_gaps() {
        let raw = "#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://x/c6\"\n#EXT-X-MAP:URI=\"t_m.mp4\",BYTERANGE=\"10@0\"\n#EXT-X-BYTERANGE:5@20\nt_m.mp4\n";
        assert!(parse_media_m3u8("P1_A2_x.m3u8", raw).is_err());
    }

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
