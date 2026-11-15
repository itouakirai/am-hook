//! What the decoded PCM really contains, as opposed to what the format claims:
//! the bits actually used (zero-padded 16-bit audio in a 24-bit container) and
//! the bandwidth (upsampled audio leaves the band above the source's Nyquist
//! frequency at the container's quantization noise floor).

/// FFT size: about 11 Hz per bin at 44.1 kHz, 47 Hz at 192 kHz.
const N: usize = 4096;
const HOP: usize = N / 2;
/// Content counts only this far above the quantization noise floor.
const MARGIN_DB: f64 = 20.0;
/// Width of the moving average applied before searching the band limit.
const SMOOTH_HZ: f64 = 500.0;
/// The drop across the band limit is measured this far on each side.
const WALL_HZ: f64 = 1500.0;
/// Points in the reported spectrum (0 Hz to Nyquist, linear).
const SPECTRUM_POINTS: usize = 160;

pub struct Analyzer {
    channels: usize,
    bits: u8,
    rate: u32,
    /// OR of every right-justified sample, per channel.
    used_bits: Vec<u32>,
    peak: u32,
    frames: u64,
    pending: Vec<Vec<f64>>,
    power: Vec<f64>,
    windows: u64,
    fft: Fft,
    window: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Report {
    pub frames: u64,
    pub bits: u8,
    pub rate: u32,
    /// Container bits minus the low bits that are zero in every sample; None for digital silence.
    pub effective_bits: Option<u8>,
    pub peak_db: f64,
    /// Expected level of white quantization noise of the container in one bin.
    pub floor_db: f64,
    /// Highest frequency (Hz) whose smoothed level is MARGIN_DB above `floor_db`; 0 if none.
    pub band_limit: f64,
    /// Level just below the band limit minus the level just above it (0 at Nyquist).
    pub wall_db: f64,
    pub spectrum: Vec<f64>,
}

impl Analyzer {
    pub fn new(channels: usize, bits: u8, rate: u32) -> Self {
        let circle = unit_circle();
        let window = (0..N).map(|i| 0.5 - 0.5 * circle[i.min(N - i)].0).collect();
        Self {
            channels,
            bits,
            rate,
            used_bits: vec![0; channels],
            peak: 0,
            frames: 0,
            pending: vec![Vec::with_capacity(N + 4096); channels],
            power: vec![0.0; N / 2 + 1],
            windows: 0,
            fft: Fft::new(),
            window,
        }
    }

    /// Interleaved samples, left-justified in i32 as the `alac` decoder returns them.
    pub fn push(&mut self, pcm: &[i32]) {
        let shift = 32 - self.bits as u32;
        let scale = 1.0 / (1u64 << (self.bits - 1)) as f64;
        for frame in pcm.chunks_exact(self.channels) {
            for (channel, &value) in frame.iter().enumerate() {
                let sample = value >> shift;
                self.used_bits[channel] |= sample as u32;
                self.peak = self.peak.max(sample.unsigned_abs());
                self.pending[channel].push(sample as f64 * scale);
            }
        }
        self.frames += (pcm.len() / self.channels) as u64;
        while self.pending[0].len() >= N {
            self.accumulate();
            for channel in &mut self.pending {
                channel.drain(..HOP);
            }
        }
    }

    /// Adds the power spectrum of the first N pending samples of every channel.
    /// Two real channels share one complex FFT: with z = a + ib,
    /// |A[k]|^2 + |B[k]|^2 = (|Z[k]|^2 + |Z[N-k]|^2) / 2.
    fn accumulate(&mut self) {
        for pair in (0..self.channels).step_by(2) {
            let a = &self.pending[pair];
            let b = self.pending.get(pair + 1);
            let (re, im) = self.fft.input();
            for i in 0..N {
                re[i] = a[i] * self.window[i];
                im[i] = b.map_or(0.0, |b| b[i] * self.window[i]);
            }
            self.fft.run();
            let (re, im) = self.fft.input();
            let mag = |k: usize| re[k % N] * re[k % N] + im[k % N] * im[k % N];
            // power 的长度为 N/2 + 1
            for (k, power) in self.power.iter_mut().enumerate() {
                *power += if b.is_some() { (mag(k) + mag(N - k)) / 2.0 } else { mag(k) };
            }
            self.windows += if b.is_some() { 2 } else { 1 };
        }
    }

