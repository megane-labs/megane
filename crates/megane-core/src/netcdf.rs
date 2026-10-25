/// Minimal AMBER NetCDF (NCTRAJ) trajectory parser.
///
/// Handles NetCDF CDF-1 and CDF-2 (classic) format files following the AMBER
/// NetCDF trajectory convention:
/// https://ambermd.org/netcdf/nctraj.xhtml
///
/// Only the variables needed for trajectory visualization are decoded:
/// `coordinates`, `time`, `cell_lengths`, `cell_angles`.
use crate::cell::cell_params_to_matrix;
use crate::trajectory::{TrajectoryData, VectorChannel, VectorFrame};

const TAG_DIM: u32 = 10;
const TAG_VAR: u32 = 11;
const TAG_ATT: u32 = 12;

const NC_FLOAT: u32 = 5;
const NC_DOUBLE: u32 = 6;

// ─── low-level reader ──────────────────────────────────────────────────────

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
    cdf2: bool,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8], cdf2: bool) -> Self {
        Self { data, pos: 0, cdf2 }
    }

    fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.pos)
    }

    fn read_u32(&mut self) -> Result<u32, String> {
        let b = self
            .data
            .get(self.pos..self.pos + 4)
            .ok_or("unexpected EOF reading u32")?;
        self.pos += 4;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn read_u64(&mut self) -> Result<u64, String> {
        let b = self
            .data
            .get(self.pos..self.pos + 8)
            .ok_or("unexpected EOF reading u64")?;
        self.pos += 8;
        Ok(u64::from_be_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }

    fn read_begin(&mut self) -> Result<u64, String> {
        if self.cdf2 {
            self.read_u64()
        } else {
            Ok(self.read_u32()? as u64)
        }
    }

    fn read_string(&mut self) -> Result<String, String> {
        let len = self.read_u32()? as usize;
        // `len + 3` overflows usize on wasm32 for a length near u32::MAX.
        let padded = padded4(Some(len)).ok_or("NetCDF string length overflows")?;
        if self.remaining() < padded {
            return Err("unexpected EOF reading string".into());
        }
        let s = std::str::from_utf8(&self.data[self.pos..self.pos + len])
            .map_err(|e| format!("invalid UTF-8 in NetCDF string: {e}"))?
            .to_string();
        self.pos += padded;
        Ok(s)
    }

    fn skip_att_payload(&mut self, nc_type: u32, nelems: usize) -> Result<(), String> {
        let elem_size: usize = match nc_type {
            1 | 2 => 1,
            3 => 2,
            4 | 5 => 4,
            6 => 8,
            _ => return Err(format!("unknown nc_type {nc_type} in attribute")),
        };
        let padded = padded4(nelems.checked_mul(elem_size))
            .ok_or("NetCDF attribute payload size overflows")?;
        if self.remaining() < padded {
            return Err("unexpected EOF skipping attribute payload".into());
        }
        self.pos += padded;
        Ok(())
    }

    fn skip_att_list(&mut self) -> Result<(), String> {
        self.read_att_list().map(|_| ())
    }

    /// Read an attribute list, keeping only a numeric `scale_factor` (the
    /// netCDF convention: stored value × scale_factor = the value meant).
    fn read_att_list(&mut self) -> Result<Option<f64>, String> {
        let tag = self.read_u32()?;
        let count = self.read_u32()?;
        if tag == 0 && count == 0 {
            return Ok(None);
        }
        if tag != TAG_ATT {
            return Err(format!("expected NC_ATTRIBUTE tag ({TAG_ATT}), got {tag}"));
        }
        let mut scale_factor = None;
        for _ in 0..count {
            let name = self.read_string()?;
            let nc_type = self.read_u32()?;
            let nelems = self.read_u32()? as usize;
            let payload = self.pos;
            self.skip_att_payload(nc_type, nelems)?;
            if name == "scale_factor" && nelems >= 1 {
                scale_factor = match nc_type {
                    NC_FLOAT => Some(self.read_f32_at(payload)? as f64),
                    NC_DOUBLE => Some(self.read_f64_at(payload)?),
                    _ => scale_factor,
                };
            }
        }
        Ok(scale_factor)
    }

    /// Read a f32 from an absolute byte offset (big-endian).
    fn read_f32_at(&self, offset: usize) -> Result<f32, String> {
        let b = self
            .data
            .get(offset..offset + 4)
            .ok_or_else(|| format!("read_f32_at: offset {offset} out of bounds"))?;
        Ok(f32::from_bits(u32::from_be_bytes([b[0], b[1], b[2], b[3]])))
    }

    /// Read a f64 from an absolute byte offset (big-endian).
    fn read_f64_at(&self, offset: usize) -> Result<f64, String> {
        let b = self
            .data
            .get(offset..offset + 8)
            .ok_or_else(|| format!("read_f64_at: offset {offset} out of bounds"))?;
        Ok(f64::from_bits(u64::from_be_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ])))
    }
}

/// `n` rounded up to the 4-byte XDR boundary, or `None` when `n` is missing
/// or the rounding overflows `usize` (a size near `u32::MAX` on wasm32).
fn padded4(n: Option<usize>) -> Option<usize> {
    n?.checked_add(3).map(|v| v & !3)
}

// ─── variable descriptor ───────────────────────────────────────────────────

struct VarDesc {
    name: String,
    dimids: Vec<u32>,
    nc_type: u32,
    vsize: u32,
    begin: u64,
    /// The variable's `scale_factor` attribute, when it has a numeric one.
    scale_factor: Option<f64>,
}

// ─── parse helpers ─────────────────────────────────────────────────────────

fn parse_dim_list(r: &mut Reader) -> Result<Vec<(String, u32)>, String> {
    let tag = r.read_u32()?;
    let count = r.read_u32()?;
    if tag == 0 && count == 0 {
        return Ok(vec![]);
    }
    if tag != TAG_DIM {
        return Err(format!("expected NC_DIMENSION tag ({TAG_DIM}), got {tag}"));
    }
    // `count` is a header claim; every entry takes at least 8 bytes (name
    // length + size), so reserve no more entries than the bytes left can hold.
    let mut dims = Vec::with_capacity((count as usize).min(r.remaining() / 8));
    for _ in 0..count {
        let name = r.read_string()?;
        let size = r.read_u32()?;
        dims.push((name, size));
    }
    Ok(dims)
}

fn parse_var_list(r: &mut Reader) -> Result<Vec<VarDesc>, String> {
    let tag = r.read_u32()?;
    let count = r.read_u32()?;
    if tag == 0 && count == 0 {
        return Ok(vec![]);
    }
    if tag != TAG_VAR {
        return Err(format!("expected NC_VARIABLE tag ({TAG_VAR}), got {tag}"));
    }
    // As for dimensions: every variable entry takes at least 28 bytes (name
    // length, ndims, attribute-list header, type, vsize, begin), and every
    // dimension id 4.
    let mut vars = Vec::with_capacity((count as usize).min(r.remaining() / 28));
    for _ in 0..count {
        let name = r.read_string()?;
        let ndims = r.read_u32()? as usize;
        let mut dimids = Vec::with_capacity(ndims.min(r.remaining() / 4));
        for _ in 0..ndims {
            dimids.push(r.read_u32()?);
        }
        let scale_factor = r.read_att_list()?;
        let nc_type = r.read_u32()?;
        let vsize = r.read_u32()?;
        let begin = r.read_begin()?;
        vars.push(VarDesc {
            name,
            dimids,
            nc_type,
            vsize,
            begin,
            scale_factor,
        });
    }
    Ok(vars)
}

