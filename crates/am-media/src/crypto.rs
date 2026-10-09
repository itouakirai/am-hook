//! AES block helpers, AES-CMAC and base64, shared by decryption and PlayReady.

// cipher 0.4 exposes blocks as generic-array 0.14 types, whose newest release
// deprecates them; this module is the only place that touches them.
#![allow(deprecated)]

use aes::cipher::generic_array::GenericArray;
use aes::cipher::{BlockDecrypt, BlockEncrypt, KeyInit};

pub struct Aes(aes::Aes128);

impl Aes {
    pub fn new(key: &[u8; 16]) -> Aes {
        Aes(aes::Aes128::new(GenericArray::from_slice(key)))
    }

    pub fn encrypt(&self, block: &mut [u8; 16]) {
        self.0.encrypt_block(GenericArray::from_mut_slice(block));
    }

    pub fn decrypt(&self, block: &mut [u8; 16]) {
        self.0.decrypt_block(GenericArray::from_mut_slice(block));
    }

    /// In-place CBC decryption of whole blocks, continuing the chain in `prev`.
    pub fn cbc_decrypt(&self, data: &mut [u8], prev: &mut [u8; 16]) {
        for chunk in data.chunks_exact_mut(16) {
            let block: &mut [u8; 16] = chunk.try_into().unwrap();
            let saved = *block;
            self.decrypt(block);
            block.iter_mut().zip(prev.iter()).for_each(|(x, p)| *x ^= p);
            *prev = saved;
        }
    }

    /// In-place CBC encryption of whole blocks.
    pub fn cbc_encrypt(&self, data: &mut [u8], iv: &[u8; 16]) {
        let mut prev = *iv;
        for chunk in data.chunks_exact_mut(16) {
            let block: &mut [u8; 16] = chunk.try_into().unwrap();
            block.iter_mut().zip(prev.iter()).for_each(|(x, p)| *x ^= p);
            self.encrypt(block);
            prev = *block;
        }
    }

    /// In-place ECB encryption of whole blocks.
    pub fn ecb_encrypt(&self, data: &mut [u8]) {
        for chunk in data.chunks_exact_mut(16) {
            self.encrypt(chunk.try_into().unwrap());
        }
    }
}

fn cmac_double(input: &[u8; 16]) -> [u8; 16] {
    let mut out = [0u8; 16];
    let mut carry = 0;
    for i in (0..16).rev() {
        out[i] = input[i] << 1 | carry;
        carry = input[i] >> 7;
    }
    if input[0] & 0x80 != 0 {
        out[15] ^= 0x87;
    }
    out
}

/// AES-CMAC (RFC 4493).
pub fn cmac(key: &[u8; 16], message: &[u8]) -> [u8; 16] {
    let aes = Aes::new(key);
    let mut l = [0u8; 16];
    aes.encrypt(&mut l);
    let k1 = cmac_double(&l);
    let k2 = cmac_double(&k1);
    let complete = !message.is_empty() && message.len().is_multiple_of(16);
    let blocks = if message.is_empty() { 1 } else { message.len().div_ceil(16) };
    let mut state = [0u8; 16];
    for i in 0..blocks {
        let mut block = [0u8; 16];
        let part = &message[(i * 16).min(message.len())..((i + 1) * 16).min(message.len())];
        block[..part.len()].copy_from_slice(part);
        if i == blocks - 1 {
            if complete {
                block.iter_mut().zip(k1).for_each(|(b, k)| *b ^= k);
            } else {
                block[part.len()] = 0x80;
                block.iter_mut().zip(k2).for_each(|(b, k)| *b ^= k);
            }
        }
        state.iter_mut().zip(block).for_each(|(s, b)| *s ^= b);
        aes.encrypt(&mut state);
    }
    state
}

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding.
pub fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Strict standard base64 (padding required), like Go's `StdEncoding` except
/// that CR/LF are skipped as Go does.
pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let bytes: Vec<u8> = text.bytes().filter(|&b| b != b'\r' && b != b'\n').collect();
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for (ci, chunk) in bytes.chunks(4).enumerate() {
        let last = ci == bytes.len() / 4 - 1;
        let mut n = 0u32;
        let mut pad = 0;
        for (i, &c) in chunk.iter().enumerate() {
            let v = match c {
                b'A'..=b'Z' => c - b'A',
                b'a'..=b'z' => c - b'a' + 26,
                b'0'..=b'9' => c - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                b'=' if last && i >= 2 => {
                    pad += 1;
                    0
                }
                _ => return None,
            };
            if pad > 0 && c != b'=' {
                return None;
            }
            n = n << 6 | v as u32;
        }
        let b = n.to_be_bytes();
        out.extend_from_slice(&b[1..4 - pad]);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn cmac_matches_rfc4493() {
        let key: [u8; 16] = hex("2b7e151628aed2a6abf7158809cf4f3c").try_into().unwrap();
        let msg = hex("6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411");
        assert_eq!(cmac(&key, &[]).to_vec(), hex("bb1d6929e95937287fa37d129b756746"));
        assert_eq!(cmac(&key, &msg[..16]).to_vec(), hex("070a16b46b4d4144f79bdd9dd04a287c"));
        assert_eq!(cmac(&key, &msg).to_vec(), hex("dfa66747de9ae63030ca32611497c827"));
    }

    #[test]
    fn base64_round_trips() {
        for n in 0..10 {
            let data: Vec<u8> = (0..n).map(|i| (i * 37 + 5) as u8).collect();
            assert_eq!(base64_decode(&base64_encode(&data)).unwrap(), data);
        }
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert!(base64_decode("Zm9vYg=").is_none());
        assert!(base64_decode("Zm=vYg==").is_none());
    }
}
