//! Repairs malformed QuickTime closed-caption (c608) samples in place, without
//! changing any sample size or data offset.
//!
//! Apple MV streams start their caption track with an all-zero 12-byte sample.
//! A c608 sample must be a sequence of cdat/cdt2 atoms; recent FFmpeg rejects
//! the zero sample and retries it forever, so mpv stops playback after ten
//! read errors. Such samples are rewritten as a cdat atom of CEA-608 null pairs.

use std::collections::HashMap;

use crate::bmff::{be32, Atom};
use crate::cenc::tkhd_track_id;
use crate::frag::{traf_tfhd, Trex, Trun, TRUN_DATA_OFFSET, TRUN_SIZE};
use crate::{bail, Result};

/// CEA-608 padding byte (0x00 with odd parity).
const NULL_PAIR: u8 = 0x80;

/// FFmpeg's c608 sample rules (libavformat/mov.c get_eia608_packet): samples of
/// at most 8 bytes are passed through, larger ones need at least 10 bytes and
/// consist of atoms carrying whole byte pairs. A tail shorter than 10 bytes is ignored.
fn valid(mut b: &[u8]) -> bool {
    if b.len() <= 8 {
        return true;
    }
    if b.len() < 10 {
        return false;
    }
    while b.len() >= 10 {
        let size = be32(b, 0) as usize;
        if size < 10 || size > b.len() || !size.is_multiple_of(2) {
            return false;
        }
        b = &b[size..];
    }
    true
}

/// Rewrites `b` as one cdat atom of null pairs, followed by at most one zero
/// byte when the size is odd. False when `b` cannot hold an atom with one pair.
fn repair(b: &mut [u8]) -> bool {
    if b.len() < 10 {
        return false;
    }
    let size = b.len() & !1;
    b[..4].copy_from_slice(&(size as u32).to_be_bytes());
    b[4..8].copy_from_slice(b"cdat");
    b[8..size].fill(NULL_PAIR);
    b[size..].fill(0);
    true
}

/// Caption track IDs of an init moov mapped to their trex.
pub fn tracks(moov: &Atom) -> Result<HashMap<u32, Option<Trex>>> {
    let mut out = HashMap::new();
    for trak in moov.all(b"trak") {
        let Some(stsd) = trak.path(&[b"mdia", b"minf", b"stbl", b"stsd"]) else { continue };
        if !stsd.children().iter().any(|e| &e.kind == b"c608") {
            continue;
        }
        let id = tkhd_track_id(trak)?;
        let mut trex = None;
        if let Some(mvex) = moov.child(b"mvex") {
            for t in mvex.all(b"trex") {
                let t = Trex::parse(t)?;
                if t.track_id == id {
                    trex = Some(t);
                }
            }
        }
        out.insert(id, trex);
    }
    Ok(out)
}

