/// XTC (GROMACS trajectory) binary format parser.
///
/// Port of the xdrfile BSD-licensed decompression algorithm
/// (Erik Lindahl & David van der Spoel, 2009-2014).
///
/// Magic number that identifies an XTC frame header.
const XTC_MAGIC: i32 = 1995;

/// Smallest valid `smallidx` (the first non-zero `MAGICINTS` entry).
const FIRSTIDX: usize = 9;
/// Largest valid `smallidx` (the last `MAGICINTS` entry). A `smallidx` outside
/// `FIRSTIDX..=LASTIDX` names a zero or missing magic integer, so decoding
/// with it would divide by zero or index past the table.
const LASTIDX: usize = MAGICINTS.len() - 1;

#[rustfmt::skip]
static MAGICINTS: [u32; 73] = [
    0,        0,        0,        0,        0,        0,        0,        0,        0,        8,
    10,       12,       16,       20,       25,       32,       40,       50,       64,       80,
    101,      128,      161,      203,      256,      322,      406,      512,      645,      812,
    1024,     1290,     1625,     2048,     2580,     3250,     4096,     5060,     6501,     8192,
    10321,    13003,    16384,    20642,    26007,    32768,    41285,    52015,    65536,    82570,
    104031,   131072,   165140,   208063,   262144,   330280,   416127,   524287,   660561,   832255,
    1048576,  1321122,  1664510,  2097152,  2642245,  3329021,  4194304,  5284491,  6658042,  8388607,
    10568983, 13316085, 16777216,
];

use crate::trajectory::TrajectoryData;

/// Type alias kept for backwards compatibility.
pub type XtcData = TrajectoryData;

// ---------- XDR primitive readers ----------

/// `n` rounded up to the 4-byte XDR boundary, or `None` when that overflows
/// `usize` (a length near `u32::MAX` on wasm32).
fn xdr_padded(n: usize) -> Option<usize> {
    n.checked_add(3).map(|v| v & !3)
}

struct XdrReader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> XdrReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.pos)
    }

    fn read_i32(&mut self) -> Result<i32, String> {
        if self.pos + 4 > self.data.len() {
            return Err("unexpected end of data reading i32".into());
        }
        let val = i32::from_be_bytes([
            self.data[self.pos],
            self.data[self.pos + 1],
            self.data[self.pos + 2],
            self.data[self.pos + 3],
        ]);
        self.pos += 4;
        Ok(val)
    }

    fn read_f32(&mut self) -> Result<f32, String> {
        Ok(f32::from_bits(self.read_i32()? as u32))
    }

    fn read_u32(&mut self) -> Result<u32, String> {
        Ok(self.read_i32()? as u32)
    }

    /// Read `n` raw bytes, advancing position (XDR pads to 4-byte boundary).
    fn read_opaque(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = xdr_padded(n)
            .and_then(|padded| self.pos.checked_add(padded))
            .filter(|&end| end <= self.data.len())
            .ok_or("unexpected end of data reading opaque")?;
        let slice = &self.data[self.pos..self.pos + n];
        self.pos = end;
        Ok(slice)
    }

    /// Jump to an absolute byte position (used to decode a single frame lazily).
    fn seek(&mut self, pos: usize) {
        self.pos = pos;
    }

    /// Advance `n` bytes without reading (used by the index scan to skip past a
    /// compressed coordinate block).
    fn skip(&mut self, n: usize) -> Result<(), String> {
        self.pos = self
            .pos
            .checked_add(n)
            .filter(|&end| end <= self.data.len())
            .ok_or("unexpected end of data while skipping")?;
        Ok(())
    }
}

// ---------- Bitstream reader for compressed coords ----------

struct BitReader<'a> {
    buf: &'a [u8],
    cnt: usize,
    lastbits: u32,
    lastbyte: u32,
}

impl<'a> BitReader<'a> {
    /// Borrow the compressed bitstream directly — no per-frame copy. The caller
    /// (`decompress_coords`) hands us a slice that already lives in the file
    /// buffer, so this avoids a full `to_vec()` of every frame's bitstream.
    fn new(data: &'a [u8]) -> Self {
        Self {
            buf: data,
            cnt: 0,
            lastbits: 0,
            lastbyte: 0,
        }
    }

    /// Read one byte from the buffer, returning 0 past the end.
    /// The C reference allocates a much larger buffer than the compressed data,
    /// so reads past the actual data hit zero-filled padding. We emulate that.
    fn read_byte(&mut self) -> u32 {
        if self.cnt < self.buf.len() {
            let b = self.buf[self.cnt] as u32;
            self.cnt += 1;
            b
        } else {
            self.cnt += 1;
            0
        }
    }

    fn decode_bits(&mut self, mut num_of_bits: u32) -> u32 {
        let mask = (1u32 << num_of_bits) - 1;
        let mut num: u32 = 0;

        while num_of_bits >= 8 {
            self.lastbyte = (self.lastbyte << 8) | self.read_byte();
            num |= (self.lastbyte >> self.lastbits) << (num_of_bits - 8);
            num_of_bits -= 8;
        }
        if num_of_bits > 0 {
            if self.lastbits < num_of_bits {
                self.lastbits += 8;
                self.lastbyte = (self.lastbyte << 8) | self.read_byte();
            }
            self.lastbits -= num_of_bits;
            num |= (self.lastbyte >> self.lastbits) & ((1u32 << num_of_bits) - 1);
        }
        num & mask
    }

