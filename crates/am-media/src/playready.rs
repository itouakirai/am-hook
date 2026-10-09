//! PlayReady license challenge generation and XMR content-key extraction.
//!
//! A port of puppyready (<https://git.gay/itouakirai/puppyready>, commit
//! 17be0787ee7f02f27b71a99ac3d40ab2bd61ec04), itself a focused Go port of the
//! `Device`, `PSSH` and `Cdm` parts of pyplayready
//! (<https://git.gay/ready-dl/pyplayready>). Only the license-acquisition path is included.

use std::collections::HashMap;

use p256::ecdsa::signature::hazmat::PrehashSigner;
use p256::ecdsa::{Signature, SigningKey};
use p256::elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use p256::{AffinePoint, EncodedPoint, FieldBytes, NonZeroScalar, ProjectivePoint, SecretKey};
use rand_core::{CryptoRng, RngCore};
use sha2::{Digest, Sha256};

use crate::crypto::{base64_decode, base64_encode, cmac, Aes};
use crate::{bail, Error, Result};

const CLIENT_VERSION: &str = "10.0.16384.10011";

const WMRM_SERVER_X: [u8; 32] = hex32("c8b6af16ee941aadaa5389b4af2c10e356be42af175ef3face93254e7b0b3d9b");
const WMRM_SERVER_Y: [u8; 32] = hex32("982b27b5cb2341326e56aa857dbfd5c634ce2cf9ea74fca8f2af5957efeea562");

/// The device bundled with puppyready.
const DEFAULT_DEVICE: &str = include_str!("default_device.b64");

const fn hex32(s: &str) -> [u8; 32] {
    let b = s.as_bytes();
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        out[i] = nibble(b[2 * i]) << 4 | nibble(b[2 * i + 1]);
        i += 1;
    }
    out
}

const fn nibble(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        _ => panic!("invalid hex"),
    }
}

/// Randomness supplied by the host (`crypto.getRandomValues` in the browser).
pub struct Entropy<'a>(pub &'a mut dyn FnMut(&mut [u8]));

impl RngCore for Entropy<'_> {
    fn next_u32(&mut self) -> u32 {
        let mut b = [0; 4];
        (self.0)(&mut b);
        u32::from_le_bytes(b)
    }
    fn next_u64(&mut self) -> u64 {
        let mut b = [0; 8];
        (self.0)(&mut b);
        u64::from_le_bytes(b)
    }
    fn fill_bytes(&mut self, dest: &mut [u8]) {
        (self.0)(dest)
    }
    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> std::result::Result<(), rand_core::Error> {
        (self.0)(dest);
        Ok(())
    }
}

impl CryptoRng for Entropy<'_> {}

/// Minimal big-endian bytes, rounded up to an even length
/// (pyplayready's `Util.to_bytes`).
fn util_to_bytes(fixed: &[u8]) -> Vec<u8> {
    let start = fixed.iter().position(|&b| b != 0).unwrap_or(fixed.len());
    let mut v = fixed[start..].to_vec();
    if !v.len().is_multiple_of(2) {
        v.insert(0, 0);
    }
    v
}

#[allow(deprecated)] // generic-array 0.14 accessors, see crypto.rs
fn coordinates(p: &AffinePoint) -> ([u8; 32], [u8; 32]) {
    let e = p.to_encoded_point(false);
    (e.x().unwrap().as_slice().try_into().unwrap(), e.y().unwrap().as_slice().try_into().unwrap())
}

#[allow(deprecated)]
fn point(x: &[u8], y: &[u8]) -> Option<AffinePoint> {
    let e = EncodedPoint::from_affine_coordinates(FieldBytes::from_slice(x), FieldBytes::from_slice(y), false);
    Option::from(AffinePoint::from_encoded_point(&e))
}

#[derive(Clone)]
struct EccKey {
    secret: NonZeroScalar,
    public: AffinePoint,
}

impl EccKey {
    fn from_private(data: &[u8]) -> Result<EccKey> {
        if data.len() < 32 {
            bail!("ECC private key must be at least 32 bytes, got {}", data.len());
        }
        let secret = SecretKey::from_slice(&data[..32]).map_err(|_| Error::new("ECC private key is outside the P-256 scalar range"))?;
        Ok(EccKey::from_scalar(secret.to_nonzero_scalar()))
    }

    fn from_scalar(secret: NonZeroScalar) -> EccKey {
        EccKey { secret, public: (ProjectivePoint::GENERATOR * *secret).to_affine() }
    }

    fn generate(rng: &mut Entropy) -> EccKey {
        EccKey::from_scalar(NonZeroScalar::random(rng))
    }

