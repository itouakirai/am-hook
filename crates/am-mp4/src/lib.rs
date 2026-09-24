//! ISOBMFF 处理：按 box 树精确定位（不做字节扫描），所有改写都保持字节长度不变，
//! 保证 HTTP Range 偏移与上游完全一致。

use std::ops::Range;
use std::sync::OnceLock;

pub use temari::rounds::Template;
pub use temari::template::template_from_json;
use temari::rounds::{decrypt_ranges_in_place, decrypt_ranges_par};

/// 每条轨道第一个 fragment 使用的固定 key
pub const FIXED_KEY_URI: &str = "skd://itunes.apple.com/P000000000/s1/e1";
pub const FIXED_TEMPLATE_JSON: &str = include_str!("fixed_template.json");

/// 内嵌的固定 key 解密模板（首次调用时解析）
pub fn fixed_template() -> &'static Template {
    static FIXED: OnceLock<Template> = OnceLock::new();
    FIXED.get_or_init(|| template_from_json(FIXED_TEMPLATE_JSON).expect("embedded fixed template must parse"))
}

#[derive(Debug, Clone, Copy)]
struct BoxHeader {
    typ: [u8; 4],
    start: usize,
    /// payload 起始（跳过 size/type/largesize）
    body: usize,
    end: usize,
}

/// 遍历 `buf[range]` 内的同级 box，遇到畸形 box 即停止。
fn children(buf: &[u8], range: Range<usize>) -> Vec<BoxHeader> {
    let mut out = Vec::new();
    let mut pos = range.start;
    let end = range.end.min(buf.len());
    while pos + 8 <= end {
        let size = be_u32(buf, pos) as usize;
        let typ: [u8; 4] = buf[pos + 4..pos + 8].try_into().unwrap();
        let (len, header) = match size {
            0 => (end - pos, 8),
            1 => {
                if pos + 16 > end {
                    break;
                }
                (be_u64(buf, pos + 8) as usize, 16)
            }
            n => (n, 8),
        };
        if len < header || pos + len > end {
            break;
        }
        out.push(BoxHeader { typ, start: pos, body: pos + header, end: pos + len });
        pos += len;
    }
    out
}

fn find(buf: &[u8], range: Range<usize>, typ: &[u8; 4]) -> Option<BoxHeader> {
    children(buf, range).into_iter().find(|b| &b.typ == typ)
}

fn be_u32(buf: &[u8], pos: usize) -> u32 {
    u32::from_be_bytes(buf[pos..pos + 4].try_into().unwrap())
}

fn be_u64(buf: &[u8], pos: usize) -> u64 {
    u64::from_be_bytes(buf[pos..pos + 8].try_into().unwrap())
}

/// 待改写的 box 类型：(box 起始偏移, 新类型)。先只读扫描收集，再统一写入，
/// 这样同一套逻辑既能原地改写（wasm），也能写到副本里（服务端并行解密）。
type Renames = Vec<(usize, [u8; 4])>;

fn apply_renames(buf: &mut [u8], renames: &Renames) {
    for (start, typ) in renames {
        buf[start + 4..start + 8].copy_from_slice(typ);
    }
}

/// 改造 init segment (ftyp + moov)：
/// stsd 中每个 enca/encv 改回 frma 记录的原始编码 (ec-3/mp4a/alac...)，
/// 其 sinf 与 moov 下的 pssh 改为等长 free box。
/// sinf 改名后 body 清零：部分分离器（如 PotPlayer 的 Built-in MP4 Source）会按 QuickTime
/// `wave` 布局在 sample entry 内扫描 `frma`，把紧随其后的 schm 误当作 ALAC magic cookie。
pub fn patch_init_segment(init: &[u8]) -> Vec<u8> {
    let mut out = init.to_vec();
    patch_init_in_place(&mut out);
    out
}

