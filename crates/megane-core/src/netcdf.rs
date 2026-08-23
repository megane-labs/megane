/// Minimal AMBER NetCDF (NCTRAJ) trajectory parser.
///
/// Handles NetCDF CDF-1 and CDF-2 (classic) format files following the AMBER
/// NetCDF trajectory convention:
/// https://ambermd.org/netcdf/nctraj.xhtml
///
/// Only the variables needed for trajectory visualization are decoded:
/// `coordinates`, `time`, `cell_lengths`, `cell_angles`.
use crate::trajectory::TrajectoryData;

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
        let padded = (len + 3) & !3;
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
        let padded = (nelems * elem_size + 3) & !3;
        if self.remaining() < padded {
            return Err("unexpected EOF skipping attribute payload".into());
        }
        self.pos += padded;
        Ok(())
    }

    fn skip_att_list(&mut self) -> Result<(), String> {
        let tag = self.read_u32()?;
        let count = self.read_u32()?;
        if tag == 0 && count == 0 {
            return Ok(());
        }
        if tag != TAG_ATT {
            return Err(format!("expected NC_ATTRIBUTE tag ({TAG_ATT}), got {tag}"));
        }
        for _ in 0..count {
            let _name = self.read_string()?;
            let nc_type = self.read_u32()?;
            let nelems = self.read_u32()? as usize;
            self.skip_att_payload(nc_type, nelems)?;
        }
        Ok(())
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

// ─── variable descriptor ───────────────────────────────────────────────────

struct VarDesc {
    name: String,
    dimids: Vec<u32>,
    nc_type: u32,
    vsize: u32,
    begin: u64,
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
    let mut dims = Vec::with_capacity(count as usize);
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
    let mut vars = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let name = r.read_string()?;
        let ndims = r.read_u32()? as usize;
        let mut dimids = Vec::with_capacity(ndims);
        for _ in 0..ndims {
            dimids.push(r.read_u32()?);
        }
        r.skip_att_list()?;
        let nc_type = r.read_u32()?;
        let vsize = r.read_u32()?;
        let begin = r.read_begin()?;
        vars.push(VarDesc {
            name,
            dimids,
            nc_type,
            vsize,
            begin,
        });
    }
    Ok(vars)
}

/// Build a 3×3 cell matrix from lengths (Å) and angles (degrees).
///
/// Right angles take the exact diagonal path so orthorhombic cells are free of
/// f32 trigonometric noise.
fn cell_matrix(a: f32, b: f32, c: f32, alpha: f32, beta: f32, gamma: f32) -> [f32; 9] {
    let right = |ang: f32| (ang - 90.0).abs() < 1e-3;
    if right(alpha) && right(beta) && right(gamma) {
        [a, 0.0, 0.0, 0.0, b, 0.0, 0.0, 0.0, c]
    } else {
        crate::parser::cell_params_to_matrix(a, b, c, alpha, beta, gamma)
    }
}

// ─── public API ────────────────────────────────────────────────────────────

