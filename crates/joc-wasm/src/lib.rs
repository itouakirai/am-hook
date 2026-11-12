//! C ABI for the browser build.  `web/joc/decode-worker.js` is the only caller.
//!
//! Buffers cross the boundary by pointer: `joc_alloc` reserves memory, the caller
//! writes into it, and `joc_free` releases it.  A stream is an opaque pointer; the
//! error of the most recent failing call is exposed through
//! `joc_error_ptr` / `joc_error_len`.

use std::alloc::{alloc, dealloc, Layout};
use std::cell::RefCell;

use joc_core::sofa_binaural::head_rotation;
use joc_core::stream::{BinauralProfile, Mode, Stream, StreamConfig, StreamInfo};

thread_local! {
    static LAST_ERROR: RefCell<String> = const { RefCell::new(String::new()) };
}

fn set_error(message: String) {
    LAST_ERROR.with(|slot| *slot.borrow_mut() = message);
}

fn report(error: impl core::fmt::Display) -> i32 {
    set_error(error.to_string());
    -1
}

#[no_mangle]
pub extern "C" fn joc_version() -> u32 {
    1
}

#[no_mangle]
pub extern "C" fn joc_error_ptr() -> *const u8 {
    LAST_ERROR.with(|slot| slot.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn joc_error_len() -> usize {
    LAST_ERROR.with(|slot| slot.borrow().len())
}

#[no_mangle]
pub extern "C" fn joc_alloc(len: usize) -> *mut u8 {
    // SAFETY: size is at least one byte and the alignment is one.
    unsafe { alloc(Layout::from_size_align_unchecked(len.max(1), 1)) }
}

/// # Safety
/// `ptr` must come from `joc_alloc` with the same `len`.
#[no_mangle]
pub unsafe extern "C" fn joc_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        dealloc(ptr, Layout::from_size_align_unchecked(len.max(1), 1));
    }
}

/// `mode`: 0 = speaker 2.0, 1 = binaural.  `hrtf` is the .jochrtf image (binaural
/// only) and may be null for speaker.  `profile`: 0 near, 1 mid, 2 far.
///
/// # Safety
/// `hrtf` must point to `hrtf_len` readable bytes, or be null.
#[no_mangle]
pub unsafe extern "C" fn joc_open(
    mode: u32,
    gain_db: f64,
    profile: u32,
    object_delay: u32,
    tail_seconds: f64,
    hrtf: *const u8,
    hrtf_len: usize,
) -> *mut Stream {
    let hrtf = if hrtf.is_null() || hrtf_len == 0 {
        None
    } else {
        Some(std::slice::from_raw_parts(hrtf, hrtf_len).to_vec())
    };
    let profile = match profile {
        0 => BinauralProfile::Near,
        2 => BinauralProfile::Far,
        _ => BinauralProfile::Mid,
    };
    let config = StreamConfig {
        mode: if mode == 1 { Mode::Binaural } else { Mode::Speaker20 },
        gain_db,
        object_delay_samples: object_delay,
        tail_seconds,
        binaural_profile: profile,
        hrtf,
    };
    match Stream::new(config) {
        Ok(stream) => Box::into_raw(Box::new(stream)),
        Err(error) => {
            set_error(error.to_string());
            std::ptr::null_mut()
        }
    }
}

/// # Safety
/// `stream` must come from `joc_open`.
#[no_mangle]
pub unsafe extern "C" fn joc_close(stream: *mut Stream) {
    if !stream.is_null() {
        drop(Box::from_raw(stream));
    }
}

/// # Safety
/// `stream` must come from `joc_open`.
#[no_mangle]
pub unsafe extern "C" fn joc_reset(stream: *mut Stream) -> i32 {
    match stream.as_mut() {
        Some(stream) => {
            stream.reset();
            0
        }
        None => report("null stream"),
    }
}