    fn decode_ints(&mut self, num_of_ints: usize, num_of_bits: u32, sizes: &[u32]) -> [i32; 3] {
        // Coordinates are always 3D, so this hot-loop helper (called once per atom
        // per frame) returns a fixed-size stack array instead of heap-allocating a
        // Vec on every call.
        debug_assert_eq!(num_of_ints, 3, "decode_ints only decodes 3D coordinates");
        let mut bytes = [0u32; 32];
        let mut num_of_bytes: usize = 0;
        let mut remaining_bits = num_of_bits;

        while remaining_bits > 8 {
            bytes[num_of_bytes] = self.decode_bits(8);
            num_of_bytes += 1;
            remaining_bits -= 8;
        }
        if remaining_bits > 0 {
            bytes[num_of_bytes] = self.decode_bits(remaining_bits);
            num_of_bytes += 1;
        }

        let mut nums = [0i32; 3];
        for i in (1..num_of_ints).rev() {
            let mut num: u32 = 0;
            for j in (0..num_of_bytes).rev() {
                num = (num << 8) | bytes[j];
                let p = num / sizes[i];
                bytes[j] = p;
                num -= p * sizes[i];
            }
            nums[i] = num as i32;
        }
        nums[0] = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) as i32;

        nums
    }
}

// ---------- Helper functions ----------

fn sizeofint(size: u32) -> u32 {
    let mut num: u32 = 1;
    let mut bits: u32 = 0;
    while size >= num && bits < 32 {
        bits += 1;
        num <<= 1;
    }
    bits
}

fn sizeofints(num_of_ints: usize, sizes: &[u32]) -> u32 {
    let mut bytes = [0u32; 32];
    let mut num_of_bytes: usize = 1;
    bytes[0] = 1;

    for &size in sizes.iter().take(num_of_ints) {
        let mut tmp: u64 = 0;
        for byte in bytes.iter_mut().take(num_of_bytes) {
            tmp += *byte as u64 * size as u64;
            *byte = (tmp & 0xff) as u32;
            tmp >>= 8;
        }
        while tmp != 0 {
            bytes[num_of_bytes] = (tmp & 0xff) as u32;
            num_of_bytes += 1;
            tmp >>= 8;
        }
    }

    let mut num: u32 = 1;
    let mut num_of_bits: u32 = 0;
    let last = num_of_bytes - 1;
    while bytes[last] >= num {
        num_of_bits += 1;
        num *= 2;
    }
    num_of_bits + last as u32 * 8
}

// ---------- Decompress one frame's coordinates ----------

/// GROMACS XTC stores coordinates in nanometers; convert to Angstroms.
fn nm_to_angstrom(mut coords: Vec<f32>) -> Vec<f32> {
    for v in &mut coords {
        *v *= 10.0;
    }
    coords
}

