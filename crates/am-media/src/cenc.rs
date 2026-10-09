//! CENC (AES-CTR) and CBCS (pattern AES-CBC) decryption of fragmented MP4,
//! following mp4ff's `DecryptInit` / `DecryptFragment`.

use crate::bmff::{be32, fourcc, Atom, FourCC, Reader};
use crate::crypto::Aes;
use crate::frag::{traf_tfhd, Trex, Trun};
use crate::{bail, Error, Result};

/// PIFF sample encryption box UUID (a2394f52-5a9b-4f14-a244-6c427c648df4).
const PIFF_SENC: [u8; 16] = [0xa2, 0x39, 0x4f, 0x52, 0x5a, 0x9b, 0x4f, 0x14, 0xa2, 0x44, 0x6c, 0x42, 0x7c, 0x64, 0x8d, 0xf4];

#[derive(Clone, Debug, Default)]
pub struct Tenc {
    pub crypt_blocks: u8,
    pub skip_blocks: u8,
    pub iv_size: u8,
    pub constant_iv: Vec<u8>,
}

impl Tenc {
    fn parse(atom: &Atom) -> Result<Tenc> {
        let mut r = Reader::new(atom.bytes());
        let version = r.u8()?;
        r.take(4)?; // flags, reserved
        let pattern = r.u8()?;
        let mut t = Tenc::default();
        if version > 0 {
            t.crypt_blocks = pattern >> 4;
            t.skip_blocks = pattern & 0x0f;
        }
        let protected = r.u8()?;
        t.iv_size = r.u8()?;
        r.take(16)?; // KID
        if protected == 1 && t.iv_size == 0 {
            let n = r.u8()? as usize;
            t.constant_iv = r.take(n)?.to_vec();
        }
        Ok(t)
    }
}

#[derive(Clone, Debug)]
pub struct Protection {
    pub scheme: FourCC,
    pub tenc: Tenc,
}

#[derive(Clone, Debug)]
pub struct TrackInfo {
    pub track_id: u32,
    pub protection: Option<Protection>,
    pub trex: Option<Trex>,
}

#[derive(Clone, Debug, Default)]
pub struct DecryptInfo {
    pub tracks: Vec<TrackInfo>,
}

impl DecryptInfo {
    pub fn find(&self, track_id: u32) -> Option<&TrackInfo> {
        self.tracks.iter().find(|t| t.track_id == track_id)
    }
}

pub fn tkhd_track_id(trak: &Atom) -> Result<u32> {
    let b = trak.req(&[b"tkhd"])?.bytes();
    let at = if b.first() == Some(&1) { 20 } else { 12 };
    if b.len() < at + 4 {
        bail!("truncated tkhd");
    }
    Ok(be32(b, at))
}

/// Removes protection from the init segment's moov (sample entries get their
/// original format back, sinf and pssh boxes are dropped) and returns what
/// fragments need for decryption.
pub fn decrypt_init(moov: &mut Atom) -> Result<DecryptInfo> {
    let mut info = DecryptInfo::default();
    for trak in moov.children_mut().iter_mut().filter(|c| &c.kind == b"trak") {
        let track_id = tkhd_track_id(trak)?;
        let stsd = trak.req_mut(&[b"mdia", b"minf", b"stbl", b"stsd"])?;
        let mut scheme: Option<FourCC> = None;
        for entry in stsd.children_mut().iter_mut().filter(|e| &e.kind == b"encv" || &e.kind == b"enca") {
            let at = entry
                .children()
                .iter()
                .position(|c| &c.kind == b"sinf")
                .ok_or_else(|| Error::new("does not have sinf box"))?;
            let sinf = entry.children_mut().remove(at);
            let frma = sinf.req(&[b"frma"])?.bytes();
            let schm = sinf.req(&[b"schm"])?.bytes();
            if frma.len() < 4 || schm.len() < 8 {
                bail!("truncated sinf");
            }
            entry.kind = frma[..4].try_into().unwrap();
            let s: FourCC = schm[4..8].try_into().unwrap();
            let tenc = match sinf.path(&[b"schi", b"tenc"]) {
                Some(t) => Tenc::parse(t)?,
                None => bail!("sinf has no tenc"),
            };
            scheme = Some(s);
            info.tracks.push(TrackInfo { track_id, protection: Some(Protection { scheme: s, tenc }), trex: None });
        }
        match scheme {
            Some(s) if &s != b"cenc" && &s != b"cbcs" => bail!("scheme type {} not supported", fourcc(&s)),
            Some(_) => {}
            None => info.tracks.push(TrackInfo { track_id, protection: None, trex: None }),
        }
    }
    if let Some(mvex) = moov.child(b"mvex") {
        for trex in mvex.all(b"trex") {
            let trex = Trex::parse(trex)?;
            if let Some(t) = info.tracks.iter_mut().find(|t| t.track_id == trex.track_id) {
                t.trex = Some(trex);
            }
        }
    }
    moov.children_mut().retain(|c| &c.kind != b"pssh");
    Ok(info)
}

