//! Converts a fragmented MP4 into a progressive MP4 (ftyp, moov, mdat).
//!
//! Adapted from internal/media/defrag/defrag.go in
//! <https://github.com/itouakirai/apple-music-downloader> (via the Go port that
//! preceded this crate). Metadata is decoded into memory; sample data is copied
//! from the input without decoding.
//!
//! - [`Options::song`] reproduces the reference `DefragmentMP4`: the
//!   tag-compatible ftyp, one chunk per source trun, tracks one after another.
//! - [`Options::mv`] uses the given ftyp and cuts chunks to at most one second,
//!   written in decode-time order so tracks are interleaved.

use std::collections::HashMap;

use crate::bmff::{self, be32, put32, put64, version_flags, Atom, FourCC};
use crate::cenc::tkhd_track_id;
use crate::frag::{sgpd_grouping_type, traf_tfhd, Sample, Sbgp, Tfhd, Trex, Trun, TRUN_DATA_OFFSET};
use crate::readahead::{Reader, Sink, Source};
use crate::{bail, Error, Result};

/// Chunk duration bound in seconds when interleaving.
pub const MAX_CHUNK_DURATION: u64 = 1;
const MDAT_HEADER: u64 = 8;
/// Keeps every output mdat within int32, the widest box size go-mp4tag parses.
const MAX_MDAT_PAYLOAD: u64 = (1 << 31) - 1 - MDAT_HEADER;
/// Largest chunk offset written with 32-bit stco. The headroom leaves room for
/// tag writers to insert tags and cover art before mdat.
const STCO_OFFSET_LIMIT: u64 = u32::MAX as u64 - (64 << 20);

pub struct Options {
    pub major_brand: FourCC,
    pub minor_version: u32,
    pub compatible_brands: Vec<FourCC>,
    pub interleave: bool,
}

impl Options {
    /// The reference song path (`DefragmentMP4`).
    pub fn song() -> Options {
        Options { major_brand: *b"M4A ", minor_version: 1, compatible_brands: vec![*b"M4A ", *b"mp42", *b"isom", *b"iso5"], interleave: false }
    }

    /// MV downloads: same brands as the reference mv.Mux output, interleaved chunks.
    pub fn mv() -> Options {
        Options { major_brand: *b"isom", minor_version: 0x200, compatible_brands: vec![*b"isom", *b"iso4"], interleave: true }
    }

    fn ftyp(&self) -> Atom {
        let mut b = self.major_brand.to_vec();
        b.extend_from_slice(&self.minor_version.to_be_bytes());
        self.compatible_brands.iter().for_each(|x| b.extend_from_slice(x));
        Atom::data(b"ftyp", b)
    }
}

struct Mdat {
    start: u64,
    header: u64,
    size: u64,
}

impl Mdat {
    fn payload_start(&self) -> u64 {
        self.start + self.header
    }
}

#[derive(Clone, Copy)]
struct Chunk {
    mdat: usize,
    offset: u64,
    size: u64,
    samples: u32,
    description: u32,
    /// Decode time of the first sample in the track's timescale.
    time: u64,
}

struct GroupRun {
    grouping_type: FourCC,
    version: u8,
    flags: u32,
    parameter: u32,
    count: u32,
    index: u32,
}

struct Track {
    id: u32,
    samples: Vec<Sample>,
    chunks: Vec<Chunk>,
    groups: Vec<GroupRun>,
    duration: u64,
    timescale: u32,
}

struct Fragment {
    moof: Atom,
    start: u64,
    mdat: usize,
}

struct Parsed {
    ftyp: bool,
    moov: Option<Atom>,
    fragments: Vec<Fragment>,
    mdats: Vec<Mdat>,
}

fn parse_file<S: Source>(r: &mut Reader<S>) -> Result<Parsed> {
    let size = r.size();
    let mut p = Parsed { ftyp: false, moov: None, fragments: Vec::new(), mdats: Vec::new() };
    let mut pending: Option<(Atom, u64)> = None;
    let mut pos = 0u64;
    while pos < size {
        let head = r.read_vec(pos, (size - pos).min(16))?;
        if head.len() < 8 {
            bail!("truncated box header");
        }
        let kind: FourCC = head[4..8].try_into().unwrap();
        let (mut box_size, mut header) = (be32(&head, 0) as u64, 8usize);
        if box_size == 1 {
            if head.len() < 16 {
                bail!("truncated large box header");
            }
            box_size = bmff::be64(&head, 8);
            header = 16;
        } else if box_size == 0 {
            box_size = size - pos;
        }
        if box_size < header as u64 || box_size > size - pos {
            bail!("invalid {} box size {box_size}", bmff::fourcc(&kind));
        }
        match &kind {
            b"ftyp" | b"moov" | b"moof" => {
                let bytes = r.read_vec(pos, box_size)?;
                let span = bmff::Span { kind, start: 0, header, end: bytes.len() };
                let atom = Atom::from_span(&bytes, &span)?;
                match &kind {
                    b"ftyp" => p.ftyp = true,
                    b"moov" => p.moov = Some(atom),
                    _ => {
                        if pending.is_some() {
                            bail!("fragment has no mdat");
                        }
                        pending = Some((atom, pos));
                    }
                }
            }
            b"mdat" => {
                p.mdats.push(Mdat { start: pos, header: header as u64, size: box_size });
                if let Some((moof, start)) = pending.take() {
                    p.fragments.push(Fragment { moof, start, mdat: p.mdats.len() - 1 });
                }
            }
            _ => {}
        }
        pos += box_size;
    }
    if pending.is_some() {
        bail!("fragment has no mdat");
    }
    Ok(p)
}

