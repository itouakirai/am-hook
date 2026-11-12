//! Binaural rendering of the 16 reconstructed channels.
//!
//! A port of the reference SOFA/compiled-field renderer: a 64-band QMF analysis,
//! a 77-band hybrid analysis, a fifth-order ACN/N3D real spherical-harmonic
//! evaluation of the HRTF field per path, six first-order image sources, a shared
//! unitary FDN late room, a 120-180 Hz LFE low-pass and the 961-sample latency
//! compensation.  All arithmetic is float64 and keeps the reference's term order.

use crate::jochrtf::{Field, Kernels};
use crate::{Error, ErrorKind, Result};

use std::f64::consts::PI;
const CHANNELS: usize = 16;
const HOP: usize = 64;
const QMF: usize = 64;
const HYBRID: usize = 77;
const RANK: usize = 4;
const LATENCY: usize = 961;
const ORDER: usize = 5;
const TERMS: usize = (ORDER + 1) * (ORDER + 1);
const EARLY_HISTORY: usize = 256;
const TRANSITION_SLOTS: usize = 8;
const SAMPLE_RATE: f64 = 48000.0;
const FFT_SIZE: usize = 128;
const MAX_BLOCK_SAMPLES: usize = 512;
const MAX_SLOTS: usize = MAX_BLOCK_SAMPLES / HOP;

const DISTANCE_M: [f64; 3] = [1.00000465, 2.19327927, 6.40177584];
const MINIMUM_DISTANCE: f64 = 0.10;
const COUPLING: f64 = 0.01318359375;
const ROOM_CALIBRATION: f64 = 1.4;
const LATE_SEND: [f64; 3] = [0.06, 0.16, 0.28];
const AIR: f64 = 0.002;

#[derive(Clone, Copy, Default, PartialEq)]
pub struct Complex {
    pub re: f64,
    pub im: f64,
}

#[inline]
fn add(a: Complex, b: Complex) -> Complex {
    Complex { re: a.re + b.re, im: a.im + b.im }
}

#[inline]
fn mul(a: Complex, b: Complex) -> Complex {
    Complex { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re }
}

#[inline]
fn mulr(a: Complex, b: f64) -> Complex {
    Complex { re: a.re * b, im: a.im * b }
}

struct Fft128 {
    twiddle: [Complex; FFT_SIZE],
    reverse: [usize; FFT_SIZE],
    stage_twiddle: [Complex; FFT_SIZE - 1],
    stage_begin: [usize; 7],
}

impl Fft128 {
    fn new() -> Self {
        let mut fft = Self {
            twiddle: [Complex::default(); FFT_SIZE],
            reverse: [0; FFT_SIZE],
            stage_twiddle: [Complex::default(); FFT_SIZE - 1],
            stage_begin: [0; 7],
        };
        for k in 0..FFT_SIZE {
            let angle = -2.0 * PI * k as f64 / FFT_SIZE as f64;
            fft.twiddle[k] = Complex { re: angle.cos(), im: angle.sin() };
        }
        for index in 0..FFT_SIZE {
            let mut reversed = 0usize;
            for bit in 0..7 {
                reversed = (reversed << 1) | ((index >> bit) & 1);
            }
            fft.reverse[index] = reversed;
        }
        let mut cursor = 0usize;
        let mut stage = 0usize;
        let mut size = 2usize;
        while size <= FFT_SIZE {
            fft.stage_begin[stage] = cursor;
            let step = FFT_SIZE / size;
            for offset in 0..size / 2 {
                fft.stage_twiddle[cursor] = fft.twiddle[offset * step];
                cursor += 1;
            }
            size <<= 1;
            stage += 1;
        }
        fft
    }

    fn permuted(&self, index: usize) -> usize {
        self.reverse[index]
    }

    fn butterflies(&self, data: &mut [Complex; FFT_SIZE]) {
        let mut stage = 0usize;
        let mut length = 2usize;
        while length <= FFT_SIZE {
            let table = &self.stage_twiddle[self.stage_begin[stage]..];
            let mut start = 0usize;
            while start < FFT_SIZE {
                for offset in 0..length / 2 {
                    let even = data[start + offset];
                    let odd = mul(data[start + offset + length / 2], table[offset]);
                    data[start + offset] = add(even, odd);
                    data[start + offset + length / 2] = Complex {
                        re: even.re - odd.re,
                        im: even.im - odd.im,
                    };
                }
                start += length;
            }
            length <<= 1;
            stage += 1;
        }
    }
}

struct QmfAnalysis {
    coeff: [[f64; 10]; QMF],
    pre_cos: [f64; QMF],
    pre_sin: [f64; QMF],
    post_cos: [f64; QMF],
    post_sin: [f64; QMF],
    history: [[[f64; 64]; CHANNELS]; 9],
    joined: [[[f64; 64]; CHANNELS]; 9 + MAX_SLOTS],
    fft: Fft128,
}

impl QmfAnalysis {
    fn new() -> Self {
        Self {
            coeff: [[0.0; 10]; QMF],
            pre_cos: [0.0; QMF],
            pre_sin: [0.0; QMF],
            post_cos: [0.0; QMF],
            post_sin: [0.0; QMF],
            history: [[[0.0; 64]; CHANNELS]; 9],
            joined: [[[0.0; 64]; CHANNELS]; 9 + MAX_SLOTS],
            fft: Fft128::new(),
        }
    }

    fn configure(&mut self, coefficients: &[f64; 640]) {
        for p in 0..QMF {
            for tap in 0..10 {
                self.coeff[p][tap] = coefficients[p * 10 + tap];
            }
            let pre_angle = -PI * p as f64 / FFT_SIZE as f64;
            self.pre_cos[p] = pre_angle.cos();
            self.pre_sin[p] = pre_angle.sin();
            let post_angle = -3.0 * (p as f64 + 0.5) * PI / FFT_SIZE as f64;
            self.post_cos[p] = post_angle.cos();
            self.post_sin[p] = post_angle.sin();
        }
    }

    fn reset(&mut self) {
        self.history = [[[0.0; 64]; CHANNELS]; 9];
    }

    fn process(&mut self, input: &[f64], slots: usize, output: &mut [Complex]) {
        for lag in 0..9 {
            self.joined[lag] = self.history[lag];
        }
        for slot in 0..slots {
            for channel in 0..CHANNELS {
                for p in 0..64 {
                    self.joined[9 + slot][channel][p] = input[(slot * 64 + p) * CHANNELS + channel];
                }
            }
        }
        for slot in 0..slots {
            for channel in 0..CHANNELS {
                let mut even_fft = [Complex::default(); FFT_SIZE];
                let mut odd_fft = [Complex::default(); FFT_SIZE];
                let perm = &self.fft;
                for p in QMF..FFT_SIZE {
                    even_fft[perm.permuted(p)] = Complex::default();
                    odd_fft[perm.permuted(p)] = Complex::default();
                }
                for p in 0..QMF {
                    let mut even_re = 0.0;
                    let mut odd_re = 0.0;
                    for lag in 0..5 {
                        even_re += self.joined[9 + slot - 2 * lag][channel][p] * self.coeff[p][2 * lag];
                    }
                    for lag in 0..5 {
                        odd_re +=
                            self.joined[9 + slot - (2 * lag + 1)][channel][p] * self.coeff[p][2 * lag + 1];
                    }
                    even_fft[perm.permuted(p)] =
                        Complex { re: even_re * self.pre_cos[p], im: even_re * self.pre_sin[p] };
                    odd_fft[perm.permuted(p)] =
                        Complex { re: odd_re * self.pre_cos[p], im: odd_re * self.pre_sin[p] };
                }
                self.fft.butterflies(&mut even_fft);
                self.fft.butterflies(&mut odd_fft);
                let base = (slot * CHANNELS + channel) * QMF;
                for b in 0..QMF {
                    let post = Complex { re: self.post_cos[b], im: self.post_sin[b] };
                    let even_post = Complex { re: 0.0, im: if b % 2 == 0 { 1.0 } else { -1.0 } };
                    output[base + b] = mul(post, add(odd_fft[b], mul(even_fft[b], even_post)));
                }
            }
        }
        for lag in 0..9 {
            self.history[lag] = self.joined[slots + lag];
        }
    }
}

