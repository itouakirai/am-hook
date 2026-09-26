//! Minimal ALAC packet decoder and FLAC verbatim-frame writer.
//! MP4 parsing/muxing stays in JavaScript, so this module is loaded only for ALAC playback.

use std::alloc::{alloc, dealloc, Layout};
use std::cell::RefCell;

use alac::{Decoder, StreamInfo};

struct Context {
    decoder: Decoder,
    pcm: Vec<i32>,
    frame: Vec<u8>,
    channels: usize,
    bits: u8,
    rate: u32,
    max_block: u32,
    samples: u32,
}

thread_local! {
    static CONTEXT: RefCell<Option<Context>> = const { RefCell::new(None) };
}

#[no_mangle]
pub extern "C" fn flac_alloc(len: usize) -> *mut u8 {
    unsafe { alloc(Layout::from_size_align_unchecked(len.max(1), 1)) }
}

/// # Safety
/// `ptr` and `len` must belong to the same `flac_alloc` call.
#[no_mangle]
pub unsafe extern "C" fn flac_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        dealloc(ptr, Layout::from_size_align_unchecked(len.max(1), 1));
    }
}

/// Returns 1 on success. The cookie is the 24-byte ALACSpecificConfig,
/// optionally preceded by an ALAC atom header.
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn flac_open(ptr: *const u8, len: usize) -> u32 {
    let Some(cookie) = (!ptr.is_null()).then(|| std::slice::from_raw_parts(ptr, len)) else {
        return 0;
    };
    let Ok(info) = StreamInfo::from_cookie(cookie) else {
        return 0;
    };
    let bits = info.bit_depth();
    let channels = info.channels() as usize;
    let rate = info.sample_rate();
    let capacity = info.max_samples_per_packet() as usize;
    let max_block = info.max_frames_per_packet();
    if !matches!(bits, 16 | 20 | 24 | 32)
        || !(1..=8).contains(&channels)
        || rate == 0
        || rate > 655_350
        || capacity == 0
        || capacity > 8 * 65535
    {
        return 0;
    }
    CONTEXT.with(|cell| {
        *cell.borrow_mut() = Some(Context {
            decoder: Decoder::new(info),
            pcm: vec![0; capacity],
            frame: Vec::new(),
            channels,
            bits,
            rate,
            max_block,
            samples: 0,
        });
    });
    1
}

#[no_mangle]
pub extern "C" fn flac_close() {
    CONTEXT.with(|cell| *cell.borrow_mut() = None);
}

#[no_mangle]
pub extern "C" fn flac_channels() -> u32 {
    CONTEXT.with(|cell| cell.borrow().as_ref().map_or(0, |c| c.channels as u32))
}

#[no_mangle]
pub extern "C" fn flac_bits() -> u32 {
    CONTEXT.with(|cell| cell.borrow().as_ref().map_or(0, |c| c.bits as u32))
}

#[no_mangle]
pub extern "C" fn flac_rate() -> u32 {
    CONTEXT.with(|cell| cell.borrow().as_ref().map_or(0, |c| c.rate))
}

#[no_mangle]
pub extern "C" fn flac_max_block() -> u32 {
    CONTEXT.with(|cell| cell.borrow().as_ref().map_or(0, |c| c.max_block))
}

#[no_mangle]
pub extern "C" fn flac_samples() -> u32 {
    CONTEXT.with(|cell| cell.borrow().as_ref().map_or(0, |c| c.samples))
}

#[no_mangle]
pub extern "C" fn flac_frame_ptr() -> *const u8 {
    CONTEXT.with(|cell| {
        cell.borrow()
            .as_ref()
            .map_or(std::ptr::null(), |c| c.frame.as_ptr())
    })
}

#[no_mangle]
pub extern "C" fn flac_frame_len() -> usize {
    CONTEXT.with(|cell| cell.borrow().as_ref().map_or(0, |c| c.frame.len()))
}