/// Converts the fragmented MP4 read from `input` into a progressive MP4 written to `output`.
pub fn defragment<S: Source, W: Sink>(input: S, output: &mut W, options: &Options) -> Result<()> {
    let mut r = Reader::new(input);
    let parsed = parse_file(&mut r).map_err(|e| e.context("decode fragmented MP4"))?;
    if parsed.fragments.is_empty() {
        bail!("input is not a fragmented MP4");
    }
    if !parsed.ftyp {
        bail!("input has no ftyp");
    }
    let mut moov = parsed.moov.ok_or_else(|| Error::new("fragmented MP4 has no initialization moov"))?;
    if moov.child(b"mvhd").is_none() {
        bail!("moov has no mvhd");
    }
    if moov.child(b"trak").is_none() {
        bail!("moov has no tracks");
    }
    if moov.child(b"mvex").is_none() {
        bail!("fragmented MP4 has no mvex");
    }

    let tracks = collect_tracks(&moov, &parsed.fragments, &parsed.mdats, options.interleave)
        .map_err(|e| e.context("collect fragmented samples"))?;
    validate_source_ranges(&tracks).map_err(|e| e.context("validate source ranges"))?;
    build_progressive_moov(&mut moov, &tracks).map_err(|e| e.context("build progressive moov"))?;
    moov.children_mut().retain(|c| &c.kind != b"mvex");
    let ftyp = options.ftyp();
    ensure_tag_metadata(&mut moov);

    let order = write_order(&tracks, options.interleave);
    let mdat_sizes = plan_mdats(&tracks, &order).map_err(|e| e.context("plan output mdat boxes"))?;
    install_chunk_offsets(ftyp.size(), &mut moov, &tracks, &order).map_err(|e| e.context("calculate output chunk offsets"))?;
    write_progressive(&mut r, output, &ftyp, &moov, &tracks, &parsed.mdats, &order, &mdat_sizes)
        .map_err(|e| e.context("write progressive MP4"))
}

fn trak_timescale(trak: &Atom) -> Result<u32> {
    let mdhd = trak.req(&[b"mdia", b"mdhd"])?;
    let b = mdhd.bytes();
    let at = if mdhd.version() == 1 { 20 } else { 12 };
    if b.len() < at + 4 {
        bail!("truncated mdhd");
    }
    Ok(be32(b, at))
}

fn collect_tracks(moov: &Atom, fragments: &[Fragment], mdats: &[Mdat], interleave: bool) -> Result<Vec<Track>> {
    let mut by_id: HashMap<u32, Track> = HashMap::new();
    let mut order = Vec::new();
    for trak in moov.all(b"trak") {
        let id = tkhd_track_id(trak).map_err(|_| Error::new("trak has no tkhd"))?;
        let stsd = trak
            .path(&[b"mdia", b"minf", b"stbl", b"stsd"])
            .filter(|_| trak.path(&[b"mdia", b"mdhd"]).is_some())
            .ok_or_else(|| Error::msg(format!("track {id} has incomplete media/sample table")))?;
        if stsd.children().is_empty() {
            bail!("track {id} has empty stsd");
        }
        // Encrypted tracks cannot be converted by merely changing moof/trun into
        // stbl tables: CENC/CBCS auxiliary information would need converting too.
        if stsd.children().iter().any(|e| &e.kind == b"encv" || &e.kind == b"enca") {
            bail!("track {id} is encrypted; encrypted fMP4 is not supported");
        }
        let timescale = trak_timescale(trak)?;
        if timescale == 0 {
            bail!("track {id} has zero media timescale");
        }
        by_id.insert(id, Track { id, samples: Vec::with_capacity(4096), chunks: Vec::new(), groups: Vec::new(), duration: 0, timescale });
        order.push(id);
    }
    let mut trexs: HashMap<u32, Trex> = HashMap::new();
    for trex in moov.req(&[b"mvex"])?.all(b"trex") {
        let trex = Trex::parse(trex)?;
        if !by_id.contains_key(&trex.track_id) {
            bail!("trex references unknown track {}", trex.track_id);
        }
        trexs.insert(trex.track_id, trex);
    }
    for id in &order {
        if !trexs.contains_key(id) {
            bail!("track {id} has no trex");
        }
    }
    for (i, frag) in fragments.iter().enumerate() {
        collect_fragment(frag, &mdats[frag.mdat], frag.mdat, &trexs, &mut by_id, interleave)
            .map_err(|e| e.context(&format!("segment 0 fragment {i}")))?;
    }
    order
        .into_iter()
        .map(|id| {
            let t = by_id.remove(&id).unwrap();
            if t.samples.is_empty() {
                bail!("track {id} contains no samples");
            }
            Ok(t)
        })
        .collect()
}