/// One frame's coordinates in Å, whichever way the frame stores them.
fn decompress_coords(xdr: &mut XdrReader, natoms: usize) -> Result<Vec<f32>, String> {
    // Read lsize (number of atoms in coordinate block)
    let lsize = xdr.read_i32()? as usize;
    if lsize != natoms {
        return Err(format!("coord block size {} != natoms {}", lsize, natoms));
    }

    // Checked (wasm32): room for natoms*3 ints plus the run-length overshoot pad.
    let size3 = natoms
        .checked_mul(3)
        .filter(|&n| n <= usize::MAX - 36)
        .ok_or_else(|| format!("XTC atom count {natoms} is too large"))?;

    // Small atom count: plain XDR floats, in nm like the compressed ones
    if natoms <= 9 {
        let mut coords = Vec::with_capacity(size3);
        for _ in 0..size3 {
            coords.push(xdr.read_f32()?);
        }
        return Ok(nm_to_angstrom(coords));
    }

    // Read precision
    let precision = xdr.read_f32()?;
    if precision == 0.0 {
        return Err("zero precision in XTC".into());
    }
    let inv_precision = 1.0f32 / precision;

    // Read min/max integer coords
    let mut minint = [0i32; 3];
    let mut maxint = [0i32; 3];
    for v in &mut minint {
        *v = xdr.read_i32()?;
    }
    for v in &mut maxint {
        *v = xdr.read_i32()?;
    }

    let mut sizeint = [0u32; 3];
    for i in 0..3 {
        // A range is at least one integer and, as in the C reference's `int`
        // arithmetic, below 2^31 (so a large coordinate takes at most 31 bits).
        sizeint[i] = i32::try_from(maxint[i] as i64 - minint[i] as i64 + 1)
            .ok()
            .filter(|&n| n > 0)
            .map(|n| n as u32)
            .ok_or_else(|| format!("invalid XTC coordinate range {}..{}", minint[i], maxint[i]))?;
    }

    // Determine encoding mode
    let mut bitsizeint = [0u32; 3];
    let bitsize = if (sizeint[0] | sizeint[1] | sizeint[2]) > 0x00ff_ffff {
        bitsizeint[0] = sizeofint(sizeint[0]);
        bitsizeint[1] = sizeofint(sizeint[1]);
        bitsizeint[2] = sizeofint(sizeint[2]);
        0
    } else {
        sizeofints(3, &sizeint)
    };

    let smallidx_raw = xdr.read_i32()?;
    let mut smallidx = usize::try_from(smallidx_raw)
        .ok()
        .filter(|i| (FIRSTIDX..=LASTIDX).contains(i))
        .ok_or_else(|| format!("invalid XTC smallidx {smallidx_raw}"))?;
    let tmp_idx = if smallidx > 0 { smallidx - 1 } else { 0 };
    let tmp_idx = if FIRSTIDX > tmp_idx {
        FIRSTIDX
    } else {
        tmp_idx
    };
    let mut smaller = MAGICINTS[tmp_idx] / 2;
    let mut smallnum = MAGICINTS[smallidx] / 2;
    let mut sizesmall = [MAGICINTS[smallidx]; 3];

    // Read compressed bitstream
    let nbytes = xdr.read_u32()? as usize;
    let bitstream_data = xdr.read_opaque(nbytes)?;

    // `natoms` comes from the frame header, so check it against the bitstream
    // before sizing buffers from it. Every atom costs at least two bits: an
    // absolute coordinate (one bit or more) plus its run flag, or a delta of
    // `smallidx` (>= FIRSTIDX) bits inside a run. The slack covers one run
    // decoded with an out-of-range `smallidx` before the decoder rejects it.
    if natoms > nbytes.saturating_mul(4).saturating_add(16) {
        return Err(format!(
            "XTC frame claims {natoms} atoms but its {nbytes}-byte bitstream cannot hold them"
        ));
    }

    let mut bits = BitReader::new(bitstream_data);

    // Decompress.
    // The run-length inner loop can advance `i` past natoms (up to +10 atoms).
    // The C reference allocates a much larger buffer; we add padding here.
    let mut coords = vec![0i32; size3 + 36];
    let mut output = Vec::with_capacity(size3);
    let mut prevcoord = [0i32; 3];

    // `run` and `is_smaller` persist across iterations of the outer loop,
    // matching the C xdrfile reference. When flag=0 the decoder reuses the
    // previous run length to read delta coordinates from the bitstream.
    let mut run: usize = 0;
    let mut is_smaller: i32;

    let mut i: usize = 0;
    while i < natoms {
        // Read large (absolute) coordinate
        let this = i * 3;
        if bitsize == 0 {
            coords[this] = bits.decode_bits(bitsizeint[0]) as i32;
            coords[this + 1] = bits.decode_bits(bitsizeint[1]) as i32;
            coords[this + 2] = bits.decode_bits(bitsizeint[2]) as i32;
        } else {
            let decoded = bits.decode_ints(3, bitsize, &sizeint);
            coords[this] = decoded[0];
            coords[this + 1] = decoded[1];
            coords[this + 2] = decoded[2];
        }

        i += 1;
        coords[this] += minint[0];
        coords[this + 1] += minint[1];
        coords[this + 2] += minint[2];

        prevcoord[0] = coords[this];
        prevcoord[1] = coords[this + 1];
        prevcoord[2] = coords[this + 2];

        // Read run-length flag
        let flag = bits.decode_bits(1);
        is_smaller = 0;
        if flag == 1 {
            let run_val = bits.decode_bits(5) as i32;
            is_smaller = run_val % 3;
            run = (run_val - is_smaller) as usize;
            is_smaller -= 1;
        }

        // Decode run of small (delta) coordinates
        if run > 0 {
            for k in (0..run).step_by(3) {
                let ri = i * 3;
                let decoded = bits.decode_ints(3, smallidx as u32, &sizesmall);
                coords[ri] = decoded[0];
                coords[ri + 1] = decoded[1];
                coords[ri + 2] = decoded[2];
                i += 1;

                coords[ri] += prevcoord[0] - smallnum as i32;
                coords[ri + 1] += prevcoord[1] - smallnum as i32;
                coords[ri + 2] += prevcoord[2] - smallnum as i32;

                if k == 0 {
                    // Swap first run coord with the large coord
                    std::mem::swap(&mut coords[ri], &mut prevcoord[0]);
                    std::mem::swap(&mut coords[ri + 1], &mut prevcoord[1]);
                    std::mem::swap(&mut coords[ri + 2], &mut prevcoord[2]);

                    output.push(prevcoord[0] as f32 * inv_precision);
                    output.push(prevcoord[1] as f32 * inv_precision);
                    output.push(prevcoord[2] as f32 * inv_precision);
                } else {
                    prevcoord[0] = coords[ri];
                    prevcoord[1] = coords[ri + 1];
                    prevcoord[2] = coords[ri + 2];
                }
                output.push(coords[ri] as f32 * inv_precision);
                output.push(coords[ri + 1] as f32 * inv_precision);
                output.push(coords[ri + 2] as f32 * inv_precision);
            }
        } else {
            output.push(coords[this] as f32 * inv_precision);
            output.push(coords[this + 1] as f32 * inv_precision);
            output.push(coords[this + 2] as f32 * inv_precision);
        }

        // Adjust smallidx; a step out of the table is a corrupt bitstream (the
        // C reference rejects the zero magic integer below FIRSTIDX too).
        smallidx = smallidx
            .checked_add_signed(is_smaller as isize)
            .filter(|i| (FIRSTIDX..=LASTIDX).contains(i))
            .ok_or("invalid sizesmall in xdr3dfcoord")?;
        if is_smaller < 0 {
            smallnum = smaller;
            if smallidx > FIRSTIDX {
                smaller = MAGICINTS[smallidx - 1] / 2;
            } else {
                smaller = 0;
            }
        } else if is_smaller > 0 {
            smaller = smallnum;
            smallnum = MAGICINTS[smallidx] / 2;
        }
        sizesmall = [MAGICINTS[smallidx]; 3];
    }

    // Truncate output to exactly natoms*3 (run-length can overshoot)
    output.truncate(size3);

    Ok(nm_to_angstrom(output))
}

// ---------- Frame header + index scan (shared by eager and lazy paths) ----------

/// The fixed 52-byte XTC frame header: magic + natoms + step + time + 3x3 box.
struct FrameHeader {
    natoms: usize,
    time: f32,
    box_matrix: [f32; 9],
}