struct HybridAnalysis {
    low: [[[[[f64; 2]; 16]; 13]; 2]; 3],
    low_by_term: [f64; 78 * 32],
    history: [[[[f64; 2]; 3]; CHANNELS]; 12],
    low_joined: [[[[f64; 2]; 3]; CHANNELS]; 12 + MAX_SLOTS],
    high_history: [[[Complex; 61]; CHANNELS]; 6],
    high_joined: [[[Complex; 61]; CHANNELS]; 6 + MAX_SLOTS],
}

impl HybridAnalysis {
    fn new() -> Self {
        Self {
            low: [[[[[0.0; 2]; 16]; 13]; 2]; 3],
            low_by_term: [0.0; 78 * 32],
            history: [[[[0.0; 2]; 3]; CHANNELS]; 12],
            low_joined: [[[[0.0; 2]; 3]; CHANNELS]; 12 + MAX_SLOTS],
            high_history: [[[Complex::default(); 61]; CHANNELS]; 6],
            high_joined: [[[Complex::default(); 61]; CHANNELS]; 6 + MAX_SLOTS],
        }
    }

    fn configure(&mut self, low_kernel: &[f64; 2496]) {
        let mut cursor = 0usize;
        for parent in 0..3 {
            for comp in 0..2 {
                for lag in 0..13 {
                    for hb in 0..16 {
                        self.low[parent][comp][lag][hb][0] = low_kernel[cursor];
                        self.low[parent][comp][lag][hb][1] = low_kernel[cursor + 1];
                        cursor += 2;
                    }
                }
            }
        }
        cursor = 0;
        for parent in 0..3 {
            for comp in 0..2 {
                for lag in 0..13 {
                    for hb in 0..16 {
                        self.low_by_term[cursor] = self.low[parent][comp][lag][hb][0];
                        self.low_by_term[cursor + 1] = self.low[parent][comp][lag][hb][1];
                        cursor += 2;
                    }
                }
            }
        }
    }

    fn reset(&mut self) {
        self.history = [[[[0.0; 2]; 3]; CHANNELS]; 12];
        self.high_history = [[[Complex::default(); 61]; CHANNELS]; 6];
    }

    fn process(&mut self, qmf: &[Complex], slots: usize, output: &mut [Complex]) {
        for lag in 0..12 {
            self.low_joined[lag] = self.history[lag];
        }
        for lag in 0..6 {
            self.high_joined[lag] = self.high_history[lag];
        }
        for slot in 0..slots {
            for channel in 0..CHANNELS {
                let band = &qmf[(slot * CHANNELS + channel) * QMF..];
                for parent in 0..3 {
                    self.low_joined[12 + slot][channel][parent][0] = band[parent].re;
                    self.low_joined[12 + slot][channel][parent][1] = band[parent].im;
                }
                self.high_joined[6 + slot][channel].copy_from_slice(&band[3..64]);
            }
        }
        for slot in 0..slots {
            for channel in 0..CHANNELS {
                // 78 terms in (parent, component, lag) order, 32 outputs, skipping
                // zero terms exactly like the scalar reference.
                let mut staged = [0.0f64; 78];
                for parent in 0..3 {
                    for comp in 0..2 {
                        for lag in 0..13 {
                            staged[(parent * 2 + comp) * 13 + lag] =
                                self.low_joined[12 + slot - lag][channel][parent][comp];
                        }
                    }
                }
                let mut joined = [0.0f64; 32];
                for term in 0..78 {
                    let value = staged[term];
                    if value == 0.0 {
                        continue;
                    }
                    let weights = &self.low_by_term[term * 32..term * 32 + 32];
                    for out in 0..32 {
                        joined[out] += value * weights[out];
                    }
                }
                let base = (slot * CHANNELS + channel) * HYBRID;
                for hb in 0..16 {
                    output[base + hb] = Complex { re: joined[hb * 2], im: joined[hb * 2 + 1] };
                }
                for b in 0..61 {
                    output[base + 16 + b] =
                        self.high_joined[slot][channel][b];
                }
            }
        }
        for lag in 0..12 {
            self.history[lag] = self.low_joined[slots + lag];
        }
        for lag in 0..6 {
            self.high_history[lag] = self.high_joined[slots + lag];
        }
    }
}

struct SynthesisEntry {
    in_band: usize,
    in_comp: usize,
    out_band: usize,
    out_comp: usize,
    gain: f64,
}

struct HybridSynthesis {
    entries: Vec<SynthesisEntry>,
}

impl HybridSynthesis {
    fn new() -> Self {
        Self { entries: Vec::new() }
    }

    fn configure(&mut self, indices: &[i16; 616], values: &[f64; 154], count: u32) {
        self.entries.clear();
        for index in 0..count as usize {
            self.entries.push(SynthesisEntry {
                in_band: usize::try_from(indices[index * 4]).unwrap_or(0),
                in_comp: usize::try_from(indices[index * 4 + 1]).unwrap_or(0),
                out_band: usize::try_from(indices[index * 4 + 2]).unwrap_or(0),
                out_comp: usize::try_from(indices[index * 4 + 3]).unwrap_or(0),
                gain: values[index],
            });
        }
    }

    fn process(&self, hybrid: &[Complex], slots: usize, output: &mut [Complex]) {
        for slot in 0..slots {
            for channel in 0..2 {
                let source = &hybrid[(slot * 2 + channel) * HYBRID..];
                let target = &mut output[(slot * 2 + channel) * QMF..];
                target[..QMF].fill(Complex::default());
                for entry in &self.entries {
                    let value = source[entry.in_band];
                    let component = if entry.in_comp == 0 { value.re } else { value.im };
                    if entry.out_comp == 0 {
                        target[entry.out_band].re += component * entry.gain;
                    } else {
                        target[entry.out_band].im += component * entry.gain;
                    }
                }
            }
        }
    }
}

struct QmfSynthesis {
    basis: [[[f64; FFT_SIZE]; RANK]; QMF],
    basis_by_tap: Vec<f64>,
    taps: [[[f64; RANK]; 10]; QMF],
    flat: [[[f64; FFT_SIZE]; 2]; MAX_SLOTS],
    history: [[[[f64; RANK]; QMF]; 2]; 9],
    joined: [[[[f64; RANK]; QMF]; 2]; 9 + MAX_SLOTS],
}

impl QmfSynthesis {
    fn new() -> Self {
        Self {
            basis: [[[0.0; FFT_SIZE]; RANK]; QMF],
            basis_by_tap: vec![0.0; QMF * FFT_SIZE * RANK],
            taps: [[[0.0; RANK]; 10]; QMF],
            flat: [[[0.0; FFT_SIZE]; 2]; MAX_SLOTS],
            history: [[[[0.0; RANK]; QMF]; 2]; 9],
            joined: [[[[0.0; RANK]; QMF]; 2]; 9 + MAX_SLOTS],
        }
    }

