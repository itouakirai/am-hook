//! Per-stream MV processing: decrypting initialization and media segments,
//! normalizing decode timestamps and merging video and audio initialization
//! metadata for muxed downloads.

use std::collections::HashMap;

use crate::bmff::{self, be32, put32, put64, Atom};
use crate::c608;
use crate::cenc::{self, tkhd_track_id, DecryptInfo, FragmentOutcome};
use crate::frag::{self, Tfhd, Trex, Trun};
use crate::{bail, Error, Result};

pub struct Stream {
    info: DecryptInfo,
    /// Decrypted initialization segment boxes (ftyp, moov, ...).
    init: Vec<Atom>,
    /// Source track ID -> muxed track ID.
    ids: HashMap<u32, u32>,
    /// Caption tracks whose malformed samples are repaired in each fragment.
    captions: HashMap<u32, Option<Trex>>,
    /// First decode timestamp of each track, retained across seeks and subtracted.
    origin: HashMap<u32, u64>,
}

fn encode_all(atoms: &[Atom]) -> Vec<u8> {
    let mut out = Vec::with_capacity(atoms.iter().map(|a| a.size() as usize).sum());
    atoms.iter().for_each(|a| a.encode(&mut out));
    out
}

fn moov_mut(atoms: &mut [Atom]) -> Result<&mut Atom> {
    atoms.iter_mut().find(|a| &a.kind == b"moov").ok_or_else(|| Error::new("missing fragmented MP4 init"))
}

impl Stream {
    /// Parses and decrypts an initialization segment. Track `i` of the init is
    /// numbered `base + i` when muxed. Returns the stream and the clear init bytes.
    pub fn open(raw: &[u8], base: u32) -> Result<(Stream, Vec<u8>)> {
        let mut init = bmff::parse(raw)?;
        let moov = moov_mut(&mut init)?;
        if moov.child(b"mvex").is_none() {
            bail!("missing fragmented MP4 init");
        }
        let info = cenc::decrypt_init(moov)?;
        let captions = c608::tracks(moov)?;
        let mut ids = HashMap::new();
        for (i, trak) in moov.all(b"trak").enumerate() {
            ids.insert(tkhd_track_id(trak)?, base + i as u32);
        }
        let bytes = encode_all(&init);
        Ok((Stream { info, init, ids, captions, origin: HashMap::new() }, bytes))
    }

    /// Decrypts one media segment. With `mux`, fragments are renumbered from
    /// `sequence` and tracks get their muxed IDs. Boxes other than moof/mdat
    /// (styp, sidx, ...) are dropped.
    pub fn fragment(&mut self, raw: &mut [u8], key: &[u8; 16], mux: bool, mut sequence: u32) -> Result<Vec<u8>> {
        let mut out = Vec::with_capacity(raw.len());
        let mut pending: Option<(Atom, u64)> = None;
        for span in bmff::spans(raw, 0, raw.len())? {
            match &span.kind {
                b"moof" => {
                    if pending.is_some() {
                        bail!("incomplete fragment");
                    }
                    pending = Some((Atom::from_span(raw, &span)?, span.start as u64));
                }
                b"mdat" => {
                    let (mut moof, moof_start) = pending.take().ok_or_else(|| Error::new("mdat without moof"))?;
                    let payload_start = (span.start + span.header) as u64;
                    let mdat = &mut raw[span.payload()];
                    // Before decryption, while offsets still match the source positions.
                    // Caption samples are clear and keep their size.
                    c608::repair_fragment(&moof, moof_start, mdat, payload_start, &self.captions)?;
                    // A traf without senc leaves the fragment as it is, like mp4ff's
                    // "no senc box in traf" error that the Go worker ignored.
                    let _: FragmentOutcome = cenc::decrypt_fragment(&mut moof, moof_start, mdat, payload_start, &self.info, key)?;
                    self.normalize(&mut moof, mux, &mut sequence)?;
                    single_trun_offset(&mut moof, span.header as u64);
                    moof.encode(&mut out);
                    let size = span.header as u64 + mdat.len() as u64;
                    if span.header == 16 {
                        out.extend_from_slice(&1u32.to_be_bytes());
                        out.extend_from_slice(b"mdat");
                        out.extend_from_slice(&size.to_be_bytes());
                    } else {
                        out.extend_from_slice(&(size as u32).to_be_bytes());
                        out.extend_from_slice(b"mdat");
                    }
                    out.extend_from_slice(mdat);
                }
                _ => {}
            }
        }
        if pending.is_some() || out.is_empty() {
            bail!("missing or incomplete media fragment");
        }
        Ok(out)
    }

