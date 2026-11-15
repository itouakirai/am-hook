//! Unit tests for the crate's parsers and small DSP pieces.
//!
//! They deliberately use synthetic buffers: the bitstream layer is exercised
//! against hand-built frames, while the full precision comparison against the
//! C++ reference lives in `tests/` (it needs real material).

use joc_core::bits::{variable_bits, BitReader};
use joc_core::eac3::parse_syncframe_header;
use joc_core::id14::{self, FrameParams};
use joc_core::jochrtf;
use joc_core::speaker::Speaker20;
use joc_core::timeline::q_to_adm_xyz;
use joc_core::ErrorKind;

#[test]
fn bit_reader_reads_msb_first_and_reports_truncation() {
    let data = [0b1011_0010, 0b0100_0000];
    let mut reader = BitReader::new(&data);
    assert_eq!(reader.read(3), 0b101);
    assert_eq!(reader.read(5), 0b10010);
    assert_eq!(reader.read(4), 0b0100);
    assert!(!reader.failed());
    assert_eq!(reader.read(8), 0);
    assert!(reader.failed());
    assert_eq!(reader.error().unwrap().kind, ErrorKind::BitstreamTruncated);
}

#[test]
fn variable_bits_extends_with_a_continuation_bit() {
    // width 2, value 2, continue, value 3, stop  -> (2+1)<<2 + 3 = 15
    let data = [0b1011_1000u8, 0b0000_0000];
    let mut reader = BitReader::new(&data);
    assert_eq!(variable_bits(&mut reader, 2, 4), Some(15));
}

fn eac3_header(size_words: u16, strmtyp: u8, acmod: u8, lfeon: u8) -> [u8; 16] {
    let mut data = [0u8; 16];
    data[0] = 0x0b;
    data[1] = 0x77;
    data[2] = (strmtyp << 6) | (((size_words - 1) >> 8) as u8 & 0x07);
    data[3] = ((size_words - 1) & 0xff) as u8;
    data[4] = 0x00; // fscod/substreamid
    // bsid = 16 at bits 40..44, then dialnorm (=0) and compre (=0).
    data[5] = 16 << 3;
    data[6] = 0x00;
    data[7] = 0x00;
    // acmod (3 bits) + lfeon at bit 36..39: the byte is bit 32..39.
    // byte 4: fscod(2) numblkscod(2) acmod(3) lfeon(1)
    data[4] = ((acmod & 0x07) << 1) | (lfeon & 0x01);
    data
}

#[test]
fn eac3_syncframe_header_is_parsed() {
    let data = eac3_header(1536, 0, 7, 1);
    let frame = parse_syncframe_header(&data, 0).expect("header parses");
    assert_eq!(frame.size, 1536 * 2);
    assert_eq!(frame.codec, 1);
    assert_eq!(frame.strmtyp, 0);
    assert_eq!(frame.acmod, 7);
    assert_eq!(frame.lfeon, 1);
    assert_eq!(frame.bsid, 16);
    assert!(!frame.has_chanmap);
}

#[test]
fn a_missing_syncword_is_rejected() {
    let data = [0u8; 16];
    assert!(parse_syncframe_header(&data, 0).is_none());
}

/// One dense object, five channels, one parameter band, all matrix deltas zero.
fn synthetic_id14() -> Vec<u8> {
    let mut bits: Vec<u8> = Vec::new();
    let mut push = |value: u32, count: u32| {
        for index in (0..count).rev() {
            bits.push(((value >> index) & 1) as u8);
        }
    };
    push(0, 3); // dmx_config_idx = 0 -> 5 channels
    push(0, 6); // num_objects_bits = 0 -> one object
    push(0, 3); // ext_config_idx
    push(4, 3); // clipgain x = 4 -> 2^0
    push(0, 5); // clipgain y = 0
    push(0, 10); // seq_count
    // object 0
    push(1, 1); // present
    push(0, 3); // num_bands_idx = 0 -> 1 band
    push(0, 1); // sparse = 0
    push(0, 1); // quant_idx = 0 (96 levels)
    push(0, 1); // slope_idx = 0
    push(0, 1); // num_dpoints_bits = 0 -> one dpoint
    // 5 channels x 1 band, Huffman symbol 0 is the single bit 0.
    for _ in 0..5 {
        push(0, 1);
    }
    while !bits.len().is_multiple_of(8) {
        bits.push(0);
    }
    let mut bytes = vec![0u8; bits.len() / 8];
    for (index, bit) in bits.iter().enumerate() {
        if *bit != 0 {
            bytes[index / 8] |= 1 << (7 - index % 8);
        }
    }
    bytes
}