/// `patch_init_segment` 的原地版本
pub fn patch_init_in_place(init: &mut [u8]) {
    let mut renames = Renames::new();
    let mut wipes: Vec<Range<usize>> = Vec::new();
    for moov in children(init, 0..init.len()).iter().filter(|b| &b.typ == b"moov") {
        for b in children(init, moov.body..moov.end) {
            match &b.typ {
                b"pssh" => renames.push((b.start, *b"free")),
                b"trak" => patch_trak(init, &b, &mut renames, &mut wipes),
                _ => {}
            }
        }
    }
    apply_renames(init, &renames);
    for r in wipes {
        init[r].fill(0);
    }
}

fn patch_trak(src: &[u8], trak: &BoxHeader, renames: &mut Renames, wipes: &mut Vec<Range<usize>>) {
    let stsd = find(src, trak.body..trak.end, b"mdia")
        .and_then(|b| find(src, b.body..b.end, b"minf"))
        .and_then(|b| find(src, b.body..b.end, b"stbl"))
        .and_then(|b| find(src, b.body..b.end, b"stsd"));
    let Some(stsd) = stsd else { return };

    // stsd: FullBox(4) + entry_count(4)，随后是 sample entries
    for entry in children(src, stsd.body + 8..stsd.end) {
        // SampleEntry(8) + AudioSampleEntry(20) / VisualSampleEntry(70) 后才是子 box
        let fields = match &entry.typ {
            b"enca" => 28,
            b"encv" => 78,
            _ => continue,
        };
        let Some(sinf) = find(src, entry.body + fields..entry.end, b"sinf") else { continue };
        let Some(frma) = find(src, sinf.body..sinf.end, b"frma") else { continue };
        if frma.body + 4 > frma.end {
            continue;
        }
        let original: [u8; 4] = src[frma.body..frma.body + 4].try_into().unwrap();
        renames.push((entry.start, original));
        renames.push((sinf.start, *b"free"));
        wipes.push(sinf.body..sinf.end);
    }
}

/// 解密一个媒体分片 (moof + mdat)：
/// 1. 解析 tfhd/trun 得到每个 sample 的字节范围；
/// 2. 将 senc/saiz/saio、'seig'/'seam' 类型的 sgpd/sbgp 以及 pssh 改为等长 free box；
/// 3. 用 temari 线程池并行解密全部 sample，写入副本返回。
///
/// CPU 密集，调用方应放在阻塞线程中执行。
pub fn decrypt_fragment(frag: &[u8], tmpl: &Template) -> Result<Vec<u8>, String> {
    let (samples, renames) = scan_fragment(frag)?;
    let mut out = frag.to_vec();
    apply_renames(&mut out, &renames);
    decrypt_ranges_par(tmpl, frag, &samples, &mut out);
    Ok(out)
}

/// `decrypt_fragment` 的原地单线程版本，供没有线程的环境（浏览器 wasm）使用。
pub fn decrypt_fragment_in_place(frag: &mut [u8], tmpl: &Template) -> Result<(), String> {
    let (samples, renames) = scan_fragment(frag)?;
    apply_renames(frag, &renames);
    decrypt_ranges_in_place(tmpl, frag, &samples);
    Ok(())
}

/// 只读扫描分片，返回按顺序排列的 sample 字节范围与需要改为 free 的 box。
fn scan_fragment(frag: &[u8]) -> Result<(Vec<Range<usize>>, Renames), String> {
    let mut samples: Vec<Range<usize>> = Vec::new();
    let mut renames = Renames::new();
    let mut found_moof = false;

    for moof in children(frag, 0..frag.len()).iter().filter(|b| &b.typ == b"moof") {
        found_moof = true;
        for b in children(frag, moof.body..moof.end) {
            match &b.typ {
                b"pssh" => renames.push((b.start, *b"free")),
                b"traf" => parse_traf(frag, moof, &b, &mut samples, &mut renames)?,
                _ => {}
            }
        }
    }
    if !found_moof {
        return Err("No moof box found in fragment".into());
    }

    samples.retain(|r| !r.is_empty());
    let mut prev_end = 0;
    for r in &samples {
        if r.start < prev_end || r.end > frag.len() {
            return Err(format!("Sample range {r:?} is out of order or past fragment end {}", frag.len()));
        }
        prev_end = r.end;
    }
    Ok((samples, renames))
}