// ─── public API ────────────────────────────────────────────────────────────

/// Where the frames of an AMBER NetCDF trajectory are, from its header. In a
/// classic NetCDF file every record variable of frame `i` (coordinates, time,
/// cell) sits in the record `record_start + i * recsize ..+ recsize`, so a host
/// can index the file from its first bytes and read each frame's record alone.
pub struct NetcdfLayout {
    pub n_atoms: usize,
    pub n_frames: usize,
    /// Byte offset of frame 0's record (the lowest record-variable `begin`).
    pub record_start: u64,
    /// Bytes per record (the padded sizes of all record variables).
    pub recsize: u64,
    /// Offsets of the variables within a record.
    coord_off: u64,
    time_off: Option<u64>,
    cell_len_off: Option<u64>,
    cell_ang_off: Option<u64>,
    /// Per-atom vector record variables (AMBER `velocities` / `forces`), in
    /// channel order.
    vectors: Vec<VectorVar>,
}

/// A per-atom `(frame, atom, spatial)` float record variable decoded as a
/// vector channel.
struct VectorVar {
    /// Channel name (megane's conventional `velocity` / `force`).
    name: &'static str,
    /// Offset within a record.
    off: u64,
    /// The variable's `scale_factor` (AMBER velocities carry 20.455, turning
    /// the stored values into Å/ps); applied on decode.
    scale: Option<f32>,
}

/// One frame of a [`NetcdfLayout`].
pub struct NetcdfFrame {
    /// Positions (Å), `n_atoms * 3`.
    pub positions: Vec<f32>,
    /// This frame's cell, when the file carries `cell_lengths`.
    pub cell: Option<[f32; 9]>,
    /// This frame's `time` (ps), when the file carries a float one.
    pub time: Option<f32>,
    /// This frame's per-atom vectors (`n_atoms * 3` each), parallel to
    /// [`NetcdfLayout::vector_channel_names`].
    pub vectors: Vec<Vec<f32>>,
}

impl NetcdfLayout {
    /// The file carries a cell per frame.
    pub fn has_cell(&self) -> bool {
        self.cell_len_off.is_some()
    }

    /// The file carries a float `time` per frame.
    pub fn has_time(&self) -> bool {
        self.time_off.is_some()
    }

    /// Names of the per-atom vector channels each frame decodes
    /// (`velocity`, `force`), in [`NetcdfFrame::vectors`] order.
    pub fn vector_channel_names(&self) -> Vec<&'static str> {
        self.vectors.iter().map(|v| v.name).collect()
    }

    /// Where in a record the cell is (offset from the record start, length).
    pub fn cell_range(&self) -> Option<(u64, u64)> {
        let cl = self.cell_len_off?;
        let lo = self.cell_ang_off.map_or(cl, |ca| ca.min(cl));
        let hi = self
            .cell_ang_off
            .map_or(cl + 24, |ca| (ca + 24).max(cl + 24));
        Some((lo, hi - lo))
    }

    /// Bytes from a frame's record start that hold everything decoded from it:
    /// the record, or more when coordinates are (unusually) not a record
    /// variable and lie past it.
    pub fn record_span(&self) -> u64 {
        let ends = [
            Some(self.coord_off + self.n_atoms as u64 * 12),
            self.time_off.map(|o| o + 4),
            self.cell_len_off.map(|o| o + 24),
            self.cell_ang_off.map(|o| o + 24),
        ];
        let vector_ends = self
            .vectors
            .iter()
            .map(|v| v.off + self.n_atoms as u64 * 12);
        ends.into_iter()
            .flatten()
            .chain(vector_ends)
            .fold(self.recsize, u64::max)
    }
}

/// The [`NetcdfLayout`] of a `file_len`-byte AMBER NetCDF file; `head` must
/// hold its whole header (dimensions, attributes and variable list).
pub fn read_layout(head: &[u8], file_len: u64) -> Result<NetcdfLayout, String> {
    if head.len() < 4 {
        return Err("file too short to be NetCDF".into());
    }
    let cdf2 = if &head[..4] == b"CDF\x01" {
        false
    } else if &head[..4] == b"CDF\x02" {
        true
    } else {
        return Err("not a NetCDF CDF-1 or CDF-2 file (wrong magic bytes)".into());
    };

    let mut r = Reader::new(head, cdf2);
    r.pos = 4;

    // numrecs (0xFFFFFFFF = STREAMING)
    let numrecs_raw = r.read_u32()?;

    // header sections
    let dims = parse_dim_list(&mut r)?;
    r.skip_att_list()?; // global attributes
    let vars = parse_var_list(&mut r)?;

    // unlimited dimension id (the "frame" dimension)
    let unlimited_id: Option<u32> = dims.iter().position(|(_, sz)| *sz == 0).map(|i| i as u32);
    let is_record = |v: &VarDesc| unlimited_id.is_some_and(|uid| v.dimids.first() == Some(&uid));

    // required "atom" dimension
    let n_atoms = dims
        .iter()
        .find(|(n, _)| n == "atom")
        .map(|(_, s)| *s as usize)
        .ok_or("missing 'atom' dimension — is this an AMBER NCTRAJ file?")?;
    if n_atoms == 0 {
        return Err("'atom' dimension is zero".into());
    }

    // locate key variables
    let coord_var = vars
        .iter()
        .find(|v| v.name == "coordinates")
        .ok_or("missing 'coordinates' variable (not an AMBER NCTRAJ file?)")?;
    let time_var = vars
        .iter()
        .find(|v| v.name == "time")
        .filter(|tv| tv.nc_type == NC_FLOAT && tv.vsize == 4);
    let cell_len_var = vars
        .iter()
        .find(|v| v.name == "cell_lengths")
        .filter(|cl| cl.nc_type == NC_DOUBLE && cl.vsize >= 24);
    let cell_ang_var = vars
        .iter()
        .find(|v| v.name == "cell_angles")
        .filter(|ca| ca.nc_type == NC_DOUBLE && ca.vsize >= 24);

    // validate coordinates type
    if coord_var.nc_type != NC_FLOAT {
        return Err(format!(
            "'coordinates' must be NC_FLOAT (5), got {}",
            coord_var.nc_type
        ));
    }
    // Checked: on wasm32 a huge 'atom' dimension would wrap the product and
    // let a small vsize pass for it.
    let expected_vsize = n_atoms
        .checked_mul(3 * 4)
        .ok_or_else(|| format!("'atom' dimension {n_atoms} is too large"))?;
    if coord_var.vsize as usize != expected_vsize {
        return Err(format!(
            "'coordinates' vsize {} != {} (n_atoms={n_atoms} × 3 × 4)",
            coord_var.vsize, expected_vsize
        ));
    }

    // recsize = sum of padded vsizes of all record variables
    let recsize: u64 = vars
        .iter()
        .filter(|v| is_record(v))
        .map(|v| (v.vsize as u64 + 3) & !3)
        .sum();

    // A non-record variable is the same in every frame: read it from frame 0's
    // record offsets as the eager reader does (`begin + i * recsize`).
    let record_start = vars
        .iter()
        .filter(|v| is_record(v))
        .map(|v| v.begin)
        .min()
        .unwrap_or(coord_var.begin)
        .min(coord_var.begin);

    // number of frames
    let n_frames: usize = if numrecs_raw == 0xFFFF_FFFF {
        if recsize == 0 {
            return Err("streaming numrecs and recsize=0 — cannot determine frame count".into());
        }
        // Whole records from where the record section starts, not from where
        // `coordinates` sits in it: a record variable defined before it
        // (`time`) starts the record earlier.
        file_len
            .saturating_sub(record_start)
            .checked_div(recsize)
            .unwrap_or(0) as usize
    } else {
        numrecs_raw as usize
    };

    if n_frames == 0 {
        return Err("NetCDF trajectory has 0 frames".into());
    }
    let off = |v: &VarDesc| v.begin.checked_sub(record_start);
    // AMBER's optional per-atom record variables, laid out like coordinates.
    let vectors = [("velocities", "velocity"), ("forces", "force")]
        .into_iter()
        .filter_map(|(var, name)| {
            let v = vars.iter().find(|v| v.name == var)?;
            if v.nc_type != NC_FLOAT || v.vsize as usize != expected_vsize || !is_record(v) {
                return None;
            }
            Some(VectorVar {
                name,
                off: off(v)?,
                scale: v.scale_factor.map(|f| f as f32),
            })
        })
        .collect();
    Ok(NetcdfLayout {
        n_atoms,
        n_frames,
        record_start,
        recsize,
        coord_off: off(coord_var).ok_or("'coordinates' precedes the records")?,
        time_off: time_var.and_then(off),
        cell_len_off: cell_len_var.and_then(off),
        cell_ang_off: cell_len_var.and(cell_ang_var).and_then(off),
        vectors,
    })
}