    fn public_bytes(&self) -> Vec<u8> {
        let (x, y) = coordinates(&self.public);
        [util_to_bytes(&x), util_to_bytes(&y)].concat()
    }
}

pub struct Device {
    encryption: EccKey,
    signing: EccKey,
    certificate: Vec<u8>,
}

impl Device {
    pub fn default_device() -> Result<Device> {
        let data = base64_decode(DEFAULT_DEVICE.trim()).ok_or_else(|| Error::new("invalid default device"))?;
        Device::parse(&data)
    }

    /// Parses a .prd file (versions 2 and 3; version 1 lacks the encryption
    /// and signing keys needed here).
    pub fn parse(data: &[u8]) -> Result<Device> {
        if data.len() < 5 || &data[..3] != b"PRD" {
            bail!("invalid PRD header");
        }
        let u32_at = |at: usize| u32::from_be_bytes(data[at..at + 4].try_into().unwrap()) as usize;
        match data[3] {
            2 => {
                if data.len() < 212 {
                    bail!("truncated PRD v2");
                }
                let cert_len = u32_at(4);
                if 8 + cert_len + 192 > data.len() {
                    bail!("invalid PRD v2 lengths");
                }
                let keys = 8 + cert_len;
                Ok(Device {
                    certificate: data[8..keys].to_vec(),
                    encryption: EccKey::from_private(&data[keys..keys + 96])?,
                    signing: EccKey::from_private(&data[keys + 96..keys + 192])?,
                })
            }
            3 => {
                if data.len() < 297 {
                    bail!("truncated PRD v3");
                }
                EccKey::from_private(&data[4..100])?; // group key, unused
                let cert_len = u32_at(292);
                if 296 + cert_len > data.len() {
                    bail!("invalid PRD v3 certificate length");
                }
                Ok(Device {
                    encryption: EccKey::from_private(&data[100..196])?,
                    signing: EccKey::from_private(&data[196..292])?,
                    certificate: data[296..296 + cert_len].to_vec(),
                })
            }
            1 => bail!("PRD v1 devices have no encryption and signing keys"),
            v => bail!("unsupported PRD version {v}"),
        }
    }
}

struct Session {
    xml_key: EccKey,
}