#[test]
fn id14_dense_object_dequantises_to_zero() {
    let payload = synthetic_id14();
    let mut params = FrameParams::default();
    id14::parse_id14(&payload, &mut params).expect("ID14 parses");
    assert_eq!(params.dmx_config_idx, 0);
    assert_eq!(params.n_channels, 5);
    assert_eq!(params.n_objects, 1);
    assert_eq!(params.present_mask, 1);
    assert!((params.clipgain - 1.0).abs() < 1e-12);
    assert_eq!(params.objects[0].n_bands, 1);
    for channel in &params.objects[0].dq[0][..5] {
        assert_eq!(channel[0], 0.0);
    }
}

#[test]
fn q15_positions_map_to_adm() {
    // Centre/front/level, then hard left, then low.
    let centre = q_to_adm_xyz(16384, 16384, 0);
    assert!(centre[0].abs() < 1e-6, "x = {}", centre[0]);
    assert!(centre[1].abs() < 1e-6, "y = {}", centre[1]);
    assert_eq!(centre[2], 0.0);
    let left = q_to_adm_xyz(0, 16384, 0);
    assert!((left[0] + 1.0).abs() < 1e-6);
    let up = q_to_adm_xyz(16384, 16384, 32767);
    assert!((up[2] - 1.0).abs() < 1e-6);
    // OAMD carries the height magnitude only; a negative height was already
    // folded to zero by the parser.
    let level = q_to_adm_xyz(16384, 16384, 0);
    assert_eq!(level[2], 0.0);
}

#[test]
fn speaker_20_pans_centre_and_edges() {
    let objects = vec![0.0f32; 16 * 1536];
    let mut engine = Speaker20::new();
    let mut out = vec![0.0f64; 1536 * 2];
    engine.process(&objects, None, &mut out);
    assert!(out.iter().all(|value| *value == 0.0));

    // A position at the extreme left puts the centre object in the left channel
    // only; check through the public renderer via a fresh event.
    let mut update = joc_core::oamd::OamdUpdate::new();
    update.slots[0].q1 = Some(0);
    update.slots[0].q2 = Some(16384);
    update.slots[0].q3 = Some(0);
    update.ramp_duration_samples = 0;
    let mut objects = vec![0.0f32; 16 * 1536];
    for sample in 0..1536 {
        objects[1536 + sample] = 1.0; // object 0 (channel 1 of the kernel output)
    }
    engine.process(&objects, Some(&update), &mut out);
    let left = out.iter().step_by(2).fold(0.0f64, |a, b| a.max(b.abs()));
    let right = out.iter().skip(1).step_by(2).fold(0.0f64, |a, b| a.max(b.abs()));
    assert!(left > 0.5, "left peak {left}");
    assert!(right < 1e-3, "right peak {right}");
}

#[test]
fn jochrtf_rejects_a_placeholder() {
    let error = jochrtf::load_jochrtf(b"not a zip").expect_err("placeholder must fail");
    assert_eq!(error.kind, ErrorKind::HrtfFormat);
}

#[test]
fn builtin_kernels_have_the_expected_shape() {
    let kernels = jochrtf::builtin_kernels();
    assert_eq!(kernels.hybrid_count, 154);
    assert_eq!(kernels.qmf_basis.len(), 64 * 4 * 128);
    assert!(kernels.qmf_analysis[..64].iter().all(|value| value.is_finite()));
}