    pub fn finish(&self) -> Report {
        let bits = self.bits;
        let effective_bits = self
            .used_bits
            .iter()
            .filter(|&&used| used != 0)
            .map(|used| used.trailing_zeros().min(bits as u32 - 1) as u8)
            .min()
            .map(|zeros| bits - zeros);
        let peak_db = 20.0 * (self.peak as f64 / (1u64 << (bits - 1)) as f64).log10();
        // Uniform quantization noise LSB^2 / 12 lands in each bin with this
        // normalization (sum of squared window weights).
        let floor_db = 10.0 * (0.5f64.powi(2 * (bits as i32 - 1)) / 12.0).log10();
        let mut report = Report {
            frames: self.frames,
            bits,
            rate: self.rate,
            effective_bits,
            peak_db,
            floor_db,
            band_limit: 0.0,
            wall_db: 0.0,
            spectrum: Vec::new(),
        };
        if self.windows == 0 {
            return report;
        }
        let norm = self.windows as f64 * self.window.iter().map(|w| w * w).sum::<f64>();
        let psd: Vec<f64> = self.power.iter().map(|p| p / norm).collect();
        let bin_hz = self.rate as f64 / N as f64;
        let half = ((SMOOTH_HZ / 2.0 / bin_hz).round() as usize).max(1);
        let smooth: Vec<f64> = (0..psd.len())
            .map(|k| {
                let range = k.saturating_sub(half)..(k + half + 1).min(psd.len());
                db(psd[range.clone()].iter().sum::<f64>() / range.len() as f64)
            })
            .collect();
        if let Some(limit) = (1..smooth.len()).rev().find(|&k| smooth[k] > floor_db + MARGIN_DB) {
            report.band_limit = limit as f64 * bin_hz;
            let reach = (WALL_HZ / bin_hz).round() as usize;
            if limit + reach < smooth.len() {
                report.wall_db = smooth[limit.saturating_sub(reach)] - smooth[limit + reach];
            }
        }
        report.spectrum = (0..SPECTRUM_POINTS)
            .map(|i| {
                let range = i * psd.len() / SPECTRUM_POINTS..((i + 1) * psd.len() / SPECTRUM_POINTS).max(i * psd.len() / SPECTRUM_POINTS + 1);
                db(psd[range.clone()].iter().sum::<f64>() / range.len() as f64)
            })
            .collect();
        report
    }
}

/// Power to dB; digital silence is clamped far below any container's noise floor.
fn db(power: f64) -> f64 {
    10.0 * power.max(1e-20).log10()
}

/// Integers and one-decimal numbers are written by hand: `core::fmt` (and float
/// formatting even more) would considerably enlarge the wasm module.
fn push_int(out: &mut String, v: i64) {
    if v < 0 {
        out.push('-');
    }
    let mut digits = [0u8; 20];
    let mut n = v.unsigned_abs();
    let mut start = digits.len();
    loop {
        start -= 1;
        digits[start] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 {
            break;
        }
    }
    out.extend(digits[start..].iter().map(|&d| d as char));
}

fn push_num(out: &mut String, v: f64) {
    if !v.is_finite() {
        out.push_str("null");
        return;
    }
    let tenths = (v * 10.0).round() as i64;
    if tenths < 0 {
        out.push('-');
    }
    push_int(out, tenths.abs() / 10);
    out.push('.');
    push_int(out, tenths.abs() % 10);
}

impl Report {
    pub fn to_json(&self) -> String {
        let mut out = String::with_capacity(160 + self.spectrum.len() * 7);
        out.push_str("{\"frames\":");
        push_int(&mut out, self.frames as i64);
        out.push_str(",\"bits\":");
        push_int(&mut out, self.bits as i64);
        out.push_str(",\"rate\":");
        push_int(&mut out, self.rate as i64);
        out.push_str(",\"effectiveBits\":");
        match self.effective_bits {
            Some(bits) => push_int(&mut out, bits as i64),
            None => out.push_str("null"),
        }
        for (key, value) in [("peakDb", self.peak_db), ("floorDb", self.floor_db)] {
            out.push_str(",\"");
            out.push_str(key);
            out.push_str("\":");
            push_num(&mut out, value);
        }
        out.push_str(",\"bandLimit\":");
        push_int(&mut out, self.band_limit.round() as i64);
        out.push_str(",\"wallDb\":");
        push_num(&mut out, self.wall_db);
        out.push_str(",\"spectrum\":[");
        for (i, v) in self.spectrum.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            push_num(&mut out, *v);
        }
        out.push_str("]}");
        out
    }
}