pub struct Cdm {
    device: Device,
    sessions: HashMap<String, Session>,
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl Cdm {
    pub fn new(device: Device) -> Cdm {
        Cdm { device, sessions: HashMap::new() }
    }

    pub fn open(&mut self, rng: &mut Entropy) -> String {
        let mut id = [0u8; 16];
        rng.fill_bytes(&mut id);
        // The client data AES IV and key are the two halves of the XML key's X,
        // which must therefore have a 32-byte minimal encoding.
        let xml_key = loop {
            let k = EccKey::generate(rng);
            if util_to_bytes(&coordinates(&k.public).0).len() == 32 {
                break k;
            }
        };
        let id = hex(&id);
        self.sessions.insert(id.clone(), Session { xml_key });
        id
    }

    pub fn close(&mut self, session: &str) {
        self.sessions.remove(session);
    }

    /// SOAP AcquireLicense request for a WRMHEADER. `now` is the Unix time in seconds.
    pub fn license_challenge(&self, session: &str, wrm_header: &str, now: u64, rng: &mut Entropy) -> Result<String> {
        let sess = self.sessions.get(session).ok_or_else(|| Error::new("invalid CDM session"))?;
        if wrm_header.is_empty() {
            bail!("empty WRM header");
        }
        let protocol = match wrm_header_version(wrm_header)?.as_str() {
            "4.3.0.0" => 5,
            "4.2.0.0" => 4,
            _ => 1,
        };
        let server = point(&WMRM_SERVER_X, &WMRM_SERVER_Y).unwrap();
        let server_data = ecc256_encrypt(&server, &sess.xml_key.public, rng);
        let client_data = self.encrypted_client_data(sess);
        let mut nonce = [0u8; 16];
        rng.fill_bytes(&mut nonce);
        let d = &self.device;

        let la = format!(
            concat!(
                r#"<LA xmlns="http://schemas.microsoft.com/DRM/2007/03/protocols" Id="SignedData" xml:space="preserve">"#,
                "<Version>{}</Version><ContentHeader>{}</ContentHeader>",
                "<CLIENTINFO><CLIENTVERSION>{}</CLIENTVERSION></CLIENTINFO>",
                "<LicenseNonce>{}</LicenseNonce><ClientTime>{}</ClientTime>",
                r#"<EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#" Type="http://www.w3.org/2001/04/xmlenc#Element">"#,
                r#"<EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"></EncryptionMethod>"#,
                r#"<KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#">"#,
                r#"<EncryptedKey xmlns="http://www.w3.org/2001/04/xmlenc#">"#,
                r#"<EncryptionMethod Algorithm="http://schemas.microsoft.com/DRM/2007/03/protocols#ecc256"></EncryptionMethod>"#,
                r#"<KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><KeyName>WMRMServer</KeyName></KeyInfo>"#,
                "<CipherData><CipherValue>{}</CipherValue></CipherData>",
                "</EncryptedKey></KeyInfo>",
                "<CipherData><CipherValue>{}</CipherValue></CipherData>",
                "</EncryptedData></LA>"
            ),
            protocol,
            wrm_header,
            CLIENT_VERSION,
            base64_encode(&nonce),
            now,
            base64_encode(&server_data),
            base64_encode(&client_data),
        );
        let signed_info = format!(
            concat!(
                r#"<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">"#,
                r#"<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></CanonicalizationMethod>"#,
                r#"<SignatureMethod Algorithm="http://schemas.microsoft.com/DRM/2007/03/protocols#ecdsa-sha256"></SignatureMethod>"#,
                r##"<Reference URI="#SignedData"><DigestMethod Algorithm="http://schemas.microsoft.com/DRM/2007/03/protocols#sha256"></DigestMethod>"##,
                "<DigestValue>{}</DigestValue></Reference></SignedInfo>"
            ),
            base64_encode(&Sha256::digest(la.as_bytes())),
        );
        let signer = SigningKey::from(d.signing.secret);
        let signature: Signature = signer
            .sign_prehash(&Sha256::digest(signed_info.as_bytes()))
            .map_err(|_| Error::new("ECDSA signing failed"))?;
        let challenge = format!(
            concat!(
                r#"<Challenge xmlns="http://schemas.microsoft.com/DRM/2007/03/protocols/messages">{}"#,
                r#"<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">{}<SignatureValue>{}</SignatureValue>"#,
                r#"<KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><KeyValue><ECCKeyValue><PublicKey>{}</PublicKey></ECCKeyValue></KeyValue></KeyInfo></Signature></Challenge>"#
            ),
            la,
            signed_info,
            base64_encode(&signature.to_bytes()),
            base64_encode(&d.signing.public_bytes()),
        );
        Ok(format!(
            concat!(
                r#"<?xml version="1.0" encoding="utf-8"?>"#,
                r#"<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">"#,
                r#"<soap:Body><AcquireLicense xmlns="http://schemas.microsoft.com/DRM/2007/03/protocols"><challenge>{}</challenge></AcquireLicense></soap:Body></soap:Envelope>"#
            ),
            challenge
        ))
    }

    fn encrypted_client_data(&self, sess: &Session) -> Vec<u8> {
        let xml = format!(
            concat!(
                "<Data><CertificateChains><CertificateChain> {} </CertificateChain></CertificateChains>",
                r#"<Features><Feature Name="AESCBC"></Feature><REE><AESCBC></AESCBC></REE></Features></Data>"#
            ),
            base64_encode(&self.device.certificate)
        );
        let (x, _) = coordinates(&sess.xml_key.public);
        let (iv, key): ([u8; 16], [u8; 16]) = (x[..16].try_into().unwrap(), x[16..].try_into().unwrap());
        let mut data = xml.into_bytes();
        let pad = 16 - data.len() % 16;
        data.extend(std::iter::repeat_n(pad as u8, pad));
        Aes::new(&key).cbc_encrypt(&mut data, &iv);
        [iv.to_vec(), data].concat()
    }

    /// Decrypts every license in an AcquireLicense response and returns the
    /// content keys as (key ID, key).
    pub fn parse_license(&self, session: &str, license_xml: &[u8]) -> Result<Vec<(String, [u8; 16])>> {
        if !self.sessions.contains_key(session) {
            bail!("invalid CDM session");
        }
        let payloads = extract_license_payloads(license_xml)?;
        if payloads.is_empty() {
            bail!("license XML contains no License payload");
        }
        payloads
            .iter()
            .map(|p| {
                let raw = base64_decode(p.trim()).ok_or_else(|| Error::new("decode XMR license: illegal base64 data"))?;
                decrypt_xmr_license(&raw, &self.device.encryption)
            })
            .collect()
    }
}

/// ElGamal encryption of `plaintext` to `public`: (k·G, plaintext + k·public).
fn ecc256_encrypt(public: &AffinePoint, plaintext: &AffinePoint, rng: &mut Entropy) -> Vec<u8> {
    let k = NonZeroScalar::random(rng);
    let p1 = (ProjectivePoint::GENERATOR * *k).to_affine();
    let p2 = (ProjectivePoint::from(*plaintext) + ProjectivePoint::from(*public) * *k).to_affine();
    let ((x1, y1), (x2, y2)) = (coordinates(&p1), coordinates(&p2));
    [util_to_bytes(&x1), util_to_bytes(&y1), util_to_bytes(&x2), util_to_bytes(&y2)].concat()
}

fn ecc256_decrypt(key: &EccKey, ciphertext: &[u8]) -> Result<Vec<u8>> {
    if ciphertext.len() < 128 {
        bail!("ECC ciphertext is too short: {}", ciphertext.len());
    }
    let p1 = point(&ciphertext[..32], &ciphertext[32..64]);
    let p2 = point(&ciphertext[64..96], &ciphertext[96..128]);
    let (Some(p1), Some(p2)) = (p1, p2) else { bail!("invalid ECC ciphertext point") };
    let shared = ProjectivePoint::from(p1) * *key.secret;
    let decrypted = (ProjectivePoint::from(p2) - shared).to_affine();
    Ok(util_to_bytes(&coordinates(&decrypted).0))
}

/// The `version` attribute of the WRMHEADER root element.
fn wrm_header_version(header: &str) -> Result<String> {
    let root = xml::tokens(header.as_bytes())
        .map_err(|e| e.context("invalid WRMHEADER XML"))?
        .into_iter()
        .find_map(|t| match t {
            xml::Token::Start { attrs, .. } => Some(attrs),
            _ => None,
        })
        .ok_or_else(|| Error::new("invalid WRMHEADER XML: EOF"))?;
    match root.into_iter().find(|(k, _)| k == "version") {
        Some((_, v)) if !v.is_empty() => Ok(v),
        _ => bail!("WRMHEADER has no version"),
    }
}

fn utf16le(data: &[u8]) -> Result<String> {
    if !data.len().is_multiple_of(2) {
        bail!("UTF-16LE data has odd length");
    }
    let words: Vec<u16> = data.chunks_exact(2).map(|w| u16::from_le_bytes([w[0], w[1]])).collect();
    Ok(String::from_utf16_lossy(&words))
}

fn printable_utf16le(data: &[u8]) -> bool {
    utf16le(data).is_ok_and(|s| s.chars().all(|c| (' '..='~').contains(&c)))
}

fn decode_wrm_header(data: &[u8]) -> Result<String> {
    let data = data.strip_prefix(&[0xff, 0xfe]).unwrap_or(data);
    let header = utf16le(data)?;
    wrm_header_version(&header)?;
    Ok(header)
}

fn le16(b: &[u8], at: usize) -> usize {
    u16::from_le_bytes([b[at], b[at + 1]]) as usize
}

fn parse_playready_header(data: &[u8]) -> Result<String> {
    if data.len() < 6 {
        bail!("truncated PlayReady header");
    }
    let count = le16(data, 4);
    let mut pos = 6;
    let mut first = None;
    for _ in 0..count {
        if pos + 4 > data.len() {
            bail!("truncated PlayReady object header");
        }
        let (kind, len) = (le16(data, pos), le16(data, pos + 2));
        pos += 4;
        if pos + len > data.len() {
            bail!("invalid PlayReady object length");
        }
        if kind == 1 {
            let h = decode_wrm_header(&data[pos..pos + len])?;
            first.get_or_insert(h);
        }
        pos += len;
    }
    first.ok_or_else(|| Error::new("PlayReady header has no type 1 object"))
}

fn parse_pssh_box(data: &[u8]) -> Option<Result<String>> {
    if data.len() < 32 || &data[4..8] != b"pssh" {
        return None;
    }
    let be = |at: usize| u32::from_be_bytes(data[at..at + 4].try_into().unwrap()) as usize;
    Some((|| {
        let len = be(0);
        if len < 32 || len > data.len() {
            bail!("invalid pssh box length");
        }
        let version = data[8];
        let mut pos = 12 + 16;
        if pos > len {
            bail!("truncated pssh system id");
        }
        if version == 1 {
            if pos + 4 > len {
                bail!("truncated pssh key id count");
            }
            let count = be(pos);
            pos += 4;
            if pos + count * 16 > len {
                bail!("invalid pssh key id count");
            }
            pos += count * 16;
        }
        if pos + 4 > len {
            bail!("truncated pssh data length");
        }
        let n = be(pos);
        pos += 4;
        if pos + n > len {
            bail!("invalid pssh data length");
        }
        let body = &data[pos..pos + n];
        if printable_utf16le(body) {
            decode_wrm_header(body)
        } else {
            parse_playready_header(body)
        }
    })())
}

/// The first WRMHEADER of a base64 PSSH box, PlayReady header or PlayReady object.
pub fn parse_pssh(input: &str) -> Result<String> {
    let data = base64_decode(input.trim()).ok_or_else(|| Error::new("decode PSSH base64: illegal base64 data"))?;
    if data.is_empty() {
        bail!("empty PSSH");
    }
    if let Some(r) = parse_pssh_box(&data) {
        return r;
    }
    // A PlayReady Header starts with its little-endian total length, an Object with its type.
    if data.len() >= 2 && le16(&data, 0) > 3 {
        return parse_playready_header(&data);
    }
    if data.len() < 4 {
        bail!("truncated PlayReady object");
    }
    let (kind, len) = (le16(&data, 0), le16(&data, 2));
    if kind != 1 || 4 + len > data.len() {
        bail!("invalid PlayReady object");
    }
    decode_wrm_header(&data[4..4 + len])
}

/// Text of every `License` element directly inside `Licenses`.
fn extract_license_payloads(license_xml: &[u8]) -> Result<Vec<String>> {
    let mut path: Vec<String> = Vec::new();
    let mut payloads = Vec::new();
    let mut capture: Option<String> = None;
    for t in xml::tokens(license_xml)? {
        match t {
            xml::Token::Start { name, empty, .. } => {
                if name == "License" && path.last().map(String::as_str) == Some("Licenses") {
                    if empty {
                        payloads.push(String::new());
                    } else {
                        capture = Some(String::new());
                    }
                }
                if !empty {
                    path.push(name);
                }
            }
            xml::Token::Text(text) => {
                if let Some(c) = capture.as_mut() {
                    c.push_str(&text);
                }
            }
            xml::Token::End(name) => {
                if name == "License" {
                    if let Some(c) = capture.take() {
                        payloads.push(c.trim().to_owned());
                    }
                }
                path.pop();
            }
        }
    }
    Ok(payloads)
}

struct XmrObject<'a> {
    kind: u16,
    data: &'a [u8],
}