/// Parse an AMBER NetCDF trajectory file (`.nc`).
///
/// Accepts CDF-1 and CDF-2 classic NetCDF files following the AMBER NCTRAJ
/// convention.  Returns a `TrajectoryData` with positions in Angstroms.
pub fn parse_netcdf(data: &[u8]) -> Result<TrajectoryData, String> {
    if data.len() < 4 {
        return Err("file too short to be NetCDF".into());
    }
    let cdf2 = if &data[..4] == b"CDF\x01" {
        false
    } else if &data[..4] == b"CDF\x02" {
        true
    } else {
        return Err("not a NetCDF CDF-1 or CDF-2 file (wrong magic bytes)".into());
    };

    let mut r = Reader::new(data, cdf2);
    r.pos = 4;

    // numrecs (0xFFFFFFFF = STREAMING)
    let numrecs_raw = r.read_u32()?;

    // header sections
    let dims = parse_dim_list(&mut r)?;
    r.skip_att_list()?; // global attributes
    let vars = parse_var_list(&mut r)?;

    // unlimited dimension id (the "frame" dimension)
    let unlimited_id: Option<u32> = dims.iter().position(|(_, sz)| *sz == 0).map(|i| i as u32);

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
    let time_var = vars.iter().find(|v| v.name == "time");
    let cell_len_var = vars.iter().find(|v| v.name == "cell_lengths");
    let cell_ang_var = vars.iter().find(|v| v.name == "cell_angles");

    // validate coordinates type
    if coord_var.nc_type != NC_FLOAT {
        return Err(format!(
            "'coordinates' must be NC_FLOAT (5), got {}",
            coord_var.nc_type
        ));
    }
    let expected_vsize = n_atoms * 3 * 4;
    if coord_var.vsize as usize != expected_vsize {
        return Err(format!(
            "'coordinates' vsize {} != {} (n_atoms={n_atoms} × 3 × 4)",
            coord_var.vsize, expected_vsize
        ));
    }

    // recsize = sum of padded vsizes of all record variables
    let recsize: usize = vars
        .iter()
        .filter(|v| {
            unlimited_id
                .map(|uid| v.dimids.first() == Some(&uid))
                .unwrap_or(false)
        })
        .map(|v| (v.vsize as usize + 3) & !3)
        .sum();

    // number of frames
    let n_frames: usize = if numrecs_raw == 0xFFFF_FFFF {
        if recsize == 0 {
            return Err("streaming numrecs and recsize=0 — cannot determine frame count".into());
        }
        (data.len() as u64)
            .saturating_sub(coord_var.begin)
            .checked_div(recsize as u64)
            .unwrap_or(0) as usize
    } else {
        numrecs_raw as usize
    };

    if n_frames == 0 {
        return Err("NetCDF trajectory has 0 frames".into());
    }

    // read per-frame coordinates
    let n_coords = n_atoms * 3;
    let coord_begin = coord_var.begin as usize;
    let mut frame_positions_flat: Vec<f32> = Vec::with_capacity(n_frames * n_coords);

    for i in 0..n_frames {
        let base = coord_begin
            .checked_add(i.checked_mul(recsize).ok_or("frame offset overflow")?)
            .ok_or("frame offset overflow")?;
        if base + expected_vsize > data.len() {
            return Err(format!(
                "frame {i} coordinates out of bounds (offset {base})"
            ));
        }
        for j in 0..n_coords {
            frame_positions_flat.push(r.read_f32_at(base + j * 4)?);
        }
    }

    // derive timestep from time variable (frames 0 and 1 difference)
    let timestep_ps: f32 = if n_frames >= 2 {
        if let Some(tv) = time_var {
            if tv.nc_type == NC_FLOAT && tv.vsize == 4 && recsize > 0 {
                let t0 = r.read_f32_at(tv.begin as usize).unwrap_or(0.0);
                let t1 = r.read_f32_at(tv.begin as usize + recsize).unwrap_or(1.0);
                (t1 - t0).max(0.0)
            } else {
                1.0
            }
        } else {
            1.0
        }
    } else {
        1.0
    };

    // Read per-frame cell_lengths and cell_angles. Both are record variables,
    // so frame `i`'s value lives at `var.begin + i*recsize`. Per the AMBER
    // convention `cell_angles` holds alpha/beta/gamma in degrees; when absent
    // the cell is orthorhombic. Frame 0 is the representative `box_matrix`; a
    // per-frame side table is built only when the cell actually changes
    // (variable-cell / NPT runs).
    let mut box_matrix: Option<[f32; 9]> = None;
    let mut per_frame_cells: Vec<[f32; 9]> = Vec::new();
    let mut varies_cell = false;
    if let Some(cl) = cell_len_var {
        if cl.nc_type == NC_DOUBLE && cl.vsize >= 24 {
            let cl_begin = cl.begin as usize;
            let ca_begin = cell_ang_var
                .filter(|ca| ca.nc_type == NC_DOUBLE && ca.vsize >= 24)
                .map(|ca| ca.begin as usize);
            for i in 0..n_frames {
                let base = cl_begin.saturating_add(i.saturating_mul(recsize));
                if base + 24 > data.len() {
                    break;
                }
                let a = r.read_f64_at(base)? as f32;
                let b = r.read_f64_at(base + 8)? as f32;
                let c = r.read_f64_at(base + 16)? as f32;
                let (alpha, beta, gamma) = match ca_begin {
                    Some(cab) => {
                        let ab = cab.saturating_add(i.saturating_mul(recsize));
                        if ab + 24 > data.len() {
                            (90.0, 90.0, 90.0)
                        } else {
                            (
                                r.read_f64_at(ab)? as f32,
                                r.read_f64_at(ab + 8)? as f32,
                                r.read_f64_at(ab + 16)? as f32,
                            )
                        }
                    }
                    None => (90.0, 90.0, 90.0),
                };
                let m = cell_matrix(a, b, c, alpha, beta, gamma);
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
        }
    }

    let hetero = crate::trajectory::build_cell_hetero(varies_cell, per_frame_cells, n_atoms);

    Ok(TrajectoryData {
        n_atoms,
        n_frames,
        timestep_ps,
        box_matrix,
        box_origin: None,
        frame_positions_flat,
        vector_channels: vec![],
        hetero,
    })
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
            crate::parser::cell_params_to_matrix(10.0, 10.0, 10.0, 109.471, 109.471, 109.471);
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
}