/// (cos, sin) of 2πk/N for k in 0..=N/2. Built from half angles and rotations instead of
/// `f64::cos` / `f64::sin`, whose argument reduction alone would add 8 KB to the wasm module.
fn unit_circle() -> Vec<(f64, f64)> {
    // Halve π/2 down to 2π/N: cos(θ/2) = √((1 + cos θ) / 2), sin(θ/2) = sin θ / (2 cos(θ/2)).
    let (mut c, mut s) = (0.0f64, 1.0f64);
    for _ in 0..(N / 4).trailing_zeros() {
        let half = ((1.0 + c) / 2.0).sqrt();
        s /= 2.0 * half;
        c = half;
    }
    let mut out = Vec::with_capacity(N / 2 + 1);
    let (mut x, mut y) = (1.0f64, 0.0f64);
    for k in 0..=N / 2 {
        // Re-anchor at the exact quarter turn so the rotation error stays tiny.
        if k == N / 4 {
            (x, y) = (0.0, 1.0);
        }
        out.push((x, y));
        (x, y) = (x * c - y * s, x * s + y * c);
    }
    out
}

/// In-place iterative radix-2 complex FFT of size N.
struct Fft {
    re: Vec<f64>,
    im: Vec<f64>,
    cos: Vec<f64>,
    sin: Vec<f64>,
    reversed: Vec<usize>,
}

impl Fft {
    fn new() -> Self {
        let bits = N.trailing_zeros();
        let circle = unit_circle();
        Self {
            re: vec![0.0; N],
            im: vec![0.0; N],
            cos: circle[..N / 2].iter().map(|&(c, _)| c).collect(),
            sin: circle[..N / 2].iter().map(|&(_, s)| -s).collect(),
            reversed: (0..N).map(|i| i.reverse_bits() >> (usize::BITS - bits)).collect(),
        }
    }

    fn input(&mut self) -> (&mut [f64], &mut [f64]) {
        (&mut self.re, &mut self.im)
    }

