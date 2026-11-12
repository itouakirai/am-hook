//! Browser media core for am-hook, compiled to `web/media/media.wasm` by `crates/am-media-wasm`.
//!
//! - [`playready`]: PlayReady license challenges and XMR content-key extraction;
//! - [`widevine`]: Widevine license challenges and content-key extraction;
//! - [`cenc`]: CENC/CBCS decryption of fragmented MP4;
//! - [`mv`]: per-stream MV fragment processing and init muxing;
//! - [`c608`]: repair of malformed closed-caption samples;
//! - [`defrag`]: fragmented to progressive MP4 conversion.
//!
//! The MP4 handling reproduces the Go implementation it replaces (mp4ff based), byte for byte.

pub mod bmff;
pub mod c608;
pub mod cenc;
pub mod crypto;
pub mod defrag;
pub mod frag;
pub mod mv;
pub mod playready;
pub mod readahead;
pub mod widevine;
#[cfg(test)]
mod testutil;

use std::fmt;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error(String);

impl Error {
    pub fn new(msg: &str) -> Error {
        Error(msg.to_owned())
    }

    pub fn msg(msg: String) -> Error {
        Error(msg)
    }

    pub fn context(self, what: &str) -> Error {
        Error(format!("{what}: {}", self.0))
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

/// `Err(Error::msg(format!(...)))`
#[macro_export]
macro_rules! bail {
    ($($arg:tt)*) => { return Err($crate::Error::msg(format!($($arg)*))) };
}