/// Decodes one ALAC packet and writes one FLAC frame. Returns 1 on success.
/// `sample_number` is the absolute PCM sample position, split into 32-bit words.
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn flac_encode(
    ptr: *const u8,
    len: usize,
    sample_lo: u32,
    sample_hi: u32,
) -> u32 {
    let Some(packet) = (!ptr.is_null()).then(|| std::slice::from_raw_parts(ptr, len)) else {
        return 0;
    };
    CONTEXT.with(|cell| {
        let mut borrow = cell.borrow_mut();
        let Some(ctx) = borrow.as_mut() else { return 0 };
        let Ok(pcm) = ctx.decoder.decode_packet(packet, &mut ctx.pcm) else {
            return 0;
        };
        let samples = pcm.len() / ctx.channels;
        // FLAC permits 1..15 samples in the final frame (RFC 9639 §4.1).
        // ALAC's final packet can be this short; rejecting it loses the whole
        // last HLS segment because the worker transcodes a segment atomically.
        if !(1..=65535).contains(&samples) {
            return 0;
        }
        ctx.samples = samples as u32;
        let sample_number = ((sample_hi as u64) << 32) | sample_lo as u64;
        write_verbatim_frame(
            &mut ctx.frame,
            pcm,
            ctx.channels,
            ctx.bits,
            samples,
            sample_number,
        );
        1
    })
}

fn crc8(bytes: &[u8]) -> u8 {
    let mut crc = 0u8;
    for &byte in bytes {
        crc ^= byte;
        for _ in 0..8 {
            crc = if crc & 0x80 != 0 {
                (crc << 1) ^ 0x07
            } else {
                crc << 1
            };
        }
    }
    crc
}

fn crc16(bytes: &[u8]) -> u16 {
    let mut crc = 0u16;
    for &byte in bytes {
        crc ^= (byte as u16) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x8005
            } else {
                crc << 1
            };
        }
    }
    crc
}

fn utf8_uint(out: &mut Vec<u8>, n: u64) {
    let count = if n < 0x80 {
        1
    } else if n < 0x800 {
        2
    } else if n < 0x10000 {
        3
    } else if n < 0x200000 {
        4
    } else if n < 0x4000000 {
        5
    } else if n < 0x80000000 {
        6
    } else {
        7
    };
    if count == 1 {
        out.push(n as u8);
        return;
    }
    let first_bits = if count == 7 { 0 } else { 7 - count };
    out.push((!0u8 << (8 - count)) | (((n >> (6 * (count - 1))) as u8) & ((1 << first_bits) - 1)));
    for i in (0..count - 1).rev() {
        out.push(0x80 | (((n >> (6 * i)) as u8) & 0x3f));
    }
}

struct BitWriter<'a> {
    out: &'a mut Vec<u8>,
    held: u8,
    used: u8,
}

impl<'a> BitWriter<'a> {
    fn new(out: &'a mut Vec<u8>) -> Self {
        Self {
            out,
            held: 0,
            used: 0,
        }
    }

    fn write(&mut self, value: u64, bits: u8) {
        for shift in (0..bits).rev() {
            self.held = (self.held << 1) | ((value >> shift) as u8 & 1);
            self.used += 1;
            if self.used == 8 {
                self.out.push(self.held);
                self.held = 0;
                self.used = 0;
            }
        }
    }

    fn finish(&mut self) {
        if self.used != 0 {
            self.out.push(self.held << (8 - self.used));
            self.held = 0;
            self.used = 0;
        }
    }
}

fn sample(pcm: &[i32], frame: usize, channel: usize, channels: usize, bits: u8) -> i64 {
    (pcm[frame * channels + channel] >> (32 - bits)) as i64
}

fn rice_parameter(
    pcm: &[i32],
    channel: usize,
    channels: usize,
    bits: u8,
    samples: usize,
) -> Option<u8> {
    let verbatim_bits = 8 + samples as u64 * bits as u64;
    let mut best = verbatim_bits;
    let mut chosen = None;
    for k in 0..=14u8 {
        let mut cost = 8 + bits as u64 + 10; // subframe, warmup, residual headers
        let mut previous = sample(pcm, 0, channel, channels, bits);
        for frame in 1..samples {
            let current = sample(pcm, frame, channel, channels, bits);
            let difference = current - previous;
            previous = current;
            if difference <= i32::MIN as i64 || difference > i32::MAX as i64 {
                cost = verbatim_bits;
                break;
            }
            let folded = if difference < 0 {
                (-difference as u64) * 2 - 1
            } else {
                difference as u64 * 2
            };
            cost += (folded >> k) + 1 + k as u64;
            if cost >= best {
                break;
            }
        }
        if cost < best {
            best = cost;
            chosen = Some(k);
        }
    }
    chosen
}

