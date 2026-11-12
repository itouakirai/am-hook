//! Golden test on the committed fixture: the real EMDF containers (ID14 / OAMD)
//! of 24 syncframes from an Apple Music Atmos stream with the audio payload
//! zeroed, plus a synthetic 5.1 tone bed (see fixtures/make_joc_fixture.py).
//!
//! The expected digests were rendered by am-hook-joc's native reference
//! harness from the same sources; the browser build must produce the same
//! samples, so any change to the DSP shows up here first.

use joc_core::binaural::{Controls, Scene};
use joc_core::sofa_binaural::head_rotation;
use joc_core::stream::{Mode, Stream, StreamConfig};
use joc_core::FRAME_SAMPLES;
use sha2::{Digest, Sha256};

const EAC3: &[u8] = include_bytes!("fixtures/joc_fixture.eac3");
const D2: &[u8] = include_bytes!("../../../web/joc/hrtf/D2.jochrtf");
const CHANNELS: usize = 6;
const TONES_HZ: [f64; 6] = [440.0, 554.0, 659.0, 880.0, 110.0, 55.0];
const AMPLITUDE: f64 = 0.08;

const SPEAKER_SHA256: &str = "907b8cca070b5f4e4eb07d63d0a60803eb50e12b13a0012ee62403bef830c13a";
const BINAURAL_SHA256: &str = "27ff9104fb2691567b6a8fec86def7d2f451e1800ff30ee0369200d7f09d89f9";

fn frames() -> Vec<&'static [u8]> {
    let mut out = Vec::new();
    let mut offset = 0;
    while offset + 4 <= EAC3.len() {
        let size = ((((EAC3[offset + 2] & 0x07) as usize) << 8 | EAC3[offset + 3] as usize) + 1) * 2;
        out.push(&EAC3[offset..offset + size]);
        offset += size;
    }
    out
}

fn bed(frames: usize) -> Vec<f32> {
    let mut bed = vec![0.0f32; frames * FRAME_SAMPLES * CHANNELS];
    for sample in 0..frames * FRAME_SAMPLES {
        let t = sample as f64 / 48000.0;
        for channel in 0..CHANNELS {
            let phase = 2.0 * std::f64::consts::PI * TONES_HZ[channel] * t + channel as f64 * 0.3;
            bed[sample * CHANNELS + channel] = (AMPLITUDE * phase.sin()) as f32;
        }
    }
    bed
}

/// Feeds the fixture the way joc/decode-worker.js does: one syncframe and its
/// core PCM at a time, with `flush_pending` at every sample boundary when asked.
fn render(mode: Mode, hrtf: Option<&[u8]>, flush_each: bool, finish: bool) -> Vec<f32> {
    let frames = frames();
    let bed = bed(frames.len());
    let config = StreamConfig { mode, hrtf: hrtf.map(<[u8]>::to_vec), ..StreamConfig::default() };
    let mut stream = Stream::new(config).expect("open");
    let mut out = Vec::new();
    let mut buffer = vec![0.0f32; 4096 * 2];
    let mut drain = |stream: &mut Stream, out: &mut Vec<f32>| loop {
        let count = stream.pull(&mut buffer, 4096).expect("pull");
        if count == 0 {
            break;
        }
        out.extend_from_slice(&buffer[..count * 2]);
    };
    for (index, frame) in frames.iter().enumerate() {
        stream.push_eac3(frame).expect("push_eac3");
        let pcm = &bed[index * FRAME_SAMPLES * CHANNELS..(index + 1) * FRAME_SAMPLES * CHANNELS];
        stream.push_pcm(pcm, CHANNELS).expect("push_pcm");
        if flush_each {
            stream.flush_pending().expect("flush_pending");
        }
        drain(&mut stream, &mut out);
    }
    stream.flush_pending().expect("flush_pending");
    if finish {
        stream.flush().expect("flush");
    }
    drain(&mut stream, &mut out);
    out
}

