use super::*;

/// Configuration is tied to the init segment's track ID, never inferred from
/// decrypted bytes (AAC/EC-3 may coincidentally resemble an ALAC header).
#[derive(Clone, Debug)]
pub struct AlacTrack {
    track_id: u32,
    default_description: u32,
    configs: Vec<Option<am_alac::Config>>,
}

/// Read a single-track ALAC init, before or after encryption-box sanitizing.
/// Each sample description is checked separately, including FairPlay key changes.
pub fn alac_track(init: &[u8]) -> Option<AlacTrack> {
    let moov = find(init, 0..init.len(), b"moov")?;
    let tracks: Vec<_> = children(init, moov.body..moov.end)
        .into_iter()
        .filter(|b| &b.typ == b"trak")
        .collect();
    if tracks.len() != 1 {
        return None;
    }
    let trak = tracks[0];
    let tkhd = find(init, trak.body..trak.end, b"tkhd")?;
    let offset = match init.get(tkhd.body)? {
        0 => 12,
        1 => 20,
        _ => return None,
    };
    if tkhd.body + offset + 4 > tkhd.end {
        return None;
    }
    let track_id = be_u32(init, tkhd.body + offset);
    let mdia = find(init, trak.body..trak.end, b"mdia")?;
    let minf = find(init, mdia.body..mdia.end, b"minf")?;
    let stbl = find(init, minf.body..minf.end, b"stbl")?;
    let stsd = find(init, stbl.body..stbl.end, b"stsd")?;
    if stsd.body + 8 > stsd.end {
        return None;
    }
    let entries = children(init, stsd.body + 8..stsd.end);
    if entries.len() != be_u32(init, stsd.body + 4) as usize {
        return None;
    }
    let configs: Vec<_> = entries
        .iter()
        .map(|entry| entry_config(init, entry))
        .collect();
    if !configs.iter().any(Option::is_some) {
        return None;
    }
    let mut default_description = if configs.len() == 1 { 1 } else { 0 };
    if let Some(mvex) = find(init, moov.body..moov.end, b"mvex") {
        for trex in children(init, mvex.body..mvex.end)
            .iter()
            .filter(|b| &b.typ == b"trex")
        {
            if trex.body + 12 <= trex.end && be_u32(init, trex.body + 4) == track_id {
                default_description = be_u32(init, trex.body + 8);
            }
        }
    }
    Some(AlacTrack {
        track_id,
        default_description,
        configs,
    })
}

fn entry_config(init: &[u8], entry: &BoxHeader) -> Option<am_alac::Config> {
    if entry.body + 28 > entry.end || init[entry.body + 8..entry.body + 10] != [0, 0] {
        return None;
    }
    if &entry.typ != b"alac" {
        if &entry.typ != b"enca" {
            return None;
        }
        let sinf = find(init, entry.body + 28..entry.end, b"sinf")?;
        let frma = find(init, sinf.body..sinf.end, b"frma")?;
        if frma.body + 4 > frma.end || &init[frma.body..frma.body + 4] != b"alac" {
            return None;
        }
    }
    let cookie = find(init, entry.body + 28..entry.end, b"alac")?;
    if cookie.end - cookie.body != 28 {
        return None;
    }
    am_alac::Config::from_cookie(&init[cookie.body + 4..cookie.end])
}

