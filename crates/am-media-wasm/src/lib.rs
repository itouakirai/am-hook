//! am-media 的 wasm 导出（C ABI），JS 调用方见 `web/media/media-worker.js`。
//!
//! 约定：
//! - 输入先用 `media_alloc` 申请并写入，调用后由 JS 用 `media_free` 释放；字符串为 UTF-8。
//! - 返回 1 表示成功，产物（字节）通过 `media_result_ptr` / `media_result_len` 读取，
//!   在下一次调用前有效；返回 0 表示失败，错误信息通过 `media_error_ptr` / `media_error_len` 读取。
//! - 随机数与文件读写由宿主导入（`env.random_fill` / `env.file_*`），不依赖 wasm-bindgen。

use std::alloc::{alloc, dealloc, Layout};
use std::cell::RefCell;
use std::collections::HashMap;

use am_media::defrag::{defragment, Options};
use am_media::mv::{mux_init, Stream};
use am_media::playready::{parse_pssh, Cdm, Device, Entropy};
use am_media::readahead::{Sink, Source};
use am_media::widevine;
use am_media::{Error, Result};

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C" {
    fn random_fill(ptr: *mut u8, len: usize);
    fn file_size(handle: u32) -> f64;
    fn file_read(handle: u32, ptr: *mut u8, len: usize, at: f64) -> i32;
    fn file_write(handle: u32, ptr: *const u8, len: usize, at: f64) -> i32;
}

// Native builds (tests, cargo check) have no host; the entry points are only used from wasm.
#[cfg(not(target_arch = "wasm32"))]
unsafe fn random_fill(_: *mut u8, _: usize) {
    unimplemented!("host import")
}
#[cfg(not(target_arch = "wasm32"))]
unsafe fn file_size(_: u32) -> f64 {
    unimplemented!("host import")
}
#[cfg(not(target_arch = "wasm32"))]
unsafe fn file_read(_: u32, _: *mut u8, _: usize, _: f64) -> i32 {
    unimplemented!("host import")
}
#[cfg(not(target_arch = "wasm32"))]
unsafe fn file_write(_: u32, _: *const u8, _: usize, _: f64) -> i32 {
    unimplemented!("host import")
}

struct State {
    cdm: Option<Cdm>,
    widevine: Option<widevine::Cdm>,
    streams: HashMap<String, Stream>,
    result: Vec<u8>,
    error: String,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State { cdm: None, widevine: None, streams: HashMap::new(), result: Vec::new(), error: String::new() });
}

fn fill(buf: &mut [u8]) {
    // SAFETY: buf is valid for writes of its length.
    unsafe { random_fill(buf.as_mut_ptr(), buf.len()) }
}

/// Runs `f` and stores its result or error; returns 1 on success.
fn run(f: impl FnOnce(&mut State) -> Result<Vec<u8>>) -> i32 {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        match f(&mut s) {
            Ok(v) => {
                s.result = v;
                1
            }
            Err(e) => {
                s.error = e.to_string();
                0
            }
        }
    })
}

/// # Safety
/// `ptr` must point to `len` readable bytes.
unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len)
    }
}

/// # Safety
/// `ptr` must point to `len` readable bytes.
unsafe fn text<'a>(ptr: *const u8, len: usize) -> Result<&'a str> {
    std::str::from_utf8(bytes(ptr, len)).map_err(|_| Error::new("argument is not UTF-8"))
}

#[no_mangle]
pub extern "C" fn media_alloc(len: usize) -> *mut u8 {
    // SAFETY: size is at least 1 and alignment 1.
    unsafe { alloc(Layout::from_size_align_unchecked(len.max(1), 1)) }
}

/// # Safety
/// `ptr` / `len` must come from one `media_alloc` call.
#[no_mangle]
pub unsafe extern "C" fn media_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        dealloc(ptr, Layout::from_size_align_unchecked(len.max(1), 1));
    }
}

#[no_mangle]
pub extern "C" fn media_result_ptr() -> *const u8 {
    STATE.with(|s| s.borrow().result.as_ptr())
}

#[no_mangle]
pub extern "C" fn media_result_len() -> usize {
    STATE.with(|s| s.borrow().result.len())
}

#[no_mangle]
pub extern "C" fn media_error_ptr() -> *const u8 {
    STATE.with(|s| s.borrow().error.as_ptr())
}

#[no_mangle]
pub extern "C" fn media_error_len() -> usize {
    STATE.with(|s| s.borrow().error.len())
}

fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Opens a CDM session and builds a license challenge for an HLS key URI
/// (`data:...;base64,<payload>`). `now` is the Unix time in seconds.
/// - `drm` 0, PlayReady: the payload is a PSSH or 16-byte KID; the challenge is the SOAP request.
/// - `drm` 1, Widevine: the payload is a KID or Widevine pssh box; the challenge
///   is a SignedLicenseRequest.
///
/// Result: JSON `{"session","uri","challenge"}`; `uri` is what the license
/// server expects and `challenge` the base64 request.
///
/// # Safety
/// Pointers must reference readable memory of the given lengths.
#[no_mangle]
pub unsafe extern "C" fn media_challenge(drm: u32, uri: *const u8, uri_len: usize, now: f64) -> i32 {
    run(|s| {
        let mut uri = text(uri, uri_len)?.to_owned();
        let mut f = fill;
        if drm == 1 {
            let (_, payload) = uri.split_once(',').ok_or_else(|| Error::new("invalid Widevine URI"))?;
            let payload = am_media::crypto::base64_decode(payload).ok_or_else(|| Error::new("invalid Widevine KID"))?;
            let header = widevine::cenc_header(&payload)?;
            if s.widevine.is_none() {
                s.widevine = Some(widevine::Cdm::new(widevine::Device::default_device()?));
            }
            let cdm = s.widevine.as_mut().unwrap();
            let session = cdm.open(&mut Entropy(&mut f));
            let challenge = cdm.license_challenge(&session, &header, now as u64, &mut Entropy(&mut f));
            return challenge_json(&session, &uri, challenge.inspect_err(|_| cdm.close(&session))?);
        }
        if drm != 0 {
            return Err(Error::new("unknown DRM system"));
        }
        if s.cdm.is_none() {
            s.cdm = Some(Cdm::new(Device::default_device()?));
        }
        let cdm = s.cdm.as_mut().unwrap();
        let (_, payload) = uri.split_once(',').ok_or_else(|| Error::new("invalid PlayReady URI"))?;
        let payload = payload.to_owned();
        let header = match parse_pssh(&payload) {
            Ok(h) => h,
            Err(_) => {
                let kid = am_media::crypto::base64_decode(&payload).filter(|k| k.len() == 16);
                if kid.is_none() {
                    return Err(Error::new("invalid PlayReady PSSH/KID"));
                }
                uri = format!("data:;base64,{payload}");
                format!(
                    concat!(
                        r#"<WRMHEADER xmlns="http://schemas.microsoft.com/DRM/2007/03/PlayReadyHeader" version="4.0.0.0">"#,
                        "<DATA><PROTECTINFO><KEYLEN>16</KEYLEN><ALGID>AESCTR</ALGID></PROTECTINFO><KID>{}</KID></DATA></WRMHEADER>"
                    ),
                    payload
                )
            }
        };
        let session = cdm.open(&mut Entropy(&mut f));
        let challenge = cdm.license_challenge(&session, &header, now as u64, &mut Entropy(&mut f));
        challenge_json(&session, &uri, challenge.inspect_err(|_| cdm.close(&session))?.into_bytes())
    })
}

fn challenge_json(session: &str, uri: &str, challenge: Vec<u8>) -> Result<Vec<u8>> {
    Ok(format!(
        r#"{{"session":{},"uri":{},"challenge":{}}}"#,
        json_string(session),
        json_string(uri),
        json_string(&am_media::crypto::base64_encode(&challenge))
    )
    .into_bytes())
}

/// Parses a base64 license response for a session and closes it. Result: the
/// 128-bit content key (for Widevine the last content key, as the reference
/// downloader does; Apple licenses carry one).
///
/// # Safety
/// Pointers must reference readable memory of the given lengths.
#[no_mangle]
pub unsafe extern "C" fn media_license(session: *const u8, session_len: usize, license: *const u8, license_len: usize) -> i32 {
    run(|s| {
        let session = text(session, session_len)?;
        if let Some(cdm) = s.widevine.as_mut().filter(|c| c.has(session)) {
            let result = (|| {
                let license = am_media::crypto::base64_decode(text(license, license_len)?.trim())
                    .ok_or_else(|| Error::new("illegal base64 data in license"))?;
                let keys = cdm.parse_license(session, &license)?;
                keys.last().map(|(_, key)| key.to_vec()).ok_or_else(|| Error::new("license contains no content key"))
            })();
            cdm.close(session);
            return result;
        }
        let cdm = s.cdm.as_mut().ok_or_else(|| Error::new("invalid CDM session"))?;
        let result = (|| {
            let xml = am_media::crypto::base64_decode(text(license, license_len)?.trim())
                .ok_or_else(|| Error::new("illegal base64 data in license"))?;
            let keys = cdm.parse_license(session, &xml)?;
            if keys.len() != 1 {
                am_media::bail!("expected one 128-bit content key, got {}", keys.len());
            }
            Ok(keys[0].1.to_vec())
        })();
        cdm.close(session);
        result
    })
}