fn digest(samples: &[f32]) -> String {
    let mut hash = Sha256::new();
    for value in samples {
        hash.update(value.to_le_bytes());
    }
    hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

fn peak(samples: &[f32]) -> f32 {
    samples.iter().fold(0.0f32, |peak, value| {
        assert!(value.is_finite(), "non-finite sample");
        peak.max(value.abs())
    })
}

/// The stream keeps megabyte-sized fixed arrays; give the test a large stack.
fn on_big_stack(f: impl FnOnce() + Send + 'static) {
    std::thread::Builder::new()
        .stack_size(64 * 1024 * 1024)
        .spawn(f)
        .expect("spawn")
        .join()
        .expect("fixture test");
}

#[test]
fn speaker_matches_the_reference() {
    on_big_stack(|| {
        let out = render(Mode::Speaker20, None, false, false);
        assert_eq!(out.len(), 24 * FRAME_SAMPLES * 2);
        assert_eq!(digest(&out), SPEAKER_SHA256);
        assert!((peak(&out) - 0.378_611_2).abs() < 1e-6);
        // Rendering every syncframe at its sample boundary (as the worker does)
        // gives the same samples.
        assert_eq!(digest(&render(Mode::Speaker20, None, true, false)), SPEAKER_SHA256);
    });
}

#[test]
fn binaural_matches_the_reference() {
    on_big_stack(|| {
        let out = render(Mode::Binaural, Some(D2), false, false);
        // The kernel's 961-sample latency is trimmed at the start.
        assert_eq!(out.len(), (24 * FRAME_SAMPLES - joc_core::BINAURAL_LATENCY_SAMPLES) * 2);
        assert_eq!(digest(&out), BINAURAL_SHA256);
        assert!((peak(&out) - 0.167_236_5).abs() < 1e-6);
        assert_eq!(digest(&render(Mode::Binaural, Some(D2), true, false)), BINAURAL_SHA256);
    });
}

#[test]
fn binaural_flush_completes_the_programme_and_adds_the_room_tail() {
    on_big_stack(|| {
        let programme = render(Mode::Binaural, Some(D2), true, false);
        let finished = render(Mode::Binaural, Some(D2), true, true);
        assert!(finished.len() >= 24 * FRAME_SAMPLES * 2, "flush returns the held-back latency");
        assert_eq!(&finished[..programme.len()], &programme[..]);
        peak(&finished);
    });
}

#[test]
fn reset_starts_from_a_clean_state() {
    on_big_stack(|| {
        let frames = frames();
        let bed = bed(frames.len());
        let config = StreamConfig { mode: Mode::Binaural, hrtf: Some(D2.to_vec()), ..StreamConfig::default() };
        let mut stream = Stream::new(config).expect("open");
        for (index, frame) in frames.iter().take(10).enumerate() {
            stream.push_eac3(frame).expect("push_eac3");
            stream
                .push_pcm(&bed[index * FRAME_SAMPLES * CHANNELS..(index + 1) * FRAME_SAMPLES * CHANNELS], CHANNELS)
                .expect("push_pcm");
            stream.flush_pending().expect("flush_pending");
        }
        stream.reset();
        let mut out = Vec::new();
        let mut buffer = vec![0.0f32; 4096 * 2];
        for (index, frame) in frames.iter().enumerate() {
            stream.push_eac3(frame).expect("push_eac3");
            stream
                .push_pcm(&bed[index * FRAME_SAMPLES * CHANNELS..(index + 1) * FRAME_SAMPLES * CHANNELS], CHANNELS)
                .expect("push_pcm");
            stream.flush_pending().expect("flush_pending");
            loop {
                let count = stream.pull(&mut buffer, 4096).expect("pull");
                if count == 0 {
                    break;
                }
                out.extend_from_slice(&buffer[..count * 2]);
            }
        }
        assert_eq!(digest(&out), BINAURAL_SHA256);
    });
}

/// Renders the fixture with interactive controls set before the first frame.
fn render_with(controls: &Controls) -> (Vec<f32>, Vec<Scene>) {
    let frames = frames();
    let bed = bed(frames.len());
    let config = StreamConfig { mode: Mode::Binaural, hrtf: Some(D2.to_vec()), ..StreamConfig::default() };
    let mut stream = Stream::new(config).expect("open");
    stream.set_controls(controls);
    let mut out = Vec::new();
    let mut scenes = Vec::new();
    let mut buffer = vec![0.0f32; 4096 * 2];
    for (index, frame) in frames.iter().enumerate() {
        stream.push_eac3(frame).expect("push_eac3");
        stream
            .push_pcm(&bed[index * FRAME_SAMPLES * CHANNELS..(index + 1) * FRAME_SAMPLES * CHANNELS], CHANNELS)
            .expect("push_pcm");
        stream.flush_pending().expect("flush_pending");
        scenes.push(stream.take_scene().expect("binaural scene"));
        loop {
            let count = stream.pull(&mut buffer, 4096).expect("pull");
            if count == 0 {
                break;
            }
            out.extend_from_slice(&buffer[..count * 2]);
        }
    }
    (out, scenes)
}

#[test]
fn default_controls_keep_the_reference_output() {
    on_big_stack(|| {
        let (out, scenes) = render_with(&Controls::default());
        assert_eq!(digest(&out), BINAURAL_SHA256);
        // The scene follows the programme: the tone bed is audible and the objects have positions
        let last = scenes.last().expect("scenes");
        assert!(last.levels.iter().any(|level| *level > 1e-3), "levels: {:?}", last.levels);
        assert!(last.positions.iter().all(|p| p.iter().all(|v| v.is_finite() && v.abs() <= 1.0)));
    });
}

#[test]
fn controls_change_the_render() {
    on_big_stack(|| {
        let muted = Controls { gains: [0.0; 16], ..Controls::default() };
        let (out, _) = render_with(&muted);
        assert!(peak(&out) < 1e-6, "every source muted: peak {}", peak(&out));

        let turned = Controls {
            head: head_rotation(2.0, 0.3, 0.1),
            walk: [1.0, -2.0, 0.0],
            focus: 1.0,
            height: 2.0,
            ..Controls::default()
        };
        let (out, _) = render_with(&turned);
        assert_ne!(digest(&out), BINAURAL_SHA256);
        assert!(peak(&out) > 0.01 && peak(&out) < 2.0, "peak {}", peak(&out));

        // A walk outside the room is kept inside it
        let config = StreamConfig { mode: Mode::Binaural, hrtf: Some(D2.to_vec()), ..StreamConfig::default() };
        let mut stream = Stream::new(config).expect("open");
        stream.set_controls(&Controls { walk: [100.0, -100.0, f64::NAN], ..Controls::default() });
        let walk = stream.controls().expect("controls").walk;
        assert_eq!(walk, [8.5, -8.5, 0.0]);
    });
}

#[test]
fn every_shipped_field_renders() {
    let names = ["D1", "D2", "H3", "H4", "H5", "H6", "H7", "H8", "H9", "H10", "H11", "H12", "H13", "H14", "H15", "H16", "H17", "H18", "H19", "H20"];
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../web/joc/hrtf");
    on_big_stack(move || {
        for name in names {
            let bytes = std::fs::read(format!("{root}/{name}.jochrtf")).expect(name);
            let config = StreamConfig { mode: Mode::Binaural, hrtf: Some(bytes), ..StreamConfig::default() };
            let mut stream = Stream::new(config).expect(name);
            let frames = frames();
            let bed = bed(4);
            for (index, frame) in frames.iter().take(4).enumerate() {
                stream.push_eac3(frame).expect("push_eac3");
                stream
                    .push_pcm(&bed[index * FRAME_SAMPLES * CHANNELS..(index + 1) * FRAME_SAMPLES * CHANNELS], CHANNELS)
                    .expect("push_pcm");
            }
            stream.flush_pending().expect("flush_pending");
            let mut buffer = vec![0.0f32; 8192 * 2];
            let count = stream.pull(&mut buffer, 8192).expect("pull");
            assert!(count > 0, "{name}: no output");
            assert!(peak(&buffer[..count * 2]) > 0.0, "{name}: silent");
        }
    });
}