    fn configure(&mut self, basis: &[f64; 32768], taps: &[f64; 2560]) {
        for b in 0..QMF {
            for r in 0..RANK {
                for j in 0..FFT_SIZE {
                    self.basis[b][r][j] = basis[(b * RANK + r) * FFT_SIZE + j];
                }
            }
            for lag in 0..10 {
                for r in 0..RANK {
                    self.taps[b][lag][r] = taps[(b * 10 + lag) * RANK + r];
                }
            }
        }
        let mut cursor = 0usize;
        for b in 0..QMF {
            for j in 0..FFT_SIZE {
                for r in 0..RANK {
                    self.basis_by_tap[cursor] = self.basis[b][r][j];
                    cursor += 1;
                }
            }
        }
    }

    fn reset(&mut self) {
        self.history = [[[[0.0; RANK]; QMF]; 2]; 9];
    }

    fn process(&mut self, qmf: &[Complex], slots: usize, output: &mut [f64]) {
        for lag in 0..9 {
            self.joined[lag] = self.history[lag];
        }
        for slot in 0..slots {
            for channel in 0..2 {
                let values = &qmf[(slot * 2 + channel) * QMF..];
                for b in 0..QMF {
                    self.flat[slot][channel][2 * b] = values[b].re;
                    self.flat[slot][channel][2 * b + 1] = values[b].im;
                }
            }
        }
        for row in 0..slots * 2 {
            let slot = row / 2;
            let channel = row % 2;
            let source = &self.flat[slot][channel];
            for b in 0..QMF {
                let table = &self.basis_by_tap[b * FFT_SIZE * RANK..];
                for r in 0..RANK {
                    let mut sum = 0.0;
                    for tap in 0..FFT_SIZE {
                        sum += source[tap] * table[tap * RANK + r];
                    }
                    self.joined[9 + slot][channel][b][r] = sum;
                }
            }
        }
        output[..slots * 2 * QMF].fill(0.0);
        for lag in 0..10 {
            for slot in 0..slots {
                let source_slot = 9 + slot - lag;
                for channel in 0..2 {
                    for b in 0..QMF {
                        let mut sum = 0.0;
                        for r in 0..RANK {
                            sum += self.joined[source_slot][channel][b][r] * self.taps[b][lag][r];
                        }
                        output[(slot * 2 + channel) * QMF + b] += sum;
                    }
                }
            }
        }
        for lag in 0..9 {
            self.history[lag] = self.joined[slots + lag];
        }
    }
}

struct RealSh;

impl RealSh {
    fn evaluate(direction: &[f64; 3], basis: &mut [f64; TERMS]) {
        let azimuth = direction[1].atan2(direction[0]);
        let x = direction[2].clamp(-1.0, 1.0);
        let mut pmm = [0.0f64; ORDER + 1];
        for m in 0..=ORDER {
            pmm[m] = Self::pmm_value(m, x);
        }
        let mut norm = [[0.0f64; ORDER + 1]; ORDER + 1];
        for degree in 0..=ORDER {
            for absolute in 0..=degree {
                norm[degree][absolute] =
                    ((2.0 * degree as f64 + 1.0) / (4.0 * PI)
                        * Self::factorial_ratio(degree, absolute))
                    .sqrt();
            }
        }
        let mut index = 0usize;
        for degree in 0..=ORDER {
            for order in -(degree as i32)..=(degree as i32) {
                let absolute = order.unsigned_abs() as usize;
                let normalization = norm[degree][absolute];
                let legendre = Self::associated_legendre(degree, absolute, x, pmm[absolute]);
                if order > 0 {
                    basis[index] = 2.0f64.sqrt()
                        * normalization
                        * legendre
                        * (order as f64 * azimuth).cos();
                } else if order < 0 {
                    basis[index] = 2.0f64.sqrt()
                        * normalization
                        * legendre
                        * ((absolute as f64) * azimuth).sin();
                } else {
                    basis[index] = normalization * legendre;
                }
                index += 1;
            }
        }
    }

    fn factorial_ratio(degree: usize, order: usize) -> f64 {
        let mut ratio = 1.0;
        let mut value = degree - order + 1;
        while value <= degree + order {
            ratio /= value as f64;
            value += 1;
        }
        ratio
    }

    fn pmm_value(m: usize, x: f64) -> f64 {
        if m == 0 {
            return 1.0;
        }
        let mut double_factorial = 1.0;
        let mut value = 1usize;
        while value < 2 * m {
            double_factorial *= value as f64;
            value += 2;
        }
        let mut result = double_factorial * (1.0 - x * x).max(0.0).powf(0.5 * m as f64);
        if m % 2 == 1 {
            result = -result;
        }
        result
    }

    fn associated_legendre(degree: usize, order: usize, x: f64, pmm: f64) -> f64 {
        if degree == order {
            return pmm;
        }
        let mut pm1 = pmm;
        let mut pmm1 = (2.0 * order as f64 + 1.0) * x * pmm;
        if degree == order + 1 {
            return pmm1;
        }
        let mut result = 0.0;
        for l in order + 2..=degree {
            result = ((2.0 * l as f64 - 1.0) * x * pmm1
                - (l as f64 + order as f64 - 1.0) * pm1)
                / (l as f64 - order as f64);
            pm1 = pmm1;
            pmm1 = result;
        }
        result
    }
}

#[derive(Clone)]
struct Path {
    delay_slots: [i32; 2],
    transfer: [[Complex; HYBRID]; 2],
}

#[derive(Clone)]
struct SourceState {
    position: [f64; 3],
    profile: i32,
    gain: f64,
    enabled: bool,
    special_lfe: bool,
    current: Vec<Path>,
    target: Vec<Path>,
    fade_position: i32,
    fade_total: i32,
    late_current: f64,
    late_start: f64,
    late_target: f64,
    late_fade_position: i64,
    late_fade_total: i64,
    memo_position: [f64; 3],
    memo_effective: f64,
    memo_profile: i32,
    memo_special_lfe: i32,
    memo_valid: bool,
    memo_paths: Vec<Path>,
}

impl Default for SourceState {
    fn default() -> Self {
        Self {
            position: [0.0, 1.0, 0.0],
            profile: 1,
            gain: 1.0,
            enabled: true,
            special_lfe: false,
            current: Vec::new(),
            target: Vec::new(),
            fade_position: 0,
            fade_total: 0,
            late_current: 0.0,
            late_start: 0.0,
            late_target: 0.0,
            late_fade_position: 0,
            late_fade_total: 0,
            memo_position: [0.0; 3],
            memo_effective: 0.0,
            memo_profile: 0,
            memo_special_lfe: 0,
            memo_valid: false,
            memo_paths: Vec::new(),
        }
    }
}

/// Room constants the reference's native bridge passes for its default shoebox.
#[derive(Clone, Copy)]
pub struct RoomConstants {
    pub dims: [f64; 3],
    pub listener: [f64; 3],
    pub wall_gains: [f64; 6],
    pub speed_of_sound: f64,
    pub fdn_delays: [u32; 4],
    pub fdn_feedback: [f64; 4],
    pub damping: f64,
    pub fdn_output_gain: f64,
    pub allpass_delays: [u32; 2],
    pub allpass_gains: [f64; 2],
    pub enable_early_reflections: bool,
    pub enable_late_room: bool,
}

impl Default for RoomConstants {
    fn default() -> Self {
        Self {
            dims: [18.0, 18.0, 14.0],
            listener: [9.0, 9.0, 7.0],
            wall_gains: [0.62, 0.60, 0.58, 0.61, 0.52, 0.56],
            speed_of_sound: 343.3,
            fdn_delays: [1427, 1783, 1973, 2099],
            fdn_feedback: [
                0.7853685923259284,
                0.7394299865898056,
                0.7160221718631921,
                0.7009092068085467,
            ],
            damping: 0.32,
            fdn_output_gain: 0.22,
            allpass_delays: [113, 331],
            allpass_gains: [0.63, 0.51],
            enable_early_reflections: true,
            enable_late_room: true,
        }
    }
}