/// Decode frame `i` from `data`, whose first byte is file offset `base`: the
/// frame's record (from [`NetcdfLayout::record_start`] `+ i * recsize`), or
/// the whole file with `base` 0.
fn decode_frame(
    layout: &NetcdfLayout,
    data: &[u8],
    base: u64,
    i: usize,
) -> Result<NetcdfFrame, String> {
    let r = Reader::new(data, false);
    let rec = layout.record_start + i as u64 * layout.recsize;
    let at = |off: u64| -> Option<usize> { (rec + off).checked_sub(base).map(|o| o as usize) };
    let n_coords = layout.n_atoms * 3;
    let coord = at(layout.coord_off).ok_or("record precedes its bytes")?;
    if coord + n_coords * 4 > data.len() {
        return Err(format!(
            "frame {i} coordinates out of bounds (offset {})",
            rec + layout.coord_off
        ));
    }
    let mut positions = Vec::with_capacity(n_coords);
    for j in 0..n_coords {
        positions.push(r.read_f32_at(coord + j * 4)?);
    }
    let time = layout
        .time_off
        .and_then(at)
        .and_then(|t| r.read_f32_at(t).ok());
    let cell = read_cell(layout, data, base, i)?;
    let mut vectors = Vec::with_capacity(layout.vectors.len());
    for v in &layout.vectors {
        let start = at(v.off).ok_or("record precedes its bytes")?;
        let mut values = Vec::with_capacity(n_coords);
        for j in 0..n_coords {
            let x = r.read_f32_at(start + j * 4).map_err(|_| {
                format!(
                    "frame {i} {} out of bounds (offset {})",
                    v.name,
                    rec + v.off
                )
            })?;
            values.push(v.scale.map_or(x, |f| x * f));
        }
        vectors.push(values);
    }
    Ok(NetcdfFrame {
        positions,
        cell,
        time,
        vectors,
    })
}

/// Frame `i`'s cell from `data` (whose first byte is file offset `base`), or
/// `None` when the file has none or `data` does not reach it. Per the AMBER
/// convention `cell_angles` holds alpha/beta/gamma in degrees; when absent the
/// cell is orthorhombic.
fn read_cell(
    layout: &NetcdfLayout,
    data: &[u8],
    base: u64,
    i: usize,
) -> Result<Option<[f32; 9]>, String> {
    let r = Reader::new(data, false);
    let rec = layout.record_start + i as u64 * layout.recsize;
    let at = |off: u64| -> Option<usize> { (rec + off).checked_sub(base).map(|o| o as usize) };
    Ok(match layout.cell_len_off.and_then(at) {
        Some(cl) if cl + 24 <= data.len() => {
            let a = r.read_f64_at(cl)? as f32;
            let b = r.read_f64_at(cl + 8)? as f32;
            let c = r.read_f64_at(cl + 16)? as f32;
            let (alpha, beta, gamma) = match layout.cell_ang_off.and_then(at) {
                Some(ab) if ab + 24 <= data.len() => (
                    r.read_f64_at(ab)? as f32,
                    r.read_f64_at(ab + 8)? as f32,
                    r.read_f64_at(ab + 16)? as f32,
                ),
                _ => (90.0, 90.0, 90.0),
            };
            Some(cell_params_to_matrix(a, b, c, alpha, beta, gamma))
        }
        _ => None,
    })
}

/// Decode frame `i`'s cell from just [`NetcdfLayout::cell_range`] of its
/// record (`bytes` starts that far into the record).
pub fn decode_layout_cell(
    layout: &NetcdfLayout,
    bytes: &[u8],
    i: usize,
) -> Result<Option<[f32; 9]>, String> {
    let Some((lo, _)) = layout.cell_range() else {
        return Ok(None);
    };
    read_cell(
        layout,
        bytes,
        layout.record_start + i as u64 * layout.recsize + lo,
        i,
    )
}

/// Decode frame `i` from just its record's bytes (`record` starts at
/// `layout.record_start + i * layout.recsize`).
pub fn decode_layout_record(
    layout: &NetcdfLayout,
    record: &[u8],
    i: usize,
) -> Result<NetcdfFrame, String> {
    decode_frame(
        layout,
        record,
        layout.record_start + i as u64 * layout.recsize,
        i,
    )
}