fn xmr_objects<'a>(data: &'a [u8], out: &mut Vec<XmrObject<'a>>) -> Result<()> {
    let mut pos = 0;
    while pos < data.len() {
        if data.len() - pos < 8 {
            bail!("truncated XMR object header");
        }
        let flags = u16::from_be_bytes([data[pos], data[pos + 1]]);
        let kind = u16::from_be_bytes([data[pos + 2], data[pos + 3]]);
        let len = u32::from_be_bytes(data[pos + 4..pos + 8].try_into().unwrap()) as usize;
        pos += 8;
        if len < 8 || len - 8 > data.len() - pos {
            bail!("invalid XMR object length");
        }
        let payload = &data[pos..pos + len - 8];
        // Depth-first, parents before their children, as pyplayready walks them.
        out.push(XmrObject { kind, data: payload });
        if flags == 2 || flags == 3 {
            xmr_objects(payload, out)?;
        }
        pos += len - 8;
    }
    Ok(())
}

fn be16(b: &[u8], at: usize) -> usize {
    u16::from_be_bytes([b[at], b[at + 1]]) as usize
}

fn decrypt_xmr_license(raw: &[u8], encryption: &EccKey) -> Result<(String, [u8; 16])> {
    if raw.len() < 24 || &raw[..4] != b"XMR\0" {
        bail!("invalid XMR license header");
    }
    let mut objects = Vec::new();
    xmr_objects(&raw[24..], &mut objects)?;
    let first = |kind: u16| objects.iter().find(|o| o.kind == kind).ok_or_else(|| Error::msg(format!("XMR object 0x{kind:04x} not found")));

    // ECC_DEVICE_KEY_OBJECT
    let device = first(0x002a)?.data;
    if device.len() < 4 {
        bail!("truncated XMR ECC device key");
    }
    let n = be16(device, 2);
    if device.len() < 4 + n {
        bail!("invalid XMR ECC device key length");
    }
    if device[4..4 + n] != encryption.public_bytes()[..] {
        bail!("XMR public encryption key does not match device");
    }

    // CONTENT_KEY_OBJECT
    let content = first(0x000a)?.data;
    if content.len() < 22 {
        bail!("truncated XMR content key");
    }
    let key_id = &content[..16];
    let cipher_type = be16(content, 18);
    let n = be16(content, 20);
    if content.len() < 22 + n {
        bail!("invalid XMR content key length");
    }
    let encrypted = &content[22..22 + n];
    if !matches!(cipher_type, 3 | 4 | 6) {
        bail!("unsupported XMR cipher type {cipher_type}");
    }
    let decrypted = ecc256_decrypt(encryption, encrypted)?;
    if decrypted.len() < 32 {
        bail!("decrypted XMR content key is too short");
    }
    let mut integrity: [u8; 16] = decrypted[..16].try_into().unwrap();
    let mut key: [u8; 16] = decrypted[16..32].try_into().unwrap();

    // AUX_KEY_OBJECT: scalable license.
    if let Ok(aux) = first(0x0051) {
        let even: Vec<u8> = decrypted.iter().step_by(2).copied().collect();
        let odd: Vec<u8> = decrypted.iter().skip(1).step_by(2).copied().collect();
        if even.len() < 16 || odd.len() < 16 {
            bail!("scalable XMR integrity key is too short");
        }
        integrity = even[..16].try_into().unwrap();
        key = odd[..16].try_into().unwrap();
        if cipher_type == 6 {
            (key, integrity) = unwrap_symmetric_key(encrypted, &key, aux_key(aux.data)?)?;
        }
    }

    // SIGNATURE_OBJECT: AES-CMAC over the license without the signature object.
    let signature = first(0x000b)?.data;
    if signature.len() < 4 {
        bail!("truncated XMR signature");
    }
    let n = be16(signature, 2);
    if signature.len() < 4 + n {
        bail!("invalid XMR signature length");
    }
    let excluded = n + 12;
    if excluded > raw.len() {
        bail!("invalid XMR signature length");
    }
    if cmac(&integrity, &raw[..raw.len() - excluded])[..] != signature[4..4 + n] {
        bail!("XMR license integrity signature does not match");
    }
    Ok((canonical_uuid_hex(key_id), key))
}