#[derive(Debug, PartialEq, Eq)]
pub enum FragmentOutcome {
    /// Bytes removed from the moof.
    Decrypted(u64),
    /// An encrypted track's traf has no senc: mp4ff stops there and the caller
    /// keeps the fragment as it is.
    NoSenc,
}

#[derive(Clone, Copy, Debug, Default)]
struct Subsample {
    clear: u32,
    protected: u32,
}

#[derive(Default)]
struct Senc {
    ivs: Vec<Vec<u8>>,
    subsamples: Vec<Vec<Subsample>>,
}

fn is_piff_senc(atom: &Atom) -> bool {
    &atom.kind == b"uuid" && atom.bytes().get(..16) == Some(&PIFF_SENC[..])
}

/// Per-sample IV size from a fragment-local seig sample group, as mp4ff does.
fn seig_iv_size(traf: &Atom) -> Result<Option<u8>> {
    let (Some(sbgp), Some(sgpd)) = (traf.all(b"sbgp").last(), traf.all(b"sgpd").last()) else { return Ok(None) };
    let sbgp = crate::frag::Sbgp::parse(sbgp)?;
    if &sbgp.grouping_type != b"seig" || crate::frag::sgpd_grouping_type(sgpd) != Some(*b"seig") {
        return Ok(None);
    }
    if sbgp.indices.len() != 1 {
        bail!("sbgp entries = {}, only 1 supported for now", sbgp.indices.len());
    }
    if sbgp.indices[0] != 65536 + 1 {
        bail!("sgpd entry number must be first inside = 65536 + 1");
    }
    let mut r = Reader::new(sgpd.bytes());
    let version = r.u8()?;
    r.take(7)?; // flags, grouping type
    let default_length = if version == 1 { r.u32()? } else { 0 };
    if version >= 2 {
        r.u32()?;
    }
    if r.u32()? == 0 {
        bail!("empty seig sgpd");
    }
    if version == 1 && default_length == 0 {
        r.u32()?;
    }
    r.take(3)?; // reserved, pattern, isProtected
    Ok(Some(r.u8()?))
}

fn parse_senc(payload: &[u8], iv_hint: u8) -> Result<Senc> {
    let mut r = Reader::new(payload);
    let flags = r.u32()? & 0x00ff_ffff;
    let count = r.u32()? as usize;
    let body = &payload[8..];
    if flags & 0x2 == 0 {
        let size = if iv_hint != 0 { iv_hint as usize } else { body.len().checked_div(count).unwrap_or(0) };
        let mut s = Senc::default();
        match size {
            0 => {}
            8 | 16 => {
                for i in 0..count {
                    let iv = body.get(i * size..(i + 1) * size).ok_or_else(|| Error::new("truncated senc"))?;
                    s.ivs.push(iv.to_vec());
                }
            }
            n => bail!("strange derived PerSampleIVSize: {n}"),
        }
        return Ok(s);
    }
    let fill = |size: usize| -> Option<Senc> {
        let mut r = Reader::new(body);
        let mut s = Senc::default();
        for _ in 0..count {
            if size > 0 {
                s.ivs.push(r.take(size).ok()?.to_vec());
            }
            let n = r.u16().ok()? as usize;
            let mut subs = Vec::with_capacity(n);
            for _ in 0..n {
                subs.push(Subsample { clear: r.u16().ok()? as u32, protected: r.u32().ok()? });
            }
            s.subsamples.push(subs);
        }
        (r.left() == 0).then_some(s)
    };
    if iv_hint != 0 {
        return fill(iv_hint as usize).ok_or_else(|| Error::msg(format!("error decoding senc with perSampleIVSize = {iv_hint}")));
    }
    [0, 8, 16].into_iter().find_map(fill).ok_or_else(|| Error::new("could not decode senc"))
}