pub struct BinauralRenderer {
    analysis: QmfAnalysis,
    hybrid_analysis: HybridAnalysis,
    hybrid_synthesis: HybridSynthesis,
    synthesis: QmfSynthesis,
    kernels_ready: bool,
    field_ready: bool,
    room_ready: bool,
    field_coeff: [[[Complex; HYBRID]; 2]; TERMS],
    delay_coeff: [[f64; 2]; TERMS],
    delay_bounds: [[f64; 2]; 2],
    centers: [f64; HYBRID],
    measurement_radius: f64,
    hrtf_slots: u32,
    dims: [f64; 3],
    listener: [f64; 3],
    wall_gain: [f64; 6],
    speed: f64,
    fdn_delays: [u32; 4],
    fdn_feedback: [f64; 4],
    damping: f64,
    fdn_gain: f64,
    allpass_delays: [u32; 2],
    allpass_gains: [f64; 2],
    enable_early_reflections: bool,
    enable_late_room: bool,
    /// Listener pose (an am-hook extension, not in the reference): the world -> head rotation and
    /// the head's offset from the room's listening position in metres.  While the head is not
    /// turned and has not moved, every path is computed exactly as the reference does.
    head: [[f64; 3]; 3],
    head_turned: bool,
    walk: [f64; 3],
    walking: bool,
    latency_to_discard: u32,
    processed_input_samples: u64,
    processed_slots: i64,
    history_slots: u32,
    position: u32,
    maximum_early_delay: f64,
    history: Vec<Vec<Complex>>,
    sources: Vec<SourceState>,
    fdn_buffers: [Vec<f64>; 4],
    fdn_positions: [u32; 4],
    damping_state: [f64; 4],
    allpass_buffers: [Vec<f64>; 2],
    allpass_positions: [u32; 2],
    late_ring: [f64; 2 * LATENCY],
    late_pos: u32,
    qmf_work: Vec<Complex>,
    hybrid_work: Vec<Complex>,
    qmf_synth_work: Vec<Complex>,
    pcm_work: Vec<f64>,
    output: Vec<f64>,
    mono: Vec<f64>,
    late_pcm: Vec<f64>,
    diffused: Vec<f64>,
    allpass_work: Vec<f64>,
    direct_early: Vec<Complex>,
}

impl Default for BinauralRenderer {
    fn default() -> Self {
        Self::new()
    }
}

impl BinauralRenderer {
    pub fn new() -> Self {
        Self {
            analysis: QmfAnalysis::new(),
            hybrid_analysis: HybridAnalysis::new(),
            hybrid_synthesis: HybridSynthesis::new(),
            synthesis: QmfSynthesis::new(),
            kernels_ready: false,
            field_ready: false,
            room_ready: false,
            field_coeff: [[[Complex::default(); HYBRID]; 2]; TERMS],
            delay_coeff: [[0.0; 2]; TERMS],
            delay_bounds: [[0.0; 2]; 2],
            centers: [0.0; HYBRID],
            measurement_radius: 1.0,
            hrtf_slots: 0,
            dims: [0.0; 3],
            listener: [0.0; 3],
            wall_gain: [0.0; 6],
            speed: 343.3,
            fdn_delays: [0; 4],
            fdn_feedback: [0.0; 4],
            damping: 0.32,
            fdn_gain: 0.22,
            allpass_delays: [0; 2],
            allpass_gains: [0.0; 2],
            enable_early_reflections: true,
            enable_late_room: true,
            head: IDENTITY,
            head_turned: false,
            walk: [0.0; 3],
            walking: false,
            latency_to_discard: LATENCY as u32,
            processed_input_samples: 0,
            processed_slots: 0,
            history_slots: EARLY_HISTORY as u32,
            position: 0,
            maximum_early_delay: 0.0,
            history: Vec::new(),
            sources: Vec::new(),
            fdn_buffers: [Vec::new(), Vec::new(), Vec::new(), Vec::new()],
            fdn_positions: [0; 4],
            damping_state: [0.0; 4],
            allpass_buffers: [Vec::new(), Vec::new()],
            allpass_positions: [0; 2],
            late_ring: [0.0; 2 * LATENCY],
            late_pos: 0,
            qmf_work: vec![Complex::default(); MAX_SLOTS * CHANNELS * QMF],
            hybrid_work: vec![Complex::default(); MAX_SLOTS * CHANNELS * HYBRID],
            qmf_synth_work: vec![Complex::default(); MAX_SLOTS * 2 * QMF],
            pcm_work: vec![0.0; MAX_SLOTS * 2 * 64],
            output: vec![0.0; MAX_BLOCK_SAMPLES * 2],
            mono: Vec::new(),
            late_pcm: Vec::new(),
            diffused: Vec::new(),
            allpass_work: Vec::new(),
            direct_early: Vec::new(),
        }
    }

    pub fn configure_kernels(&mut self, kernels: &Kernels) -> Result<()> {
        self.analysis.configure(&kernels.qmf_analysis);
        self.hybrid_analysis.configure(&kernels.hybrid_low);
        self.hybrid_synthesis
            .configure(kernels.hybrid_indices, &kernels.hybrid_values, kernels.hybrid_count);
        self.synthesis.configure(kernels.qmf_basis, kernels.qmf_taps);
        self.kernels_ready = true;
        self.reset();
        Ok(())
    }

    pub fn configure_field(&mut self, field: &Field) -> Result<()> {
        if field.coefficients.len() != TERMS * 2 * HYBRID * 2
            || field.delay_coefficients.len() != TERMS * 2
            || field.delay_bounds.len() != 4
            || field.band_centers_hz.len() != HYBRID
        {
            return Err(Error::new(
                ErrorKind::HrtfFormat,
                "render",
                "compiled HRTF field has unexpected array sizes",
            ));
        }
        for term in 0..TERMS {
            for ear in 0..2 {
                for band in 0..HYBRID {
                    let source = ((term * 2 + ear) * HYBRID + band) * 2;
                    self.field_coeff[term][ear][band] = Complex {
                        re: field.coefficients[source],
                        im: field.coefficients[source + 1],
                    };
                }
                self.delay_coeff[term][ear] = field.delay_coefficients[term * 2 + ear];
            }
        }
        self.delay_bounds[0][0] = field.delay_bounds[0];
        self.delay_bounds[0][1] = field.delay_bounds[1];
        self.delay_bounds[1][0] = field.delay_bounds[2];
        self.delay_bounds[1][1] = field.delay_bounds[3];
        for (index, value) in field.band_centers_hz.iter().enumerate() {
            self.centers[index] = *value;
        }
        self.measurement_radius = field.measurement_radius_m;
        let maximum = self.delay_bounds[0][1].max(self.delay_bounds[1][1]);
        self.hrtf_slots = (maximum / HOP as f64).ceil() as u32;
        self.field_ready = true;
        self.reset();
        Ok(())
    }

    pub fn configure_room(&mut self, room: &RoomConstants) -> Result<()> {
        if room.fdn_delays.contains(&0)
            || room.allpass_delays.contains(&0)
        {
            return Err(Error::new(
                ErrorKind::InvalidArgument,
                "render",
                "invalid sofa binaural room configuration",
            ));
        }
        self.dims = room.dims;
        self.listener = room.listener;
        self.wall_gain = room.wall_gains;
        self.speed = room.speed_of_sound;
        self.fdn_delays = room.fdn_delays;
        self.fdn_feedback = room.fdn_feedback;
        self.damping = room.damping;
        self.fdn_gain = room.fdn_output_gain;
        self.allpass_delays = room.allpass_delays;
        self.allpass_gains = room.allpass_gains;
        self.enable_early_reflections = room.enable_early_reflections;
        self.enable_late_room = room.enable_late_room;
        for line in 0..4 {
            self.fdn_buffers[line] = vec![0.0; self.fdn_delays[line] as usize];
        }
        for line in 0..2 {
            self.allpass_buffers[line] = vec![0.0; self.allpass_delays[line] as usize];
        }
        self.room_ready = true;
        self.reset();
        Ok(())
    }