/// # Safety
/// `stream` must come from `joc_open`; `data` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn joc_push_eac3(stream: *mut Stream, data: *const u8, len: usize) -> i32 {
    let Some(stream) = stream.as_mut() else {
        return report("null stream");
    };
    let bytes = std::slice::from_raw_parts(data, len);
    match stream.push_eac3(bytes) {
        Ok(()) => 0,
        Err(error) => report(error),
    }
}

/// `pcm` is interleaved float32 with `channels` channels.
///
/// # Safety
/// `stream` must come from `joc_open`; `pcm` must point to `frames * channels` floats.
#[no_mangle]
pub unsafe extern "C" fn joc_push_pcm(
    stream: *mut Stream,
    pcm: *const f32,
    frames: usize,
    channels: usize,
) -> i32 {
    let Some(stream) = stream.as_mut() else {
        return report("null stream");
    };
    let samples = std::slice::from_raw_parts(pcm, frames * channels);
    match stream.push_pcm(samples, channels) {
        Ok(()) => 0,
        Err(error) => report(error),
    }
}

/// Renders into `out` (interleaved stereo float32, `max_frames` frames) and
/// returns the number of frames written.
///
/// # Safety
/// `stream` must come from `joc_open`; `out` must hold `max_frames * 2` floats.
#[no_mangle]
pub unsafe extern "C" fn joc_pull(stream: *mut Stream, out: *mut f32, max_frames: usize) -> i32 {
    let Some(stream) = stream.as_mut() else {
        return report("null stream");
    };
    let buffer = std::slice::from_raw_parts_mut(out, max_frames * 2);
    match stream.pull(buffer, max_frames) {
        Ok(count) => count as i32,
        Err(error) => report(error),
    }
}

/// Updates the output gain in dB.
///
/// # Safety
/// `stream` must come from `joc_open`.
#[no_mangle]
pub unsafe extern "C" fn joc_set_gain(stream: *mut Stream, gain_db: f64) -> i32 {
    match stream.as_mut() {
        Some(stream) => {
            stream.set_gain_db(gain_db);
            0
        }
        None => report("null stream"),
    }
}

/// Interactive binaural controls, applied from the next 512-sample block: the head turned left by
/// `yaw`, up by `pitch` and its right ear down by `roll` (radians), standing `x` / `y` / `z` metres
/// right / ahead / above the listening position, `focus` (0..1), the height scale, and `gains`
/// (16 linear gains: LFE, then the 15 objects; null keeps the current ones).  Speaker 2.0 ignores
/// them.
///
/// # Safety
/// `stream` must come from `joc_open`; `gains` must point to 16 floats, or be null.
#[no_mangle]
pub unsafe extern "C" fn joc_set_controls(
    stream: *mut Stream,
    yaw: f64,
    pitch: f64,
    roll: f64,
    x: f64,
    y: f64,
    z: f64,
    focus: f64,
    height: f64,
    gains: *const f32,
) -> i32 {
    let Some(stream) = stream.as_mut() else {
        return report("null stream");
    };
    let Some(mut controls) = stream.controls() else {
        return 0;
    };
    let finite = |value: f64| if value.is_finite() { value } else { 0.0 };
    controls.head = head_rotation(finite(yaw), finite(pitch), finite(roll));
    controls.walk = [finite(x), finite(y), finite(z)];
    controls.focus = focus;
    controls.height = height;
    if !gains.is_null() {
        for (slot, value) in controls.gains.iter_mut().zip(std::slice::from_raw_parts(gains, 16)) {
            *slot = f64::from(*value);
        }
    }
    stream.set_controls(&controls);
    0
}

/// Floats written by `joc_scene`: 15 object positions (ADM x, y, z), 16 RMS levels (LFE, then the
/// objects) and the listener's offset in metres after clamping to the room.
pub const SCENE_FLOATS: usize = 15 * 3 + 16 + 3;