/// Fixes malformed samples of the caption tracks in `mdat`, whose payload
/// starts at `mdat_payload_start` in the coordinates of `moof_start`.
/// Returns the number of samples rewritten.
pub fn repair_fragment(
    moof: &Atom,
    moof_start: u64,
    mdat: &mut [u8],
    mdat_payload_start: u64,
    tracks: &HashMap<u32, Option<Trex>>,
) -> Result<usize> {
    if tracks.is_empty() {
        return Ok(0);
    }
    let mut repaired = 0;
    for traf in moof.all(b"traf") {
        let tfhd = traf_tfhd(traf)?;
        let Some(trex) = tracks.get(&tfhd.track_id) else { continue };
        let base = tfhd.base_data_offset.unwrap_or(moof_start);
        let size = tfhd.size.or(trex.map(|t| t.size)).unwrap_or(0);
        // Without a trun data-offset, samples continue after the previous trun.
        let mut offset = base;
        for trun in traf.all(b"trun") {
            let trun = Trun::parse(trun)?;
            if trun.has(TRUN_DATA_OFFSET) {
                offset = (base as i64 + trun.data_offset as i64) as u64;
            }
            for s in &trun.samples {
                let n = if trun.has(TRUN_SIZE) { s.size } else { size } as u64;
                if offset < mdat_payload_start || offset + n > mdat_payload_start + mdat.len() as u64 {
                    bail!("caption track {} sample outside mdat", tfhd.track_id);
                }
                let at = (offset - mdat_payload_start) as usize;
                let b = &mut mdat[at..at + n as usize];
                if !valid(b) && repair(b) {
                    repaired += 1;
                }
                offset += n;
            }
        }
    }
    Ok(repaired)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repairs_only_invalid_samples() {
        let mut zero = [0u8; 12];
        assert!(!valid(&zero));
        assert!(repair(&mut zero));
        assert_eq!(&zero[..8], &[0, 0, 0, 12, b'c', b'd', b'a', b't']);
        assert!(zero[8..].iter().all(|&b| b == NULL_PAIR));
        assert!(valid(&zero));

        let mut odd = [0u8; 13];
        assert!(repair(&mut odd));
        assert_eq!(odd[3], 12);
        assert_eq!(odd[12], 0);

        assert!(valid(&[0u8; 8]));
        let mut short = [0u8; 9];
        assert!(!valid(&short) && !repair(&mut short));
    }

    fn cdat(pairs: &[u8]) -> Vec<u8> {
        [vec![0, 0, 0, 8 + pairs.len() as u8], b"cdat".to_vec(), pairs.to_vec()].concat()
    }

    #[test]
    fn validates_like_ffmpeg() {
        for (b, want) in [
            (vec![0; 8], true),
            (vec![0; 9], false),
            (vec![0; 12], false),
            (cdat(&[1, 2]), true),
            (cdat(&[1, 2, 3]), false),
            ([cdat(&[1, 2]), cdat(&[3, 4])].concat(), true),
            ([cdat(&[1, 2]), vec![0, 0, 0]].concat(), true),
        ] {
            assert_eq!(valid(&b), want, "{b:x?}");
        }
    }

    /// A fragment like an Apple MV segment: video and caption trafs in one moof,
    /// samples interleaved so every trun has its own offset, placed at `prefix`.
    fn repaired(prefix: usize, tracks: &HashMap<u32, Option<Trex>>, captions: &[Vec<u8>]) -> (usize, Vec<u8>) {
        use crate::testutil::{fragment, Run};
        let runs: Vec<Run> = captions
            .iter()
            .enumerate()
            .flat_map(|(i, c)| {
                [
                    Run { track: 1, start_time: i as u64, samples: vec![(1, 0, b"video".to_vec())] },
                    Run { track: 2, start_time: i as u64, samples: vec![(1, 0, c.clone())] },
                ]
            })
            .collect();
        let frag = fragment(1, &runs, &|_| Vec::new());
        let spans = crate::bmff::spans(&frag, 0, frag.len()).unwrap();
        let moof = Atom::from_span(&frag, &spans[0]).unwrap();
        let mut mdat = frag[spans[1].payload()].to_vec();
        let start = (prefix + spans[1].payload().start) as u64;
        let n = repair_fragment(&moof, prefix as u64, &mut mdat, start, tracks).unwrap();
        (n, mdat)
    }

    #[test]
    fn repairs_caption_samples_of_a_fragment() {
        let good = cdat(&[0x94, 0x20, 0xc1, 0xc2]);
        let captions = [vec![0; 12], good.clone(), vec![0; 13], vec![1, 2, 3, 4, 5, 6, 7, 8]];
        let (n, mdat) = repaired(100, &HashMap::from([(2, None)]), &captions);
        assert_eq!(n, 2);
        let null = cdat(&[0x80; 4]);
        let want = [&b"video"[..], &null, b"video", &good, b"video", &[null.clone(), vec![0]].concat(), b"video", &[1, 2, 3, 4, 5, 6, 7, 8]].concat();
        assert_eq!(mdat, want);

        let (n, mdat) = repaired(0, &HashMap::from([(3, None)]), &[vec![0; 12]]);
        assert_eq!((n, mdat), (0, [b"video".to_vec(), vec![0; 12]].concat()), "other tracks are left alone");
    }
}