    pub fn reset(&mut self) {
        self.analysis.reset();
        self.hybrid_analysis.reset();
        self.synthesis.reset();
        self.reset_state();
    }

    /// Turns and moves the listener: `rotation` maps world (ADM) directions into the head's frame
    /// (see [`head_rotation`]) and `walk` is the head's offset from the listening position in
    /// metres, kept inside the room.  The room stays where it is, so the early reflections change
    /// with the pose too.  Sources pick the new pose up on their next `set_source`, through the
    /// usual crossfade.
    pub fn set_listener_pose(&mut self, rotation: &[[f64; 3]; 3], walk: &[f64; 3]) {
        let mut clamped = [0.0f64; 3];
        for axis in 0..3 {
            let margin = 0.5f64.min(self.dims[axis] / 2.0);
            let low = margin - self.listener[axis];
            let high = self.dims[axis] - margin - self.listener[axis];
            clamped[axis] = if walk[axis].is_finite() { walk[axis].clamp(low.min(0.0), high.max(0.0)) } else { 0.0 };
        }
        self.head = *rotation;
        self.head_turned = *rotation != IDENTITY;
        self.walk = clamped;
        self.walking = clamped != [0.0; 3];
        for state in &mut self.sources {
            state.memo_valid = false;
        }
    }

    /// The listener's offset after clamping to the room.
    pub fn walk(&self) -> [f64; 3] {
        self.walk
    }

    fn reset_state(&mut self) {
        self.latency_to_discard = LATENCY as u32;
        self.processed_input_samples = 0;
        self.processed_slots = 0;
        self.position = 0;
        self.maximum_early_delay = 0.0;
        self.history_slots = EARLY_HISTORY as u32 + self.hrtf_slots;
        self.history = vec![vec![Complex::default(); self.history_slots as usize * HYBRID]; CHANNELS];
        self.sources = vec![SourceState::default(); CHANNELS];
        for line in 0..4 {
            self.fdn_positions[line] = 0;
            self.damping_state[line] = 0.0;
            self.fdn_buffers[line].fill(0.0);
        }
        for line in 0..2 {
            self.allpass_positions[line] = 0;
            self.allpass_buffers[line].fill(0.0);
        }
        self.late_pos = 0;
        self.late_ring = [0.0; 2 * LATENCY];
    }

    pub fn set_source(
        &mut self,
        source: usize,
        position: &[f64; 3],
        profile: u32,
        gain: f64,
        enabled: bool,
        special_lfe: bool,
        fade: bool,
    ) -> Result<()> {
        if !self.kernels_ready || !self.field_ready || !self.room_ready {
            return Err(Error::new(
                ErrorKind::State,
                "render",
                "sofa binaural renderer is not configured",
            ));
        }
        if source >= CHANNELS || profile > 2 {
            return Err(Error::new(
                ErrorKind::InvalidArgument,
                "render",
                "invalid sofa binaural source update",
            ));
        }
        {
            let state = &mut self.sources[source];
            state.position = *position;
            state.profile = profile as i32;
            state.gain = gain;
            state.enabled = enabled;
            state.special_lfe = special_lfe;
        }

        let effective = if enabled { gain } else { 0.0 };
        let memo_special_lfe = i32::from(special_lfe);
        let memo_hit = {
            let state = &self.sources[source];
            state.memo_valid
                && state.memo_profile == profile as i32
                && state.memo_special_lfe == memo_special_lfe
                && state.memo_position == *position
                && state.memo_effective == effective
        };
        let mut late_send = 0.0;
        let (direction, radius) = normalize_adm(position);
        let distance = MINIMUM_DISTANCE.max(radius * DISTANCE_M[profile as usize]);
        if !memo_hit {
            let paths = if special_lfe {
                vec![self.lfe_path(effective)]
            } else {
                self.ordinary_paths(&direction, distance, profile as i32, effective)
            };
            let state = &mut self.sources[source];
            state.memo_paths = paths;
            state.memo_position = *position;
            state.memo_effective = effective;
            state.memo_profile = profile as i32;
            state.memo_special_lfe = memo_special_lfe;
            state.memo_valid = true;
        }
        let paths = self.sources[source].memo_paths.clone();
        if !special_lfe && enabled && self.enable_late_room {
            let base = LATE_SEND[profile as usize];
            let radial = radius.max(0.0).sqrt().clamp(0.25, 1.5);
            late_send = effective * ROOM_CALIBRATION * base * radial;
        }
        self.set_late_target(source, late_send, fade);

        let state = &mut self.sources[source];
        let fade_slots = if fade && self.processed_slots > 0 {
            TRANSITION_SLOTS
        } else {
            0
        };
        if !state.target.is_empty() {
            state.current = core::mem::take(&mut state.target);
        }
        if self.processed_slots == 0 || fade_slots == 0 {
            state.current = paths;
            state.target.clear();
            state.fade_position = 0;
            state.fade_total = 0;
        } else {
            state.target = paths;
            state.fade_position = 0;
            state.fade_total = fade_slots as i32;
        }
        Ok(())
    }

    fn set_late_target(&mut self, source: usize, value: f64, fade: bool) {
        let fade_samples = if fade && self.processed_input_samples > 0 {
            (TRANSITION_SLOTS * HOP) as i64
        } else {
            0
        };
        let state = &mut self.sources[source];
        if fade_samples == 0 {
            state.late_current = value;
            state.late_start = value;
            state.late_target = value;
            state.late_fade_position = 0;
            state.late_fade_total = 0;
        } else {
            state.late_start = state.late_current;
            state.late_target = value;
            state.late_fade_position = 0;
            state.late_fade_total = fade_samples;
        }
    }

    fn direct_level_gain(profile: i32, distance: f64) -> f64 {
        if profile == 0 {
            return 1.0;
        }
        1.0 / (1.0 + COUPLING * distance * distance).sqrt()
    }

    fn inverse_distance_gain(&self, path_distance: f64) -> f64 {
        self.measurement_radius / path_distance
    }

    fn make_path(&self, direction: &[f64; 3], extra_delay: f64, amplitude: f64) -> Path {
        let mut basis = [0.0f64; TERMS];
        let direction = if self.head_turned { rotate(&self.head, direction) } else { *direction };
        // ADM (+X right, +Y front, +Z up) -> SOFA listener (+X front, +Y left).
        let listener_direction = [direction[1], -direction[0], direction[2]];
        RealSh::evaluate(&listener_direction, &mut basis);
        let mut aligned = [[Complex::default(); HYBRID]; 2];
        let mut delay_value = [0.0f64; 2];
        for term in 0..TERMS {
            for ear in 0..2 {
                delay_value[ear] += basis[term] * self.delay_coeff[term][ear];
            }
            let scale = basis[term];
            for ear in 0..2 {
                for band in 0..HYBRID {
                    let field = self.field_coeff[term][ear][band];
                    aligned[ear][band].re += field.re * scale;
                    aligned[ear][band].im += field.im * scale;
                }
            }
        }
        let mut delay = [0.0f64; 2];
        for ear in 0..2 {
            delay[ear] = delay_value[ear].clamp(self.delay_bounds[ear][0], self.delay_bounds[ear][1]);
        }
        let mut path = Path { delay_slots: [0; 2], transfer: [[Complex::default(); HYBRID]; 2] };
        for ear in 0..2 {
            let total = delay[ear] + extra_delay;
            let slots = (total / HOP as f64).floor();
            path.delay_slots[ear] = slots as i32;
            let residual = total - slots * HOP as f64;
            for band in 0..HYBRID {
                let phase = -2.0 * PI * self.centers[band] * residual / SAMPLE_RATE;
                let rotated = Complex {
                    re: aligned[ear][band].re * phase.cos() - aligned[ear][band].im * phase.sin(),
                    im: aligned[ear][band].re * phase.sin() + aligned[ear][band].im * phase.cos(),
                };
                path.transfer[ear][band] = mulr(rotated, amplitude);
            }
        }
        path
    }

