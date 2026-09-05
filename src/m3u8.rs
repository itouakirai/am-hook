use regex::Regex;
use crate::state::FragmentRange;

#[derive(Debug, Clone, serde::Serialize)]
pub struct MasterVariant {
    pub uri: String,
    pub file_uri: String,
    pub group_id: String,
    pub audio: String,
    pub codecs: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ParsedSongLink {
    pub adam_id: String,
}

pub fn parse_song_link(url: &str) -> Result<String, String> {
    let pattern = Regex::new(r"^https://music\.apple\.com/[a-z]{2}/song/[^/?#]+/([0-9]+)(?:[/?#]|$)")
        .map_err(|e| e.to_string())?;
    pattern
        .captures(url.trim())
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().to_string())
        .ok_or_else(|| format!("Only Apple Music song links are supported: {url}"))
}

pub fn parse_master_variants(content: &str) -> Result<Vec<MasterVariant>, String> {
    let attr_pattern = Regex::new(
        r#"([A-Z0-9-]+)=("(?:[^"]*)"|[^,\r\n]+)"#,
    )
    .map_err(|e| e.to_string())?;
    let media_pattern = Regex::new(r#"^#EXT-X-MEDIA:(.*)$"#).map_err(|e| e.to_string())?;
    let stream_pattern = Regex::new(r#"^#EXT-X-STREAM-INF:(.*)$"#).map_err(|e| e.to_string())?;
    let line_pattern = Regex::new(r#"^[^#\r\n].*\.m3u8$"#).map_err(|e| e.to_string())?;

    let mut audio_groups = std::collections::HashMap::<String, String>::new();
    let mut current_stream = None;
    let mut variants = Vec::new();

    for line in content.lines() {
        let line = line.trim();
        if let Some(caps) = media_pattern.captures(line) {
            let attrs = parse_hls_attributes(&caps[1], &attr_pattern);
            if attrs.get("TYPE").map(String::as_str) == Some("AUDIO") {
                if let Some(group_id) = attrs.get("GROUP-ID") {
                    audio_groups.insert(group_id.clone(), attrs.get("NAME").cloned().unwrap_or_default());
                }
            }
        } else if let Some(caps) = stream_pattern.captures(line) {
            current_stream = Some(parse_hls_attributes(&caps[1], &attr_pattern));
        } else if line_pattern.is_match(line) {
            let attrs = current_stream.take().unwrap_or_default();
            let group_id = attrs.get("AUDIO").cloned().unwrap_or_default();
            let uri = line.to_string();
            let file_uri = uri.replace(".m3u8", "_m.mp4");
            variants.push(MasterVariant {
                uri,
                file_uri,
                group_id: group_id.clone(),
                audio: audio_groups.get(&group_id).cloned().unwrap_or_default(),
                codecs: attrs.get("CODECS").cloned(),
            });
        }
    }

    if variants.is_empty() {
        return Err("No variants found in master m3u8".to_string());
    }
    Ok(variants)
}

fn parse_hls_attributes(
    input: &str,
    pattern: &Regex,
) -> std::collections::HashMap<String, String> {
    let mut attrs = std::collections::HashMap::new();
    for caps in pattern.captures_iter(input) {
        let key = caps.get(1).map(|m| m.as_str()).unwrap_or_default().to_string();
        let mut value = caps.get(2).map(|m| m.as_str()).unwrap_or_default().to_string();
        if value.starts_with('"') && value.ends_with('"') && value.len() >= 2 {
            value = value[1..value.len() - 1].to_string();
        }
        attrs.insert(key, value);
    }
    attrs
}

#[derive(Debug, Clone)]
pub struct ParsedMediaM3u8 {
    pub adam_id: String,
    pub uri: String,
    pub fileuri: String,
    pub range1: String,
    pub init_range: (u64, u64),
    pub fragments: Vec<FragmentRange>,
    pub total_size: u64,
}

pub fn parse_and_clean_media_m3u8(
    source_url: &str,
    content: &str,
) -> Result<(ParsedMediaM3u8, String), String> {
    // 1. Extract adamId from URL (_A followed by digits)
    let adam_re = Regex::new(r"_A(\d+)").map_err(|e| e.to_string())?;
    let adam_id = adam_re
        .captures(source_url)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .ok_or_else(|| format!("Could not find '_A<digits>' in source URL: {source_url}"))?;

    let mut found_uri = None;
    let mut found_fileuri = None;
    let mut init_range = (0u64, 0u64);
    let mut first_range = None;
    let mut fragments = Vec::new();
    let mut current_offset: u64 = 0;

    let key_re = Regex::new(r#"URI="([^"]+)""#).map_err(|e| e.to_string())?;
    let byterange_attr_re = Regex::new(r#"BYTERANGE="(\d+)(?:@(\d+))?""#).map_err(|e| e.to_string())?;
    let byterange_tag_re = Regex::new(r#"^#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?"#).map_err(|e| e.to_string())?;

    let mut cleaned_lines = Vec::new();

    for line in content.lines() {
        let trimmed = line.trim();

        // Filter out encryption key declarations
        if trimmed.starts_with("#EXT-X-KEY") || trimmed.starts_with("#EXT-X-SESSION-KEY") {
            // Parse key URI if it's SAMPLE-AES
            if trimmed.contains("METHOD=SAMPLE-AES") {
                if let Some(caps) = key_re.captures(trimmed) {
                    if let Some(uri_match) = caps.get(1) {
                        let u = uri_match.as_str();
                        // Ignore the fixed P000000000/s1/e1 key URI
                        if !u.contains("P000000000/s1/e1") {
                            found_uri = Some(u.to_string());
                        }
                    }
                }
            }
            // Do NOT include this line in cleaned_lines
            continue;
        }

        // Parse #EXT-X-MAP
        if trimmed.starts_with("#EXT-X-MAP:") {
            if let Some(caps) = key_re.captures(trimmed) {
                if let Some(m) = caps.get(1) {
                    found_fileuri = Some(m.as_str().to_string());
                }
            }
            if let Some(caps) = byterange_attr_re.captures(trimmed) {
                let len: u64 = caps[1].parse().unwrap_or(0);
                let off: u64 = caps.get(2).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
                init_range = (off, len);
                current_offset = off + len;
            }
        }

        // Parse #EXT-X-BYTERANGE
        if trimmed.starts_with("#EXT-X-BYTERANGE:") {
            let raw_val = trimmed.strip_prefix("#EXT-X-BYTERANGE:").unwrap().trim();
            if first_range.is_none() {
                first_range = Some(raw_val.to_string());
            }
            if let Some(caps) = byterange_tag_re.captures(trimmed) {
                let len: u64 = caps[1].parse().map_err(|e| format!("Invalid byterange length: {e}"))?;
                let off: u64 = if let Some(off_match) = caps.get(2) {
                    off_match.as_str().parse().map_err(|e| format!("Invalid byterange offset: {e}"))?
                } else {
                    current_offset
                };
                fragments.push(FragmentRange { offset: off, length: len });
                current_offset = off + len;
            }
        }

        cleaned_lines.push(line);
    }

    let uri = found_uri.ok_or_else(|| "Could not find non-fixed SAMPLE-AES key URI in m3u8".to_string())?;
    let fileuri = found_fileuri.ok_or_else(|| "Could not find EXT-X-MAP URI in m3u8".to_string())?;
    let range1 = first_range.ok_or_else(|| "Could not find first EXT-X-BYTERANGE in m3u8".to_string())?;

    let total_size = if let Some(last_frag) = fragments.last() {
        last_frag.offset + last_frag.length
    } else {
        init_range.0 + init_range.1
    };

    let cleaned_m3u8 = cleaned_lines.join("\n") + "\n";

    Ok((
        ParsedMediaM3u8 {
            adam_id,
            uri,
            fileuri,
            range1,
            init_range,
            fragments,
            total_size,
        },
        cleaned_m3u8,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_and_clean_media_m3u8() {
        let raw = "#EXTM3U\n#EXT-X-TARGETDURATION:15\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://itunes.apple.com/P000000000/s1/e1\"\n#EXT-X-MAP:URI=\"test_m.mp4\",BYTERANGE=\"1058@0\"\n#EXTINF:15,\n#EXT-X-BYTERANGE:1441673@1058\ntest_m.mp4\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://itunes.apple.com/p1263211745/c6\"\n#EXTINF:15,\n#EXT-X-BYTERANGE:1441601@1442731\ntest_m.mp4\n#EXT-X-ENDLIST\n";
        let url = "https://aod.itunes.apple.com/itunes-assets/v4/P1263211745_A1468058171_audio.m3u8";
        let (parsed, cleaned) = parse_and_clean_media_m3u8(url, raw).unwrap();
        assert_eq!(parsed.adam_id, "1468058171");
        assert_eq!(parsed.uri, "skd://itunes.apple.com/p1263211745/c6");
        assert_eq!(parsed.fileuri, "test_m.mp4");
        assert_eq!(parsed.range1, "1441673@1058");
        assert_eq!(parsed.init_range, (0, 1058));
        assert_eq!(parsed.fragments.len(), 2);
        assert_eq!(parsed.total_size, 1442731 + 1441601);
        assert!(!cleaned.contains("#EXT-X-KEY"));
        assert!(cleaned.contains("#EXT-X-MAP:URI="));
    }
}