/// # Safety
/// Pointers must reference readable memory of the given lengths.
#[no_mangle]
pub unsafe extern "C" fn media_close_session(session: *const u8, session_len: usize) {
    run(|s| {
        let session = text(session, session_len)?;
        if let Some(cdm) = s.cdm.as_mut() {
            cdm.close(session);
        }
        if let Some(cdm) = s.widevine.as_mut() {
            cdm.close(session);
        }
        Ok(Vec::new())
    });
}

/// Opens stream `name` from its initialization segment; its tracks are
/// numbered from `base` when muxed. Result: the clear init segment.
///
/// # Safety
/// Pointers must reference readable memory of the given lengths.
#[no_mangle]
pub unsafe extern "C" fn media_init(name: *const u8, name_len: usize, data: *const u8, len: usize, base: u32) -> i32 {
    run(|s| {
        let name = text(name, name_len)?.to_owned();
        let (stream, init) = Stream::open(bytes(data, len), base)?;
        s.streams.insert(name, stream);
        Ok(init)
    })
}

/// Decrypts a media segment of stream `name` with a 16-byte key. The input is
/// modified. With `mux`, fragments are renumbered from `sequence` and tracks
/// get their muxed IDs. Result: the clear fragments.
///
/// # Safety
/// `data` must point to `len` writable bytes and `key` to `key_len` readable bytes.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn media_fragment(
    name: *const u8,
    name_len: usize,
    data: *mut u8,
    len: usize,
    key: *const u8,
    key_len: usize,
    mux: i32,
    sequence: u32,
) -> i32 {
    run(|s| {
        let name = text(name, name_len)?;
        let stream = s.streams.get_mut(name).ok_or_else(|| Error::new("stream is closed"))?;
        let key: [u8; 16] = bytes(key, key_len).try_into().map_err(|_| Error::new("invalid content key"))?;
        let raw = if len == 0 { &mut [][..] } else { std::slice::from_raw_parts_mut(data, len) };
        stream.fragment(raw, &key, mux != 0, sequence)
    })
}

/// Merges the init segments of two streams into one muxed init of `duration`
/// seconds. Result: the muxed init.
///
/// # Safety
/// Pointers must reference readable memory of the given lengths.
#[no_mangle]
pub unsafe extern "C" fn media_mux_init(video: *const u8, video_len: usize, audio: *const u8, audio_len: usize, duration: f64) -> i32 {
    run(|s| {
        let v = s.streams.get(text(video, video_len)?).ok_or_else(|| Error::new("stream is closed"))?;
        let a = s.streams.get(text(audio, audio_len)?).ok_or_else(|| Error::new("stream is closed"))?;
        mux_init(v, a, duration)
    })
}

/// # Safety
/// Pointers must reference readable memory of the given lengths.
#[no_mangle]
pub unsafe extern "C" fn media_release(name: *const u8, name_len: usize) {
    run(|s| {
        s.streams.remove(text(name, name_len)?);
        Ok(Vec::new())
    });
}

struct HostFile {
    handle: u32,
    pos: u64,
}

impl Source for HostFile {
    fn size(&self) -> u64 {
        // SAFETY: host import.
        unsafe { file_size(self.handle) as u64 }
    }
    fn read_at(&mut self, buf: &mut [u8], at: u64) -> usize {
        // SAFETY: buf is valid for writes of its length.
        let n = unsafe { file_read(self.handle, buf.as_mut_ptr(), buf.len(), at as f64) };
        n.max(0) as usize
    }
}

impl Sink for HostFile {
    fn write(&mut self, buf: &[u8]) -> Result<()> {
        // SAFETY: buf is valid for reads of its length.
        let n = unsafe { file_write(self.handle, buf.as_ptr(), buf.len(), self.pos as f64) };
        if n < 0 || n as usize != buf.len() {
            return Err(Error::new("short write"));
        }
        self.pos += buf.len() as u64;
        Ok(())
    }
}

/// Converts the fragmented MP4 of host file `input` into a progressive MP4
/// written to the empty host file `output`. `song` selects the reference song
/// ftyp, otherwise the MV ftyp; both write tracks one after another. `tags` (may be empty) are the
/// iTunes items written into moov.udta.meta.ilst. Result: the output size as
/// a big-endian u64.
///
/// # Safety
/// `tags` must point to `tags_len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn media_defrag(input: u32, output: u32, song: i32, tags: *const u8, tags_len: usize) -> i32 {
    run(|_| {
        let mut out = HostFile { handle: output, pos: 0 };
        if out.size() != 0 {
            return Err(Error::new("defrag output is not empty"));
        }
        let options = if song != 0 { Options::song() } else { Options::mv() }.with_tags(bytes(tags, tags_len).to_vec());
        defragment(HostFile { handle: input, pos: 0 }, &mut out, &options)?;
        Ok(out.pos.to_be_bytes().to_vec())
    })
}