fn collect_fragment(
    frag: &Fragment,
    mdat: &Mdat,
    mdat_index: usize,
    trexs: &HashMap<u32, Trex>,
    tracks: &mut HashMap<u32, Track>,
    interleave: bool,
) -> Result<()> {
    for traf in frag.moof.all(b"traf") {
        let tfhd = traf_tfhd(traf)?;
        let id = tfhd.track_id;
        let td = tracks.get_mut(&id).ok_or_else(|| Error::msg(format!("traf references unknown track {id}")))?;
        let trex = trexs.get(&id);
        let description = tfhd.description.or(trex.map(|t| t.description)).unwrap_or(0);
        if description == 0 {
            bail!("track {id} has sample description index 0");
        }
        let fragment_start = td.samples.len();
        for (trun_index, trun) in traf.all(b"trun").enumerate() {
            let mut trun = Trun::parse(trun)?;
            trun.fill_defaults(&tfhd, trex);
            if trun.samples.is_empty() {
                continue;
            }
            let offset = trun_offset(frag.start, &tfhd, &trun).map_err(|e| e.context(&format!("track {id} trun {trun_index}")))?;
            let mut size = 0u64;
            for (i, s) in trun.samples.iter().enumerate() {
                if s.size == 0 {
                    bail!("track {id} trun {trun_index} sample {} has zero size", i + 1);
                }
                size += s.size as u64;
            }
            validate_mdat_range(mdat, offset, size).map_err(|e| e.context(&format!("track {id} trun {trun_index}")))?;
            // When interleaving, split the trun into chunks of at most
            // MAX_CHUNK_DURATION; otherwise the whole trun is one chunk. Every
            // chunk holds at least one sample.
            let limit = if interleave { td.timescale as u64 * MAX_CHUNK_DURATION } else { u64::MAX };
            let mut chunk = Chunk { mdat: mdat_index, offset, size: 0, samples: 0, description, time: td.duration };
            let last = trun.samples.len() - 1;
            for (i, s) in trun.samples.iter().enumerate() {
                chunk.size += s.size as u64;
                chunk.samples += 1;
                td.samples.push(*s);
                td.duration += s.duration as u64;
                if i == last || td.duration - chunk.time >= limit {
                    td.chunks.push(chunk);
                    chunk = Chunk { mdat: mdat_index, offset: chunk.offset + chunk.size, size: 0, samples: 0, description, time: td.duration };
                }
            }
        }
        // Like mp4ff's traf.Sbgp, only the last sbgp of a traf counts.
        if let Some(sbgp) = traf.all(b"sbgp").last() {
            collect_sample_groups(td, &Sbgp::parse(sbgp)?, traf.all(b"sgpd").last().is_some(), fragment_start)
                .map_err(|e| e.context(&format!("track {id}")))?;
        }
    }
    Ok(())
}

fn collect_sample_groups(td: &mut Track, sbgp: &Sbgp, has_sgpd: bool, fragment_start: usize) -> Result<()> {
    let kind = String::from_utf8_lossy(&sbgp.grouping_type).into_owned();
    // Apple HLS audio fragments may carry fragment-local roll sample group
    // descriptions. Roll groups only provide random-access hints, so they can
    // be omitted from the progressive output without changing sample data.
    if &sbgp.grouping_type == b"roll" || &sbgp.grouping_type == b"prol" {
        return Ok(());
    }
    if sbgp.version > 1 {
        bail!("sbgp grouping type {kind:?} has unsupported version {}", sbgp.version);
    }
    let mut covered = 0u64;
    for (i, (&count, &index)) in sbgp.counts.iter().zip(&sbgp.indices).enumerate() {
        if count == 0 {
            bail!("sbgp grouping type {kind:?} entry {} has zero sample count", i + 1);
        }
        if covered > u32::MAX as u64 - count as u64 {
            bail!("sbgp grouping type {kind:?} sample count overflows uint32");
        }
        covered += count as u64;
        if index >= 65536 {
            if has_sgpd {
                bail!("sbgp grouping type {kind:?} uses fragment-local sgpd entry {}, which is not supported", index - 65536);
            }
            bail!("sbgp grouping type {kind:?} has invalid group description index {index}");
        }
        td.groups.push(GroupRun {
            grouping_type: sbgp.grouping_type,
            version: sbgp.version,
            flags: sbgp.flags,
            parameter: sbgp.parameter,
            count,
            index,
        });
    }
    let fragment_samples = td.samples.len() - fragment_start;
    if covered != fragment_samples as u64 {
        bail!("sbgp grouping type {kind:?} covers {covered} samples, but the fragment has {fragment_samples}");
    }
    Ok(())
}

/// Absolute source offset of a trun: tfhd base-data-offset or the moof start,
/// plus the trun data offset.
fn trun_offset(moof_start: u64, tfhd: &Tfhd, trun: &Trun) -> Result<u64> {
    let mut base = moof_start as i64;
    if let Some(b) = tfhd.base_data_offset {
        if b > i64::MAX as u64 {
            bail!("base-data-offset exceeds int64 range");
        }
        base = b as i64;
    }
    if trun.has(TRUN_DATA_OFFSET) {
        base += trun.data_offset as i64;
    }
    if base < 0 {
        bail!("calculated negative media data offset {base}");
    }
    Ok(base as u64)
}

fn validate_mdat_range(mdat: &Mdat, offset: u64, size: u64) -> Result<()> {
    let start = mdat.payload_start();
    let payload = mdat.size - mdat.header;
    if offset < start {
        bail!("sample offset {offset} before mdat payload {start}");
    }
    let relative = offset - start;
    if relative > payload {
        bail!("sample offset {offset} is beyond mdat payload size {payload}");
    }
    if size > payload - relative {
        bail!("sample range [{offset},{}) exceeds mdat payload [{start},{})", offset + size, start + payload);
    }
    Ok(())
}

fn validate_source_ranges(tracks: &[Track]) -> Result<()> {
    let mut ranges: Vec<(usize, u64, u64, u32, usize)> = Vec::new();
    for t in tracks {
        for (i, c) in t.chunks.iter().enumerate() {
            ranges.push((c.mdat, c.offset, c.offset + c.size, t.id, i));
        }
    }
    ranges.sort_by_key(|r| (r.0, r.1, r.2));
    for w in ranges.windows(2) {
        let (p, c) = (w[0], w[1]);
        if p.0 == c.0 && c.1 < p.2 {
            bail!(
                "overlapping source ranges: track {} chunk {} [{},{}) and track {} chunk {} [{},{})",
                p.3,
                p.4,
                p.1,
                p.2,
                c.3,
                c.4,
                c.1,
                c.2
            );
        }
    }
    Ok(())
}

fn set_versioned(atom: &mut Atom, v0_at: usize, v1_at: usize, value: u64) {
    let v1 = atom.version() == 1;
    let b = atom.bytes_mut();
    if v1 {
        put64(b, v1_at, value);
    } else {
        put32(b, v0_at, value as u32);
    }
}