/// Decrypts every encrypted traf of `moof` in place in `mdat` and removes the
/// encryption boxes, adjusting trun data offsets. `moof_start` and
/// `mdat_payload_start` are positions in the same coordinate space the trun
/// offsets refer to.
pub fn decrypt_fragment(
    moof: &mut Atom,
    moof_start: u64,
    mdat: &mut [u8],
    mdat_payload_start: u64,
    info: &DecryptInfo,
    key: &[u8; 16],
) -> Result<FragmentOutcome> {
    let cipher = Aes::new(key);
    let mut removed = 0u64;
    for traf in moof.children_mut().iter_mut().filter(|c| &c.kind == b"traf") {
        let tfhd = traf_tfhd(traf)?;
        let Some(ti) = info.find(tfhd.track_id) else { continue };
        let Some(prot) = &ti.protection else { continue };
        let senc_payload = if let Some(s) = traf.child(b"senc") {
            s.bytes().to_vec()
        } else if let Some(u) = traf.children().iter().find(|c| is_piff_senc(c)) {
            u.bytes()[16..].to_vec()
        } else {
            return Ok(FragmentOutcome::NoSenc);
        };
        let hint = seig_iv_size(traf)?.unwrap_or(prot.tenc.iv_size);
        let senc = parse_senc(&senc_payload, hint).map_err(|e| e.context("parseReadSenc"))?;

        // Sample ranges inside mdat.
        let base = tfhd.base_data_offset.unwrap_or(moof_start);
        let mut ranges = Vec::new();
        for trun in traf.all(b"trun") {
            let mut trun = Trun::parse(trun)?;
            trun.fill_defaults(&tfhd, ti.trex.as_ref());
            let start = if trun.has(crate::frag::TRUN_DATA_OFFSET) { base as i64 + trun.data_offset as i64 } else { base as i64 };
            let mut at = start
                .checked_sub(mdat_payload_start as i64)
                .filter(|&v| v >= 0 && v as u64 <= mdat.len() as u64)
                .ok_or_else(|| Error::new("offset in mdata beyond size"))? as usize;
            for s in &trun.samples {
                let end = at + s.size as usize;
                if end > mdat.len() {
                    bail!("sample outside mdat");
                }
                ranges.push(at..end);
                at = end;
            }
        }

        let mut iv = [0u8; 16];
        let n = prot.tenc.constant_iv.len().min(16);
        iv[..n].copy_from_slice(&prot.tenc.constant_iv[..n]);
        // Per-sample IVs replace the constant IV only when there is one per sample.
        let per_sample = senc.ivs.len() == ranges.len();
        for (i, range) in ranges.into_iter().enumerate() {
            let subs: &[Subsample] = senc.subsamples.get(i).map(|v| v.as_slice()).unwrap_or(&[]);
            let sample = &mut mdat[range];
            if per_sample {
                let v = &senc.ivs[i];
                if v.len() < 16 {
                    iv = [0; 16];
                }
                let n = v.len().min(16);
                iv[..n].copy_from_slice(&v[..n]);
            }
            match &prot.scheme {
                b"cenc" => ctr(&cipher, sample, &iv, subs),
                _ => cbcs(&cipher, sample, &iv, subs, &prot.tenc)?,
            }
        }

        let before: u64 = traf.children().iter().map(Atom::size).sum();
        traf.children_mut().retain(|c| !is_encryption_box(c));
        removed += before - traf.children().iter().map(Atom::size).sum::<u64>();
    }
    let before: u64 = moof.children().iter().map(Atom::size).sum();
    moof.children_mut().retain(|c| &c.kind != b"pssh");
    removed += before - moof.children().iter().map(Atom::size).sum::<u64>();
    if removed > 0 {
        for traf in moof.children_mut().iter_mut().filter(|c| &c.kind == b"traf") {
            for trun in traf.children_mut().iter_mut().filter(|c| &c.kind == b"trun") {
                if let Some(off) = Trun::data_offset(trun) {
                    Trun::set_data_offset(trun, off.wrapping_sub(removed as i32));
                }
            }
        }
    }
    Ok(FragmentOutcome::Decrypted(removed))
}