fn write_verbatim_frame(
    out: &mut Vec<u8>,
    pcm: &[i32],
    channels: usize,
    bits: u8,
    samples: usize,
    sample_number: u64,
) {
    out.clear();
    // Sync 0x3ffe, variable block size, 16-bit block-size extension, rate/bits from STREAMINFO.
    out.extend_from_slice(&[0xff, 0xf9, 0x70, ((channels as u8 - 1) << 4)]);
    utf8_uint(out, sample_number);
    out.extend_from_slice(&((samples - 1) as u16).to_be_bytes());
    out.push(crc8(out));
    let mut writer = BitWriter::new(out);
    for channel in 0..channels {
        if let Some(k) = rice_parameter(pcm, channel, channels, bits, samples) {
            writer.write(0x12, 8); // fixed predictor, order 1
            writer.write(sample(pcm, 0, channel, channels, bits) as u64, bits);
            writer.write(0, 6); // Rice method 0, partition order 0
            writer.write(k as u64, 4);
            let mut previous = sample(pcm, 0, channel, channels, bits);
            for frame in 1..samples {
                let current = sample(pcm, frame, channel, channels, bits);
                let difference = current - previous;
                previous = current;
                let folded = if difference < 0 {
                    (-difference as u64) * 2 - 1
                } else {
                    difference as u64 * 2
                };
                let quotient = folded >> k;
                for _ in 0..quotient {
                    writer.write(0, 1);
                }
                writer.write(1, 1);
                writer.write(folded & ((1 << k) - 1), k);
            }
        } else {
            writer.write(0x02, 8); // verbatim subframe
            for frame in 0..samples {
                writer.write(sample(pcm, frame, channel, channels, bits) as u64, bits);
            }
        }
    }
    writer.finish();
    let crc = crc16(out);
    out.extend_from_slice(&crc.to_be_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn short_alac_packet(samples: u32) -> Vec<u8> {
        let mut packet = Vec::new();
        let mut writer = BitWriter::new(&mut packet);
        writer.write(1, 3); // stereo channel pair
        writer.write(0, 16); // instance tag and unused header bits
        writer.write(1, 1); // explicit sample count
        writer.write(0, 2); // no shifted low bits
        writer.write(1, 1); // uncompressed ALAC samples
        writer.write(samples as u64, 32);
        for i in 0..samples {
            writer.write(i as u64, 24);
            writer.write((-(i as i32)) as u64, 24);
        }
        writer.write(7, 3); // end of packet
        writer.finish();
        packet
    }

    #[test]
    fn transcodes_short_final_alac_packets_without_padding() {
        // 176.4 kHz / 24-bit stereo, 4096 samples per ordinary packet.
        let cookie = [
            0, 0, 0x10, 0, 0, 24, 40, 10, 14, 2, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0xb1, 0x10,
        ];
        assert_eq!(unsafe { flac_open(cookie.as_ptr(), cookie.len()) }, 1);
        // Song 269573364 ends with 13 samples. Cover every short final block
        // and the ordinary 16-sample boundary through the public WASM API.
        for samples in 1..=16 {
            let packet = short_alac_packet(samples);
            assert_eq!(
                unsafe { flac_encode(packet.as_ptr(), packet.len(), 0, 0) },
                1
            );
            assert_eq!(flac_samples(), samples);
            let frame = unsafe { std::slice::from_raw_parts(flac_frame_ptr(), flac_frame_len()) };
            assert_eq!(u16::from_be_bytes([frame[5], frame[6]]) as u32 + 1, samples);
            assert_eq!(crc8(&frame[..7]), frame[7]);
            assert_eq!(crc16(frame), 0);
        }
        let empty = short_alac_packet(0);
        assert_eq!(unsafe { flac_encode(empty.as_ptr(), empty.len(), 0, 0) }, 0);
        flac_close();
    }

    #[test]
    fn frame_has_valid_crc_and_size() {
        let mut out = Vec::new();
        write_verbatim_frame(&mut out, &[0, 1 << 16, -1 << 16, 0], 2, 16, 2, 0);
        assert_eq!(crc8(&out[..7]), out[7]);
        assert_eq!(
            crc16(&out[..out.len() - 2]),
            u16::from_be_bytes(out[out.len() - 2..].try_into().unwrap())
        );
    }
}