fn build_progressive_moov(moov: &mut Atom, tracks: &[Track]) -> Result<()> {
    let mvhd = moov.req(&[b"mvhd"])?;
    let movie_timescale = be32(mvhd.bytes(), if mvhd.version() == 1 { 20 } else { 12 }) as u64;
    let by_id: HashMap<u32, &Track> = tracks.iter().map(|t| (t.id, t)).collect();
    let mut max_duration = 0u64;
    for trak in moov.children_mut().iter_mut().filter(|c| &c.kind == b"trak") {
        let id = tkhd_track_id(trak)?;
        let td = *by_id.get(&id).ok_or_else(|| Error::msg(format!("track {id} is missing collected data")))?;
        let entries = trak.req(&[b"mdia", b"minf", b"stbl", b"stsd"])?.children().len() as u32;
        let descriptions = normalize_descriptions(td, entries)?;
        rebuild_sample_table(trak.req_mut(&[b"mdia", b"minf", b"stbl"])?, td, &descriptions)?;
        // mdhd duration is in the media timescale.
        set_versioned(trak.req_mut(&[b"mdia", b"mdhd"])?, 16, 24, td.duration);
        if movie_timescale == 0 {
            bail!("mvhd has zero timescale");
        }
        let duration = track_duration(trak, movie_timescale, td.duration).map_err(|e| e.context(&format!("track {id}")))?;
        // Version 0 keeps the low 32 bits, like mp4ff; the movie duration uses the full value.
        set_versioned(trak.req_mut(&[b"tkhd"])?, 20, 28, duration);
        max_duration = max_duration.max(duration);
    }
    set_versioned(moov.req_mut(&[b"mvhd"])?, 16, 24, max_duration);
    Ok(())
}

/// Movie-timescale duration of a progressive track. Fragmented initialization
/// segments commonly carry a single placeholder edit with segment_duration 0
/// while media_time is already known; it is completed from the media duration.
fn track_duration(trak: &mut Atom, movie_timescale: u64, media_duration: u64) -> Result<u64> {
    let media_timescale = trak_timescale(trak)? as u64;
    if media_timescale == 0 {
        bail!("mdhd has zero timescale");
    }
    let Some(edts) = trak.child_mut(b"edts") else {
        return scale_duration(media_duration, media_timescale, movie_timescale);
    };
    // (elst index, entry position, version) of zero-duration entries.
    let mut total = 0u64;
    let mut zeros = Vec::new();
    for (ei, elst) in edts.children().iter().enumerate().filter(|(_, c)| &c.kind == b"elst") {
        let b = elst.bytes();
        let v1 = elst.version() == 1;
        let (entry, dur) = if v1 { (20, 8) } else { (12, 4) };
        let n = if b.len() >= 8 { be32(b, 4) as usize } else { 0 };
        for i in 0..n {
            let at = 8 + i * entry;
            if b.len() < at + entry {
                bail!("truncated elst");
            }
            let d = if v1 { bmff::be64(b, at) } else { be32(b, at) as u64 };
            if d == 0 {
                let media_time = if v1 { bmff::be64(b, at + dur) as i64 } else { be32(b, at + dur) as i32 as i64 };
                let rate_int = crate::bmff::be16(b, at + 2 * dur) as i16;
                let rate_frac = crate::bmff::be16(b, at + 2 * dur + 2) as i16;
                zeros.push((ei, at, v1, media_time, rate_int, rate_frac));
                continue;
            }
            total = total.checked_add(d).ok_or_else(|| Error::new("edit list duration overflows uint64"))?;
        }
    }
    if total != 0 {
        return Ok(total);
    }
    if zeros.len() != 1 {
        bail!("edit list has {} zero-duration entries; cannot determine presentation duration", zeros.len());
    }
    let (ei, at, v1, media_time, rate_int, rate_frac) = zeros[0];
    if media_time < 0 || rate_int != 1 || rate_frac != 0 {
        bail!("zero-duration edit list placeholder is not a forward media edit");
    }
    let media_time = media_time as u64;
    if media_time > media_duration {
        bail!("edit list media time {media_time} exceeds media duration {media_duration}");
    }
    let segment = scale_duration(media_duration - media_time, media_timescale, movie_timescale)
        .map_err(|e| e.context("scale edit list duration"))?;
    if segment == 0 {
        bail!("edit list presentation duration rounds to zero");
    }
    let b = edts.children_mut()[ei].bytes_mut();
    if v1 {
        put64(b, at, segment);
    } else {
        put32(b, at, segment as u32);
    }
    Ok(segment)
}

/// Rescales a duration without overflowing the intermediate multiplication.
fn scale_duration(value: u64, from: u64, to: u64) -> Result<u64> {
    if from == 0 {
        bail!("source timescale is zero");
    }
    if to == 0 {
        bail!("destination timescale is zero");
    }
    if value == 0 || from == to {
        return Ok(value);
    }
    let (q, r) = (value / from, value % from);
    let mut result = q.checked_mul(to).ok_or_else(|| Error::new("duration scaling overflows uint64"))?;
    if r != 0 {
        result = result.checked_add(r * to / from).ok_or_else(|| Error::new("duration scaling overflows uint64"))?;
    }
    Ok(result)
}

/// Sample description index of every chunk. Some sources carry a stale index
/// although stsd has a single entry; strict demuxers such as VLC then recreate
/// the decoder and may stop, so the only existing entry is used.
fn normalize_descriptions(td: &Track, entries: u32) -> Result<Vec<u32>> {
    if entries == 0 {
        bail!("track {} has empty stsd", td.id);
    }
    td.chunks
        .iter()
        .enumerate()
        .map(|(i, c)| match c.description {
            0 => bail!("track {} chunk {i} has sample description index 0", td.id),
            d if d <= entries => Ok(d),
            _ if entries == 1 => Ok(1),
            d => bail!("track {} chunk {i} references sample description {d}, but stsd has {entries} entries", td.id),
        })
        .collect()
}