/// saiz, saio, senc (plain or PIFF) and seig/seam sample groups. The grouping
/// type sits at payload bytes 4..8 for both sbgp and sgpd.
fn is_encryption_box(c: &Atom) -> bool {
    matches!(&c.kind, b"saiz" | b"saio" | b"senc")
        || is_piff_senc(c)
        || (matches!(&c.kind, b"sbgp" | b"sgpd") && matches!(c.bytes().get(4..8), Some(b"seig") | Some(b"seam")))
}

fn ctr(cipher: &Aes, sample: &mut [u8], iv: &[u8; 16], subs: &[Subsample]) {
    // One keystream per sample, continuing across its protected ranges.
    let mut counter = u128::from_be_bytes(*iv);
    let mut stream = [0u8; 16];
    let mut used = 16;
    let mut xor = |data: &mut [u8]| {
        for b in data {
            if used == 16 {
                stream = counter.to_be_bytes();
                cipher.encrypt(&mut stream);
                counter = counter.wrapping_add(1);
                used = 0;
            }
            *b ^= stream[used];
            used += 1;
        }
    };
    if subs.is_empty() {
        xor(sample);
        return;
    }
    let mut pos = 0usize;
    for s in subs {
        pos += s.clear as usize;
        let end = (pos + s.protected as usize).min(sample.len());
        if pos < end {
            xor(&mut sample[pos..end]);
        }
        pos += s.protected as usize;
    }
}

/// One cbcs protected range: crypt/skip pattern, restarting from the IV. The
/// CBC chain continues across the encrypted blocks of the range.
fn cbcs_range(cipher: &Aes, data: &mut [u8], iv: &[u8; 16], crypt: usize, skip: usize) -> Result<()> {
    let size = data.len();
    let mut prev = *iv;
    if skip == 0 {
        cipher.cbc_decrypt(&mut data[..size & !0xf], &mut prev);
        return Ok(());
    }
    if crypt == 0 {
        bail!("cbcs pattern skips without encrypting");
    }
    let mut pos = 0;
    while size - pos >= crypt {
        cipher.cbc_decrypt(&mut data[pos..pos + crypt], &mut prev);
        pos += crypt;
        if size - pos < skip {
            break;
        }
        pos += skip;
    }
    Ok(())
}

fn cbcs(cipher: &Aes, sample: &mut [u8], iv: &[u8; 16], subs: &[Subsample], tenc: &Tenc) -> Result<()> {
    let crypt = tenc.crypt_blocks as usize * 16;
    let skip = tenc.skip_blocks as usize * 16;
    if subs.is_empty() {
        return cbcs_range(cipher, sample, iv, crypt, skip);
    }
    let mut pos = 0usize;
    for s in subs {
        pos += s.clear as usize;
        if s.protected > 0 {
            let end = pos + s.protected as usize;
            if end > sample.len() {
                bail!("subsample outside sample");
            }
            cbcs_range(cipher, &mut sample[pos..end], iv, crypt, skip)?;
        }
        pos += s.protected as usize;
    }
    Ok(())
}