fn aux_key(data: &[u8]) -> Result<[u8; 16]> {
    if data.len() < 2 {
        bail!("truncated XMR auxiliary key object");
    }
    if be16(data, 0) < 1 {
        bail!("XMR auxiliary key object is empty");
    }
    if data.len() < 22 {
        bail!("invalid XMR auxiliary key object");
    }
    Ok(data[6..22].try_into().unwrap())
}

fn unwrap_symmetric_key(encrypted: &[u8], key: &[u8; 16], aux: [u8; 16]) -> Result<([u8; 16], [u8; 16])> {
    if encrypted.len() < 176 {
        bail!("symmetric scalable XMR content key is too short");
    }
    const MAGIC_ZERO: [u8; 16] = [0x7e, 0xe9, 0xed, 0x4a, 0xf7, 0x73, 0x22, 0x4f, 0x00, 0xb8, 0xea, 0x7e, 0xfb, 0x02, 0x7c, 0xbb];
    let ecb = |k: &[u8; 16], data: &[u8]| -> Result<Vec<u8>> {
        if data.is_empty() || !data.len().is_multiple_of(16) {
            bail!("AES-ECB plaintext length must be a non-zero multiple of 16");
        }
        let mut d = data.to_vec();
        Aes::new(k).ecb_encrypt(&mut d);
        Ok(d)
    };
    let rgb: Vec<u8> = key.iter().zip(MAGIC_ZERO).map(|(a, b)| a ^ b).collect();
    let prime: [u8; 16] = ecb(key, &rgb)?.try_into().unwrap();
    let uplink: [u8; 16] = ecb(&prime, &aux)?.try_into().unwrap();
    let secondary: [u8; 16] = ecb(key, &encrypted[128..144])?.try_into().unwrap();
    let leaf = ecb(&secondary, &ecb(&uplink, &encrypted[144..])?)?;
    if leaf.len() < 32 {
        bail!("embedded symmetric XMR leaf license is too short");
    }
    Ok((leaf[16..32].try_into().unwrap(), leaf[..16].try_into().unwrap()))
}