    fn lfe_path(&self, gain: f64) -> Path {
        let mut path = Path { delay_slots: [0; 2], transfer: [[Complex::default(); HYBRID]; 2] };
        for band in 0..HYBRID {
            let frequency = self.centers[band];
            let mut lowpass = 1.0;
            if frequency >= 180.0 {
                lowpass = 0.0;
            } else if frequency > 120.0 {
                let amount = (frequency - 120.0) / 60.0;
                let value = (0.5 * PI * amount).cos();
                lowpass = value * value;
            }
            let value = gain * lowpass / 2.0f64.sqrt();
            path.transfer[0][band] = Complex { re: value, im: 0.0 };
            path.transfer[1][band] = Complex { re: value, im: 0.0 };
        }
        path
    }

    fn ordinary_paths(
        &mut self,
        direction: &[f64; 3],
        distance: f64,
        profile: i32,
        gain: f64,
    ) -> Vec<Path> {
        let mut paths = Vec::new();
        let source = [
            self.listener[0] + direction[0] * distance,
            self.listener[1] + direction[1] * distance,
            self.listener[2] + direction[2] * distance,
        ];
        // The ears: the listening position, or where the listener has walked to (`walk` is zero
        // otherwise, and adding zero keeps the reference's values)
        let ear = [
            self.listener[0] + self.walk[0],
            self.listener[1] + self.walk[1],
            self.listener[2] + self.walk[2],
        ];
        let mut direction = *direction;
        let mut distance = distance;
        let mut direct_gain = gain * Self::direct_level_gain(profile, distance);
        if self.walking {
            // The object stays where the mix put it: aim at it from the new position, and let its
            // level follow the change of distance (+6 dB at half the distance, within +-12 dB)
            let vector = [source[0] - ear[0], source[1] - ear[1], source[2] - ear[2]];
            let length = (vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2]).sqrt();
            if length > 1.0e-9 {
                direction = [vector[0] / length, vector[1] / length, vector[2] / length];
            }
            let walked = MINIMUM_DISTANCE.max(length);
            let proximity = (distance / walked).clamp(0.25, 4.0);
            distance = walked;
            direct_gain = gain * Self::direct_level_gain(profile, distance) * proximity;
        }
        paths.push(self.make_path(&direction, 0.0, direct_gain));
        if self.enable_early_reflections {
            for axis in 0..3 {
                for side in 0..2 {
                    let mut image = source;
                    image[axis] = if side == 0 {
                        -image[axis]
                    } else {
                        2.0 * self.dims[axis] - image[axis]
                    };
                    let vector = [
                        image[0] - ear[0],
                        image[1] - ear[1],
                        image[2] - ear[2],
                    ];
                    let path_distance =
                        (vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2]).sqrt();
                    let path_direction = [
                        vector[0] / path_distance,
                        vector[1] / path_distance,
                        vector[2] / path_distance,
                    ];
                    let extra =
                        (0.0f64).max((path_distance - distance) * SAMPLE_RATE / self.speed);
                    let air = (-AIR * (path_distance - distance).max(0.0)).exp();
                    let amplitude = gain
                        * ROOM_CALIBRATION
                        * self.wall_gain[axis * 2 + side]
                        * air
                        * self.inverse_distance_gain(path_distance);
                    let path = self.make_path(&path_direction, extra, amplitude);
                    self.maximum_early_delay = self.maximum_early_delay.max(extra);
                    paths.push(path);
                }
            }
        }
        paths
    }

    pub fn process(
        &mut self,
        input: &[f64],
        sample_count: usize,
        output_gain: f64,
        output: &mut [f64],
    ) -> Result<usize> {
        if sample_count == 0 || sample_count > MAX_BLOCK_SAMPLES || !sample_count.is_multiple_of(HOP) {
            return Err(Error::new(
                ErrorKind::InvalidArgument,
                "render",
                "sofa binaural process requires 64-sample alignment",
            ));
        }
        let slots = sample_count / HOP;
        self.process_internal(Some(input), slots, output_gain);
        let skip = (self.latency_to_discard as usize).min(sample_count);
        self.latency_to_discard -= skip as u32;
        self.processed_input_samples += sample_count as u64;
        output[..(sample_count - skip) * 2]
            .copy_from_slice(&self.output[skip * 2..sample_count * 2]);
        Ok(sample_count - skip)
    }

    pub fn finish(&mut self, flush_samples: usize, output: &mut [f64]) -> Result<usize> {
        if flush_samples == 0 || flush_samples > MAX_BLOCK_SAMPLES || !flush_samples.is_multiple_of(HOP) {
            return Err(Error::new(
                ErrorKind::InvalidArgument,
                "render",
                "invalid sofa binaural finish request",
            ));
        }
        let slots = flush_samples / HOP;
        self.process_internal(None, slots, 1.0);
        let skip = (self.latency_to_discard as usize).min(flush_samples);
        self.latency_to_discard -= skip as u32;
        self.processed_input_samples += flush_samples as u64;
        output[..(flush_samples - skip) * 2]
            .copy_from_slice(&self.output[skip * 2..flush_samples * 2]);
        Ok(flush_samples - skip)
    }

    fn process_internal(&mut self, input: Option<&[f64]>, slots: usize, output_gain: f64) {
        let sample_count = slots * HOP;
        // 1) late send envelopes -> mono
        self.mono.clear();
        self.mono.resize(sample_count, 0.0);
        for source in 0..CHANNELS {
            let state = &mut self.sources[source];
            let total = state.late_fade_total;
            if total == 0 {
                if let Some(input) = input {
                    if state.late_current != 0.0 {
                        for s in 0..sample_count {
                            self.mono[s] += input[s * CHANNELS + source] * state.late_current;
                        }
                    }
                }
                continue;
            }
            let mut position = state.late_fade_position;
            for s in 0..sample_count {
                position += 1;
                let amount = (position as f64 / total as f64).clamp(0.0, 1.0);
                let value = state.late_start * (1.0 - amount) + state.late_target * amount;
                if let Some(input) = input {
                    self.mono[s] += input[s * CHANNELS + source] * value;
                }
            }
            if position >= total {
                state.late_current = state.late_target;
                state.late_start = state.late_target;
                state.late_fade_position = 0;
                state.late_fade_total = 0;
            } else {
                let amount = (position as f64 / total as f64).clamp(0.0, 1.0);
                state.late_current = state.late_start * (1.0 - amount) + state.late_target * amount;
                state.late_fade_position = position;
            }
        }

        // 2) FDN + 961-sample stereo delay
        self.late_pcm.clear();
        self.late_pcm.resize(sample_count * 2, 0.0);
        if self.enable_late_room {
            self.diffused.clear();
            self.diffused.extend_from_slice(&self.mono);
            for line in 0..2 {
                self.allpass(line);
                core::mem::swap(&mut self.diffused, &mut self.allpass_work);
            }
            for s in 0..sample_count {
                let value = self.diffused[s];
                let mut delayed = [0.0f64; 4];
                for line in 0..4 {
                    delayed[line] =
                        self.fdn_buffers[line][self.fdn_positions[line] as usize];
                }
                let mut damping_state = [0.0f64; 4];
                for line in 0..4 {
                    damping_state[line] =
                        self.damping * self.damping_state[line] + (1.0 - self.damping) * delayed[line];
                    self.damping_state[line] = damping_state[line];
                }
                let fdn_left = damping_state[0] + damping_state[1]
                    - damping_state[2]
                    - damping_state[3];
                let fdn_right = damping_state[0] - damping_state[1] + damping_state[2]
                    - damping_state[3];
                let out_left = self.late_ring[self.late_pos as usize * 2];
                let out_right = self.late_ring[self.late_pos as usize * 2 + 1];
                self.late_pcm[s * 2] = out_left;
                self.late_pcm[s * 2 + 1] = out_right;
                self.late_ring[self.late_pos as usize * 2] = self.fdn_gain * 0.5 * fdn_left;
                self.late_ring[self.late_pos as usize * 2 + 1] = self.fdn_gain * 0.5 * fdn_right;
                self.late_pos = (self.late_pos + 1) % LATENCY as u32;
                let mut feedback = [0.0f64; 4];
                for target in 0..4u32 {
                    let mut acc = 0.0;
                    for source_line in 0..4u32 {
                        let odd = (target & source_line).count_ones() & 1 != 0;
                        let sign = if odd { -1.0 } else { 1.0 };
                        acc += sign * damping_state[source_line as usize] * self.fdn_feedback[source_line as usize];
                    }
                    feedback[target as usize] = 0.5 * acc;
                }
                let input_vector = [0.5, -0.5, 0.5, 0.5];
                for line in 0..4 {
                    let write = input_vector[line] * value + feedback[line];
                    self.fdn_buffers[line][self.fdn_positions[line] as usize] = write;
                    self.fdn_positions[line] =
                        (self.fdn_positions[line] + 1) % self.fdn_delays[line];
                }
            }
        }

        // 3) analysis chain
        let silence;
        let analysis_input: &[f64] = match input {
            Some(input) => input,
            None => {
                silence = vec![0.0; sample_count * CHANNELS];
                &silence
            }
        };
        self.analysis.process(analysis_input, slots, &mut self.qmf_work);
        self.hybrid_analysis
            .process(&self.qmf_work, slots, &mut self.hybrid_work);

        // 4) per-object direct/early with crossfade
        self.direct_early.clear();
        self.direct_early.resize(slots * 2 * HYBRID, Complex::default());
        for slot in 0..slots {
            let hybrid_slot = &self.hybrid_work[slot * CHANNELS * HYBRID..];
            for source in 0..CHANNELS {
                let start = self.position as usize * HYBRID;
                self.history[source][start..start + HYBRID]
                    .copy_from_slice(&hybrid_slot[source * HYBRID..(source + 1) * HYBRID]);
            }
            let out_start = slot * 2 * HYBRID;
            let position = self.position;
            let history_slots = self.history_slots;
            {
                let history = &self.history;
                let sources = &mut self.sources;
                let direct = &mut self.direct_early;
                for source in (0..CHANNELS).rev() {
                    let state = &mut sources[source];
                    let row = &history[source];
                    if state.target.is_empty() {
                        Self::render_paths(
                            &mut direct[out_start..out_start + 2 * HYBRID],
                            &state.current,
                            row,
                            position,
                            history_slots,
                            1.0,
                        );
                        continue;
                    }
                    state.fade_position += 1;
                    let amount =
                        (state.fade_position as f64 / state.fade_total as f64).clamp(0.0, 1.0);
                    Self::render_paths(
                        &mut direct[out_start..out_start + 2 * HYBRID],
                        &state.current,
                        row,
                        position,
                        history_slots,
                        1.0 - amount,
                    );
                    Self::render_paths(
                        &mut direct[out_start..out_start + 2 * HYBRID],
                        &state.target,
                        row,
                        position,
                        history_slots,
                        amount,
                    );
                    if state.fade_position >= state.fade_total {
                        state.current = core::mem::take(&mut state.target);
                        state.fade_position = 0;
                        state.fade_total = 0;
                    }
                }
            }
            self.position = (self.position + 1) % self.history_slots;
            self.processed_slots += 1;
        }

        // 5) synthesis chain
        self.hybrid_synthesis
            .process(&self.direct_early, slots, &mut self.qmf_synth_work);
        self.synthesis.process(&self.qmf_synth_work, slots, &mut self.pcm_work);

        // 6) mix, gain, interleave [samples][2]
        for s in 0..sample_count {
            let slot = s / HOP;
            let b = s % HOP;
            let direct_left = self.pcm_work[slot * 2 * QMF + b];
            let direct_right = self.pcm_work[(slot * 2 + 1) * QMF + b];
            self.output[s * 2] = (direct_left + self.late_pcm[s * 2]) * output_gain;
            self.output[s * 2 + 1] = (direct_right + self.late_pcm[s * 2 + 1]) * output_gain;
        }
    }

    fn render_paths(
        out: &mut [Complex],
        paths: &[Path],
        history: &[Complex],
        position: u32,
        history_slots: u32,
        scale: f64,
    ) {
        for path in paths {
            let slots = history_slots as i32;
            let raw0 = position as i32 + slots - path.delay_slots[0];
            let raw1 = position as i32 + slots - path.delay_slots[1];
            let index0 = if raw0 >= slots {
                raw0 - slots
            } else if raw0 < 0 {
                raw0 + slots
            } else {
                raw0
            };
            let index1 = if raw1 >= slots {
                raw1 - slots
            } else if raw1 < 0 {
                raw1 + slots
            } else {
                raw1
            };
            let h0 = &history[index0 as usize * HYBRID..];
            let h1 = &history[index1 as usize * HYBRID..];
            for band in 0..HYBRID {
                let (hr0, hi0) = (h0[band].re, h0[band].im);
                let (hr1, hi1) = (h1[band].re, h1[band].im);
                let tap0 = path.transfer[0][band];
                let tap1 = path.transfer[1][band];
                out[band].re += hr0 * tap0.re * scale - hi0 * tap0.im * scale;
                out[band].im += hr0 * tap0.im * scale + hi0 * tap0.re * scale;
                out[HYBRID + band].re += hr1 * tap1.re * scale - hi1 * tap1.im * scale;
                out[HYBRID + band].im += hr1 * tap1.im * scale + hi1 * tap1.re * scale;
            }
        }
    }

    fn allpass(&mut self, line: usize) {
        let source = core::mem::take(&mut self.diffused);
        self.allpass_work.clear();
        self.allpass_work.resize(source.len(), 0.0);
        let gain = self.allpass_gains[line];
        let delay = self.allpass_delays[line];
        let buffer = &mut self.allpass_buffers[line];
        let mut position = self.allpass_positions[line];
        for i in 0..source.len() {
            let delayed = buffer[position as usize];
            let result = delayed - gain * source[i];
            buffer[position as usize] = source[i] + gain * result;
            position = (position + 1) % delay;
            self.allpass_work[i] = result;
        }
        self.allpass_positions[line] = position;
    }

}