/// Read one frame header from the current cursor. Returns `Ok(None)` on a clean
/// end-of-stream (fewer than a header's worth of bytes remain), `Err` on a
/// corrupt header. Shared by `parse_xtc` (eager) and `build_index`/`decode_frame_at`
/// (lazy) so the header layout lives in exactly one place.
fn read_frame_header(xdr: &mut XdrReader) -> Result<Option<FrameHeader>, String> {
    // A frame needs at least magic+natoms+step+time (16 bytes) to begin.
    if xdr.remaining() < 16 {
        return Ok(None);
    }
    let magic = xdr.read_i32()?;
    if magic != XTC_MAGIC {
        return Err(format!("bad XTC magic: {} (expected {})", magic, XTC_MAGIC));
    }
    let natoms_raw = xdr.read_i32()?;
    let natoms = match usize::try_from(natoms_raw) {
        Ok(0) => return Err("zero atoms in XTC frame".into()),
        Ok(n) => n,
        Err(_) => return Err(format!("negative atom count {natoms_raw} in XTC frame")),
    };
    let _step = xdr.read_i32()?;
    let time = xdr.read_f32()?;
    let mut box_matrix = [0f32; 9];
    for v in &mut box_matrix {
        *v = xdr.read_f32()? * 10.0; // nm -> Angstrom
    }
    Ok(Some(FrameHeader {
        natoms,
        time,
        box_matrix,
    }))
}

/// Size of the fixed frame header read by `read_frame_header`.
const FRAME_HEADER_BYTES: usize = 52;

/// Bytes from the start of a frame that the index scan reads to find where the
/// next frame starts: the 52-byte header, the coordinate block's atom count,
/// and — for a compressed block — its 32-byte sub-header and byte count.
pub const FRAME_PEEK_BYTES: usize = FRAME_HEADER_BYTES + 4 + 32 + 4;

/// Byte length of the coordinate block at the cursor (at its `lsize` field),
/// read from its fixed-size sub-header (`nbytes` sits at a fixed offset), so
/// the index scan is O(1) per frame regardless of atom count and never reads
/// the block's body.
fn coord_block_len(xdr: &mut XdrReader, natoms: usize) -> Result<usize, String> {
    let lsize = xdr.read_i32()? as usize;
    if lsize != natoms {
        return Err(format!("coord block size {} != natoms {}", lsize, natoms));
    }
    if natoms <= 9 {
        // Plain XDR floats: natoms*3 four-byte values (already 4-byte aligned).
        return Ok(4 + natoms * 3 * 4);
    }
    // precision(4) + minint[3](12) + maxint[3](12) + smallidx(4) = 32 bytes.
    xdr.skip(32)?;
    let nbytes = xdr.read_u32()? as usize;
    // XDR opaque data is padded to a 4-byte boundary.
    xdr_padded(nbytes)
        .and_then(|padded| padded.checked_add(4 + 32 + 4))
        .ok_or_else(|| format!("XTC coordinate block of {nbytes} bytes is too large"))
}

/// Lightweight index over an XTC file: per-frame byte offsets + times + the box,
/// built without decompressing any coordinates. Backs lazy/streaming decode.
pub struct XtcIndex {
    pub n_atoms: usize,
    pub n_frames: usize,
    pub timestep_ps: f32,
    /// Frame 0's box: the representative cell `parse_xtc` reports.
    pub box_matrix: Option<[f32; 9]>,
    /// Byte offset of each frame's magic header (64-bit: a file indexed in
    /// windows by `XtcIndexBuilder` may be larger than wasm32's address space).
    pub offsets: Vec<u64>,
    /// Per-frame time (ps).
    pub times: Vec<f32>,
    /// Every frame's box, when it is not the same in all of them (an NPT run);
    /// `None` for a constant cell, as `parse_xtc` builds no side table then.
    pub frame_cells: Option<Vec<[f32; 9]>>,
}

/// Builds an [`XtcIndex`] from consecutive windows of a file instead of the
/// whole of it, so a host can index a file it never loads into memory: hand
/// [`scan`](Self::scan) the file's bytes from [`next_offset`](Self::next_offset)
/// on, again and again, until that offset reaches the end of the file. A
/// window needs only [`FRAME_PEEK_BYTES`] of each frame; the compressed
/// coordinates past them are skipped without being read.
#[derive(Default)]
pub struct XtcIndexBuilder {
    n_atoms: usize,
    first_box: Option<[f32; 9]>,
    /// Recorded from the first frame whose box differs from frame 0's.
    cells: Vec<[f32; 9]>,
    varies_cell: bool,
    offsets: Vec<u64>,
    times: Vec<f32>,
    next: u64,
}

impl XtcIndexBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    /// File offset of the next frame header, where the next window starts.
    pub fn next_offset(&self) -> u64 {
        self.next
    }

    /// Index every frame whose header lies in `window` (the file's bytes from
    /// `next_offset()` on) and move `next_offset()` past them, possibly beyond
    /// the window. Without `at_eof`, a frame whose first `FRAME_PEEK_BYTES`
    /// are not all in the window waits for the next one; with it (the window
    /// runs to the end of the file), fewer than 16 trailing bytes end the file
    /// and anything else must parse. Returns how many frames were found.
    pub fn scan(&mut self, window: &[u8], at_eof: bool) -> Result<usize, String> {
        let mut pos = 0usize;
        let mut found = 0usize;
        while pos < window.len() {
            let rest = &window[pos..];
            if rest.len() < FRAME_PEEK_BYTES && !at_eof {
                break;
            }
            let mut xdr = XdrReader::new(rest);
            let header = match read_frame_header(&mut xdr)? {
                Some(h) => h,
                None => break,
            };
            if self.n_atoms == 0 {
                self.n_atoms = header.natoms;
            } else if header.natoms != self.n_atoms {
                return Err(format!(
                    "inconsistent atom count: {} vs {}",
                    header.natoms, self.n_atoms
                ));
            }
            // Saturating (wasm32): a frame longer than the address space runs
            // past the end of the file, which `finish` reports.
            let len = coord_block_len(&mut xdr, self.n_atoms)?.saturating_add(FRAME_HEADER_BYTES);
            self.offsets.push(self.next + pos as u64);
            self.times.push(header.time);
            // The per-frame cell table `parse_xtc` builds, the same way.
            let first = *self.first_box.get_or_insert(header.box_matrix);
            if !self.varies_cell && first != header.box_matrix {
                self.varies_cell = true;
                self.cells
                    .extend(std::iter::repeat_n(first, self.offsets.len() - 1));
            }
            if self.varies_cell {
                self.cells.push(header.box_matrix);
            }
            pos = pos.saturating_add(len);
            found += 1;
        }
        self.next = self.next.saturating_add(pos as u64);
        Ok(found)
    }

    /// The index of a `file_len`-byte file whose windows have all been scanned.
    pub fn finish(self, file_len: u64) -> Result<XtcIndex, String> {
        if self.next > file_len {
            return Err("truncated XTC frame: coordinates run past the end of the file".into());
        }
        if self.offsets.is_empty() {
            return Err("no frames found in XTC file".into());
        }
        let n_frames = self.offsets.len();
        let timestep_ps = if n_frames > 1 {
            self.times[1] - self.times[0]
        } else {
            1.0
        };
        Ok(XtcIndex {
            n_atoms: self.n_atoms,
            n_frames,
            timestep_ps,
            box_matrix: self.first_box,
            offsets: self.offsets,
            times: self.times,
            frame_cells: self.varies_cell.then_some(self.cells),
        })
    }
}