fn canonical_uuid_hex(raw: &[u8]) -> String {
    if raw.len() != 16 {
        return hex(raw);
    }
    let mut out = raw.to_vec();
    out[0..4].reverse();
    out[4..6].reverse();
    out[6..8].reverse();
    hex(&out)
}

/// A small XML tokenizer, enough for WRMHEADERs and license responses.
mod xml {
    use crate::{bail, Result};

    pub enum Token {
        /// Local name, attributes (local names) and whether it is self-closing.
        Start { name: String, attrs: Vec<(String, String)>, empty: bool },
        End(String),
        Text(String),
    }

    fn local(name: &str) -> String {
        name.rsplit(':').next().unwrap_or(name).to_owned()
    }

    fn unescape(s: &str) -> Result<String> {
        let mut out = String::with_capacity(s.len());
        let mut rest = s;
        while let Some(i) = rest.find('&') {
            out.push_str(&rest[..i]);
            let Some(end) = rest[i..].find(';') else { bail!("invalid character entity") };
            let entity = &rest[i + 1..i + end];
            let c = match entity {
                "lt" => '<',
                "gt" => '>',
                "amp" => '&',
                "quot" => '"',
                "apos" => '\'',
                e if e.starts_with("#x") => u32::from_str_radix(&e[2..], 16).ok().and_then(char::from_u32).ok_or_else(|| crate::Error::new("invalid character entity"))?,
                e if e.starts_with('#') => e[1..].parse().ok().and_then(char::from_u32).ok_or_else(|| crate::Error::new("invalid character entity"))?,
                _ => bail!("invalid character entity &{entity};"),
            };
            out.push(c);
            rest = &rest[i + end + 1..];
        }
        out.push_str(rest);
        Ok(out)
    }