    fn run(&mut self) {
        for i in 0..N {
            let j = self.reversed[i];
            if i < j {
                self.re.swap(i, j);
                self.im.swap(i, j);
            }
        }
        let mut size = 2;
        while size <= N {
            let step = N / size;
            for start in (0..N).step_by(size) {
                for k in 0..size / 2 {
                    let (wr, wi) = (self.cos[k * step], self.sin[k * step]);
                    let (a, b) = (start + k, start + k + size / 2);
                    let tr = self.re[b] * wr - self.im[b] * wi;
                    let ti = self.re[b] * wi + self.im[b] * wr;
                    self.re[b] = self.re[a] - tr;
                    self.im[b] = self.im[a] - ti;
                    self.re[a] += tr;
                    self.im[a] += ti;
                }
            }
            size *= 2;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    /// Deterministic white noise in [-1, 1).
    struct Noise(u64);
    impl Noise {
        fn next(&mut self) -> f64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (self.0 >> 11) as f64 / (1u64 << 52) as f64 - 1.0
        }
    }

    /// Left-justified interleaved stereo, `seconds` long, from a per-frame generator.
    fn render(bits: u8, rate: u32, seconds: f64, mut frame: impl FnMut(usize) -> [f64; 2]) -> Vec<i32> {
        let full = (1i64 << (bits - 1)) as f64;
        let mut out = Vec::new();
        for i in 0..(rate as f64 * seconds) as usize {
            for v in frame(i) {
                let q = (v * full).round().clamp(-full, full - 1.0) as i32;
                out.push(q << (32 - bits as u32));
            }
        }
        out
    }

    fn analyze(bits: u8, rate: u32, pcm: &[i32]) -> Report {
        let mut a = Analyzer::new(2, bits, rate);
        // Feed packet-sized chunks like the decoder does.
        for chunk in pcm.chunks(4096 * 2) {
            a.push(chunk);
        }
        a.finish()
    }

    /// Music-like content: tones up to `top` Hz with random phases, quieter towards the top.
    fn tones(rate: u32, top: f64) -> impl FnMut(usize) -> [f64; 2] {
        let mut noise = Noise(7);
        let partials: Vec<(f64, f64, f64)> = (0..60)
            .map(|i| {
                let f = 40.0 + (top - 40.0) * i as f64 / 59.0;
                (f, (1000.0 / f).min(1.0) / 80.0, noise.next() * PI)
            })
            .collect();
        move |i| {
            let t = i as f64 / rate as f64;
            let v: f64 = partials.iter().map(|(f, a, p)| a * (2.0 * PI * f * t + p).sin()).sum();
            [v, -v * 0.7]
        }
    }

    #[test]
    fn unit_circle_matches_libm() {
        for (k, (c, s)) in unit_circle().into_iter().enumerate() {
            let angle = 2.0 * PI * k as f64 / N as f64;
            assert!((c - angle.cos()).abs() < 1e-12 && (s - angle.sin()).abs() < 1e-12, "{k}");
        }
    }

    #[test]
    fn full_band_noise_reaches_nyquist() {
        let mut noise = Noise(1);
        let pcm = render(24, 96000, 2.0, |_| [noise.next() * 0.3, noise.next() * 0.3]);
        let r = analyze(24, 96000, &pcm);
        assert_eq!(r.effective_bits, Some(24));
        assert!(r.band_limit > 47000.0, "{r:?}");
        assert_eq!(r.wall_db, 0.0);
        assert_eq!(r.spectrum.len(), SPECTRUM_POINTS);
        // White noise of amplitude 0.3: variance 0.03 per bin, about -15 dB.
        assert!((r.spectrum[80] - 10.0 * 0.03f64.log10()).abs() < 1.0, "{}", r.spectrum[80]);
    }

    #[test]
    fn band_limited_content_shows_its_wall() {
        // Content to 20 kHz in a 96 kHz container, as if upsampled from 44.1 kHz.
        let pcm = render(24, 96000, 2.0, tones(96000, 20000.0));
        let r = analyze(24, 96000, &pcm);
        assert!((20000.0..20800.0).contains(&r.band_limit), "{r:?}");
        assert!(r.wall_db > 40.0, "{r:?}");
        assert!(r.spectrum[100] < r.floor_db + 10.0, "only quantization noise above the band limit");
        assert!((r.floor_db - -149.3).abs() < 0.1);
    }

    #[test]
    fn zero_padded_low_bits_are_not_counted() {
        // Left-justified, 16-bit samples are also 24-bit samples whose eight low bits are zero.
        let pcm = render(16, 44100, 1.0, tones(44100, 15000.0));
        assert_eq!(analyze(24, 44100, &pcm).effective_bits, Some(16));
        assert_eq!(analyze(16, 44100, &pcm).effective_bits, Some(16));
        assert_eq!(analyze(24, 44100, &render(24, 44100, 1.0, tones(44100, 15000.0))).effective_bits, Some(24));
    }

    #[test]
    fn silence_and_short_input() {
        let r = analyze(16, 44100, &vec![0; 44100 * 2]);
        assert_eq!(r.effective_bits, None);
        assert_eq!(r.band_limit, 0.0);
        assert!(r.peak_db.is_infinite());
        // Shorter than one FFT window: bits are known, the spectrum is not.
        let r = analyze(16, 44100, &render(16, 44100, 0.01, |_| [0.5, 0.5]));
        assert_eq!(r.effective_bits, Some(16 - 14));
        assert!(r.spectrum.is_empty());
        let json = r.to_json();
        assert!(json.contains("\"spectrum\":[]") && json.contains("\"effectiveBits\":2"), "{json}");
    }

    #[test]
    fn mono_matches_one_channel_of_stereo() {
        let mut noise = Noise(3);
        let left: Vec<i32> = render(16, 48000, 0.5, |_| [noise.next() * 0.5, 0.0]).chunks(2).map(|f| f[0]).collect();
        let mut mono = Analyzer::new(1, 16, 48000);
        mono.push(&left);
        let stereo: Vec<i32> = left.iter().flat_map(|&v| [v, v]).collect();
        let mut both = Analyzer::new(2, 16, 48000);
        both.push(&stereo);
        let (m, s) = (mono.finish(), both.finish());
        for (a, b) in m.spectrum.iter().zip(&s.spectrum) {
            assert!((a - b).abs() < 1e-6);
        }
    }

    #[test]
    fn json_is_well_formed() {
        let r = analyze(24, 48000, &render(24, 48000, 0.5, tones(48000, 10000.0)));
        let json = r.to_json();
        assert!(json.starts_with("{\"frames\":24000,\"bits\":24,\"rate\":48000,"), "{json}");
        assert_eq!(json.matches(',').count(), 8 + SPECTRUM_POINTS - 1);
        assert!(!json.contains("NaN") && !json.contains("inf"));
        let num = |v| {
            let mut out = String::new();
            push_num(&mut out, v);
            out
        };
        assert_eq!([num(-0.04), num(-149.26), num(3.95), num(f64::NEG_INFINITY)], ["0.0", "-149.3", "4.0", "null"]);
    }
}
