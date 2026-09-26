//! Repair only fully present, uncompressed mono/stereo ALAC elements.
//! Compressed payloads and incomplete PCM are never guessed or synthesized.

#[derive(Clone, Copy, Debug)]
pub struct Config {
    pub channels: usize,
    pub bits: u8,
    pub max_block: u32,
}

impl Config {
    pub fn from_cookie(cookie: &[u8]) -> Option<Self> {
        if cookie.len() != 24 || cookie[4] != 0 {
            return None;
        }
        let config = Self {
            max_block: u32::from_be_bytes(cookie[..4].try_into().ok()?),
            bits: cookie[5],
            channels: cookie[9] as usize,
        };
        config.valid().then_some(config)
    }

    fn valid(self) -> bool {
        (1..=2).contains(&self.channels)
            && matches!(self.bits, 16 | 20 | 24 | 32)
            && (1..=65535).contains(&self.max_block)
    }

    fn end_bit(self, packet: &[u8]) -> Option<usize> {
        if !self.valid() || packet.len() < 3 {
            return None;
        }
        let header = u32::from_be_bytes([0, packet[0], packet[1], packet[2]]);
        if !matches!((header >> 21, self.channels), (0 | 3, 1) | (1, 2))
            || (header >> 5) & 0xfff != 0
            || (header >> 2) & 3 != 0
            || (header >> 1) & 1 != 1
        {
            return None;
        }
        let partial = (header >> 4) & 1 != 0;
        let samples = if partial {
            if packet.len() < 7 {
                return None;
            }
            (u32::from_be_bytes(packet[2..6].try_into().ok()?) << 7) | (packet[6] >> 1) as u32
        } else {
            self.max_block
        };
        if samples == 0 || samples > self.max_block {
            return None;
        }
        let end = 23
            + if partial { 32 } else { 0 }
            + samples as usize * self.channels * self.bits as usize;
        let remaining = packet.len().checked_mul(8)?.checked_sub(end)?;
        (remaining <= 10).then_some(end)
    }

    /// Length-preserving repair for MP4 samples. If three bits do not fit in the
    /// existing packet, leave it untouched: changing its size would break Range,
    /// trun sizes and offsets. Returns true only when a tag was actually changed.
    pub fn repair_in_place(self, packet: &mut [u8]) -> bool {
        let Some(end) = self.end_bit(packet) else {
            return false;
        };
        if end + 3 > packet.len() * 8 || has_end(packet, end) {
            return false;
        }
        write_end(packet, end);
        true
    }

    /// Transcoding owns a new output buffer and may append a missing tag byte.
    pub fn repair_copy(self, packet: &[u8], repaired: &mut Vec<u8>) -> bool {
        let Some(end) = self.end_bit(packet) else {
            return false;
        };
        if end + 3 <= packet.len() * 8 && has_end(packet, end) {
            return false;
        }
        repaired.clear();
        repaired.extend_from_slice(packet);
        repaired.resize((end + 3).div_ceil(8), 0);
        write_end(repaired, end);
        true
    }
}

fn has_end(packet: &[u8], end: usize) -> bool {
    (end..end + 3).all(|i| packet[i / 8] & (0x80 >> (i % 8)) != 0)
}

fn write_end(packet: &mut [u8], end: usize) {
    for i in end..end + 3 {
        packet[i / 8] |= 0x80 >> (i % 8);
    }
    for i in end + 3..packet.len() * 8 {
        packet[i / 8] &= !(0x80 >> (i % 8));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_place_preserves_size_pcm_and_healthy_packets() {
        let config = Config {
            channels: 2,
            bits: 16,
            max_block: 1,
        };
        // 23 header bits + 32 PCM bits + 3 end bits + 6 padding bits.
        let broken = [0x20, 0, 2, 0x12, 0x34, 0x56, 0x78, 0];
        let mut packet = broken;
        assert!(config.repair_in_place(&mut packet));
        assert_eq!(&packet[..6], &broken[..6]);
        assert_eq!(packet[6] & 0xfe, broken[6] & 0xfe);
        assert_eq!(&packet[6..], &[0x79, 0xc0]);
        assert!(!config.repair_in_place(&mut packet));
        packet[7] |= 1; // Healthy tags leave even nonzero padding unchanged.
        let healthy = packet;
        assert!(!config.repair_in_place(&mut packet));
        assert_eq!(packet, healthy);
        let mut short = broken[..7].to_vec();
        assert!(!config.repair_in_place(&mut short));
        assert_eq!(short, broken[..7]);
        assert!(config.repair_copy(&short, &mut Vec::new()));
        assert!(!config.repair_in_place(&mut broken[..6].to_vec()));
        let mut extra = broken.to_vec();
        extra.push(0);
        assert!(!config.repair_in_place(&mut extra));
    }
}