/// Parse an AMBER NetCDF trajectory file (`.nc`).
///
/// Accepts CDF-1 and CDF-2 classic NetCDF files following the AMBER NCTRAJ
/// convention.  Returns a `TrajectoryData` with positions in Angstroms.
pub fn parse_netcdf(data: &[u8]) -> Result<TrajectoryData, String> {
    let layout = read_layout(data, data.len() as u64)?;
    let (n_atoms, n_frames) = (layout.n_atoms, layout.n_frames);
    let mut frame_positions_flat: Vec<f32> =
        Vec::with_capacity(n_frames.min(data.len() / (n_atoms * 12).max(1)) * n_atoms * 3);

    // Frame 0's cell is the representative `box_matrix`; a per-frame side
    // table is built only when the cell actually changes (variable-cell / NPT
    // runs). Cells past the end of a truncated file stop being read.
    let mut box_matrix: Option<[f32; 9]> = None;
    let mut per_frame_cells: Vec<[f32; 9]> = Vec::new();
    let mut varies_cell = false;
    let mut cells_ended = false;
    let mut times = [None, None];
    let mut vector_channels: Vec<VectorChannel> = layout
        .vector_channel_names()
        .into_iter()
        .map(|name| VectorChannel {
            name: name.to_string(),
            frames: Vec::new(),
        })
        .collect();

    for i in 0..n_frames {
        let frame = decode_frame(&layout, data, 0, i)?;
        frame_positions_flat.extend_from_slice(&frame.positions);
        for (channel, vectors) in vector_channels.iter_mut().zip(frame.vectors) {
            channel.frames.push(VectorFrame { frame: i, vectors });
        }
        if let Some(t) = times.get_mut(i) {
            *t = frame.time;
        }
        if cells_ended || !layout.has_cell() {
            continue;
        }
        let Some(m) = frame.cell else {
            cells_ended = true;
            continue;
        };
        if i == 0 {
            box_matrix = Some(m);
        }
        if !varies_cell && Some(m) != box_matrix {
            varies_cell = true;
            per_frame_cells.extend(std::iter::repeat_n(box_matrix.unwrap_or([0.0; 9]), i));
        }
        if varies_cell {
            per_frame_cells.push(m);
        }
    }

    // derive timestep from time variable (frames 0 and 1 difference)
    let timestep_ps = netcdf_timestep(n_frames, layout.has_time(), times);

    let hetero = crate::trajectory::build_cell_hetero(varies_cell, per_frame_cells, n_atoms);

    Ok(TrajectoryData {
        n_atoms,
        n_frames,
        timestep_ps,
        box_matrix,
        box_origin: None,
        frame_positions_flat,
        vector_channels,
        hetero,
        warnings: Vec::new(),
    })
}

/// The time step from frames 0 and 1's `time` (1 ps without it).
pub fn netcdf_timestep(n_frames: usize, has_time: bool, times: [Option<f32>; 2]) -> f32 {
    if n_frames >= 2 && has_time {
        let t0 = times[0].unwrap_or(0.0);
        let t1 = times[1].unwrap_or(1.0);
        (t1 - t0).max(0.0)
    } else {
        1.0
    }
}