fn full(kind: &FourCC, version: u8, body: Vec<u8>) -> Atom {
    let mut b = version_flags(version, 0).to_vec();
    b.extend(body);
    Atom::data(kind, b)
}

fn rebuild_sample_table(stbl: &mut Atom, td: &Track, descriptions: &[u32]) -> Result<()> {
    // stsd keeps the codec configuration; sample group descriptions are kept
    // and their fragment assignments rebuilt. Other metadata would need a
    // semantic conversion and is refused.
    let mut stsd = None;
    let mut sgpds = Vec::new();
    for child in stbl.children_mut().drain(..) {
        match &child.kind {
            b"stsd" => stsd = Some(child),
            b"stts" | b"ctts" | b"stsc" | b"stsz" | b"stss" | b"stco" | b"co64" => {}
            b"sgpd" => sgpds.push(child),
            k => bail!("track {} has unsupported stbl child {:?}; refusing to silently change its semantics", td.id, bmff::fourcc(k)),
        }
    }
    let stsd = stsd.ok_or_else(|| Error::msg(format!("track {} has no stsd", td.id)))?;
    let mut children = vec![stsd];

    // stts
    let mut runs: Vec<(u32, u32)> = Vec::new();
    for s in &td.samples {
        match runs.last_mut() {
            Some((n, d)) if *d == s.duration => *n += 1,
            _ => runs.push((1, s.duration)),
        }
    }
    let mut b = (runs.len() as u32).to_be_bytes().to_vec();
    runs.iter().for_each(|(n, d)| {
        b.extend_from_slice(&n.to_be_bytes());
        b.extend_from_slice(&d.to_be_bytes());
    });
    children.push(full(b"stts", 0, b));

    // ctts (version 1, signed offsets) only when some offset is non-zero.
    if td.samples.iter().any(|s| s.cto != 0) {
        let mut runs: Vec<(u32, i32)> = Vec::new();
        for s in &td.samples {
            match runs.last_mut() {
                Some((n, o)) if *o == s.cto => *n += 1,
                _ => runs.push((1, s.cto)),
            }
        }
        let mut b = (runs.len() as u32).to_be_bytes().to_vec();
        runs.iter().for_each(|(n, o)| {
            b.extend_from_slice(&n.to_be_bytes());
            b.extend_from_slice(&o.to_be_bytes());
        });
        children.push(full(b"ctts", 1, b));
    }

    // stsc: consecutive chunks with the same mapping share an entry.
    let mut entries: Vec<[u32; 3]> = Vec::new();
    for (i, c) in td.chunks.iter().enumerate() {
        let d = descriptions[i];
        match entries.last() {
            Some(&[_, n, desc]) if n == c.samples && desc == d => {}
            _ => entries.push([i as u32 + 1, c.samples, d]),
        }
    }
    let mut b = (entries.len() as u32).to_be_bytes().to_vec();
    entries.iter().flatten().for_each(|v| b.extend_from_slice(&v.to_be_bytes()));
    children.push(full(b"stsc", 0, b));

    // stsz
    let uniform = td.samples[0].size;
    let mut b = Vec::new();
    if td.samples.iter().all(|s| s.size == uniform) {
        b.extend_from_slice(&uniform.to_be_bytes());
        b.extend_from_slice(&(td.samples.len() as u32).to_be_bytes());
    } else {
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&(td.samples.len() as u32).to_be_bytes());
        td.samples.iter().for_each(|s| b.extend_from_slice(&s.size.to_be_bytes()));
    }
    children.push(full(b"stsz", 0, b));

    // stss, omitted when every sample is sync. The normative marker is
    // sample_is_non_sync_sample (flags bit 16).
    let sync: Vec<u32> = td.samples.iter().enumerate().filter(|(_, s)| s.flags & 0x0001_0000 == 0).map(|(i, _)| i as u32 + 1).collect();
    if sync.len() != td.samples.len() {
        let mut b = (sync.len() as u32).to_be_bytes().to_vec();
        sync.iter().for_each(|v| b.extend_from_slice(&v.to_be_bytes()));
        children.push(full(b"stss", 0, b));
    }

    // stco placeholder; install_chunk_offsets fills it or switches to co64.
    children.push(full(b"stco", 0, 0u32.to_be_bytes().to_vec()));

    let sbgps = build_sbgps(&sgpds, td)?;
    children.extend(sgpds);
    children.extend(sbgps);
    *stbl.children_mut() = children;
    Ok(())
}

fn sgpd_entry_count(sgpd: &Atom) -> u32 {
    let b = sgpd.bytes();
    let at = match b.first() {
        Some(1) => 12,
        Some(v) if *v >= 2 => 12,
        _ => 8,
    };
    if b.len() >= at + 4 {
        be32(b, at)
    } else {
        0
    }
}

fn build_sbgps(sgpds: &[Atom], td: &Track) -> Result<Vec<Atom>> {
    let mut counts: HashMap<FourCC, u32> = HashMap::new();
    for sgpd in sgpds {
        let kind = sgpd_grouping_type(sgpd).unwrap_or(*b"    ");
        if counts.insert(kind, sgpd_entry_count(sgpd)).is_some() {
            bail!("track {} has multiple sgpd boxes for grouping type {:?}", td.id, bmff::fourcc(&kind));
        }
    }
    let mut sbgps: Vec<Sbgp> = Vec::new();
    for run in &td.groups {
        let kind = bmff::fourcc(&run.grouping_type);
        if run.count == 0 {
            bail!("track {} sample group {kind:?} has zero sample count", td.id);
        }
        if run.index != 0 {
            let n = *counts.get(&run.grouping_type).ok_or_else(|| Error::msg(format!("track {} sample group {kind:?} has no sgpd description box", td.id)))?;
            if run.index > n {
                bail!("track {} sample group {kind:?} references description {}, but sgpd has {n} entries", td.id, run.index);
            }
        }
        let at = match sbgps.iter().position(|s| s.grouping_type == run.grouping_type) {
            Some(at) => {
                let s = &sbgps[at];
                if s.version != run.version || s.flags != run.flags || s.parameter != run.parameter {
                    bail!("track {} sample group {kind:?} has inconsistent sbgp versions or flags", td.id);
                }
                at
            }
            None => {
                sbgps.push(Sbgp { version: run.version, flags: run.flags, grouping_type: run.grouping_type, parameter: run.parameter, ..Sbgp::default() });
                sbgps.len() - 1
            }
        };
        let s = &mut sbgps[at];
        if s.indices.last() == Some(&run.index) {
            let last = s.counts.last_mut().unwrap();
            *last = last.checked_add(run.count).ok_or_else(|| Error::msg(format!("track {} sample group {kind:?} sample count overflows uint32", td.id)))?;
            continue;
        }
        s.counts.push(run.count);
        s.indices.push(run.index);
    }
    Ok(sbgps.iter().map(Sbgp::encode).collect())
}