/// Repair decrypted ALAC samples without changing any box or sample length.
pub fn repair_alac_fragment(frag: &mut [u8], track: &AlacTrack) -> Result<usize, String> {
    let top = children(frag, 0..frag.len());
    let mut samples = Vec::new();
    for moof in top.iter().filter(|b| &b.typ == b"moof") {
        for traf in children(frag, moof.body..moof.end)
            .iter()
            .filter(|b| &b.typ == b"traf")
        {
            let Some(tfhd) = find(frag, traf.body..traf.end, b"tfhd") else {
                continue;
            };
            let mut r = Reader::full_box(frag, &tfhd)?;
            if r.u32()? != track.track_id {
                continue;
            }
            if r.flags & 1 != 0 {
                return Err("tfhd base-data-offset is not supported".into());
            }
            let description = if r.flags & 2 != 0 {
                r.u32()?
            } else {
                track.default_description
            };
            let Some(Some(config)) = description
                .checked_sub(1)
                .and_then(|i| track.configs.get(i as usize))
            else {
                continue;
            };
            let mut ranges = Vec::new();
            parse_traf(frag, moof, traf, &mut ranges, &mut Vec::new())?;
            samples.extend(ranges.into_iter().map(|range| (range, *config)));
        }
    }
    let mut previous = 0;
    for (sample, _) in &samples {
        if sample.start < previous
            || !top
                .iter()
                .any(|b| &b.typ == b"mdat" && sample.start >= b.body && sample.end <= b.end)
        {
            return Err("ALAC sample outside mdat or overlapping another sample".into());
        }
        previous = sample.end;
    }
    Ok(samples
        .into_iter()
        .filter(|(sample, config)| config.repair_in_place(&mut frag[sample.clone()]))
        .count())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{full, mk_box};

    fn init(codec: &[u8; 4]) -> Vec<u8> {
        init_descriptions(&[codec], 1)
    }

    fn init_descriptions(codecs: &[&[u8; 4]], default: u32) -> Vec<u8> {
        let mut tkhd = vec![0; 24];
        tkhd[15] = 7;
        let cookie = [
            0, 0, 0, 1, 0, 16, 40, 10, 14, 2, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xac, 0x44,
        ];
        let mut descriptions = full(0, &(codecs.len() as u32).to_be_bytes());
        for &codec in codecs {
            let mut entry = vec![0; 28];
            entry.extend(mk_box(b"sinf", &mk_box(b"frma", codec)));
            entry.extend(mk_box(b"alac", &full(0, &cookie)));
            descriptions.extend(mk_box(b"enca", &entry));
        }
        let stsd = mk_box(b"stsd", &descriptions);
        let mdia = mk_box(b"mdia", &mk_box(b"minf", &mk_box(b"stbl", &stsd)));
        let trex = mk_box(
            b"trex",
            &full(
                0,
                &[
                    7u32.to_be_bytes(),
                    default.to_be_bytes(),
                    [0; 4],
                    [0; 4],
                    [0; 4],
                ]
                .concat(),
            ),
        );
        mk_box(
            b"moov",
            &[
                mk_box(b"trak", &[mk_box(b"tkhd", &tkhd), mdia].concat()),
                mk_box(b"mvex", &trex),
            ]
            .concat(),
        )
    }

    fn fragment(track_id: u32) -> Vec<u8> {
        fragment_description(track_id, None)
    }

    fn fragment_description(track_id: u32, description: Option<u32>) -> Vec<u8> {
        let mut fields = track_id.to_be_bytes().to_vec();
        if let Some(index) = description {
            fields.extend(index.to_be_bytes());
        }
        fields.extend(8u32.to_be_bytes());
        let tfhd = mk_box(
            b"tfhd",
            &full(
                0x020010 | if description.is_some() { 2 } else { 0 },
                &fields,
            ),
        );
        let trun = |offset: u32| {
            mk_box(
                b"trun",
                &full(1, &[1u32.to_be_bytes(), offset.to_be_bytes()].concat()),
            )
        };
        let moof_len = 16 + tfhd.len() + trun(0).len();
        [
            mk_box(
                b"moof",
                &mk_box(b"traf", &[tfhd, trun((moof_len + 8) as u32)].concat()),
            ),
            mk_box(b"mdat", &[0x20, 0, 2, 0x12, 0x34, 0x56, 0x78, 0]),
        ]
        .concat()
    }

    #[test]
    fn selects_description_from_tfhd_or_trex() {
        for default in [1, 2] {
            let config = alac_track(&init_descriptions(&[b"mp4a", b"alac"], default)).unwrap();
            for index in [None, Some(0), Some(1), Some(2), Some(3)] {
                let mut frag = fragment_description(7, index);
                let before = frag.clone();
                let expected = usize::from(index.unwrap_or(default) == 2);
                assert_eq!(repair_alac_fragment(&mut frag, &config).unwrap(), expected);
                if expected == 0 {
                    assert_eq!(frag, before);
                }
            }
        }
        let config = alac_track(&init_descriptions(&[b"alac", b"alac"], 1)).unwrap();
        for index in [1, 2] {
            assert_eq!(
                repair_alac_fragment(&mut fragment_description(7, Some(index)), &config).unwrap(),
                1
            );
        }
    }

    #[test]
    fn identifies_codec_from_init_and_repairs_only_matching_track() {
        let encrypted_init = init(b"alac");
        let clear_init = patch_init_segment(&encrypted_init);
        for bytes in [&encrypted_init, &clear_init] {
            let config = alac_track(bytes).unwrap();
            let mut frag = fragment(7);
            let original = frag.clone();
            assert_eq!(repair_alac_fragment(&mut frag, &config).unwrap(), 1);
            assert_eq!(frag.len(), original.len());
            assert_eq!(&frag[..frag.len() - 2], &original[..original.len() - 2]);
            assert_eq!(&frag[frag.len() - 2..], &[0x79, 0xc0]);
            assert_eq!(repair_alac_fragment(&mut frag, &config).unwrap(), 0);
            let mut other = fragment(8);
            let original = other.clone();
            assert_eq!(repair_alac_fragment(&mut other, &config).unwrap(), 0);
            assert_eq!(other, original);
        }
        for codec in [b"ec-3", b"mp4a"] {
            let bytes = init(codec);
            assert!(alac_track(&bytes).is_none());
            assert!(alac_track(&patch_init_segment(&bytes)).is_none());
        }
        for end in 0..encrypted_init.len() {
            assert!(alac_track(&encrypted_init[..end]).is_none());
        }
    }

    #[test]
    fn rejects_samples_outside_mdat_before_modifying_anything() {
        let config = alac_track(&init(b"alac")).unwrap();
        let mut frag = fragment(7);
        let moof = find(&frag, 0..frag.len(), b"moof").unwrap();
        let traf = find(&frag, moof.body..moof.end, b"traf").unwrap();
        let trun = find(&frag, traf.body..traf.end, b"trun").unwrap();
        frag[trun.body + 8..trun.body + 12].copy_from_slice(&0u32.to_be_bytes());
        let before = frag.clone();
        assert!(repair_alac_fragment(&mut frag, &config).is_err());
        assert_eq!(frag, before);
    }
}