const IDENTITY: [[f64; 3]; 3] = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

fn rotate(matrix: &[[f64; 3]; 3], vector: &[f64; 3]) -> [f64; 3] {
    let mut out = [0.0f64; 3];
    for row in 0..3 {
        out[row] = matrix[row][0] * vector[0] + matrix[row][1] * vector[1] + matrix[row][2] * vector[2];
    }
    out
}

/// The world -> head rotation for [`BinauralRenderer::set_listener_pose`], in ADM axes (+X right,
/// +Y front, +Z up): the head turns left by `yaw`, then looks up by `pitch`, then tilts its right
/// ear down by `roll` (radians).  All zero gives the identity.
pub fn head_rotation(yaw: f64, pitch: f64, roll: f64) -> [[f64; 3]; 3] {
    if yaw == 0.0 && pitch == 0.0 && roll == 0.0 {
        return IDENTITY;
    }
    let (sy, cy) = yaw.sin_cos();
    let (sp, cp) = pitch.sin_cos();
    let (sr, cr) = roll.sin_cos();
    let turn = [[cy, -sy, 0.0], [sy, cy, 0.0], [0.0, 0.0, 1.0]];
    let nod = [[1.0, 0.0, 0.0], [0.0, cp, -sp], [0.0, sp, cp]];
    let tilt = [[cr, 0.0, sr], [0.0, 1.0, 0.0], [-sr, 0.0, cr]];
    let product = |a: &[[f64; 3]; 3], b: &[[f64; 3]; 3]| {
        let mut out = [[0.0f64; 3]; 3];
        for row in 0..3 {
            for column in 0..3 {
                out[row][column] = (0..3).map(|k| a[row][k] * b[k][column]).sum();
            }
        }
        out
    };
    // The head's orientation in the world, transposed: world directions in the head's frame
    let orientation = product(&product(&turn, &nod), &tilt);
    let mut inverse = [[0.0f64; 3]; 3];
    for row in 0..3 {
        for column in 0..3 {
            inverse[row][column] = orientation[column][row];
        }
    }
    inverse
}