/// go-mp4tag only accepts ISO meta with hdlr and requires moov.udta.meta.ilst.
fn ensure_tag_metadata(moov: &mut Atom) {
    let hdlr = || {
        let mut b = version_flags(0, 0).to_vec();
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(b"mdir");
        b.extend_from_slice(&[0; 12]);
        b.extend_from_slice(b"mp4ff mdir handler\0");
        Atom::data(b"hdlr", b)
    };
    if !moov.children().iter().any(|c| &c.kind == b"udta" && c.is_tree()) {
        moov.children_mut().push(Atom::tree(b"udta", Vec::new(), Vec::new()));
    }
    let udta = moov.children_mut().iter_mut().find(|c| &c.kind == b"udta" && c.is_tree()).unwrap();
    let Some(meta) = udta.children_mut().iter_mut().find(|c| &c.kind == b"meta" && c.is_tree()) else {
        udta.children_mut().push(Atom::tree(b"meta", version_flags(0, 0).to_vec(), vec![hdlr(), Atom::data(b"ilst", Vec::new())]));
        return;
    };
    if meta.head().is_empty() {
        // QuickTime meta: give it the 4-byte version/flags of an ISO meta.
        *meta.bytes_mut() = version_flags(0, 0).to_vec();
    }
    if meta.child(b"hdlr").is_none() {
        meta.children_mut().push(hdlr());
    }
    if meta.child(b"ilst").is_none() {
        meta.children_mut().push(Atom::data(b"ilst", Vec::new()));
    }
}

#[derive(Clone, Copy)]
struct ChunkRef {
    track: usize,
    chunk: usize,
}

/// Output chunk order: by decode time in seconds, then track order, or, when
/// not interleaving, track after track. Each track's chunks keep their order.
fn write_order(tracks: &[Track], interleave: bool) -> Vec<ChunkRef> {
    let mut order: Vec<ChunkRef> =
        tracks.iter().enumerate().flat_map(|(t, tr)| (0..tr.chunks.len()).map(move |c| ChunkRef { track: t, chunk: c })).collect();
    if interleave {
        order.sort_by(|a, b| {
            let (ta, tb) = (&tracks[a.track], &tracks[b.track]);
            let x = ta.chunks[a.chunk].time as u128 * tb.timescale as u128;
            let y = tb.chunks[b.chunk].time as u128 * ta.timescale as u128;
            x.cmp(&y).then(a.track.cmp(&b.track))
        });
    }
    order
}

/// Groups chunks, in write order, into consecutive mdat boxes and returns each
/// box's payload size. A chunk never spans two boxes.
fn plan_mdats(tracks: &[Track], order: &[ChunkRef]) -> Result<Vec<u64>> {
    let mut sizes = Vec::new();
    let mut current = 0u64;
    for r in order {
        let size = tracks[r.track].chunks[r.chunk].size;
        if size > MAX_MDAT_PAYLOAD {
            bail!("track {} chunk {} size {size} exceeds the mdat size limit", tracks[r.track].id, r.chunk);
        }
        if current > 0 && current + size > MAX_MDAT_PAYLOAD {
            sizes.push(current);
            current = 0;
        }
        current += size;
    }
    if current == 0 {
        bail!("output contains no media data");
    }
    sizes.push(current);
    Ok(sizes)
}

fn stbl_of(moov: &mut Atom, id: u32) -> Result<&mut Atom> {
    for trak in moov.children_mut().iter_mut().filter(|c| &c.kind == b"trak") {
        if tkhd_track_id(trak)? == id {
            return trak.req_mut(&[b"mdia", b"minf", b"stbl"]);
        }
    }
    bail!("track {id}: stbl not found")
}

fn set_offsets(stbl: &mut Atom, offsets: &[u64], wide: bool) -> Result<()> {
    let at = stbl
        .children()
        .iter()
        .position(|c| &c.kind == b"stco" || &c.kind == b"co64")
        .ok_or_else(|| Error::new("track has no stco"))?;
    let mut b = (offsets.len() as u32).to_be_bytes().to_vec();
    for &o in offsets {
        if wide {
            b.extend_from_slice(&o.to_be_bytes());
        } else {
            b.extend_from_slice(&(o as u32).to_be_bytes());
        }
    }
    stbl.children_mut()[at] = full(if wide { b"co64" } else { b"stco" }, 0, b);
    Ok(())
}