    fn normalize(&mut self, moof: &mut Atom, mux: bool, sequence: &mut u32) -> Result<()> {
        for traf in moof.children_mut().iter_mut().filter(|c| &c.kind == b"traf") {
            let id = frag::traf_tfhd(traf)?.track_id;
            let tfdt = traf.child_mut(b"tfdt").ok_or_else(|| Error::new("fragment has no decode timestamp"))?;
            let stamp = frag::tfdt_time(tfdt)?;
            let origin = *self.origin.entry(id).or_insert(stamp);
            if stamp < origin {
                bail!("non-monotonic track origin");
            }
            // Keep box size stable: multi-trun fragments preserve their existing
            // relative data offsets, including interleaved caption samples.
            frag::set_tfdt_time(tfdt, stamp - origin)?;
        }
        if mux {
            let mfhd = moof.child_mut(b"mfhd").ok_or_else(|| Error::new("moof has no mfhd"))?;
            if mfhd.bytes().len() < 8 {
                bail!("truncated mfhd");
            }
            put32(mfhd.bytes_mut(), 4, *sequence);
            *sequence = sequence.wrapping_add(1);
            for traf in moof.children_mut().iter_mut().filter(|c| &c.kind == b"traf") {
                let tfhd = traf.child_mut(b"tfhd").ok_or_else(|| Error::new("traf has no tfhd"))?;
                let id = *self.ids.get(&Tfhd::parse(tfhd)?.track_id).ok_or_else(|| Error::new("unknown track"))?;
                Tfhd::set_track_id(tfhd, id)?;
            }
        }
        Ok(())
    }

    /// The decrypted init with tracks renumbered to their muxed IDs.
    fn muxed_init(&self) -> Result<Vec<Atom>> {
        let mut init = self.init.clone();
        let moov = moov_mut(&mut init)?;
        for trak in moov.children_mut().iter_mut().filter(|c| &c.kind == b"trak") {
            let id = tkhd_track_id(trak)?;
            let tkhd = trak.req_mut(&[b"tkhd"])?;
            let at = if tkhd.version() == 1 { 20 } else { 12 };
            put32(tkhd.bytes_mut(), at, self.ids.get(&id).copied().unwrap_or(0));
        }
        let mvex = moov.req_mut(&[b"mvex"])?;
        for trex in mvex.children_mut().iter_mut().filter(|c| &c.kind == b"trex") {
            let id = Trex::parse(trex)?.track_id;
            Trex::set_track_id(trex, self.ids.get(&id).copied().unwrap_or(0))?;
        }
        Ok(init)
    }
}

/// mp4ff's `Fragment.Encode` sets the data offset of a fragment's only trun to
/// the moof size plus the mdat header; with several truns it keeps them.
fn single_trun_offset(moof: &mut Atom, mdat_header: u64) {
    let count = moof.all(b"traf").map(|t| t.all(b"trun").count()).sum::<usize>();
    if count != 1 {
        return;
    }
    let offset = (moof.size() + mdat_header) as i32;
    for traf in moof.children_mut().iter_mut().filter(|c| &c.kind == b"traf") {
        for trun in traf.children_mut().iter_mut().filter(|c| &c.kind == b"trun") {
            Trun::set_data_offset(trun, offset);
        }
    }
}

fn set_duration(atom: &mut Atom, v0_at: usize, v1_at: usize, value: u64) {
    let v1 = atom.version() == 1;
    let b = atom.bytes_mut();
    if v1 {
        put64(b, v1_at, value);
    } else {
        put32(b, v0_at, value as u32);
    }
}

fn timescale(atom: &Atom) -> u32 {
    be32(atom.bytes(), if atom.version() == 1 { 20 } else { 12 })
}