// ─── tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal CDF-1 AMBER NetCDF binary in memory.
    ///
    /// Layout:
    ///   dims: frame(unlimited), atom(n_atoms), spatial(3)
    ///   vars: coordinates(frame,atom,spatial) FLOAT,
    ///         time(frame) FLOAT,
    ///         cell_lengths(frame,cell_spatial) DOUBLE  [optional]
    ///         cell_angles(frame,cell_angular) DOUBLE   [optional]
    ///   data interleaved per record
    fn build_netcdf(
        n_atoms: usize,
        frames: &[Vec<f32>],
        times: &[f32],
        cell_lengths: Option<&[[f64; 3]]>,
        cell_angles: Option<&[[f64; 3]]>,
    ) -> Vec<u8> {
        fn u32be(v: u32) -> [u8; 4] {
            v.to_be_bytes()
        }
        fn f32be(v: f32) -> [u8; 4] {
            v.to_bits().to_be_bytes()
        }
        fn f64be(v: f64) -> [u8; 8] {
            v.to_bits().to_be_bytes()
        }
        fn pad_string(s: &str) -> Vec<u8> {
            let b = s.as_bytes();
            let len = b.len();
            let padded = (len + 3) & !3;
            let mut v = Vec::new();
            v.extend_from_slice(&u32be(len as u32));
            v.extend_from_slice(b);
            v.resize(v.len() + (padded - len), 0);
            v
        }
        fn absent() -> Vec<u8> {
            let mut v = Vec::new();
            v.extend_from_slice(&u32be(0));
            v.extend_from_slice(&u32be(0));
            v
        }

        let n_frames = frames.len();
        let has_cell = cell_lengths.is_some();
        let has_angles = cell_angles.is_some();
        assert!(
            !has_angles || has_cell,
            "cell_angles requires cell_lengths in the test builder"
        );

        // ── dim_list ───────────────────────────────────────────────────────
        let n_dims: u32 = 3 + has_cell as u32 + has_angles as u32;
        let mut dim_bytes = Vec::new();
        dim_bytes.extend_from_slice(&u32be(TAG_DIM));
        dim_bytes.extend_from_slice(&u32be(n_dims));
        // dim 0: frame (unlimited)
        dim_bytes.extend(pad_string("frame"));
        dim_bytes.extend_from_slice(&u32be(0));
        // dim 1: atom
        dim_bytes.extend(pad_string("atom"));
        dim_bytes.extend_from_slice(&u32be(n_atoms as u32));
        // dim 2: spatial
        dim_bytes.extend(pad_string("spatial"));
        dim_bytes.extend_from_slice(&u32be(3));
        // dim 3: cell_spatial (only if cell present)
        if has_cell {
            dim_bytes.extend(pad_string("cell_spatial"));
            dim_bytes.extend_from_slice(&u32be(3));
        }
        // dim 4: cell_angular (only if angles present)
        if has_angles {
            dim_bytes.extend(pad_string("cell_angular"));
            dim_bytes.extend_from_slice(&u32be(3));
        }

        // ── var_list ───────────────────────────────────────────────────────
        let n_vars: u32 = 2 + has_cell as u32 + has_angles as u32;

        // vsize per variable
        let coord_vsize: u32 = (n_atoms * 3 * 4) as u32;
        let time_vsize: u32 = 4;
        let cell_vsize: u32 = 24; // 3 × f64

        // We'll fill begin placeholders after computing header size.
        // Build the var section with placeholder begins (we will fix after).
        fn build_var(name: &str, dimids: &[u32], nc_type: u32, vsize: u32, begin: u32) -> Vec<u8> {
            fn u32be(v: u32) -> [u8; 4] {
                v.to_be_bytes()
            }
            fn pad_string(s: &str) -> Vec<u8> {
                let b = s.as_bytes();
                let len = b.len();
                let padded = (len + 3) & !3;
                let mut v = Vec::new();
                v.extend_from_slice(&u32be(len as u32));
                v.extend_from_slice(b);
                v.resize(v.len() + (padded - len), 0);
                v
            }
            let mut v = Vec::new();
            v.extend(pad_string(name));
            v.extend_from_slice(&u32be(dimids.len() as u32));
            for &d in dimids {
                v.extend_from_slice(&u32be(d));
            }
            // no per-variable attributes
            v.extend_from_slice(&u32be(0));
            v.extend_from_slice(&u32be(0));
            v.extend_from_slice(&u32be(nc_type));
            v.extend_from_slice(&u32be(vsize));
            v.extend_from_slice(&u32be(begin)); // placeholder
            v
        }

        let mut var_bytes = Vec::new();
        var_bytes.extend_from_slice(&u32be(TAG_VAR));
        var_bytes.extend_from_slice(&u32be(n_vars));
        // coordinates(frame=0, atom=1, spatial=2)
        var_bytes.extend(build_var(
            "coordinates",
            &[0, 1, 2],
            NC_FLOAT,
            coord_vsize,
            0,
        ));
        // time(frame=0)
        var_bytes.extend(build_var("time", &[0], NC_FLOAT, time_vsize, 0));
        if has_cell {
            // cell_lengths(frame=0, cell_spatial=3)
            var_bytes.extend(build_var("cell_lengths", &[0, 3], NC_DOUBLE, cell_vsize, 0));
        }
        if has_angles {
            // cell_angles(frame=0, cell_angular=4)
            var_bytes.extend(build_var("cell_angles", &[0, 4], NC_DOUBLE, cell_vsize, 0));
        }

        // ── assemble header so far to compute its length ───────────────────
        let mut header = Vec::new();
        header.extend_from_slice(b"CDF\x01"); // magic
        header.extend_from_slice(&u32be(n_frames as u32)); // numrecs
        header.extend(dim_bytes);
        header.extend(absent()); // global attrs
        header.extend(var_bytes);

        let header_size = header.len();

        // ── fix begin offsets inside the header ───────────────────────────
        // Find each variable's `begin` field and patch it.
        // coordinates.begin = header_size
        // time.begin        = header_size + coord_vsize_padded
        // cell_lengths.begin= header_size + coord_vsize_padded + time_vsize_padded
        let coord_begin = header_size;
        let time_begin = coord_begin + ((coord_vsize as usize + 3) & !3);
        let cell_begin = time_begin + ((time_vsize as usize + 3) & !3);
        let angle_begin = cell_begin + ((cell_vsize as usize + 3) & !3);

        // Patch `begin` (u32) for each var: find its location in `header`.
        // Each var header ends with: nc_type[4] vsize[4] begin[4].
        // We search for a simple sentinel approach: re-scan header bytes.
        // Simpler: rebuild var section with correct begins.
        let rebuild_var = |name: &str, dimids: &[u32], nc_type: u32, vsize: u32, begin: u32| {
            build_var(name, dimids, nc_type, vsize, begin)
        };

        // Rewrite var_bytes with correct begins
        let mut var_bytes2 = Vec::new();
        var_bytes2.extend_from_slice(&u32be(TAG_VAR));
        var_bytes2.extend_from_slice(&u32be(n_vars));
        var_bytes2.extend(rebuild_var(
            "coordinates",
            &[0, 1, 2],
            NC_FLOAT,
            coord_vsize,
            coord_begin as u32,
        ));
        var_bytes2.extend(rebuild_var(
            "time",
            &[0],
            NC_FLOAT,
            time_vsize,
            time_begin as u32,
        ));
        if has_cell {
            var_bytes2.extend(rebuild_var(
                "cell_lengths",
                &[0, 3],
                NC_DOUBLE,
                cell_vsize,
                cell_begin as u32,
            ));
        }
        if has_angles {
            var_bytes2.extend(rebuild_var(
                "cell_angles",
                &[0, 4],
                NC_DOUBLE,
                cell_vsize,
                angle_begin as u32,
            ));
        }

        // Rebuild final header with correct var section
        let mut out = Vec::new();
        out.extend_from_slice(b"CDF\x01");
        out.extend_from_slice(&u32be(n_frames as u32));
        // re-emit dim_list (already built)
        // We need to rebuild dim_list again
        let mut dim_bytes2 = Vec::new();
        dim_bytes2.extend_from_slice(&u32be(TAG_DIM));
        dim_bytes2.extend_from_slice(&u32be(n_dims));
        dim_bytes2.extend(pad_string("frame"));
        dim_bytes2.extend_from_slice(&u32be(0));
        dim_bytes2.extend(pad_string("atom"));
        dim_bytes2.extend_from_slice(&u32be(n_atoms as u32));
        dim_bytes2.extend(pad_string("spatial"));
        dim_bytes2.extend_from_slice(&u32be(3));
        if has_cell {
            dim_bytes2.extend(pad_string("cell_spatial"));
            dim_bytes2.extend_from_slice(&u32be(3));
        }
        if has_angles {
            dim_bytes2.extend(pad_string("cell_angular"));
            dim_bytes2.extend_from_slice(&u32be(3));
        }
        out.extend(dim_bytes2);
        out.extend(absent()); // global attrs
        out.extend(var_bytes2);

        assert_eq!(out.len(), header_size, "header size mismatch");

        // ── data section ──────────────────────────────────────────────────
        // layout: [coord_frame0, time_frame0, (cell_frame0), coord_frame1, ...]
        for (i, frame) in frames.iter().enumerate() {
            // coordinates
            assert_eq!(frame.len(), n_atoms * 3, "frame {i} wrong atom count");
            for &v in frame {
                out.extend_from_slice(&f32be(v));
            }
            // time
            out.extend_from_slice(&f32be(times[i]));
            // cell_lengths (optional)
            if let Some(cells) = cell_lengths {
                let cl = &cells[i];
                out.extend_from_slice(&f64be(cl[0]));
                out.extend_from_slice(&f64be(cl[1]));
                out.extend_from_slice(&f64be(cl[2]));
            }
            // cell_angles (optional)
            if let Some(angles) = cell_angles {
                let ca = &angles[i];
                out.extend_from_slice(&f64be(ca[0]));
                out.extend_from_slice(&f64be(ca[1]));
                out.extend_from_slice(&f64be(ca[2]));
            }
        }

        // Verify begin offsets are consistent with actual layout
        debug_assert_eq!(
            &out[coord_begin..coord_begin + 4],
            &f32be(frames[0][0]),
            "coord_begin mismatch"
        );
        debug_assert_eq!(
            &out[time_begin..time_begin + 4],
            &f32be(times[0]),
            "time_begin mismatch"
        );

        out
    }

    #[test]
    fn layout_records_match_the_eager_parse() {
        let n_atoms = 2usize;
        let frames: Vec<Vec<f32>> = (0..4)
            .map(|i| vec![i as f32, 0.0, 0.0, 1.0 + i as f32, 0.5, 0.25])
            .collect();
        let times = vec![0.0f32, 2.0, 4.0, 6.0];
        let cells: Vec<[f64; 3]> = (0..4).map(|i| [10.0 + i as f64, 11.0, 12.0]).collect();
        let angles: Vec<[f64; 3]> = vec![[90.0, 90.0, 120.0]; 4];
        for (cl, ca) in [
            (None, None),
            (Some(&cells[..]), None),
            (Some(&cells[..]), Some(&angles[..])),
        ] {
            let data = build_netcdf(n_atoms, &frames, &times, cl, ca);
            let eager = parse_netcdf(&data).unwrap();
            // The header fits in the first bytes; the frame count needs the file length.
            let layout = read_layout(&data[..data.len().min(2048)], data.len() as u64).unwrap();
            assert_eq!(layout.n_frames, 4);
            assert_eq!(layout.has_cell(), cl.is_some());
            let mut t = [None, None];
            for i in 0..4 {
                let start = (layout.record_start + i as u64 * layout.recsize) as usize;
                let end = (start + layout.record_span() as usize).min(data.len());
                let f = decode_layout_record(&layout, &data[start..end], i).unwrap();
                assert_eq!(f.positions[..], eager.frame(i)[..]);
                if let Some(slot) = t.get_mut(i) {
                    *slot = f.time;
                }
                match (f.cell, eager.frame_cell(i)) {
                    (Some(c), Some(want)) => assert_eq!(&c[..], want),
                    (Some(c), None) => assert_eq!(Some(c), eager.box_matrix),
                    (None, _) => assert!(eager.box_matrix.is_none()),
                }
            }
            assert_eq!(netcdf_timestep(4, true, t), eager.timestep_ps);
        }
    }

    #[test]
    fn a_cell_decodes_from_just_its_bytes() {
        let cells: Vec<[f64; 3]> = vec![[10.0, 11.0, 12.0], [13.0, 14.0, 15.0]];
        let angles: Vec<[f64; 3]> = vec![[90.0, 90.0, 100.0]; 2];
        let frames = vec![vec![0.0; 6], vec![1.0; 6]];
        let data = build_netcdf(2, &frames, &[0.0, 1.0], Some(&cells), Some(&angles));
        let eager = parse_netcdf(&data).unwrap();
        let layout = read_layout(&data, data.len() as u64).unwrap();
        let (lo, len) = layout.cell_range().unwrap();
        assert_eq!(len, 48);
        for i in 0..2 {
            let start = (layout.record_start + i as u64 * layout.recsize + lo) as usize;
            let cell = decode_layout_cell(&layout, &data[start..start + len as usize], i)
                .unwrap()
                .unwrap();
            assert_eq!(&cell[..], eager.frame_cell(i).unwrap());
        }
        let plain = build_netcdf(2, &frames, &[0.0, 1.0], None, None);
        let layout = read_layout(&plain, plain.len() as u64).unwrap();
        assert!(layout.cell_range().is_none());
        assert_eq!(decode_layout_cell(&layout, &[], 0).unwrap(), None);
    }

    #[test]
    fn a_record_too_short_for_its_coordinates_is_an_error() {
        let data = build_netcdf(2, &[vec![0.0; 6]], &[0.0], None, None);
        let layout = read_layout(&data, data.len() as u64).unwrap();
        let start = layout.record_start as usize;
        assert!(decode_layout_record(&layout, &data[start..start + 8], 0).is_err());
        assert!(read_layout(&data[..3], 3).is_err());
        assert_eq!(netcdf_timestep(1, true, [Some(5.0), None]), 1.0);
        assert_eq!(netcdf_timestep(2, false, [Some(5.0), Some(9.0)]), 1.0);
    }

    #[test]
    fn test_parse_netcdf_basic() {
        let n_atoms = 3usize;
        let n_frames = 5usize;
        let mut frames = Vec::new();
        let mut times = Vec::new();
        for i in 0..n_frames {
            let fi = i as f32;
            // atom j at (j + fi, fi, 0)
            let mut pos = Vec::new();
            for j in 0..n_atoms {
                pos.push(j as f32 + fi);
                pos.push(fi);
                pos.push(0.0);
            }
            frames.push(pos);
            times.push(fi * 1.0);
        }

        let data = build_netcdf(n_atoms, &frames, &times, None, None);
        let result = parse_netcdf(&data).expect("parse NetCDF");

        assert_eq!(result.n_atoms, n_atoms);
        assert_eq!(result.n_frames, n_frames);
        assert!((result.timestep_ps - 1.0).abs() < 1e-5, "timestep_ps");
        assert!(result.box_matrix.is_none());

        for i in 0..result.n_frames {
            let frame = result.frame(i);
            let fi = i as f32;
            for j in 0..n_atoms {
                let x = frame[j * 3];
                let y = frame[j * 3 + 1];
                let z = frame[j * 3 + 2];
                assert!((x - (j as f32 + fi)).abs() < 1e-5, "x mismatch i={i} j={j}");
                assert!((y - fi).abs() < 1e-5, "y mismatch i={i} j={j}");
                assert!(z.abs() < 1e-5, "z mismatch i={i} j={j}");
            }
        }
    }

    #[test]
    fn test_parse_netcdf_with_cell() {
        let n_atoms = 2usize;
        let frames = vec![
            vec![0.0, 0.0, 0.0, 1.5, 0.0, 0.0],
            vec![0.1, 0.0, 0.0, 1.6, 0.0, 0.0],
        ];
        let times = vec![0.0f32, 2.0f32];
        let cells: Vec<[f64; 3]> = vec![[10.0, 10.0, 10.0], [10.0, 10.0, 10.0]];

        let data = build_netcdf(n_atoms, &frames, &times, Some(&cells), None);
        let result = parse_netcdf(&data).expect("parse NetCDF with cell");

        assert_eq!(result.n_atoms, n_atoms);
        assert_eq!(result.n_frames, 2);
        assert!((result.timestep_ps - 2.0).abs() < 1e-4, "timestep");

        let bm = result.box_matrix.expect("box_matrix should be present");
        assert!((bm[0] - 10.0).abs() < 1e-3, "a");
        assert!((bm[4] - 10.0).abs() < 1e-3, "b");
        assert!((bm[8] - 10.0).abs() < 1e-3, "c");
        // Constant cell → uniform fast path, no side table.
        assert!(result.hetero.is_none());

        let f1 = result.frame(1);
        assert!((f1[0] - 0.1).abs() < 1e-5);
    }

    #[test]
    fn test_parse_netcdf_variable_cell() {
        let n_atoms = 2usize;
        let frames = vec![
            vec![0.0, 0.0, 0.0, 1.5, 0.0, 0.0],
            vec![0.1, 0.0, 0.0, 1.6, 0.0, 0.0],
        ];
        let times = vec![0.0f32, 1.0f32];
        // The cell shrinks between frames (NPT-style).
        let cells: Vec<[f64; 3]> = vec![[10.0, 10.0, 10.0], [9.0, 9.0, 9.0]];

        let data = build_netcdf(n_atoms, &frames, &times, Some(&cells), None);
        let result = parse_netcdf(&data).expect("parse variable-cell NetCDF");

        // box_matrix is frame 0; the side table carries both per-frame cells.
        assert!((result.box_matrix.unwrap()[0] - 10.0).abs() < 1e-3);
        let h = result.hetero.as_ref().expect("cell side table");
        assert!(h.varies_cell);
        assert!(!h.varies_atoms);
        assert!((result.frame_cell(0).unwrap()[0] - 10.0).abs() < 1e-3);
        assert!((result.frame_cell(1).unwrap()[0] - 9.0).abs() < 1e-3);
    }

    #[test]
    fn test_parse_netcdf_cell_angles_triclinic() {
        let n_atoms = 2usize;
        let frames = vec![
            vec![0.0, 0.0, 0.0, 1.5, 0.0, 0.0],
            vec![0.1, 0.0, 0.0, 1.6, 0.0, 0.0],
        ];
        let times = vec![0.0f32, 1.0f32];
        let cells: Vec<[f64; 3]> = vec![[10.0, 10.0, 10.0], [10.0, 10.0, 10.0]];
        // Truncated-octahedron angles per the AMBER convention (degrees).
        let angles: Vec<[f64; 3]> = vec![[109.471, 109.471, 109.471], [109.471, 109.471, 109.471]];

        let data = build_netcdf(n_atoms, &frames, &times, Some(&cells), Some(&angles));
        let result = parse_netcdf(&data).expect("parse triclinic NetCDF");

        let bm = result.box_matrix.expect("box_matrix should be present");
        let expect =
            crate::cell::cell_params_to_matrix(10.0, 10.0, 10.0, 109.471, 109.471, 109.471);
        for i in 0..9 {
            assert!(
                (bm[i] - expect[i]).abs() < 1e-3,
                "m[{i}] = {} expected {}",
                bm[i],
                expect[i]
            );
        }
        // The b vector must actually tilt: b·x = 10·cos(109.471°) ≈ -3.333.
        assert!((bm[3] + 10.0 / 3.0).abs() < 1e-2, "b·x = {}", bm[3]);
        // Constant cell across frames → no side table.
        assert!(result.hetero.is_none());
    }

    #[test]
    fn test_parse_netcdf_right_angles_match_lengths_only_path() {
        let n_atoms = 2usize;
        let frames = vec![vec![0.0, 0.0, 0.0, 1.5, 0.0, 0.0]];
        let times = vec![0.0f32];
        let cells: Vec<[f64; 3]> = vec![[10.0, 11.0, 12.0]];
        let angles: Vec<[f64; 3]> = vec![[90.0, 90.0, 90.0]];

        // With explicit 90° angles the matrix must be byte-identical to the
        // one produced when `cell_angles` is absent (exact diagonal).
        let with_angles = parse_netcdf(&build_netcdf(
            n_atoms,
            &frames,
            &times,
            Some(&cells),
            Some(&angles),
        ))
        .expect("parse 90-degree NetCDF");
        let without_angles =
            parse_netcdf(&build_netcdf(n_atoms, &frames, &times, Some(&cells), None))
                .expect("parse angle-free NetCDF");
        assert_eq!(with_angles.box_matrix, without_angles.box_matrix);
        assert_eq!(
            with_angles.box_matrix.unwrap(),
            [10.0, 0.0, 0.0, 0.0, 11.0, 0.0, 0.0, 0.0, 12.0]
        );
    }

    #[test]
    fn test_parse_netcdf_variable_angles_build_side_table() {
        let n_atoms = 2usize;
        let frames = vec![
            vec![0.0, 0.0, 0.0, 1.5, 0.0, 0.0],
            vec![0.1, 0.0, 0.0, 1.6, 0.0, 0.0],
        ];
        let times = vec![0.0f32, 1.0f32];
        // Same lengths, but the angles change between frames.
        let cells: Vec<[f64; 3]> = vec![[10.0, 10.0, 10.0], [10.0, 10.0, 10.0]];
        let angles: Vec<[f64; 3]> = vec![[90.0, 90.0, 90.0], [90.0, 90.0, 120.0]];

        let data = build_netcdf(n_atoms, &frames, &times, Some(&cells), Some(&angles));
        let result = parse_netcdf(&data).expect("parse variable-angle NetCDF");

        let h = result.hetero.as_ref().expect("cell side table");
        assert!(h.varies_cell);
        // Frame 0 orthorhombic, frame 1 tilted (b·x = 10·cos 120° = -5).
        assert!((result.frame_cell(0).unwrap()[3]).abs() < 1e-4);
        assert!((result.frame_cell(1).unwrap()[3] + 5.0).abs() < 1e-3);
    }

    #[test]
    fn test_bad_magic_rejected() {
        let data = b"NOTCDF\x01\x00\x00\x00";
        assert!(parse_netcdf(data).is_err());
    }

    /// A header whose list counts claim billions of entries must fail on the
    /// missing bytes instead of reserving memory for every claimed entry
    /// (a 16-byte file used to ask for ~137 GB and abort the process).
    #[test]
    fn huge_header_counts_are_an_error_not_an_allocation() {
        let be = |v: u32| v.to_be_bytes();
        // dim_list: NC_DIMENSION tag, count 0xFFFFFFFF, then nothing.
        let mut dims = b"CDF\x01".to_vec();
        dims.extend(be(1));
        dims.extend(be(TAG_DIM));
        dims.extend(be(u32::MAX));
        assert_eq!(dims.len(), 16);
        assert!(parse_netcdf(&dims).is_err());

        // var_list: no dims, no global attributes, NC_VARIABLE count 0xFFFFFFFF.
        let mut vars = b"CDF\x01".to_vec();
        vars.extend(be(1));
        vars.extend([0; 16]);
        vars.extend(be(TAG_VAR));
        vars.extend(be(u32::MAX));
        assert!(parse_netcdf(&vars).is_err());

        // One variable whose dimension-id count claims 0xFFFFFFFF entries.
        let mut ndims = b"CDF\x01".to_vec();
        ndims.extend(be(1));
        ndims.extend([0; 16]);
        ndims.extend(be(TAG_VAR));
        ndims.extend(be(1));
        ndims.extend(be(1));
        ndims.extend(b"x\0\0\0");
        ndims.extend(be(u32::MAX));
        assert!(parse_netcdf(&ndims).is_err());
        assert!(read_layout(&ndims, ndims.len() as u64).is_err());
    }

    #[test]
    fn test_parse_fixture() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures/water.nc");
        let Ok(data) = std::fs::read(path) else {
            return; // fixture not yet generated; skip
        };
        let result = parse_netcdf(&data).expect("parse water.nc");
        assert_eq!(result.n_atoms, 3, "water has 3 atoms");
        assert!(result.n_frames >= 1, "at least 1 frame");
    }

    /// A CDF-1 AMBER file with `time`, `coordinates`, `velocities` (carrying
    /// AMBER's `scale_factor` attribute when `velocity_scale` is set) and
    /// `forces` record variables. In frame f atom-coordinate k holds
    /// `f*100 + k`, the stored velocity `f + k/10` and the force `-(f + k)`.
    fn nc_with_vectors(n_atoms: u32, n_frames: usize, velocity_scale: Option<f32>) -> Vec<u8> {
        fn name(out: &mut Vec<u8>, s: &str) {
            out.extend_from_slice(&(s.len() as u32).to_be_bytes());
            out.extend_from_slice(s.as_bytes());
            while !out.len().is_multiple_of(4) {
                out.push(0);
            }
        }
        let vsize = n_atoms * 12;
        let header = |begin: u32| {
            let mut out = b"CDF\x01".to_vec();
            let w = |out: &mut Vec<u8>, v: u32| out.extend_from_slice(&v.to_be_bytes());
            w(&mut out, n_frames as u32);
            w(&mut out, TAG_DIM);
            w(&mut out, 3);
            for (dim, size) in [("frame", 0), ("atom", n_atoms), ("spatial", 3)] {
                name(&mut out, dim);
                w(&mut out, size);
            }
            w(&mut out, 0); // no global attributes
            w(&mut out, 0);
            w(&mut out, TAG_VAR);
            w(&mut out, 4);
            let vars: [(&str, &[u32], u32, Option<f32>); 4] = [
                ("time", &[0], 4, None),
                ("coordinates", &[0, 1, 2], vsize, None),
                ("velocities", &[0, 1, 2], vsize, velocity_scale),
                ("forces", &[0, 1, 2], vsize, None),
            ];
            let mut at = begin;
            for (var, dims, size, scale) in vars {
                name(&mut out, var);
                w(&mut out, dims.len() as u32);
                for d in dims {
                    w(&mut out, *d);
                }
                match scale {
                    Some(f) => {
                        w(&mut out, TAG_ATT);
                        w(&mut out, 2);
                        // A text attribute first, to be skipped.
                        name(&mut out, "units");
                        w(&mut out, 2); // NC_CHAR
                        name(&mut out, "angstrom/picosecond");
                        name(&mut out, "scale_factor");
                        w(&mut out, NC_FLOAT);
                        w(&mut out, 1);
                        out.extend_from_slice(&f.to_be_bytes());
                    }
                    None => {
                        w(&mut out, 0);
                        w(&mut out, 0);
                    }
                }
                w(&mut out, NC_FLOAT);
                w(&mut out, size);
                w(&mut out, at);
                at += size;
            }
            out
        };
        let mut out = header(header(0).len() as u32);
        for f in 0..n_frames {
            out.extend_from_slice(&(f as f32).to_be_bytes());
            let n = n_atoms as usize * 3;
            for k in 0..n {
                out.extend_from_slice(&((f * 100 + k) as f32).to_be_bytes());
            }
            for k in 0..n {
                out.extend_from_slice(&(f as f32 + k as f32 / 10.0).to_be_bytes());
            }
            for k in 0..n {
                out.extend_from_slice(&(-((f + k) as f32)).to_be_bytes());
            }
        }
        out
    }

    #[test]
    fn velocities_and_forces_become_vector_channels() {
        let data = nc_with_vectors(2, 3, Some(20.455));
        let t = parse_netcdf(&data).unwrap();
        assert_eq!(t.n_frames, 3);
        assert_eq!(t.frame(2)[0], 200.0);
        let names: Vec<&str> = t.vector_channels.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["velocity", "force"]);
        let (vel, force) = (&t.vector_channels[0], &t.vector_channels[1]);
        assert_eq!(vel.frames.len(), 3);
        assert_eq!(force.frames.len(), 3);
        for f in 0..3 {
            assert_eq!(vel.frames[f].frame, f);
            // The stored values times the file's scale_factor (Å/ps).
            for k in 0..6 {
                let stored = f as f32 + k as f32 / 10.0;
                assert!((vel.frames[f].vectors[k] - stored * 20.455).abs() < 1e-4);
                assert_eq!(force.frames[f].vectors[k], -((f + k) as f32));
            }
        }
        // The fixed-layout reader decodes the same vectors from each record.
        let layout = read_layout(&data, data.len() as u64).unwrap();
        assert_eq!(layout.vector_channel_names(), ["velocity", "force"]);
        for f in 0..3 {
            let start = (layout.record_start + f as u64 * layout.recsize) as usize;
            let end = (start as u64 + layout.record_span()) as usize;
            let rec = decode_layout_record(&layout, &data[start..end.min(data.len())], f).unwrap();
            assert_eq!(
                rec.vectors,
                [
                    vel.frames[f].vectors.clone(),
                    force.frames[f].vectors.clone()
                ]
            );
        }
    }

    #[test]
    fn vectors_without_a_scale_factor_are_read_as_stored() {
        let t = parse_netcdf(&nc_with_vectors(1, 1, None)).unwrap();
        assert_eq!(t.vector_channels[0].frames[0].vectors, [0.0, 0.1, 0.2]);
        // A file without them has no vector channels.
        let plain = build_netcdf(1, &[vec![0.0, 0.0, 0.0]], &[0.0], None, None);
        assert!(parse_netcdf(&plain).unwrap().vector_channels.is_empty());
    }

    /// `coordinates` (time defined first), `n_frames` whole
    /// `coordinates` (the order cpptraj and pytraj write), `n_frames` whole
    /// records of `n_atoms` atoms, with `numrecs` in the header. Frame f's
    /// time is `f` ps and its coordinates are `f*100 + k`.
    fn nc_time_first(numrecs: u32, n_atoms: u32, n_frames: usize) -> Vec<u8> {
        fn name(out: &mut Vec<u8>, s: &str) {
            out.extend_from_slice(&(s.len() as u32).to_be_bytes());
            out.extend_from_slice(s.as_bytes());
            while !out.len().is_multiple_of(4) {
                out.push(0);
            }
        }
        let header = |time_begin: u32| {
            let mut out = b"CDF\x01".to_vec();
            let w = |out: &mut Vec<u8>, v: u32| out.extend_from_slice(&v.to_be_bytes());
            w(&mut out, numrecs);
            w(&mut out, TAG_DIM);
            w(&mut out, 3);
            for (dim, size) in [("frame", 0), ("atom", n_atoms), ("spatial", 3)] {
                name(&mut out, dim);
                w(&mut out, size);
            }
            w(&mut out, 0); // no global attributes
            w(&mut out, 0);
            w(&mut out, TAG_VAR);
            w(&mut out, 2);
            let vars: [(&str, &[u32], u32, u32); 2] = [
                ("time", &[0], 4, time_begin),
                ("coordinates", &[0, 1, 2], n_atoms * 12, time_begin + 4),
            ];
            for (var, dims, vsize, begin) in vars {
                name(&mut out, var);
                w(&mut out, dims.len() as u32);
                for d in dims {
                    w(&mut out, *d);
                }
                w(&mut out, 0); // no attributes
                w(&mut out, 0);
                w(&mut out, NC_FLOAT);
                w(&mut out, vsize);
                w(&mut out, begin);
            }
            out
        };
        let mut out = header(header(0).len() as u32);
        for f in 0..n_frames {
            out.extend_from_slice(&(f as f32).to_be_bytes());
            for k in 0..n_atoms * 3 {
                out.extend_from_slice(&((f * 100) as f32 + k as f32).to_be_bytes());
            }
        }
        out
    }

    #[test]
    fn streaming_numrecs_counts_records_from_the_first_record_variable() {
        // numrecs = STREAMING: the frame count comes from the file length,
        // measured from where the records start (`time`), not from where
        // `coordinates` sits inside the first one.
        let counted = nc_time_first(5, 3, 5);
        let mut streaming = counted.clone();
        streaming[4..8].copy_from_slice(&0xFFFF_FFFFu32.to_be_bytes());
        let layout = read_layout(&streaming, streaming.len() as u64).unwrap();
        assert_eq!(layout.n_frames, 5);
        let eager = parse_netcdf(&streaming).unwrap();
        let want = parse_netcdf(&counted).unwrap();
        assert_eq!(eager.n_frames, 5);
        assert_eq!(eager.frame_positions_flat, want.frame_positions_flat);
        assert_eq!(eager.frame(4)[0], 400.0);
        assert_eq!(eager.timestep_ps, 1.0);
        // A record cut short is not a frame.
        let cut = &streaming[..streaming.len() - 1];
        assert_eq!(read_layout(cut, cut.len() as u64).unwrap().n_frames, 4);
        assert_eq!(parse_netcdf(cut).unwrap().n_frames, 4);
    }

    #[test]
    fn padding_near_the_address_space_does_not_wrap() {
        // On wasm32 a string length or attribute size near u32::MAX would wrap
        // `n + 3`; the padding refuses instead.
        assert_eq!(padded4(Some(5)), Some(8));
        assert_eq!(padded4(Some(usize::MAX - 2)), None);
        assert_eq!(padded4(None), None);
        // A string length past the header is still an EOF error.
        let mut d = b"CDF\x01".to_vec();
        for w in [1u32, TAG_DIM, 1, 0xFFFF_FFFE] {
            d.extend_from_slice(&w.to_be_bytes());
        }
        assert!(parse_netcdf(&d).err().unwrap().contains("string"));
    }
}
