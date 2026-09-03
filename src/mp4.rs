use temari::rounds::{decrypt, Template};

/// 改造 fMP4 的 init segment (包含 ftyp 与 moov):
/// 将 stsd 中的 enca (或 encv) 替换为 frma 记录的原始格式 (如 ec-3, mp4a, alac)，
/// 并将 sinf box 替换为等长的 free box，确保字节大小与偏移完全不变。
pub fn patch_init_segment(init_data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = init_data.to_vec();
    let mut pos = 0;
    while pos + 8 <= out.len() {
        let size = u32::from_be_bytes(out[pos..pos + 4].try_into().unwrap()) as usize;
        let box_type = &out[pos + 4..pos + 8];
        let box_len = if size == 1 {
            if pos + 16 > out.len() { break; }
            u64::from_be_bytes(out[pos + 8..pos + 16].try_into().unwrap()) as usize
        } else if size == 0 {
            out.len() - pos
        } else {
            size
        };

        if box_len < 8 || pos + box_len > out.len() {
            break;
        }

        if box_type == b"moov" {
            patch_moov(&mut out[pos..pos + box_len]);
        }
        pos += box_len;
    }
    Ok(out)
}

fn patch_moov(moov_buf: &mut [u8]) {
    // 查找所有的 enca 或 encv，通过其内部的 sinf -> frma 确定原始格式并替换
    let mut pos = 0;
    while pos + 8 <= moov_buf.len() {
        let btype = &moov_buf[pos + 4..pos + 8];
        if btype == b"enca" || btype == b"encv" {
            let box_start = pos;
            let box_size = u32::from_be_bytes(moov_buf[pos..pos + 4].try_into().unwrap()) as usize;
            let box_end = if box_size >= 8 && pos + box_size <= moov_buf.len() {
                pos + box_size
            } else {
                moov_buf.len()
            };

            // 在该 sample entry 范围内查找 sinf
            let entry_slice = &mut moov_buf[box_start..box_end];
            if let Some(sinf_rel) = find_subslice(entry_slice, b"sinf") {
                // 在 sinf 之后查找 frma
                let sinf_slice = &entry_slice[sinf_rel..];
                if let Some(frma_rel) = find_subslice(sinf_slice, b"frma") {
                    let fmt_start = frma_rel + 4;
                    if fmt_start + 4 <= sinf_slice.len() {
                        let orig_fmt = [
                            sinf_slice[fmt_start],
                            sinf_slice[fmt_start + 1],
                            sinf_slice[fmt_start + 2],
                            sinf_slice[fmt_start + 3],
                        ];
                        // 替换 enca 为原始编码
                        entry_slice[4..8].copy_from_slice(&orig_fmt);
                        // 替换 sinf 为 free
                        entry_slice[sinf_rel..sinf_rel + 4].copy_from_slice(b"free");
                    }
                }
            }
            pos = box_end;
        } else {
            pos += 1;
        }
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// 解密一个分片 (Fragment, 包含 moof 与 mdat):
/// 1. 将 moof 中的 senc, saiz, saio, sgpd, sbgp 替换为等长 free box
/// 2. 解析 tfhd 与 trun 计算每个 sample 偏移与大小
/// 3. 使用 tmpl 解密各个 sample，原地替换 mdat 内密文数据
pub fn decrypt_fragment(frag_data: &[u8], tmpl: &Template) -> Result<Vec<u8>, String> {
    let mut out = frag_data.to_vec();
    if out.len() < 16 {
        return Ok(out);
    }

    // 1. 定位 moof
    let mut moof_range = None;
    let mut pos = 0;
    while pos + 8 <= out.len() {
        let size = u32::from_be_bytes(out[pos..pos + 4].try_into().unwrap()) as usize;
        let btype = &out[pos + 4..pos + 8];
        let blen = if size == 1 {
            if pos + 16 > out.len() { break; }
            u64::from_be_bytes(out[pos + 8..pos + 16].try_into().unwrap()) as usize
        } else if size == 0 {
            out.len() - pos
        } else {
            size
        };
        if blen < 8 || pos + blen > out.len() {
            break;
        }
        if btype == b"moof" {
            moof_range = Some((pos, blen));
            break;
        }
        pos += blen;
    }

    let (moof_offset, moof_size) = moof_range.ok_or_else(|| "No moof box found in fragment".to_string())?;

    // 2. 在 moof 中解析 tfhd 与 trun
    let (sample_base_offset, sample_sizes) = parse_moof_samples(&out[moof_offset..moof_offset + moof_size], moof_offset, moof_size)?;

    // 3. 将 moof 内部所有加密元数据 box (senc, saiz, saio, sgpd, sbgp) 替换为 free
    sanitize_moof_encryption_boxes(&mut out[moof_offset..moof_offset + moof_size]);

    // 4. 解密各个 sample
    let mut cur_offset = sample_base_offset;
    for &sample_size in &sample_sizes {
        let end = cur_offset + sample_size;
        if end > out.len() {
            return Err(format!("Sample extends past fragment end: {} > {}", end, out.len()));
        }
        if sample_size > 0 {
            let sample_ct = &out[cur_offset..end];
            let pt = decrypt(tmpl, sample_ct);
            out[cur_offset..end].copy_from_slice(&pt);
        }
        cur_offset = end;
    }

    Ok(out)
}

fn sanitize_moof_encryption_boxes(moof_buf: &mut [u8]) {
    // 扫描 moof 内部所有子 box，若为 senc, saiz, saio, sgpd, sbgp 则改为 free
    let target_boxes: [&[u8; 4]; 5] = [b"senc", b"saiz", b"saio", b"sgpd", b"sbgp"];
    let mut p = 8;
    while p + 8 <= moof_buf.len() {
        let btype = &moof_buf[p + 4..p + 8];
        if target_boxes.iter().any(|&tb| tb == btype) {
            moof_buf[p + 4..p + 8].copy_from_slice(b"free");
        }
        p += 1;
    }
}

fn parse_moof_samples(
    moof_buf: &[u8],
    moof_offset: usize,
    moof_size: usize,
) -> Result<(usize, Vec<usize>), String> {
    let mut default_sample_size = None;
    let mut data_offset = None;
    let mut sample_sizes = Vec::new();

    let mut p = 8;
    while p + 8 <= moof_buf.len() {
        let bsize = u32::from_be_bytes(moof_buf[p..p + 4].try_into().unwrap()) as usize;
        let btype = &moof_buf[p + 4..p + 8];
        if bsize >= 8 && p + bsize <= moof_buf.len() {
            if btype == b"traf" {
                let mut tp = p + 8;
                while tp + 8 <= p + bsize {
                    let t_bsize = u32::from_be_bytes(moof_buf[tp..tp + 4].try_into().unwrap()) as usize;
                    let t_btype = &moof_buf[tp + 4..tp + 8];
                    if t_bsize >= 8 && tp + t_bsize <= p + bsize {
                        if t_btype == b"tfhd" && t_bsize >= 16 {
                            let flags = u32::from_be_bytes([0, moof_buf[tp + 9], moof_buf[tp + 10], moof_buf[tp + 11]]);
                            let mut cur = tp + 16;
                            if flags & 0x01 != 0 && cur + 8 <= tp + t_bsize { cur += 8; }
                            if flags & 0x02 != 0 && cur + 4 <= tp + t_bsize { cur += 4; }
                            if flags & 0x08 != 0 && cur + 4 <= tp + t_bsize { cur += 4; }
                            if flags & 0x10 != 0 && cur + 4 <= tp + t_bsize {
                                let dss = u32::from_be_bytes(moof_buf[cur..cur + 4].try_into().unwrap()) as usize;
                                default_sample_size = Some(dss);
                            }
                        } else if t_btype == b"trun" && t_bsize >= 16 {
                            let flags = u32::from_be_bytes([0, moof_buf[tp + 9], moof_buf[tp + 10], moof_buf[tp + 11]]);
                            let sample_count = u32::from_be_bytes(moof_buf[tp + 12..tp + 16].try_into().unwrap()) as usize;
                            let mut cur = tp + 16;
                            if flags & 0x01 != 0 && cur + 4 <= tp + t_bsize {
                                let doff = i32::from_be_bytes(moof_buf[cur..cur + 4].try_into().unwrap());
                                data_offset = Some(doff);
                                cur += 4;
                            }
                            if flags & 0x04 != 0 && cur + 4 <= tp + t_bsize { cur += 4; }

                            for _ in 0..sample_count {
                                if flags & 0x100 != 0 && cur + 4 <= tp + t_bsize { cur += 4; }
                                let ssz = if flags & 0x200 != 0 && cur + 4 <= tp + t_bsize {
                                    let s = u32::from_be_bytes(moof_buf[cur..cur + 4].try_into().unwrap()) as usize;
                                    cur += 4;
                                    s
                                } else {
                                    default_sample_size.unwrap_or(0)
                                };
                                if flags & 0x400 != 0 && cur + 4 <= tp + t_bsize { cur += 4; }
                                if flags & 0x800 != 0 && cur + 4 <= tp + t_bsize { cur += 4; }
                                sample_sizes.push(ssz);
                            }
                        }
                    }
                    if t_bsize == 0 { break; }
                    tp += t_bsize;
                }
            }
        }
        if bsize == 0 { break; }
        p += bsize;
    }

    let sample_base = if let Some(doff) = data_offset {
        (moof_offset as i64 + doff as i64) as usize
    } else {
        moof_offset + moof_size + 8 // 默认紧接 moof 后的 mdat payload
    };

    Ok((sample_base, sample_sizes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_patch_init_segment() {
        // 构建简易 mock ftyp + moov + enca + sinf + frma
        let mut buf = Vec::new();
        // ftyp: 8 bytes
        buf.extend_from_slice(&[0, 0, 0, 8, b'f', b't', b'y', b'p']);
        // moov:
        let moov_start = buf.len();
        buf.extend_from_slice(&[0, 0, 0, 0, b'm', b'o', b'o', b'v']);
        // enca:
        let enca_start = buf.len();
        buf.extend_from_slice(&[0, 0, 0, 0, b'e', b'n', b'c', b'a']);
        buf.extend_from_slice(&[0u8; 28]); // audio sample entry header
        // sinf:
        let _sinf_start = buf.len();
        buf.extend_from_slice(&[0, 0, 0, 20, b's', b'i', b'n', b'f']);
        // frma:
        buf.extend_from_slice(&[0, 0, 0, 12, b'f', b'r', b'm', b'a', b'e', b'c', b'-', b'3']);

        let enca_len = (buf.len() - enca_start) as u32;
        buf[enca_start..enca_start + 4].copy_from_slice(&enca_len.to_be_bytes());
        let moov_len = (buf.len() - moov_start) as u32;
        buf[moov_start..moov_start + 4].copy_from_slice(&moov_len.to_be_bytes());

        let patched = patch_init_segment(&buf).unwrap();
        assert_eq!(patched.len(), buf.len());
        assert!(patched.windows(4).any(|w| w == b"ec-3"));
        assert!(patched.windows(4).any(|w| w == b"free"));
        assert!(!patched.windows(4).any(|w| w == b"enca"));
        assert!(!patched.windows(4).any(|w| w == b"sinf"));
    }
}
    #[test]
    fn test_real_init_and_frag1_if_present() {
        use crate::embedded_template::get_fixed_template;
        let init_path = r"C:\Users\qwer\AppData\Local\Temp\init.mp4";
        let frag1_path = r"C:\Users\qwer\AppData\Local\Temp\frag1.mp4";

        if std::path::Path::new(init_path).exists() {
            let raw_init = std::fs::read(init_path).unwrap();
            let patched_init = patch_init_segment(&raw_init).unwrap();
            assert_eq!(patched_init.len(), raw_init.len());
            // enca should be replaced with ec-3
            assert!(!patched_init.windows(4).any(|w| w == b"enca"));
            assert!(patched_init.windows(4).any(|w| w == b"ec-3"));
            assert!(patched_init.windows(4).any(|w| w == b"free"));
        }

        if std::path::Path::new(frag1_path).exists() {
            let raw_frag1 = std::fs::read(frag1_path).unwrap();
            let tmpl = get_fixed_template();
            let decrypted_frag1 = decrypt_fragment(&raw_frag1, tmpl).unwrap();
            assert_eq!(decrypted_frag1.len(), raw_frag1.len());
            // encryption boxes should be replaced with free
            assert!(!decrypted_frag1.windows(4).any(|w| w == b"senc"));
            assert!(!decrypted_frag1.windows(4).any(|w| w == b"saiz"));
            assert!(!decrypted_frag1.windows(4).any(|w| w == b"saio"));
            assert!(!decrypted_frag1.windows(4).any(|w| w == b"sgpd"));
            assert!(!decrypted_frag1.windows(4).any(|w| w == b"sbgp"));
            // sample 0 should have syncword 0x0B77
            // in frag1, sample 0 starts at 3977
            assert_eq!(&decrypted_frag1[3977..3979], &[0x0B, 0x77]);
        }
    }