/// Merges the video and audio initialization segments into one muxed init of
/// the given duration in seconds.
pub fn mux_init(video: &Stream, audio: &Stream, duration: f64) -> Result<Vec<u8>> {
    let mut merged = video.muxed_init()?;
    let other = audio.muxed_init()?;
    let other_moov = other.iter().find(|a| &a.kind == b"moov").ok_or_else(|| Error::new("missing fragmented MP4 init"))?;
    let moov = moov_mut(&mut merged)?;
    let traks: Vec<Atom> = other_moov.all(b"trak").cloned().collect();
    let trexs: Vec<Atom> = other_moov.req(&[b"mvex"])?.all(b"trex").cloned().collect();
    for trak in traks {
        // Like mp4ff's MoovBox.AddChild: a trak goes right after the last trak,
        // keeping traks together before mvex, udta and the like.
        let children = moov.children_mut();
        match children.iter().rposition(|c| &c.kind == b"trak") {
            Some(last) if last != 0 && last != children.len() - 1 => children.insert(last + 1, trak),
            _ => children.push(trak),
        }
    }
    moov.req_mut(&[b"mvex"])?.children_mut().extend(trexs);

    let mvhd = moov.req(&[b"mvhd"])?;
    let movie = (duration * timescale(mvhd) as f64) as u64;
    let mut next = 1u32;
    for trak in moov.children_mut().iter_mut().filter(|c| &c.kind == b"trak") {
        let id = tkhd_track_id(trak)?;
        set_duration(trak.req_mut(&[b"tkhd"])?, 20, 28, movie);
        let mdhd = trak.req_mut(&[b"mdia", b"mdhd"])?;
        let media = (duration * timescale(mdhd) as f64) as u64;
        set_duration(mdhd, 16, 24, media);
        if id >= next {
            next = id + 1;
        }
    }
    let mvhd = moov.req_mut(&[b"mvhd"])?;
    set_duration(mvhd, 16, 24, movie);
    let at = if mvhd.version() == 1 { 108 } else { 96 };
    put32(mvhd.bytes_mut(), at, next);
    Ok(encode_all(&merged))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::Aes;
    use crate::testutil::{be, fragment, full, init, leaf, sample_data, Run, TrackSpec};

    const KEY: [u8; 16] = [7; 16];
    const CONSTANT_IV: [u8; 16] = [9; 16];

    fn encrypted_entry(scheme: &[u8; 4]) -> Vec<u8> {
        let tenc = if scheme == b"cenc" {
            // version 0, protected, 8-byte per-sample IVs
            full(b"tenc", 0, 0, &[vec![0, 0, 1, 8], vec![1; 16]].concat())
        } else {
            // version 1, pattern 1:9, constant IV
            full(b"tenc", 1, 0, &[vec![0, 0x19, 1, 0], vec![1; 16], vec![16], CONSTANT_IV.to_vec()].concat())
        };
        let sinf = leaf(b"sinf", &[leaf(b"frma", b"mp4a"), full(b"schm", 0, 0, &[scheme.to_vec(), be(&[0x10000])].concat()), leaf(b"schi", &tenc)].concat());
        leaf(b"enca", &[vec![0u8; 28], leaf(b"esds", &[0; 8]), sinf].concat())
    }

    fn iv(i: usize) -> [u8; 8] {
        [i as u8 + 1; 8]
    }

    /// Encrypts sample `i` like a packager: two clear bytes, the rest protected.
    fn encrypt(scheme: &[u8; 4], i: usize, clear: &[u8]) -> Vec<u8> {
        let aes = Aes::new(&KEY);
        let mut s = clear.to_vec();
        if scheme == b"cenc" {
            let mut counter = [0u8; 16];
            counter[..8].copy_from_slice(&iv(i));
            for (n, chunk) in (u128::from_be_bytes(counter)..).zip(s[2..].chunks_mut(16)) {
                let mut block = n.to_be_bytes();
                aes.encrypt(&mut block);
                chunk.iter_mut().zip(block).for_each(|(b, k)| *b ^= k);
            }
        } else {
            // 1 encrypted block out of every 10, one CBC chain per subsample.
            let mut prev = CONSTANT_IV;
            for block in s[2..].as_chunks_mut::<16>().0.iter_mut().step_by(10) {
                block.iter_mut().zip(prev).for_each(|(x, p)| *x ^= p);
                aes.encrypt(block);
                prev = *block;
            }
        }
        s
    }

    fn senc(scheme: &[u8; 4], samples: &[Vec<u8>]) -> Vec<u8> {
        let mut body = be(&[samples.len() as u32]);
        for (i, s) in samples.iter().enumerate() {
            if scheme == b"cenc" {
                body.extend(iv(i));
            }
            body.extend([0, 1, 0, 2]);
            body.extend(be(&[s.len() as u32 - 2]));
        }
        [full(b"saiz", 0, 0, &[0, 0, 0, 0, 0, 0, 0, 0, 0]), full(b"saio", 0, 0, &be(&[1, 0])), full(b"senc", 0, 2, &body)].concat()
    }

    fn roundtrip(scheme: &[u8; 4]) {
        let (mut stream, clear_init) = Stream::open(&init(&[TrackSpec { id: 3, timescale: 44100, entry: encrypted_entry(scheme) }]), 100).unwrap();
        let atoms = bmff::parse(&clear_init).unwrap();
        let stsd = atoms[1].path(&[b"trak", b"mdia", b"minf", b"stbl", b"stsd"]).unwrap();
        assert_eq!(stsd.children()[0].kind, *b"mp4a");
        assert!(stsd.children()[0].child(b"sinf").is_none());

        for (seq, start) in [(1u32, 5000u64), (2, 5000 + 4 * 1024)] {
            let clear: Vec<Vec<u8>> = (0..4).map(|i| sample_data(3, i * 40 + seq as usize)).collect();
            let enc: Vec<Vec<u8>> = clear.iter().enumerate().map(|(i, s)| encrypt(scheme, i, s)).collect();
            assert_ne!(enc, clear);
            let samples = enc.iter().map(|s| (1024, 0, s.clone())).collect();
            let mut raw = fragment(seq, &[Run { track: 3, start_time: start, samples }], &|_| senc(scheme, &enc));
            let out = stream.fragment(&mut raw, &KEY, true, 40 + seq).unwrap();

            let atoms = bmff::parse(&out).unwrap();
            let (moof, mdat) = (&atoms[0], &atoms[1]);
            assert_eq!(mdat.bytes(), clear.concat(), "{} samples", String::from_utf8_lossy(scheme));
            let traf = moof.child(b"traf").unwrap();
            assert!(["senc", "saiz", "saio"].iter().all(|k| traf.child(k.as_bytes().try_into().unwrap()).is_none()));
            // The only trun points right after the moof and mdat header.
            assert_eq!(Trun::data_offset(traf.child(b"trun").unwrap()), Some(moof.size() as i32 + 8));
            assert_eq!(frag::tfdt_time(traf.child(b"tfdt").unwrap()).unwrap(), start - 5000);
            assert_eq!(frag::traf_tfhd(traf).unwrap().track_id, 100);
            assert_eq!(be32(moof.child(b"mfhd").unwrap().bytes(), 4), 40 + seq);
        }
    }

    #[test]
    fn decrypts_cenc_with_per_sample_ivs() {
        roundtrip(b"cenc");
    }

    #[test]
    fn decrypts_cbcs_with_pattern_and_constant_iv() {
        roundtrip(b"cbcs");
    }

    #[test]
    fn clear_segments_pass_through_and_origins_must_be_monotonic() {
        let (mut stream, _) = Stream::open(&init(&[TrackSpec { id: 1, timescale: 1000, entry: crate::testutil::entry(b"mp4a") }]), 1).unwrap();
        let seg = |t| fragment(1, &[Run { track: 1, start_time: t, samples: vec![(10, 0, vec![1, 2, 3])] }], &|_| Vec::new());
        let styp = leaf(b"styp", b"msdh\0\0\0\0");
        let out = stream.fragment(&mut [styp, seg(50)].concat(), &[0; 16], false, 0).unwrap();
        assert_eq!(out, seg(0), "styp dropped, time rebased, bytes otherwise unchanged");
        assert!(stream.fragment(&mut seg(10), &[0; 16], false, 0).unwrap_err().to_string().contains("non-monotonic"));
        assert!(stream.fragment(&mut leaf(b"mdat", &[1]), &[0; 16], false, 0).is_err());
    }
}