/// Absolute output offset of every chunk per track, and the largest one, for
/// the layout ftyp, moov, mdat[, mdat...].
fn chunk_offsets(ftyp_size: u64, moov_size: u64, tracks: &[Track], order: &[ChunkRef]) -> (Vec<Vec<u64>>, u64) {
    let mut payload = ftyp_size + moov_size + MDAT_HEADER;
    let mut current = 0u64;
    let mut max = 0u64;
    let mut offsets: Vec<Vec<u64>> = tracks.iter().map(|t| vec![0; t.chunks.len()]).collect();
    for r in order {
        let size = tracks[r.track].chunks[r.chunk].size;
        if current > 0 && current + size > MAX_MDAT_PAYLOAD {
            payload += MDAT_HEADER;
            current = 0;
        }
        current += size;
        offsets[r.track][r.chunk] = payload;
        max = max.max(payload);
        payload += size;
    }
    (offsets, max)
}

fn install_chunk_offsets(ftyp_size: u64, moov: &mut Atom, tracks: &[Track], order: &[ChunkRef]) -> Result<()> {
    // stco size depends on its entry count: size the tables before measuring moov.
    for t in tracks {
        if t.chunks.is_empty() {
            bail!("track {} has no output chunks", t.id);
        }
        set_offsets(stbl_of(moov, t.id)?, &vec![0; t.chunks.len()], false)?;
    }
    let (offsets, max) = chunk_offsets(ftyp_size, moov.size(), tracks, order);
    let wide = max > STCO_OFFSET_LIMIT;
    let offsets = if wide {
        // co64 entries are twice as large, so moov grows and every offset moves.
        for t in tracks {
            set_offsets(stbl_of(moov, t.id)?, &vec![0; t.chunks.len()], true)?;
        }
        chunk_offsets(ftyp_size, moov.size(), tracks, order).0
    } else {
        offsets
    };
    for (t, o) in tracks.iter().zip(&offsets) {
        set_offsets(stbl_of(moov, t.id)?, o, wide)?;
    }
    Ok(())
}

struct Buffered<'a, W: Sink> {
    out: &'a mut W,
    buf: Vec<u8>,
}