/// Fills `out` with the scene since the previous call (see `SCENE_FLOATS`); returns 1, or 0 for
/// speaker 2.0 (nothing written).
///
/// # Safety
/// `stream` must come from `joc_open`; `out` must hold `SCENE_FLOATS` floats.
#[no_mangle]
pub unsafe extern "C" fn joc_scene(stream: *mut Stream, out: *mut f32) -> i32 {
    let Some(stream) = stream.as_mut() else {
        return report("null stream");
    };
    let (Some(scene), Some(controls)) = (stream.take_scene(), stream.controls()) else {
        return 0;
    };
    let out = std::slice::from_raw_parts_mut(out, SCENE_FLOATS);
    for (index, position) in scene.positions.iter().enumerate() {
        for axis in 0..3 {
            out[index * 3 + axis] = position[axis] as f32;
        }
    }
    for (index, level) in scene.levels.iter().enumerate() {
        out[45 + index] = *level as f32;
    }
    for axis in 0..3 {
        out[61 + axis] = controls.walk[axis] as f32;
    }
    1
}

/// Renders the frame group still pending at a fragment boundary.
///
/// # Safety
/// `stream` must come from `joc_open`.
#[no_mangle]
pub unsafe extern "C" fn joc_flush_pending(stream: *mut Stream) -> i32 {
    match stream.as_mut() {
        Some(stream) => match stream.flush_pending() {
            Ok(()) => 0,
            Err(error) => report(error),
        },
        None => report("null stream"),
    }
}

/// # Safety
/// `stream` must come from `joc_open`.
#[no_mangle]
pub unsafe extern "C" fn joc_buffered(stream: *mut Stream) -> i32 {
    stream.as_ref().map_or(0, |stream| stream.buffered_frames() as i32)
}

/// # Safety
/// `stream` must come from `joc_open`.
#[no_mangle]
pub unsafe extern "C" fn joc_flush(stream: *mut Stream) -> i32 {
    match stream.as_mut() {
        Some(stream) => match stream.flush() {
            Ok(()) => 0,
            Err(error) => report(error),
        },
        None => report("null stream"),
    }
}

/// A flat status record, so the worker reads one struct instead of a dozen calls.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct JocStatus {
    pub frames_in: u64,
    pub frames_out: u64,
    pub samples_in: u64,
    pub samples_out: u64,
    pub output_channels: u32,
    pub missing_joc_frames: u32,
    pub objects_clamped_frames: u32,
    pub chanmap_pair_mismatch_frames: u32,
    pub bed_mask_mismatch_frames: u32,
    pub oamd_payloads: u32,
    pub peak: f64,
    pub over_unity: u64,
    pub non_finite: u64,
    pub ended: u32,
    pub buffered_frames: u32,
    pub tail_capacity: u32,
}

fn status_of(info: StreamInfo) -> JocStatus {
    JocStatus {
        frames_in: info.frames_in,
        frames_out: info.frames_out,
        samples_in: info.samples_in,
        samples_out: info.samples_out,
        output_channels: info.output_channels,
        missing_joc_frames: info.missing_joc_frames as u32,
        objects_clamped_frames: info.objects_clamped_frames as u32,
        chanmap_pair_mismatch_frames: info.chanmap_pair_mismatch_frames as u32,
        bed_mask_mismatch_frames: info.bed_mask_mismatch_frames as u32,
        oamd_payloads: info.oamd_payloads as u32,
        peak: info.peak,
        over_unity: info.over_unity,
        non_finite: info.non_finite,
        ended: u32::from(info.ended),
        buffered_frames: 0,
        tail_capacity: 0,
    }
}

/// # Safety
/// `stream` must come from `joc_open`; `out` must point to one writable `JocStatus`.
#[no_mangle]
pub unsafe extern "C" fn joc_status(stream: *mut Stream, out: *mut JocStatus) -> i32 {
    let Some(stream) = stream.as_ref() else {
        return report("null stream");
    };
    let Some(out) = out.as_mut() else {
        return report("null status");
    };
    let mut status = status_of(stream.info());
    status.buffered_frames = stream.buffered_frames() as u32;
    status.tail_capacity = stream.tail_capacity();
    *out = status;
    0
}