/// Scan an XTC file and build its frame index without decoding coordinates.
pub fn build_index(data: &[u8]) -> Result<XtcIndex, String> {
    let mut builder = XtcIndexBuilder::new();
    builder.scan(data, true)?;
    builder.finish(data.len() as u64)
}

/// Decode a single frame's coordinates (Å) given its byte offset (from
/// `build_index`). Reuses the exact `decompress_coords` path, so the output is
/// bit-identical to the corresponding `parse_xtc` frame.
pub fn decode_frame_at(data: &[u8], offset: usize, natoms: usize) -> Result<Vec<f32>, String> {
    let mut xdr = XdrReader::new(data);
    xdr.seek(offset);
    let header = read_frame_header(&mut xdr)?.ok_or("frame offset past end of data")?;
    if header.natoms != natoms {
        return Err(format!(
            "frame atom count {} != expected {}",
            header.natoms, natoms
        ));
    }
    decompress_coords(&mut xdr, natoms)
}

// ---------- Public API ----------

/// Parse an XTC binary trajectory and return all frames.
pub fn parse_xtc(data: &[u8]) -> Result<XtcData, String> {
    let mut xdr = XdrReader::new(data);
    // Frame-major flat coordinates (frame count unknown up front → amortized growth).
    let mut frame_positions_flat: Vec<f32> = Vec::new();
    let mut n_frames: usize = 0;
    let mut n_atoms: usize = 0;
    let mut first_time: f32 = 0.0;
    let mut second_time: f32 = 0.0;
    let mut first_box: Option<[f32; 9]> = None;
    // Per-frame cell recording, started lazily only once a frame's box diverges
    // from frame 0 (constant-cell runs allocate nothing and keep parity).
    let mut per_frame_cells: Vec<[f32; 9]> = Vec::new();
    let mut varies_cell = false;

    while let Some(header) = read_frame_header(&mut xdr)? {
        if n_atoms == 0 {
            n_atoms = header.natoms;
        } else if header.natoms != n_atoms {
            return Err(format!(
                "inconsistent atom count: {} vs {}",
                header.natoms, n_atoms
            ));
        }

        if n_frames == 0 {
            first_time = header.time;
            first_box = Some(header.box_matrix);
        } else if n_frames == 1 {
            second_time = header.time;
        }
        // Detect a per-frame cell change; backfill earlier frames with frame 0's
        // box the first time we diverge.
        if !varies_cell && first_box != Some(header.box_matrix) {
            varies_cell = true;
            per_frame_cells.extend(std::iter::repeat_n(first_box.unwrap(), n_frames));
        }
        if varies_cell {
            per_frame_cells.push(header.box_matrix);
        }

        // Decompress coordinate data straight into the flat buffer.
        let positions = decompress_coords(&mut xdr, n_atoms)?;
        frame_positions_flat.extend_from_slice(&positions);
        n_frames += 1;
    }

    if n_frames == 0 {
        return Err("no frames found in XTC file".into());
    }

    let timestep_ps = if n_frames > 1 {
        second_time - first_time
    } else {
        1.0
    };

    let hetero = crate::trajectory::build_cell_hetero(varies_cell, per_frame_cells, n_atoms);

    Ok(XtcData {
        n_atoms,
        n_frames,
        timestep_ps,
        box_matrix: first_box,
        box_origin: None,
        frame_positions_flat,
        vector_channels: vec![],
        hetero,
        warnings: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_demo_xtc() {
        let data = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/1crn_vibration.xtc"
        ))
        .expect("read XTC");
        let result = parse_xtc(&data).expect("parse XTC");
        assert_eq!(result.n_atoms, 327);
        assert_eq!(result.n_frames, 100);

        // Reference values from MDAnalysis (Angstroms)
        let frame0 = result.frame(0);
        let check = |idx: usize, ex: f32, ey: f32, ez: f32| {
            let (x, y, z) = (frame0[idx * 3], frame0[idx * 3 + 1], frame0[idx * 3 + 2]);
            assert!(
                (x - ex).abs() < 0.02 && (y - ey).abs() < 0.02 && (z - ez).abs() < 0.02,
                "atom {} mismatch: got ({:.4},{:.4},{:.4}), expected ({:.4},{:.4},{:.4})",
                idx,
                x,
                y,
                z,
                ex,
                ey,
                ez,
            );
        };
        check(0, 17.22, 14.25, 3.76);
        check(169, 7.09, 15.22, 0.81);
        check(200, 1.44, 13.00, 6.36);
        check(326, 12.61, 4.89, 10.66);
        // This demo trajectory holds a constant box → uniform fast path.
        assert!(result.hetero.is_none());
    }

    #[test]
    fn decode_frame_at_matches_parse_xtc() {
        let data = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/1crn_vibration.xtc"
        ))
        .expect("read XTC");

        let eager = parse_xtc(&data).expect("parse XTC");
        let idx = build_index(&data).expect("build index");

        // Index parity with the eager parse.
        assert_eq!(idx.n_frames, eager.n_frames);
        assert_eq!(idx.n_atoms, eager.n_atoms);
        assert_eq!(idx.offsets.len(), eager.n_frames);
        assert_eq!(idx.offsets[0], 0);
        assert!((idx.timestep_ps - eager.timestep_ps).abs() < 1e-6);

        // Every lazily-decoded frame must be BIT-IDENTICAL to the eager frame:
        // decode_frame_at reuses the same decompress_coords, so this is exact.
        for i in 0..idx.n_frames {
            let lazy = decode_frame_at(&data, idx.offsets[i] as usize, idx.n_atoms)
                .unwrap_or_else(|e| panic!("decode frame {i}: {e}"));
            assert_eq!(lazy, eager.frame(i), "frame {i} mismatch");
        }
    }

    fn demo_xtc() -> Vec<u8> {
        std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/1crn_vibration.xtc"
        ))
        .expect("read XTC")
    }

    /// Index `data` the way a host reading a file in `window`-byte pieces does.
    fn index_in_windows(data: &[u8], window: usize) -> Result<XtcIndex, String> {
        let mut builder = XtcIndexBuilder::new();
        while (builder.next_offset() as usize) < data.len() {
            let start = builder.next_offset() as usize;
            let end = (start + window).min(data.len());
            builder.scan(&data[start..end], end == data.len())?;
        }
        builder.finish(data.len() as u64)
    }

    #[test]
    fn windowed_index_matches_whole_file_index() {
        let data = demo_xtc();
        let whole = build_index(&data).expect("build index");
        // From a window that holds only a header's worth of bytes to one that
        // holds several frames: the index must not depend on how it was read.
        for window in [FRAME_PEEK_BYTES, 100, 4096, 65536] {
            let idx = index_in_windows(&data, window).expect("windowed index");
            assert_eq!(idx.offsets, whole.offsets, "window {window}");
            assert_eq!(idx.times, whole.times, "window {window}");
            assert_eq!(idx.n_atoms, whole.n_atoms);
            assert_eq!(idx.box_matrix, whole.box_matrix);
            assert_eq!(idx.timestep_ps, whole.timestep_ps);
        }
    }

    #[test]
    fn a_frame_decodes_from_its_own_bytes() {
        let data = demo_xtc();
        let eager = parse_xtc(&data).expect("parse XTC");
        let idx = index_in_windows(&data, 4096).expect("windowed index");
        for i in [0, 1, idx.n_frames - 1] {
            let start = idx.offsets[i] as usize;
            let end = idx.offsets.get(i + 1).map_or(data.len(), |&o| o as usize);
            let frame = decode_frame_at(&data[start..end], 0, idx.n_atoms).expect("decode");
            assert_eq!(frame, eager.frame(i), "frame {i}");
        }
    }

    #[test]
    fn a_window_short_of_a_header_waits_for_more() {
        let data = demo_xtc();
        let mut builder = XtcIndexBuilder::new();
        assert_eq!(builder.scan(&data[..FRAME_PEEK_BYTES - 1], false), Ok(0));
        assert_eq!(builder.next_offset(), 0);
    }

    #[test]
    fn a_truncated_file_is_rejected() {
        let data = demo_xtc();
        // The last frame's coordinates are cut short.
        assert!(build_index(&data[..data.len() - 8]).is_err());
        assert!(index_in_windows(&data[..data.len() - 8], 4096).is_err());
        // A partial header after the last frame is corrupt too.
        let mut extra = data.clone();
        extra.extend_from_slice(&data[..20]);
        assert!(build_index(&extra).is_err());
        // Fewer bytes than a header's first fields end the file cleanly.
        let mut tail = data.clone();
        tail.extend_from_slice(&[0; 8]);
        assert_eq!(build_index(&tail).expect("index").n_frames, 100);
    }

    /// A trajectory of `natoms <= 9` atoms, whose coordinates XTC stores as
    /// plain floats instead of compressing them.
    fn tiny_xtc(natoms: usize, frames: usize) -> Vec<u8> {
        let mut out = Vec::new();
        let push_i32 = |out: &mut Vec<u8>, v: i32| out.extend_from_slice(&v.to_be_bytes());
        let push_f32 = |out: &mut Vec<u8>, v: f32| out.extend_from_slice(&v.to_be_bytes());
        for f in 0..frames {
            push_i32(&mut out, XTC_MAGIC);
            push_i32(&mut out, natoms as i32);
            push_i32(&mut out, f as i32); // step
            push_f32(&mut out, f as f32 * 2.0); // time (ps)
            for v in [3.0, 0.0, 0.0, 0.0, 3.0, 0.0, 0.0, 0.0, 3.0] {
                push_f32(&mut out, v);
            }
            push_i32(&mut out, natoms as i32);
            for c in 0..natoms * 3 {
                push_f32(&mut out, (f * 100 + c) as f32);
            }
        }
        out
    }

    #[test]
    fn uncompressed_frames_are_indexed_in_windows_too() {
        let data = tiny_xtc(2, 3);
        let frame_len = FRAME_HEADER_BYTES + 4 + 2 * 3 * 4;
        let whole = build_index(&data).expect("build index");
        assert_eq!(whole.n_frames, 3);
        assert_eq!(
            whole.offsets,
            vec![0, frame_len as u64, 2 * frame_len as u64]
        );
        assert_eq!(whole.timestep_ps, 2.0);
        // Windows of FRAME_PEEK_BYTES or more (the builder's contract), here
        // a frame and a bit or several frames.
        for window in [FRAME_PEEK_BYTES, 2 * frame_len, 1000] {
            let idx = index_in_windows(&data, window).expect("windowed index");
            assert_eq!(idx.offsets, whole.offsets, "window {window}");
        }
        let last = &data[2 * frame_len..];
        assert_eq!(decode_frame_at(last, 0, 2).expect("decode").len(), 6);
    }

    #[test]
    fn a_changing_box_is_indexed_for_every_frame() {
        let mut data = tiny_xtc(2, 3);
        let frame_len = FRAME_HEADER_BYTES + 4 + 2 * 3 * 4;
        // Frames 1 and 2 grow their box's first edge (the box follows the
        // 16-byte magic / atom count / step / time fields).
        for (frame, edge) in [(1usize, 4.0f32), (2, 5.0)] {
            let at = frame * frame_len + 16;
            data[at..at + 4].copy_from_slice(&edge.to_be_bytes());
        }
        let idx = build_index(&data).expect("build index");
        // Frame 0's box is the representative cell, as `parse_xtc` reports it
        // (boxes are read in nm and kept in Å).
        let eager = parse_xtc(&data).expect("parse");
        assert_eq!(idx.box_matrix.expect("frame 0 box")[0], 30.0);
        assert_eq!(idx.box_matrix, eager.box_matrix);
        let cells = idx.frame_cells.expect("per-frame cells");
        assert_eq!(
            cells.iter().map(|c| c[0]).collect::<Vec<_>>(),
            [30.0, 40.0, 50.0]
        );
        for (f, cell) in cells.iter().enumerate() {
            assert_eq!(Some(&cell[..]), eager.frame_cell(f));
        }
        // A box that stays put records no per-frame table.
        assert!(build_index(&tiny_xtc(2, 3)).unwrap().frame_cells.is_none());
    }

    #[test]
    fn uncompressed_coordinates_are_converted_to_angstrom() {
        // tiny_xtc writes frame f's coordinate c as (f * 100 + c) nm, and a
        // 3 nm cubic box.
        let data = tiny_xtc(2, 3);
        let expected =
            |f: usize| -> Vec<f32> { (0..6).map(|c| (f * 100 + c) as f32 * 10.0).collect() };
        let eager = parse_xtc(&data).expect("parse XTC");
        assert_eq!(eager.n_atoms, 2);
        for f in 0..3 {
            assert_eq!(eager.frame(f), expected(f), "eager frame {f}");
        }
        let idx = build_index(&data).expect("build index");
        for f in 0..3 {
            let lazy = decode_frame_at(&data, idx.offsets[f] as usize, 2).expect("decode");
            assert_eq!(lazy, expected(f), "lazy frame {f}");
        }
        // The box was already converted; positions now share its unit.
        assert_eq!(idx.box_matrix.expect("box")[0], 30.0);
    }

    #[test]
    fn an_empty_file_has_no_frames() {
        assert!(build_index(&[]).is_err());
        assert!(XtcIndexBuilder::new().finish(0).is_err());
    }

    #[test]
    fn inconsistent_atom_counts_are_rejected() {
        let data = demo_xtc();
        let idx = build_index(&data).expect("build index");
        let mut mixed = data[..idx.offsets[1] as usize].to_vec();
        // A second frame claiming one atom more.
        let mut second = data[idx.offsets[1] as usize..idx.offsets[2] as usize].to_vec();
        second[4..8].copy_from_slice(&328i32.to_be_bytes());
        mixed.extend_from_slice(&second);
        assert!(build_index(&mixed).is_err());
    }

    #[test]
    fn decode_frame_at_rejects_bad_offset() {
        let data = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/1crn_vibration.xtc"
        ))
        .expect("read XTC");
        // An offset that is not a frame boundary must error (bad magic), not panic.
        assert!(decode_frame_at(&data, 3, 327).is_err());
    }

    /// A compressed frame header claiming 2^30 atoms over an empty bitstream
    /// is rejected before any buffer is sized from that count (a 92-byte
    /// file used to reserve ~25 GB and abort the process).
    #[test]
    fn an_atom_count_the_bitstream_cannot_hold_is_an_error() {
        let frame = |natoms: i32, nbytes: u32| {
            let mut d = Vec::new();
            d.extend_from_slice(&XTC_MAGIC.to_be_bytes());
            d.extend_from_slice(&natoms.to_be_bytes());
            d.extend_from_slice(&0i32.to_be_bytes()); // step
            d.extend_from_slice(&0f32.to_be_bytes()); // time
            d.extend_from_slice(&[0u8; 36]); // box
            d.extend_from_slice(&natoms.to_be_bytes()); // lsize
            d.extend_from_slice(&1000f32.to_be_bytes()); // precision
            d.extend_from_slice(&[0u8; 24]); // minint / maxint
            d.extend_from_slice(&9i32.to_be_bytes()); // smallidx
            d.extend_from_slice(&nbytes.to_be_bytes());
            d.extend(std::iter::repeat_n(0u8, (nbytes as usize + 3) & !3));
            d
        };
        let huge = frame(1 << 30, 0);
        assert_eq!(huge.len(), 92);
        let err = parse_xtc(&huge).err().expect("rejected");
        assert!(err.contains("bitstream"), "{err}");
        assert!(decode_frame_at(&huge, 0, 1 << 30).is_err());

        // A count the stream can hold still decodes (all-zero bits: every
        // atom at the origin, two bits each).
        let small = frame(16, 8);
        let t = parse_xtc(&small).expect("16 atoms fit in 8 bytes");
        assert_eq!(t.n_atoms, 16);
        assert!(t.frame(0).iter().all(|&v| v == 0.0));
    }

    fn crn_fixture() -> Vec<u8> {
        std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/1crn_vibration.xtc"
        ))
        .expect("read XTC")
    }

    /// One compressed frame of `natoms` atoms: every coordinate range is the single
    /// integer 0 (one bit per large coordinate), then `smallidx` and the
    /// bitstream `bits`.
    fn compressed_frame(natoms: i32, smallidx: i32, bits: &[u8]) -> Vec<u8> {
        let mut d = Vec::new();
        d.extend_from_slice(&XTC_MAGIC.to_be_bytes());
        d.extend_from_slice(&natoms.to_be_bytes());
        d.extend_from_slice(&0i32.to_be_bytes()); // step
        d.extend_from_slice(&0f32.to_be_bytes()); // time
        d.extend_from_slice(&[0u8; 36]); // box
        d.extend_from_slice(&natoms.to_be_bytes()); // lsize
        d.extend_from_slice(&1000f32.to_be_bytes()); // precision
        d.extend_from_slice(&[0u8; 24]); // minint = maxint = 0
        d.extend_from_slice(&smallidx.to_be_bytes());
        d.extend_from_slice(&(bits.len() as u32).to_be_bytes());
        d.extend_from_slice(bits);
        while !d.len().is_multiple_of(4) {
            d.push(0);
        }
        d
    }

    #[test]
    fn smallidx_outside_the_magic_table_is_an_error() {
        // The fixture's first frame keeps smallidx at bytes 84..88 (after the
        // 52-byte header, lsize, precision and minint/maxint).
        let crn = crn_fixture();
        for bad in [-1i32, 0, 5, 8, 73, 100] {
            let mut d = crn.clone();
            d[84..88].copy_from_slice(&bad.to_be_bytes());
            let err = parse_xtc(&d)
                .err()
                .unwrap_or_else(|| panic!("smallidx {bad}"));
            assert!(err.contains("smallidx"), "smallidx {bad}: {err}");
        }
        // The table's ends are valid: an all-zero bitstream decodes.
        for ok in [FIRSTIDX as i32, LASTIDX as i32] {
            let d = compressed_frame(10, ok, &[0; 8]);
            assert_eq!(parse_xtc(&d).expect("valid smallidx").n_frames, 1);
        }
    }

    #[test]
    fn a_zero_magic_integer_is_rejected_before_dividing_by_it() {
        // smallidx 5 names MAGICINTS[5] == 0; a run of small coordinates
        // (large = 0, flag = 1, run = 3) would divide by it.
        let d = compressed_frame(10, 5, &[0b0100_0110, 0, 0, 0]);
        assert!(parse_xtc(&d).err().unwrap().contains("smallidx"));
    }

    #[test]
    fn smallidx_stepping_past_the_table_is_an_error() {
        // large = 0, flag = 1, run_val = 2 → is_smaller = +1 with no run, so
        // smallidx steps from LASTIDX past the end of MAGICINTS.
        let d = compressed_frame(10, LASTIDX as i32, &[0b0100_0100, 0, 0, 0]);
        assert!(parse_xtc(&d).err().unwrap().contains("sizesmall"));
        // run_val = 0 → is_smaller = -1: from FIRSTIDX down to a zero magic
        // integer, which the C reference rejects too.
        let d = compressed_frame(10, FIRSTIDX as i32, &[0b0100_0000, 0, 0, 0]);
        assert!(parse_xtc(&d).err().unwrap().contains("sizesmall"));
    }

    #[test]
    fn a_negative_atom_count_is_an_error() {
        let d = compressed_frame(-1, 9, &[0; 4]);
        assert!(parse_xtc(&d).err().unwrap().contains("negative atom count"));
        assert!(build_index(&d)
            .err()
            .unwrap()
            .contains("negative atom count"));
        assert!(decode_frame_at(&d, 0, 10).is_err());
    }

    #[test]
    fn an_empty_coordinate_range_is_an_error() {
        // maxint < minint: a range of zero (or fewer) integers, which the
        // bitstream would divide by.
        let mut d = compressed_frame(10, 9, &[0; 4]);
        // minint[0] sits after the header, lsize and precision.
        d[60..64].copy_from_slice(&5i32.to_be_bytes());
        assert!(parse_xtc(&d).err().unwrap().contains("coordinate range"));
        // A range past i32 (the C reference's `int` arithmetic).
        let mut d = compressed_frame(10, 9, &[0; 4]);
        d[60..64].copy_from_slice(&i32::MIN.to_be_bytes());
        d[72..76].copy_from_slice(&i32::MAX.to_be_bytes());
        assert!(parse_xtc(&d).err().unwrap().contains("coordinate range"));
    }

    #[test]
    fn sizes_near_the_address_space_do_not_wrap() {
        // On wasm32 `nbytes + 3` overflows `usize`; the padding must refuse
        // rather than wrap to a tiny length.
        assert_eq!(xdr_padded(5), Some(8));
        assert_eq!(xdr_padded(usize::MAX - 2), None);
        let mut xdr = XdrReader::new(&[0u8; 8]);
        assert!(xdr.read_opaque(usize::MAX - 2).is_err());
        assert!(xdr.read_opaque(usize::MAX).is_err());
        assert!(xdr.skip(usize::MAX).is_err());
        // A byte count past the file is an error in the eager parse and the
        // index alike.
        let d = compressed_frame(10, 9, &[0; 4]);
        let mut huge = d.clone();
        huge[88..92].copy_from_slice(&0xFFFF_FFFEu32.to_be_bytes());
        assert!(parse_xtc(&huge).is_err());
        assert!(build_index(&huge).is_err());
    }
}