impl<W: Sink> Buffered<'_, W> {
    const CAP: usize = 1 << 20;

    fn write(&mut self, b: &[u8]) -> Result<()> {
        if self.buf.len() + b.len() > Self::CAP {
            self.flush()?;
        }
        if b.len() >= Self::CAP {
            return self.out.write(b);
        }
        self.buf.extend_from_slice(b);
        Ok(())
    }

    fn flush(&mut self) -> Result<()> {
        if !self.buf.is_empty() {
            self.out.write(&self.buf)?;
            self.buf.clear();
        }
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
fn write_progressive<S: Source, W: Sink>(
    r: &mut Reader<S>,
    out: &mut W,
    ftyp: &Atom,
    moov: &Atom,
    tracks: &[Track],
    mdats: &[Mdat],
    order: &[ChunkRef],
    mdat_sizes: &[u64],
) -> Result<()> {
    let mut w = Buffered { out, buf: Vec::with_capacity(Buffered::<W>::CAP) };
    w.write(&ftyp.to_bytes())?;
    w.write(&moov.to_bytes())?;
    let mut next = 0;
    let mut remaining = 0u64;
    let mut copy = vec![0u8; Buffered::<W>::CAP];
    for rf in order {
        let t = &tracks[rf.track];
        let c = &t.chunks[rf.chunk];
        if remaining == 0 {
            let &size = mdat_sizes.get(next).ok_or_else(|| Error::new("media data exceeds planned mdat boxes"))?;
            next += 1;
            remaining = size;
            let total = size + MDAT_HEADER;
            if total >= 1 << 32 {
                bail!("normal mdat size {total} exceeds 32-bit size field");
            }
            let mut h = (total as u32).to_be_bytes().to_vec();
            h.extend_from_slice(b"mdat");
            w.write(&h)?;
        }
        if c.size > remaining {
            bail!("track {} chunk {} does not fit its planned mdat box", t.id, rf.chunk);
        }
        remaining -= c.size;
        let m = &mdats[c.mdat];
        if c.offset < m.payload_start() || c.offset + c.size > m.start + m.size {
            bail!("copy track {} chunk {}: range outside mdat", t.id, rf.chunk);
        }
        let mut done = 0u64;
        while done < c.size {
            let n = (c.size - done).min(copy.len() as u64) as usize;
            r.read_exact_at(&mut copy[..n], c.offset + done)
                .map_err(|e| e.context(&format!("copy track {} chunk {} [{},{})", t.id, rf.chunk, c.offset, c.offset + c.size)))?;
            w.write(&copy[..n])?;
            done += n as u64;
        }
    }
    if next != mdat_sizes.len() || remaining != 0 {
        bail!("media data does not match planned mdat boxes");
    }
    w.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{entry, fragment, init, sample_data, Run, TrackSpec};

    struct Spec {
        id: u32,
        timescale: u32,
        duration: u32,
        samples: usize,
        per_fragment: usize,
    }

    /// All fragments of one track precede those of the next: the worst source layout.
    fn fragmented(specs: &[Spec]) -> Vec<u8> {
        let tracks: Vec<TrackSpec> = specs.iter().map(|s| TrackSpec { id: s.id, timescale: s.timescale, entry: entry(b"mp4a") }).collect();
        let mut out = init(&tracks);
        let mut seq = 1;
        for s in specs {
            for first in (0..s.samples).step_by(s.per_fragment) {
                let samples = (first..(first + s.per_fragment).min(s.samples)).map(|i| (s.duration, 0, sample_data(s.id, i))).collect();
                out.extend(fragment(seq, &[Run { track: s.id, start_time: first as u64 * s.duration as u64, samples }], &|_| Vec::new()));
                seq += 1;
            }
        }
        out
    }

    /// (offset, first sample index, sample count) of every chunk of a trak.
    fn chunks(trak: &Atom) -> Vec<(u64, usize, usize)> {
        let stbl = trak.path(&[b"mdia", b"minf", b"stbl"]).unwrap();
        let stco = stbl.child(b"stco").unwrap().bytes();
        let stsc = stbl.child(b"stsc").unwrap().bytes();
        let runs: Vec<(usize, usize)> =
            (0..be32(stsc, 4) as usize).map(|i| (be32(stsc, 8 + 12 * i) as usize, be32(stsc, 12 + 12 * i) as usize)).collect();
        let mut sample = 0;
        (0..be32(stco, 4) as usize)
            .map(|c| {
                let per = runs.iter().rfind(|r| r.0 <= c + 1).unwrap().1;
                let out = (be32(stco, 8 + 4 * c) as u64, sample, per);
                sample += per;
                out
            })
            .collect()
    }

    /// Checks every sample's size and bytes; returns (offset, start seconds) per chunk.
    fn check_samples(out: &[u8], trak: &Atom, spec: &Spec) -> Vec<(u64, f64)> {
        let stsz = trak.path(&[b"mdia", b"minf", b"stbl", b"stsz"]).unwrap().bytes();
        let mut starts = Vec::new();
        let mut total = 0;
        for (offset, first, count) in chunks(trak) {
            let mut p = offset as usize;
            for i in first..first + count {
                let want = sample_data(spec.id, i);
                assert_eq!(be32(stsz, 12 + 4 * i) as usize, want.len());
                assert_eq!(&out[p..p + want.len()], &want[..], "track {} sample {i}", spec.id);
                p += want.len();
            }
            starts.push((offset, first as f64 * spec.duration as f64 / spec.timescale as f64));
            total += count;
        }
        assert_eq!(total, spec.samples);
        starts
    }

    #[test]
    fn mv_layout_interleaves_tracks_by_time() {
        let specs = [
            // 0.25 s samples in 6 s fragments.
            Spec { id: 1, timescale: 48000, duration: 12000, samples: 80, per_fragment: 24 },
            // ~0.1 s samples in 4 s fragments, another timescale.
            Spec { id: 2, timescale: 44100, duration: 4410, samples: 200, per_fragment: 40 },
        ];
        let mut out = Vec::new();
        defragment(&fragmented(&specs)[..], &mut out, &Options::mv()).unwrap();
        let atoms = bmff::parse(&out).unwrap();
        assert!(atoms.iter().all(|a| &a.kind != b"moof"));
        assert_eq!(&atoms[0].bytes()[..4], b"isom");
        let mut all = Vec::new();
        for (trak, spec) in atoms[1].all(b"trak").zip(&specs) {
            all.extend(check_samples(&out, trak, spec));
            for (_, _, count) in chunks(trak) {
                let seconds = count as f64 * spec.duration as f64 / spec.timescale as f64;
                assert!(seconds <= MAX_CHUNK_DURATION as f64 + spec.duration as f64 / spec.timescale as f64);
            }
        }
        // In file order, chunk start times never go back.
        all.sort_by_key(|c| c.0);
        assert!(all.windows(2).all(|w| w[1].1 >= w[0].1));
    }

    /// The reference song layout: tag-compatible ftyp, one chunk per source
    /// trun and tracks written one after another.
    #[test]
    fn song_layout_keeps_reference_layout() {
        let specs = [
            Spec { id: 1, timescale: 44100, duration: 4096, samples: 100, per_fragment: 40 },
            Spec { id: 2, timescale: 48000, duration: 1024, samples: 300, per_fragment: 150 },
        ];
        let mut out = Vec::new();
        defragment(&fragmented(&specs)[..], &mut out, &Options::song()).unwrap();
        let atoms = bmff::parse(&out).unwrap();
        assert_eq!(&atoms[0].bytes()[..8], b"M4A \0\0\0\x01");
        let moov = &atoms[1];
        assert!(moov.path(&[b"udta", b"meta", b"ilst"]).is_some());
        assert!(moov.child(b"mvex").is_none());
        let mut last = 0;
        for (trak, spec) in moov.all(b"trak").zip(&specs) {
            let c = chunks(trak);
            assert_eq!(c.len(), spec.samples.div_ceil(spec.per_fragment), "one chunk per trun");
            assert!(c.iter().all(|x| x.0 >= last), "tracks one after another");
            last = c.last().unwrap().0;
            check_samples(&out, trak, spec);
        }
        // mdhd carries the media duration.
        let mdhd = moov.path(&[b"trak", b"mdia", b"mdhd"]).unwrap().bytes();
        assert_eq!(be32(mdhd, 16), 100 * 4096);
    }

    #[test]
    fn write_order_compares_across_timescales() {
        let chunk = |time| Chunk { mdat: 0, offset: 0, size: 1, samples: 1, description: 1, time };
        let track = |timescale, times: &[u64]| Track {
            id: 0,
            samples: Vec::new(),
            chunks: times.iter().map(|&t| chunk(t)).collect(),
            groups: Vec::new(),
            duration: 0,
            timescale,
        };
        let tracks = [track(1000, &[0, 1000, 2000]), track(3, &[0, 2, 3, 7])];
        let got: Vec<(usize, usize)> = write_order(&tracks, true).iter().map(|r| (r.track, r.chunk)).collect();
        assert_eq!(got, vec![(0, 0), (1, 0), (1, 1), (0, 1), (1, 2), (0, 2), (1, 3)]);
    }

    #[test]
    fn rejects_plain_and_encrypted_input() {
        let mut out = Vec::new();
        let plain = init(&[TrackSpec { id: 1, timescale: 1000, entry: entry(b"mp4a") }]);
        assert_eq!(defragment(&plain[..], &mut out, &Options::song()).unwrap_err().to_string(), "input is not a fragmented MP4");
        let mut enc = init(&[TrackSpec { id: 1, timescale: 1000, entry: entry(b"enca") }]);
        enc.extend(fragment(1, &[Run { track: 1, start_time: 0, samples: vec![(1, 0, vec![1])] }], &|_| Vec::new()));
        assert!(defragment(&enc[..], &mut out, &Options::song()).unwrap_err().to_string().contains("is encrypted"));
    }
}
