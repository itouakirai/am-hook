//! Positional IO for defragmentation, with read-ahead for small reads.
//!
//! Parsing the fragmented file issues many tiny reads (box headers, moof
//! bodies), which are served from a read-ahead window. Large reads, such as
//! sample data copied chunk by chunk, are passed through at exactly the
//! requested size: after a jump to another track's chunk nothing beyond it is read.

use crate::{Error, Result};

/// Read-ahead size for small reads that continue right after the current window.
pub const WINDOW: usize = 1 << 20;
/// Read-ahead size for small reads after a jump, and the request size from
/// which reads bypass read-ahead.
pub const MIN_READ: usize = 64 << 10;

/// A random-access input, such as an OPFS `FileSystemSyncAccessHandle`.
pub trait Source {
    fn size(&self) -> u64;
    /// Reads into `buf` at `at`; returns the number of bytes read (0 on failure).
    fn read_at(&mut self, buf: &mut [u8], at: u64) -> usize;
}

/// A sequential output.
pub trait Sink {
    fn write(&mut self, buf: &[u8]) -> Result<()>;
}

impl Source for &[u8] {
    fn size(&self) -> u64 {
        self.len() as u64
    }
    fn read_at(&mut self, buf: &mut [u8], at: u64) -> usize {
        let at = (at as usize).min(self.len());
        let n = buf.len().min(self.len() - at);
        buf[..n].copy_from_slice(&self[at..at + n]);
        n
    }
}

impl Sink for Vec<u8> {
    fn write(&mut self, buf: &[u8]) -> Result<()> {
        self.extend_from_slice(buf);
        Ok(())
    }
}

pub struct Reader<S: Source> {
    src: S,
    size: u64,
    buf: Vec<u8>,
    /// `buf` holds the source bytes `[start, start + len)`.
    start: u64,
    len: usize,
}

impl<S: Source> Reader<S> {
    pub fn new(src: S) -> Self {
        let size = src.size();
        Reader { src, size, buf: Vec::new(), start: 0, len: 0 }
    }

    pub fn size(&self) -> u64 {
        self.size
    }

    /// One read at `pos`, as Go's io.Reader: may return fewer bytes than asked.
    fn read(&mut self, p: &mut [u8], pos: u64) -> Result<usize> {
        if pos >= self.size {
            return Err(Error::new("unexpected EOF"));
        }
        if p.is_empty() {
            return Ok(0);
        }
        if pos >= self.start && pos < self.start + self.len as u64 {
            let from = (pos - self.start) as usize;
            let n = p.len().min(self.len - from);
            p[..n].copy_from_slice(&self.buf[from..from + n]);
            return Ok(n);
        }
        if p.len() >= MIN_READ {
            // Large read: exactly what was requested, straight into p.
            let want = (p.len() as u64).min(self.size - pos) as usize;
            let got = self.src.read_at(&mut p[..want], pos);
            if got == 0 {
                return Err(Error::new("unexpected EOF"));
            }
            return Ok(got);
        }
        let mut n = MIN_READ;
        if self.len > 0 && pos == self.start + self.len as u64 {
            n = WINDOW;
        }
        let n = (n as u64).min(self.size - pos) as usize;
        if self.buf.len() < n {
            self.buf.resize(n, 0);
        }
        let got = self.src.read_at(&mut self.buf[..n], pos);
        if got == 0 {
            self.len = 0;
            return Err(Error::new("unexpected EOF"));
        }
        self.start = pos;
        self.len = got;
        let c = p.len().min(got);
        p[..c].copy_from_slice(&self.buf[..c]);
        Ok(c)
    }

    pub fn read_exact_at(&mut self, p: &mut [u8], mut pos: u64) -> Result<()> {
        let mut done = 0;
        while done < p.len() {
            let n = self.read(&mut p[done..], pos)?;
            done += n;
            pos += n as u64;
        }
        Ok(())
    }

    pub fn read_vec(&mut self, pos: u64, len: u64) -> Result<Vec<u8>> {
        if pos.checked_add(len).is_none_or(|end| end > self.size) {
            return Err(Error::new("unexpected EOF"));
        }
        let mut v = vec![0; len as usize];
        self.read_exact_at(&mut v, pos)?;
        Ok(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Counting<'a> {
        data: &'a [u8],
        reads: Vec<(u64, usize)>,
    }

    impl Source for Counting<'_> {
        fn size(&self) -> u64 {
            self.data.len() as u64
        }
        fn read_at(&mut self, buf: &mut [u8], at: u64) -> usize {
            self.reads.push((at, buf.len()));
            let mut d = self.data;
            d.read_at(buf, at)
        }
    }

    #[test]
    fn small_reads_use_the_window_and_large_ones_pass_through() {
        let data: Vec<u8> = (0..3 << 20).map(|i| i as u8).collect();
        let mut r = Reader::new(Counting { data: &data, reads: Vec::new() });
        let mut small = [0u8; 16];
        r.read_exact_at(&mut small, 10).unwrap();
        r.read_exact_at(&mut small, 100).unwrap();
        assert_eq!(small[0], 100);
        r.read_exact_at(&mut small, MIN_READ as u64 + 10 - 16 + 16).unwrap();
        let mut big = vec![0u8; MIN_READ * 2];
        r.read_exact_at(&mut big, 2 << 20).unwrap();
        assert_eq!(big[1], ((2 << 20) + 1) as u8);
        assert_eq!(r.src.reads, vec![(10, MIN_READ), (10 + MIN_READ as u64, WINDOW), (2 << 20, MIN_READ * 2)]);
    }
}