/// Where the renderer places an ADM position, in metres from the listening position: the
/// position scaled by the profile's distance (the visualisation and the focus use this too).
pub fn source_offset(position: &[f64; 3], profile: u32) -> [f64; 3] {
    let scale = DISTANCE_M[(profile as usize).min(2)];
    [position[0] * scale, position[1] * scale, position[2] * scale]
}

fn normalize_adm(position: &[f64; 3]) -> ([f64; 3], f64) {
    let r = (position[0] * position[0] + position[1] * position[1] + position[2] * position[2]).sqrt();
    if r > 1.0e-15 {
        ([position[0] / r, position[1] / r, position[2] / r], r)
    } else {
        ([0.0, 1.0, 0.0], r)
    }
}

#[cfg(test)]
mod hrtf_regression {
    use super::*;
    use crate::jochrtf::{builtin_kernels, load_jochrtf};

    const D2: &[u8] = include_bytes!("../../../web/joc/hrtf/D2.jochrtf");
    const H3: &[u8] = include_bytes!("../../../web/joc/hrtf/H3.jochrtf");

    fn render_impulse(field: &crate::jochrtf::Field, position: [f64; 3]) -> (f64, f64) {
        render_posed(field, position, None)
    }

    fn render_posed(
        field: &crate::jochrtf::Field,
        position: [f64; 3],
        pose: Option<([[f64; 3]; 3], [f64; 3])>,
    ) -> (f64, f64) {
        let mut renderer = Box::new(BinauralRenderer::new());
        renderer
            .configure_kernels(&builtin_kernels())
            .expect("kernels");
        renderer.configure_field(field).expect("field");
        renderer.configure_room(&RoomConstants::default()).expect("room");
        if let Some((rotation, walk)) = pose {
            renderer.set_listener_pose(&rotation, &walk);
        }
        renderer
            .set_source(0, &position, 1, 1.0, true, false, false)
            .expect("source");
        let mut left = 0.0;
        let mut right = 0.0;
        let mut input = vec![0.0f64; 16 * 512];
        input[0] = 1.0;
        let mut output = vec![0.0f64; 512 * 2];
        for block in 0..24 {
            let written = renderer.process(&input, 512, 1.0, &mut output).expect("process");
            for frame in 0..written {
                left += output[frame * 2] * output[frame * 2];
                right += output[frame * 2 + 1] * output[frame * 2 + 1];
            }
            if block == 0 {
                input[0] = 0.0;
            }
        }
        (left, right)
    }

    #[test]
    fn every_shipped_field_loads_with_the_expected_shape() {
        for (name, bytes) in [("D2", D2), ("H3", H3)] {
            let field = load_jochrtf(bytes).expect(name);
            assert_eq!(field.coefficients.len(), 36 * 2 * 77 * 2, "{name} coefficients");
            assert_eq!(field.band_centers_hz.len(), 77, "{name} bands");
            assert_eq!(field.order, 5, "{name} order");
        }
    }

    #[test]
    fn hrtf_maps_adm_left_and_right_to_the_matching_ear() {
        // The renderer owns several megabyte-sized filter histories, so run it
        // on a thread with an explicit stack rather than the 2 MiB test default.
        std::thread::Builder::new()
            .stack_size(64 * 1024 * 1024)
            .spawn(|| {
                let field = load_jochrtf(D2).expect("D2");
                let (left_l, left_r) = render_impulse(&field, [-1.0, 0.0, 0.0]);
                let (right_l, right_r) = render_impulse(&field, [1.0, 0.0, 0.0]);
                let (front_l, front_r) = render_impulse(&field, [0.0, 1.0, 0.0]);
                assert!(left_l > left_r * 1.2, "ADM left: L={left_l} R={left_r}");
                assert!(right_r > right_l * 1.2, "ADM right: L={right_l} R={right_r}");
                let balance = (front_l - front_r).abs() / (front_l + front_r);
                assert!(balance < 0.2, "front is not centred: L={front_l} R={front_r}");
            })
            .expect("spawn")
            .join()
            .expect("hrtf direction test");
    }

    #[test]
    fn head_rotation_turns_the_scene_the_other_way() {
        let left = head_rotation(std::f64::consts::FRAC_PI_2, 0.0, 0.0);
        let front = rotate(&left, &[0.0, 1.0, 0.0]);
        assert!((front[0] - 1.0).abs() < 1e-12 && front[1].abs() < 1e-12, "{front:?}");
        let up = rotate(&head_rotation(0.0, std::f64::consts::FRAC_PI_2, 0.0), &[0.0, 1.0, 0.0]);
        assert!((up[2] + 1.0).abs() < 1e-12, "looking up puts the front below: {up:?}");
        assert_eq!(head_rotation(0.0, 0.0, 0.0), IDENTITY);
    }

    #[test]
    fn listener_pose_moves_the_image() {
        std::thread::Builder::new()
            .stack_size(64 * 1024 * 1024)
            .spawn(|| {
                let field = load_jochrtf(D2).expect("D2");
                let front = [0.0, 1.0, 0.0];
                let plain = render_impulse(&field, front);
                // The identity pose renders exactly as without one
                assert_eq!(render_posed(&field, front, Some((IDENTITY, [0.0; 3]))), plain);
                let quarter = std::f64::consts::FRAC_PI_2;
                let (l, r) = render_posed(&field, front, Some((head_rotation(quarter, 0.0, 0.0), [0.0; 3])));
                assert!(r > l * 1.2, "head turned left: the front source is on the right: L={l} R={r}");
                let (l, r) = render_posed(&field, front, Some((head_rotation(-quarter, 0.0, 0.0), [0.0; 3])));
                assert!(l > r * 1.2, "head turned right: the front source is on the left: L={l} R={r}");
                // Walking 1.5 m towards the source (2.19 m ahead) brings it closer and louder
                let (l, r) = render_posed(&field, front, Some((IDENTITY, [0.0, 1.5, 0.0])));
                assert!(l + r > (plain.0 + plain.1) * 2.0, "closer: {} vs {}", l + r, plain.0 + plain.1);
                // Walking past it puts it behind, still centred
                let (l, r) = render_posed(&field, front, Some((IDENTITY, [0.0, 4.0, 0.0])));
                assert!((l - r).abs() / (l + r) < 0.2, "behind is centred: L={l} R={r}");
            })
            .expect("spawn")
            .join()
            .expect("pose test");
    }
}