fn parse_traf(
    src: &[u8],
    moof: &BoxHeader,
    traf: &BoxHeader,
    samples: &mut Vec<Range<usize>>,
    renames: &mut Renames,
) -> Result<(), String> {
    let mut default_size: Option<u32> = None;
    // 未显式给出 data_offset 的 trun 紧接上一个 trun 的数据
    let mut next_data = moof.start;

    for b in children(src, traf.body..traf.end) {
        match &b.typ {
            b"tfhd" => {
                let mut r = Reader::full_box(src, &b)?;
                r.u32()?; // track_ID
                if r.flags & 0x01 != 0 {
                    return Err("tfhd base-data-offset is not supported".into());
                }
                if r.flags & 0x02 != 0 {
                    r.u32()?;
                }
                if r.flags & 0x08 != 0 {
                    r.u32()?;
                }
                if r.flags & 0x10 != 0 {
                    default_size = Some(r.u32()?);
                }
            }
            b"trun" => {
                let mut r = Reader::full_box(src, &b)?;
                let count = r.u32()? as usize;
                let mut pos = next_data;
                if r.flags & 0x01 != 0 {
                    let off = r.u32()? as i32 as i64;
                    pos = usize::try_from(moof.start as i64 + off)
                        .map_err(|_| "trun data_offset points before fragment start")?;
                }
                if r.flags & 0x04 != 0 {
                    r.u32()?;
                }
                // 每个 sample 至少占一个字段时，count 不能超过剩余字节，防止畸形 count
                if count > src.len() {
                    return Err(format!("Implausible trun sample_count {count}"));
                }
                samples.reserve(count);
                for _ in 0..count {
                    if r.flags & 0x100 != 0 {
                        r.u32()?;
                    }
                    let size = if r.flags & 0x200 != 0 {
                        r.u32()?
                    } else {
                        default_size.ok_or("Sample size missing from both trun and tfhd")?
                    } as usize;
                    if r.flags & 0x400 != 0 {
                        r.u32()?;
                    }
                    if r.flags & 0x800 != 0 {
                        r.u32()?;
                    }
                    samples.push(pos..pos + size);
                    pos += size;
                }
                next_data = pos;
            }
            b"senc" | b"saiz" | b"saio" => renames.push((b.start, *b"free")),
            b"sgpd" | b"sbgp" => {
                // FullBox(4) 后紧跟 grouping_type；只清除加密相关的 'seig' 与 Apple 换钥映射 'seam'
                if b.body + 8 <= b.end && matches!(&src[b.body + 4..b.body + 8], b"seig" | b"seam") {
                    renames.push((b.start, *b"free"));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// FullBox 顺序读取器，越界返回错误而不是 panic。
struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
    end: usize,
    flags: u32,
}

impl<'a> Reader<'a> {
    fn full_box(buf: &'a [u8], b: &BoxHeader) -> Result<Self, String> {
        let mut r = Reader { buf, pos: b.body, end: b.end, flags: 0 };
        r.flags = r.u32()? & 0x00FF_FFFF;
        Ok(r)
    }

    fn u32(&mut self) -> Result<u32, String> {
        if self.pos + 4 > self.end {
            return Err("Truncated box".into());
        }
        let v = be_u32(self.buf, self.pos);
        self.pos += 4;
        Ok(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_box(typ: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut v = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        v.extend_from_slice(typ);
        v.extend_from_slice(body);
        v
    }

    fn full(flags: u32, rest: &[u8]) -> Vec<u8> {
        let mut v = flags.to_be_bytes().to_vec();
        v.extend_from_slice(rest);
        v
    }

    #[test]
    fn test_patch_init_segment() {
        let frma = mk_box(b"frma", b"ec-3");
        let sinf = mk_box(b"sinf", &frma);
        let mut enca_body = vec![0u8; 28];
        enca_body.extend_from_slice(&sinf);
        let enca = mk_box(b"enca", &enca_body);
        let mut stsd_body = full(0, &1u32.to_be_bytes());
        stsd_body.extend_from_slice(&enca);
        let stsd = mk_box(b"stsd", &stsd_body);
        let stbl = mk_box(b"stbl", &stsd);
        let minf = mk_box(b"minf", &stbl);
        let mdia = mk_box(b"mdia", &minf);
        let trak = mk_box(b"trak", &mdia);
        let mut buf = mk_box(b"ftyp", b"isom");
        buf.extend_from_slice(&mk_box(b"moov", &trak));

        let patched = patch_init_segment(&buf);
        assert_eq!(patched.len(), buf.len());
        assert!(patched.windows(4).any(|w| w == b"ec-3"));
        assert!(patched.windows(4).any(|w| w == b"free"));
        assert!(!patched.windows(4).any(|w| w == b"enca"));
        assert!(!patched.windows(4).any(|w| w == b"sinf"));
        assert!(!patched.windows(4).any(|w| w == b"frma"), "sinf body must be wiped");
    }

    #[test]
    fn test_decrypt_fragment_sanitizes_and_locates_samples() {
        // tfhd: default-base-is-moof + default_sample_size=32
        let mut tfhd_rest = 1u32.to_be_bytes().to_vec();
        tfhd_rest.extend_from_slice(&32u32.to_be_bytes());
        let tfhd = mk_box(b"tfhd", &full(0x020010, &tfhd_rest));
        let senc = mk_box(b"senc", &full(0, &[0; 4]));
        let roll = mk_box(b"sgpd", &full(0, b"roll"));
        let seig = mk_box(b"sgpd", &full(0, b"seig"));

        let trun_len = 8 + 4 + 4 + 4;
        let traf_len = 8 + tfhd.len() + senc.len() + roll.len() + seig.len() + trun_len;
        let moof_len = 8 + traf_len;
        let mut trun_rest = 2u32.to_be_bytes().to_vec();
        trun_rest.extend_from_slice(&((moof_len + 8) as u32).to_be_bytes());
        let trun = mk_box(b"trun", &full(0x01, &trun_rest));
        let traf = mk_box(b"traf", &[tfhd, senc, roll, seig, trun].concat());
        let mut frag = mk_box(b"moof", &traf);
        assert_eq!(frag.len(), moof_len);
        frag.extend_from_slice(&mk_box(b"mdat", &[0xAB; 64]));

        let out = decrypt_fragment(&frag, fixed_template()).unwrap();
        assert_eq!(out.len(), frag.len());
        assert!(!out.windows(4).any(|w| w == b"senc"));
        assert!(out.windows(4).any(|w| w == b"roll"), "non-encryption sgpd must be kept");
        assert_eq!(out.windows(4).filter(|w| w == b"sgpd").count(), 1, "'seig' sgpd must be freed");
        assert_ne!(&out[moof_len + 8..], &frag[moof_len + 8..], "mdat samples must be decrypted");

        let mut in_place = frag.clone();
        decrypt_fragment_in_place(&mut in_place, fixed_template()).unwrap();
        assert_eq!(in_place, out, "in-place (wasm) path must match the parallel path");
    }

    #[test]
    fn test_decrypt_fragment_rejects_garbage() {
        assert!(decrypt_fragment(&[0u8; 32], fixed_template()).is_err());
        assert!(decrypt_fragment_in_place(&mut [0u8; 32], fixed_template()).is_err());
    }

    #[test]
    fn test_fixed_template_loads() {
        assert_eq!(fixed_template().ctx.len(), temari::rounds::CTX_SIZE);
    }
}