    pub fn tokens(data: &[u8]) -> Result<Vec<Token>> {
        let s = std::str::from_utf8(data).map_err(|_| crate::Error::new("XML is not UTF-8"))?;
        let s = s.strip_prefix('\u{feff}').unwrap_or(s);
        let mut out = Vec::new();
        let mut depth = 0usize;
        let mut rest = s;
        while !rest.is_empty() {
            let Some(lt) = rest.find('<') else {
                out.push(Token::Text(unescape(rest)?));
                break;
            };
            if lt > 0 {
                out.push(Token::Text(unescape(&rest[..lt])?));
            }
            rest = &rest[lt..];
            if let Some(r) = rest.strip_prefix("<!--") {
                let Some(e) = r.find("-->") else { bail!("unterminated comment") };
                rest = &r[e + 3..];
            } else if let Some(r) = rest.strip_prefix("<![CDATA[") {
                let Some(e) = r.find("]]>") else { bail!("unterminated CDATA section") };
                out.push(Token::Text(r[..e].to_owned()));
                rest = &r[e + 3..];
            } else if rest.starts_with("<?") || rest.starts_with("<!") {
                let Some(e) = rest.find('>') else { bail!("unexpected EOF") };
                rest = &rest[e + 1..];
            } else if let Some(r) = rest.strip_prefix("</") {
                let Some(e) = r.find('>') else { bail!("unexpected EOF") };
                if depth == 0 {
                    bail!("unexpected end element </{}>", r[..e].trim());
                }
                depth -= 1;
                out.push(Token::End(local(r[..e].trim())));
                rest = &r[e + 1..];
            } else {
                // Start tag; attribute values may contain '>'.
                let body = &rest[1..];
                let mut end = None;
                let mut quote = None;
                for (i, c) in body.char_indices() {
                    match (quote, c) {
                        (None, '"' | '\'') => quote = Some(c),
                        (Some(q), c) if c == q => quote = None,
                        (None, '>') => {
                            end = Some(i);
                            break;
                        }
                        _ => {}
                    }
                }
                let Some(e) = end else { bail!("unexpected EOF") };
                let mut tag = &body[..e];
                let empty = tag.ends_with('/');
                if empty {
                    tag = &tag[..tag.len() - 1];
                }
                let name_end = tag.find(|c: char| c.is_whitespace()).unwrap_or(tag.len());
                let name = &tag[..name_end];
                if name.is_empty() {
                    bail!("invalid XML name");
                }
                let mut attrs = Vec::new();
                let mut a = tag[name_end..].trim_start();
                while !a.is_empty() {
                    let Some(eq) = a.find('=') else { bail!("attribute without value") };
                    let key = a[..eq].trim();
                    let v = a[eq + 1..].trim_start();
                    let Some(q) = v.chars().next().filter(|c| *c == '"' || *c == '\'') else { bail!("unquoted attribute value") };
                    let Some(close) = v[1..].find(q) else { bail!("unterminated attribute value") };
                    attrs.push((local(key), unescape(&v[1..1 + close])?));
                    a = v[close + 2..].trim_start();
                }
                if !empty {
                    depth += 1;
                }
                out.push(Token::Start { name: local(name), attrs, empty });
                rest = &body[e + 1..];
            }
        }
        if depth != 0 {
            bail!("unexpected EOF");
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counter_rng() -> impl FnMut(&mut [u8]) {
        let mut n = 0u8;
        move |b: &mut [u8]| {
            for x in b {
                n = n.wrapping_mul(29).wrapping_add(17);
                *x = n;
            }
        }
    }

    #[test]
    fn default_device_loads() {
        let d = Device::default_device().unwrap();
        assert!(!d.certificate.is_empty());
    }

    #[test]
    fn elgamal_round_trips() {
        let mut f = counter_rng();
        let mut rng = Entropy(&mut f);
        let key = EccKey::generate(&mut rng);
        let message = EccKey::generate(&mut rng);
        let ct = ecc256_encrypt(&key.public, &message.public, &mut rng);
        // Coordinates with leading zero bytes are shortened; this seed avoids them.
        assert_eq!(ct.len(), 128);
        assert_eq!(ecc256_decrypt(&key, &ct).unwrap(), util_to_bytes(&coordinates(&message.public).0));
    }

    #[test]
    fn wrm_header_version_and_kid_header() {
        let h = r#"<WRMHEADER xmlns="http://schemas.microsoft.com/DRM/2007/03/PlayReadyHeader" version="4.0.0.0"><DATA><KID>abc=</KID></DATA></WRMHEADER>"#;
        assert_eq!(wrm_header_version(h).unwrap(), "4.0.0.0");
        assert!(wrm_header_version("<WRMHEADER><DATA/></WRMHEADER>").is_err());
        let utf16: Vec<u8> = h.encode_utf16().flat_map(|w| w.to_le_bytes()).collect();
        let mut object = vec![1, 0];
        object.extend_from_slice(&(utf16.len() as u16).to_le_bytes());
        object.extend_from_slice(&utf16);
        let mut header = ((object.len() + 6) as u32).to_le_bytes().to_vec();
        header.extend_from_slice(&1u16.to_le_bytes());
        header.extend_from_slice(&object);
        assert_eq!(parse_pssh(&base64_encode(&header)).unwrap(), h);
    }

    #[test]
    fn extracts_license_payloads() {
        let xml = br#"<?xml version="1.0"?><soap:Envelope xmlns:soap="x"><soap:Body><AcquireLicenseResponse><AcquireLicenseResult><Response><LicenseResponse><Licenses><License> QUJD
</License><License>REVG</License></Licenses><License>no</License></LicenseResponse></Response></AcquireLicenseResult></AcquireLicenseResponse></soap:Body></soap:Envelope>"#;
        assert_eq!(extract_license_payloads(xml).unwrap(), vec!["QUJD", "REVG"]);
    }

    /// Builds an XMR license for the device's encryption key and checks that
    /// the content key survives ElGamal, the CMAC and parsing.
    #[test]
    fn decrypts_xmr_license() {
        let device = Device::default_device().unwrap();
        let mut f = counter_rng();
        let mut rng = Entropy(&mut f);
        // A message point whose X is integrity key || content key.
        let (message, x) = loop {
            let k = EccKey::generate(&mut rng);
            let (x, _) = coordinates(&k.public);
            if x[0] != 0 {
                break (k, x);
            }
        };
        let ct = ecc256_encrypt(&device.encryption.public, &message.public, &mut rng);
        let obj = |flags: u16, kind: u16, payload: &[u8]| {
            let mut v = flags.to_be_bytes().to_vec();
            v.extend_from_slice(&kind.to_be_bytes());
            v.extend_from_slice(&((payload.len() + 8) as u32).to_be_bytes());
            v.extend_from_slice(payload);
            v
        };
        let public = device.encryption.public_bytes();
        let mut dk = vec![0, 1];
        dk.extend_from_slice(&(public.len() as u16).to_be_bytes());
        dk.extend_from_slice(&public);
        let kid: Vec<u8> = (1..=16).collect();
        let mut ck = kid.clone();
        ck.extend_from_slice(&[0, 1, 0, 3]);
        ck.extend_from_slice(&(ct.len() as u16).to_be_bytes());
        ck.extend_from_slice(&ct);
        let body = [obj(3, 0x0009, &[obj(0, 0x002a, &dk), obj(0, 0x000a, &ck)].concat())].concat();
        let mut raw = b"XMR\0".to_vec();
        raw.extend_from_slice(&[0; 20]);
        raw.extend_from_slice(&obj(3, 0x0001, &body));
        let integrity: [u8; 16] = x[..16].try_into().unwrap();
        let mac = cmac(&integrity, &raw);
        let mut sig = vec![0, 1, 0, 16];
        sig.extend_from_slice(&mac);
        raw.extend_from_slice(&obj(0, 0x000b, &sig));
        let (id, key) = decrypt_xmr_license(&raw, &device.encryption).unwrap();
        assert_eq!(key[..], x[16..]);
        assert_eq!(id, "0403020106050807090a0b0c0d0e0f10");
    }
}
