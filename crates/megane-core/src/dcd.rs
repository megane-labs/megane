/// DCD (CHARMM/NAMD/X-PLOR) binary trajectory parser.
///
/// Supports CHARMM and X-PLOR header variants with automatic little-endian /
/// big-endian detection via the Fortran record size markers.
///
/// Header layout (84-byte content block):
///   offset  0 –  3 : "CORD" magic
///   offset  4 –  7 : NSET  (number of frames)
///   offset  8 – 11 : ISTART
///   offset 12 – 15 : NSAVC (save frequency)
///   offset 16 – 19 : NSTEP
///   offset 20 – 35 : four unused int32 zeros
///   offset 36 – 39 : NAMNF (number of fixed atoms)
///   offset 40 – 47 : DELTA  (float32 + 4 b padding for CHARMM;
///                             float64 for X-PLOR)
///   offset 44 – 47 : HAS_CELL (CHARMM only, overlaps DELTA padding)
///   offset 48 – 79 : eight int32 zeros
///   offset 80 – 83 : CHARMM_VERSION (0 = X-PLOR)
use crate::trajectory::TrajectoryData;

pub type DcdData = TrajectoryData;

// 1 AKMA time unit ≈ 20.455 fs = 0.020455 ps
const AKMA_TO_PS: f32 = 0.020455;

// ── low-level readers ────────────────────────────────────────────────────────

#[inline]
fn read_u32_le(data: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]])
}
#[inline]
fn read_u32_be(data: &[u8], off: usize) -> u32 {
    u32::from_be_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]])
}
#[inline]
fn read_i32_le(data: &[u8], off: usize) -> i32 {
    i32::from_le_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]])
}
#[inline]
fn read_i32_be(data: &[u8], off: usize) -> i32 {
    i32::from_be_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]])
}
#[inline]
fn read_f32_le(data: &[u8], off: usize) -> f32 {
    f32::from_le_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]])
}
#[inline]
fn read_f32_be(data: &[u8], off: usize) -> f32 {
    f32::from_be_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]])
}
#[inline]
fn read_f64_le(data: &[u8], off: usize) -> f64 {
    f64::from_le_bytes([
        data[off],
        data[off + 1],
        data[off + 2],
        data[off + 3],
        data[off + 4],
        data[off + 5],
        data[off + 6],
        data[off + 7],
    ])
}
#[inline]
fn read_f64_be(data: &[u8], off: usize) -> f64 {
    f64::from_be_bytes([
        data[off],
        data[off + 1],
        data[off + 2],
        data[off + 3],
        data[off + 4],
        data[off + 5],
        data[off + 6],
        data[off + 7],
    ])
}

// ── Fortran unformatted record reader ────────────────────────────────────────

struct DcdReader<'a> {
    data: &'a [u8],
    pos: usize,
    le: bool,
}

impl<'a> DcdReader<'a> {
    fn new(data: &'a [u8], le: bool) -> Self {
        Self { data, pos: 0, le }
    }

    fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.pos)
    }

    fn read_u32(&mut self) -> Result<u32, String> {
        if self.pos + 4 > self.data.len() {
            return Err("unexpected end of DCD data reading u32".into());
        }
        let v = if self.le {
            read_u32_le(self.data, self.pos)
        } else {
            read_u32_be(self.data, self.pos)
        };
        self.pos += 4;
        Ok(v)
    }

    /// Read a Fortran unformatted binary record.
    /// Returns a slice of the record content and advances past the record.
    fn read_record(&mut self) -> Result<&'a [u8], String> {
        let size = self.read_u32()? as usize;
        let start = self.pos;
        let end = start + size;
        if end + 4 > self.data.len() {
            return Err(format!(
                "DCD record ({} bytes) extends beyond file end (pos {})",
                size, start
            ));
        }
        self.pos = end;
        let end_marker = self.read_u32()? as usize;
        if size != end_marker {
            return Err(format!(
                "DCD Fortran record markers mismatch: {} vs {}",
                size, end_marker
            ));
        }
        Ok(&self.data[start..end])
    }

    fn skip_record(&mut self) -> Result<(), String> {
        self.read_record()?;
        Ok(())
    }
}

// ── cell helpers ─────────────────────────────────────────────────────────────

/// Decode the three angle slots of a DCD unit-cell record into degrees.
///
/// NAMD writes angle **cosines** (all in [-1, 1]) while CHARMM writes angles in
/// **degrees**; a slot value of 0.0 means 90° under either convention.
fn dcd_cell_angles(alpha_raw: f64, beta_raw: f64, gamma_raw: f64) -> (f32, f32, f32) {
    let is_cosine = [alpha_raw, beta_raw, gamma_raw]
        .iter()
        .all(|v| (-1.0..=1.0).contains(v));
    let to_deg = |v: f64| -> f32 {
        if !is_cosine {
            v as f32
        } else if v == 0.0 {
            90.0
        } else {
            v.acos().to_degrees() as f32
        }
    };
    (to_deg(alpha_raw), to_deg(beta_raw), to_deg(gamma_raw))
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

// ── public API ───────────────────────────────────────────────────────────────

/// Parse a DCD binary trajectory and return all frames.
pub fn parse_dcd(data: &[u8]) -> Result<DcdData, String> {
    if data.len() < 96 {
        // Minimum: header block(92) + title(8) + natom(12) = 112, but be lenient.
        return Err("DCD file too small".into());
    }

    // Detect endianness: the first 4 bytes are a Fortran record size = 84.
    let le = if read_u32_le(data, 0) == 84 {
        true
    } else if read_u32_be(data, 0) == 84 {
        false
    } else {
        return Err(format!(
            "not a valid DCD file (first 4 bytes: {:02x} {:02x} {:02x} {:02x})",
            data[0], data[1], data[2], data[3]
        ));
    };

    let mut reader = DcdReader::new(data, le);

    // ── Block 1: 84-byte header ──────────────────────────────────────────────
    let hdr = reader.read_record()?;
    if hdr.len() != 84 {
        return Err(format!(
            "DCD header block has unexpected size {} (expected 84)",
            hdr.len()
        ));
    }
    if &hdr[0..4] != b"CORD" && &hdr[0..4] != b"VELD" {
        return Err(format!("DCD magic not found (got {:?})", &hdr[0..4]));
    }

    let read_i32 = |off: usize| -> i32 {
        if le {
            read_i32_le(hdr, off)
        } else {
            read_i32_be(hdr, off)
        }
    };

    let nset = read_i32(4).max(0) as usize;
    let nsavc = read_i32(12).max(1) as usize;

    // NAMNF (icntrl[8]): number of fixed atoms. Fixed-atom DCDs store only the
    // free atoms after the first frame, which this parser does not decode.
    let namnf = read_i32(36);
    if namnf != 0 {
        return Err(format!(
            "fixed-atom DCD files (NAMNF={namnf}) are not supported"
        ));
    }

    // CHARMM_VERSION is the last int32 of the 84-byte block.
    let charmm_version = read_i32(80);
    let is_charmm = charmm_version != 0;

    // DELTA: float32 at offset 40 (CHARMM) or float64 at offsets 40–47 (X-PLOR).
    let delta_ps = if is_charmm {
        let d = if le {
            read_f32_le(hdr, 40)
        } else {
            f32::from_be_bytes([hdr[40], hdr[41], hdr[42], hdr[43]])
        };
        d * AKMA_TO_PS
    } else {
        let d = if le {
            read_f64_le(hdr, 40)
        } else {
            read_f64_be(hdr, 40)
        } as f32;
        d * AKMA_TO_PS
    };

    // HAS_CELL: int32 at offset 44 (CHARMM only; overlaps X-PLOR DELTA padding).
    let has_cell = is_charmm && read_i32(44) != 0;

    // ── Block 2: title (skip) ────────────────────────────────────────────────
    reader.skip_record()?;

    // ── Block 3: NATOM (4 bytes) ─────────────────────────────────────────────
    let natom_rec = reader.read_record()?;
    if natom_rec.len() != 4 {
        return Err(format!(
            "DCD NATOM block has unexpected size {} (expected 4)",
            natom_rec.len()
        ));
    }
    let n_atoms = if le {
        read_i32_le(natom_rec, 0)
    } else {
        read_i32_be(natom_rec, 0)
    } as usize;

    if n_atoms == 0 {
        return Err("DCD file reports zero atoms".into());
    }

    let expected_coord_bytes = n_atoms * 4;

    // ── Frames ───────────────────────────────────────────────────────────────
    // Frame-major flat coordinates; reserve up front when the frame count is known.
    let mut frame_positions_flat: Vec<f32> = if nset > 0 {
        Vec::with_capacity(nset * n_atoms * 3)
    } else {
        Vec::new()
    };
    let mut n_frames: usize = 0;
    let mut first_box: Option<[f32; 9]> = None;
    // Per-frame cell recording, started lazily only once a frame's box diverges
    // from frame 0 (constant-cell runs allocate nothing and keep parity).
    let mut per_frame_cells: Vec<[f32; 9]> = Vec::new();
    let mut varies_cell = false;

    loop {
        if reader.remaining() == 0 {
            break;
        }

        // Optional unit-cell record for CHARMM (6 × float64 = 48 bytes).
        let mut cur_box: Option<[f32; 9]> = None;
        if has_cell {
            if reader.remaining() < 8 {
                break;
            }
            match reader.read_record() {
                Ok(cell) if cell.len() == 48 => {
                    // CHARMM XTL order: A, gamma, B, beta, alpha, C. Lengths are
                    // Angstroms; angle slots hold cosines (NAMD) or degrees (CHARMM).
                    let f = |off: usize| {
                        if le {
                            read_f64_le(cell, off)
                        } else {
                            read_f64_be(cell, off)
                        }
                    };
                    let (a, b, c) = (f(0) as f32, f(16) as f32, f(40) as f32);
                    let (alpha, beta, gamma) = dcd_cell_angles(f(32), f(24), f(8));
                    cur_box = Some(cell_matrix(a, b, c, alpha, beta, gamma));
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }

        // X coordinates
        let x_rec = match reader.read_record() {
            Ok(r) => r,
            Err(_) => break,
        };
        if x_rec.len() != expected_coord_bytes {
            if n_frames == 0 {
                return Err(format!(
                    "DCD X-coord record size {} != expected {}",
                    x_rec.len(),
                    expected_coord_bytes
                ));
            }
            break;
        }

        // Y coordinates
        let y_rec = reader.read_record()?;
        if y_rec.len() != expected_coord_bytes {
            return Err(format!(
                "DCD Y-coord record size {} != expected {}",
                y_rec.len(),
                expected_coord_bytes
            ));
        }

        // Z coordinates
        let z_rec = reader.read_record()?;
        if z_rec.len() != expected_coord_bytes {
            return Err(format!(
                "DCD Z-coord record size {} != expected {}",
                z_rec.len(),
                expected_coord_bytes
            ));
        }

        // Build interleaved [x0,y0,z0, x1,y1,z1, …] straight into the flat buffer.
        if le {
            for i in 0..n_atoms {
                let off = i * 4;
                frame_positions_flat.push(read_f32_le(x_rec, off));
                frame_positions_flat.push(read_f32_le(y_rec, off));
                frame_positions_flat.push(read_f32_le(z_rec, off));
            }
        } else {
            for i in 0..n_atoms {
                let off = i * 4;
                frame_positions_flat.push(read_f32_be(x_rec, off));
                frame_positions_flat.push(read_f32_be(y_rec, off));
                frame_positions_flat.push(read_f32_be(z_rec, off));
            }
        }
        // Record the per-frame cell now that the frame is confirmed complete.
        if n_frames == 0 {
            first_box = cur_box;
        }
        if has_cell {
            let this_box = cur_box.or(first_box).unwrap_or([0.0; 9]);
            if !varies_cell && cur_box.is_some() && cur_box != first_box {
                varies_cell = true;
                per_frame_cells
                    .extend(std::iter::repeat_n(first_box.unwrap_or([0.0; 9]), n_frames));
            }
            if varies_cell {
                per_frame_cells.push(this_box);
            }
        }
        n_frames += 1;

        if nset > 0 && n_frames >= nset {
            break;
        }
    }

    if n_frames == 0 {
        return Err("no frames found in DCD file".into());
    }

    let timestep_ps = if delta_ps > 0.0 {
        delta_ps * nsavc as f32
    } else {
        1.0
    };

    let hetero = crate::trajectory::build_cell_hetero(varies_cell, per_frame_cells, n_atoms);

    Ok(DcdData {
        n_atoms,
        n_frames,
        timestep_ps,
        box_matrix: first_box,
        box_origin: None,
        frame_positions_flat,
        vector_channels: vec![],
        hetero,
    })
}

// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_water_dcd() {
        let data = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/water.dcd"
        ))
        .expect("read water.dcd");

        let result = parse_dcd(&data).expect("parse DCD");

        assert_eq!(result.n_atoms, 3, "n_atoms");
        assert_eq!(result.n_frames, 5, "n_frames");

        // Unit-cell diagonal should be ~10 Å
        let bx = result.box_matrix.expect("box_matrix");
        assert!((bx[0] - 10.0).abs() < 0.01, "box a = {}", bx[0]);
        assert!((bx[4] - 10.0).abs() < 0.01, "box b = {}", bx[4]);
        assert!((bx[8] - 10.0).abs() < 0.01, "box c = {}", bx[8]);

        // Frame 0: atom 0 at (0,0,0), atom 1 at (0.96,0,0), atom 2 at (0,0.96,0)
        let f0 = result.frame(0);
        let check = |ai: usize, ex: f32, ey: f32, ez: f32| {
            let (x, y, z) = (f0[ai * 3], f0[ai * 3 + 1], f0[ai * 3 + 2]);
            assert!(
                (x - ex).abs() < 1e-4 && (y - ey).abs() < 1e-4 && (z - ez).abs() < 1e-4,
                "atom {ai}: got ({x},{y},{z}), expected ({ex},{ey},{ez})"
            );
        };
        check(0, 0.00, 0.00, 0.00);
        check(1, 0.96, 0.00, 0.00);
        check(2, 0.00, 0.96, 0.00);

        // Frame 4 (last) should match frame 0 (oscillation returns to origin)
        let f4 = result.frame(4);
        assert!((f4[0] - 0.00f32).abs() < 1e-4, "frame4 atom0 x");
        assert!((f4[1] - 0.00f32).abs() < 1e-4, "frame4 atom0 y");
    }

    #[test]
    fn test_bad_magic_returns_error() {
        let bad: Vec<u8> = vec![0x54, 0x00, 0x00, 0x00]; // not 84 in either endian
        assert!(parse_dcd(&bad).is_err());
    }

    #[test]
    fn test_empty_returns_error() {
        assert!(parse_dcd(&[]).is_err());
    }

    // ── synthetic DCD builders for endian / variant / error-path coverage ────

    /// Build a CHARMM 84-byte header content block.
    fn build_header(le: bool, charmm_version: i32, has_cell: bool, n_set: i32) -> [u8; 84] {
        let mut h = [0u8; 84];
        h[0..4].copy_from_slice(b"CORD");
        let i32_bytes = |v: i32| -> [u8; 4] {
            if le {
                v.to_le_bytes()
            } else {
                v.to_be_bytes()
            }
        };
        let f32_bytes = |v: f32| -> [u8; 4] {
            if le {
                v.to_le_bytes()
            } else {
                v.to_be_bytes()
            }
        };
        let f64_bytes = |v: f64| -> [u8; 8] {
            if le {
                v.to_le_bytes()
            } else {
                v.to_be_bytes()
            }
        };
        h[4..8].copy_from_slice(&i32_bytes(n_set));
        h[12..16].copy_from_slice(&i32_bytes(1)); // NSAVC
        if charmm_version != 0 {
            // CHARMM: float32 DELTA at 40, HAS_CELL at 44
            h[40..44].copy_from_slice(&f32_bytes(0.5));
            h[44..48].copy_from_slice(&i32_bytes(if has_cell { 1 } else { 0 }));
        } else {
            // X-PLOR: float64 DELTA at 40
            h[40..48].copy_from_slice(&f64_bytes(0.5));
        }
        h[80..84].copy_from_slice(&i32_bytes(charmm_version));
        h
    }

    /// Wrap a payload in a Fortran unformatted record (size + data + size).
    fn write_record(out: &mut Vec<u8>, payload: &[u8], le: bool) {
        let size = payload.len() as u32;
        out.extend_from_slice(&if le {
            size.to_le_bytes()
        } else {
            size.to_be_bytes()
        });
        out.extend_from_slice(payload);
        out.extend_from_slice(&if le {
            size.to_le_bytes()
        } else {
            size.to_be_bytes()
        });
    }

    fn write_natom(out: &mut Vec<u8>, n_atoms: i32, le: bool) {
        let bytes = if le {
            n_atoms.to_le_bytes()
        } else {
            n_atoms.to_be_bytes()
        };
        write_record(out, &bytes, le);
    }

    fn write_coord(out: &mut Vec<u8>, coords: &[f32], le: bool) {
        let mut buf = Vec::with_capacity(coords.len() * 4);
        for c in coords {
            buf.extend_from_slice(&if le { c.to_le_bytes() } else { c.to_be_bytes() });
        }
        write_record(out, &buf, le);
    }

    /// Write a unit-cell record in raw CHARMM XTL slot order
    /// `[A, gamma, B, beta, alpha, C]`.
    fn write_cell_raw(out: &mut Vec<u8>, slots: [f64; 6], le: bool) {
        let mut buf = Vec::with_capacity(48);
        for v in &slots {
            buf.extend_from_slice(&if le { v.to_le_bytes() } else { v.to_be_bytes() });
        }
        write_record(out, &buf, le);
    }

    fn write_cell(out: &mut Vec<u8>, a: f64, b: f64, c: f64, le: bool) {
        write_cell_raw(out, [a, 90.0, b, 90.0, 90.0, c], le);
    }

    /// Produce a single-frame DCD blob.
    fn build_single_frame(le: bool, charmm_version: i32, has_cell: bool) -> Vec<u8> {
        let mut out = Vec::new();
        write_record(&mut out, &build_header(le, charmm_version, has_cell, 1), le);
        // Title block: title count + 80-byte string
        let mut title = vec![0u8; 84];
        title[0..4].copy_from_slice(&if le {
            1i32.to_le_bytes()
        } else {
            1i32.to_be_bytes()
        });
        write_record(&mut out, &title, le);
        write_natom(&mut out, 2, le);
        if has_cell {
            write_cell(&mut out, 12.0, 13.0, 14.0, le);
        }
        write_coord(&mut out, &[0.0, 1.0], le); // X for 2 atoms
        write_coord(&mut out, &[2.0, 3.0], le); // Y
        write_coord(&mut out, &[4.0, 5.0], le); // Z
        out
    }

    #[test]
    fn test_parse_big_endian_charmm_with_cell() {
        let blob = build_single_frame(false, 24, true);
        let r = parse_dcd(&blob).expect("BE CHARMM with cell");
        assert_eq!(r.n_atoms, 2);
        assert_eq!(r.n_frames, 1);
        let bx = r.box_matrix.expect("cell present");
        assert!((bx[0] - 12.0).abs() < 1e-3);
        assert!((bx[4] - 13.0).abs() < 1e-3);
        assert!((bx[8] - 14.0).abs() < 1e-3);
        // First atom should be (0, 2, 4) — interleaved [x0, y0, z0]
        let f0 = r.frame(0);
        assert!((f0[0] - 0.0).abs() < 1e-5);
        assert!((f0[1] - 2.0).abs() < 1e-5);
        assert!((f0[2] - 4.0).abs() < 1e-5);
    }

    #[test]
    fn test_parse_charmm_without_cell() {
        let blob = build_single_frame(true, 24, false);
        let r = parse_dcd(&blob).expect("CHARMM no cell");
        assert_eq!(r.n_atoms, 2);
        assert_eq!(r.n_frames, 1);
        assert!(r.box_matrix.is_none());
    }

    /// Build a CHARMM DCD with `cells` frames, each carrying its own diagonal box.
    fn build_multi_frame_cells(le: bool, cells: &[(f64, f64, f64)]) -> Vec<u8> {
        let mut out = Vec::new();
        write_record(
            &mut out,
            &build_header(le, 24, true, cells.len() as i32),
            le,
        );
        let mut title = vec![0u8; 84];
        title[0..4].copy_from_slice(&if le {
            1i32.to_le_bytes()
        } else {
            1i32.to_be_bytes()
        });
        write_record(&mut out, &title, le);
        write_natom(&mut out, 2, le);
        for (i, (a, b, c)) in cells.iter().enumerate() {
            write_cell(&mut out, *a, *b, *c, le);
            let f = i as f32;
            write_coord(&mut out, &[f, f + 1.0], le); // X
            write_coord(&mut out, &[f + 2.0, f + 3.0], le); // Y
            write_coord(&mut out, &[f + 4.0, f + 5.0], le); // Z
        }
        out
    }

    #[test]
    fn test_uniform_cell_dcd_keeps_fast_path() {
        // Every frame carries the same cell → no side table, box is that cell.
        let blob = build_multi_frame_cells(true, &[(10.0, 10.0, 10.0), (10.0, 10.0, 10.0)]);
        let r = parse_dcd(&blob).expect("uniform cell DCD");
        assert_eq!(r.n_frames, 2);
        assert!(r.hetero.is_none());
        assert!((r.box_matrix.unwrap()[0] - 10.0).abs() < 1e-3);
    }

    #[test]
    fn test_variable_cell_dcd_builds_side_table() {
        let blob = build_multi_frame_cells(true, &[(10.0, 10.0, 10.0), (12.0, 12.0, 12.0)]);
        let r = parse_dcd(&blob).expect("variable cell DCD");
        assert_eq!(r.n_frames, 2);
        let h = r.hetero.as_ref().expect("cell side table");
        assert!(h.varies_cell);
        assert!(!h.varies_atoms);
        // box_matrix is frame 0; per-frame cells cover both frames.
        assert!((r.box_matrix.unwrap()[0] - 10.0).abs() < 1e-3);
        assert!((r.frame_cell(0).unwrap()[0] - 10.0).abs() < 1e-3);
        assert!((r.frame_cell(1).unwrap()[0] - 12.0).abs() < 1e-3);
    }

    #[test]
    fn test_parse_xplor_variant() {
        // charmm_version == 0 → X-PLOR header (float64 DELTA, no HAS_CELL)
        let blob = build_single_frame(true, 0, false);
        let r = parse_dcd(&blob).expect("X-PLOR DCD");
        assert_eq!(r.n_atoms, 2);
        assert_eq!(r.n_frames, 1);
        // delta=0.5 AKMA × NSAVC=1 ≈ 0.0102275 ps
        assert!(r.timestep_ps > 0.0);
    }

    #[test]
    fn test_parse_big_endian_xplor() {
        let blob = build_single_frame(false, 0, false);
        let r = parse_dcd(&blob).expect("BE X-PLOR");
        assert_eq!(r.n_atoms, 2);
        assert_eq!(r.n_frames, 1);
    }

    #[test]
    fn test_header_size_not_84_returns_error() {
        // Construct a Fortran record claiming size 80 (not 84) at offset 0.
        let mut blob = Vec::new();
        let payload = vec![0u8; 80];
        // Force first u32 to be 84 so endianness detection passes — but the
        // record must agree with that, so we deliberately build a malformed
        // file where the first record claims 84 bytes but the data is short.
        write_record(&mut blob, &payload, true);
        // First 4 bytes are now 80 (LE), 80 (BE), neither matches 84 → bad magic.
        assert!(parse_dcd(&blob).is_err());
    }

    #[test]
    fn test_zero_natoms_returns_error() {
        let mut out = Vec::new();
        write_record(&mut out, &build_header(true, 24, false, 1), true);
        let mut title = vec![0u8; 84];
        title[0..4].copy_from_slice(&1i32.to_le_bytes());
        write_record(&mut out, &title, true);
        write_natom(&mut out, 0, true);
        let err = parse_dcd(&out).err().expect("expected error");
        assert!(err.contains("zero atoms"), "got: {err}");
    }

    #[test]
    fn test_natom_block_wrong_size_returns_error() {
        let mut out = Vec::new();
        write_record(&mut out, &build_header(true, 24, false, 1), true);
        let mut title = vec![0u8; 84];
        title[0..4].copy_from_slice(&1i32.to_le_bytes());
        write_record(&mut out, &title, true);
        // NATOM record with 8 bytes instead of 4.
        write_record(&mut out, &[0u8; 8], true);
        let err = parse_dcd(&out).err().expect("expected error");
        assert!(err.contains("NATOM"), "got: {err}");
    }

    #[test]
    fn test_invalid_magic_letters_returns_error() {
        // Header record with valid 84-byte size but magic != "CORD"/"VELD".
        let mut hdr = build_header(true, 24, false, 1);
        hdr[0..4].copy_from_slice(b"XXXX");
        let mut out = Vec::new();
        write_record(&mut out, &hdr, true);
        // Pad past the 96-byte size guard so the magic check is actually reached.
        let mut title = vec![0u8; 84];
        title[0..4].copy_from_slice(&1i32.to_le_bytes());
        write_record(&mut out, &title, true);
        let err = parse_dcd(&out).err().expect("expected error");
        assert!(err.contains("magic"), "got: {err}");
    }

    #[test]
    fn test_x_record_wrong_size_first_frame_errors() {
        // Build header + title + natom=2, then write only 4 bytes of X (instead of 8).
        let mut out = Vec::new();
        write_record(&mut out, &build_header(true, 24, false, 1), true);
        let mut title = vec![0u8; 84];
        title[0..4].copy_from_slice(&1i32.to_le_bytes());
        write_record(&mut out, &title, true);
        write_natom(&mut out, 2, true);
        // Wrong-sized X coord record.
        write_record(&mut out, &[0u8; 4], true);
        let err = parse_dcd(&out).err().expect("expected error");
        assert!(err.contains("X-coord"), "got: {err}");
    }

    #[test]
    fn test_nset_caps_frame_count() {
        // Build a 1-frame body but request NSET=1 — exercises the early break.
        let blob = build_single_frame(true, 24, true);
        let r = parse_dcd(&blob).expect("nset cap");
        assert_eq!(r.n_frames, 1);
    }

    #[test]
    fn test_velocity_magic_accepted() {
        let mut hdr = build_header(true, 24, false, 1);
        hdr[0..4].copy_from_slice(b"VELD");
        let mut out = Vec::new();
        write_record(&mut out, &hdr, true);
        let mut title = vec![0u8; 84];
        title[0..4].copy_from_slice(&1i32.to_le_bytes());
        write_record(&mut out, &title, true);
        write_natom(&mut out, 2, true);
        write_coord(&mut out, &[0.0, 1.0], true);
        write_coord(&mut out, &[2.0, 3.0], true);
        write_coord(&mut out, &[4.0, 5.0], true);
        let r = parse_dcd(&out).expect("VELD magic");
        assert_eq!(r.n_atoms, 2);
        assert_eq!(r.n_frames, 1);
    }

    /// Produce a single-frame CHARMM DCD whose cell record carries the given
    /// raw slots `[A, gamma, B, beta, alpha, C]`.
    fn build_single_frame_raw_cell(le: bool, slots: [f64; 6]) -> Vec<u8> {
        let mut out = Vec::new();
        write_record(&mut out, &build_header(le, 24, true, 1), le);
        let mut title = vec![0u8; 84];
        title[0..4].copy_from_slice(&if le {
            1i32.to_le_bytes()
        } else {
            1i32.to_be_bytes()
        });
        write_record(&mut out, &title, le);
        write_natom(&mut out, 2, le);
        write_cell_raw(&mut out, slots, le);
        write_coord(&mut out, &[0.0, 1.0], le);
        write_coord(&mut out, &[2.0, 3.0], le);
        write_coord(&mut out, &[4.0, 5.0], le);
        out
    }

    #[test]
    fn test_triclinic_cosine_convention_cell() {
        // NAMD writes angle cosines: gamma = 120° → cos = -0.5, alpha = beta = 90° → 0.0.
        let blob = build_single_frame_raw_cell(true, [10.0, -0.5, 11.0, 0.0, 0.0, 12.0]);
        let r = parse_dcd(&blob).expect("cosine-convention DCD");
        let bx = r.box_matrix.expect("cell present");
        let expect = crate::parser::cell_params_to_matrix(10.0, 11.0, 12.0, 90.0, 90.0, 120.0);
        for i in 0..9 {
            assert!(
                (bx[i] - expect[i]).abs() < 1e-3,
                "m[{i}] = {} expected {}",
                bx[i],
                expect[i]
            );
        }
        // b-vector tilts by cos(120°) = -0.5 along x.
        assert!((bx[3] + 5.5).abs() < 1e-3, "b·x = {}", bx[3]);
        assert!(
            (bx[4] - 11.0 * 0.75f32.sqrt()).abs() < 1e-3,
            "b·y = {}",
            bx[4]
        );
    }

    #[test]
    fn test_triclinic_degree_convention_cell() {
        // CHARMM writes angles in degrees directly.
        let blob = build_single_frame_raw_cell(true, [10.0, 120.0, 11.0, 90.0, 90.0, 12.0]);
        let r = parse_dcd(&blob).expect("degree-convention DCD");
        let bx = r.box_matrix.expect("cell present");
        let expect = crate::parser::cell_params_to_matrix(10.0, 11.0, 12.0, 90.0, 90.0, 120.0);
        for i in 0..9 {
            assert!(
                (bx[i] - expect[i]).abs() < 1e-3,
                "m[{i}] = {} expected {}",
                bx[i],
                expect[i]
            );
        }
    }

    #[test]
    fn test_orthorhombic_cell_stays_exact_diagonal() {
        // 90° angles (degree convention) must yield the exact diagonal matrix
        // the old lengths-only path produced.
        let blob = build_single_frame_raw_cell(true, [12.0, 90.0, 13.0, 90.0, 90.0, 14.0]);
        let r = parse_dcd(&blob).expect("orthorhombic degree DCD");
        let bx = r.box_matrix.expect("cell present");
        assert_eq!(bx, [12.0, 0.0, 0.0, 0.0, 13.0, 0.0, 0.0, 0.0, 14.0]);

        // Cosine convention: 0.0 slots mean 90° and must give the same matrix.
        let blob = build_single_frame_raw_cell(true, [12.0, 0.0, 13.0, 0.0, 0.0, 14.0]);
        let r = parse_dcd(&blob).expect("orthorhombic cosine DCD");
        assert_eq!(
            r.box_matrix.unwrap(),
            [12.0, 0.0, 0.0, 0.0, 13.0, 0.0, 0.0, 0.0, 14.0]
        );
    }

    #[test]
    fn test_per_frame_triclinic_cells_in_side_table() {
        // Frame 0 orthorhombic, frame 1 triclinic → hetero side table carries
        // the full (angled) matrix for each frame.
        let mut out = Vec::new();
        write_record(&mut out, &build_header(true, 24, true, 2), true);
        let mut title = vec![0u8; 84];
        title[0..4].copy_from_slice(&1i32.to_le_bytes());
        write_record(&mut out, &title, true);
        write_natom(&mut out, 2, true);
        write_cell_raw(&mut out, [10.0, 90.0, 10.0, 90.0, 90.0, 10.0], true);
        write_coord(&mut out, &[0.0, 1.0], true);
        write_coord(&mut out, &[2.0, 3.0], true);
        write_coord(&mut out, &[4.0, 5.0], true);
        write_cell_raw(&mut out, [10.0, 120.0, 10.0, 90.0, 90.0, 10.0], true);
        write_coord(&mut out, &[0.5, 1.5], true);
        write_coord(&mut out, &[2.5, 3.5], true);
        write_coord(&mut out, &[4.5, 5.5], true);

        let r = parse_dcd(&out).expect("mixed-cell DCD");
        assert_eq!(r.n_frames, 2);
        let h = r.hetero.as_ref().expect("cell side table");
        assert!(h.varies_cell);
        let f1 = r.frame_cell(1).expect("frame 1 cell");
        assert!((f1[3] + 5.0).abs() < 1e-3, "frame1 b·x = {}", f1[3]);
    }

    #[test]
    fn test_fixed_atom_dcd_rejected() {
        let mut hdr = build_header(true, 24, false, 1);
        // NAMNF (icntrl[8]) lives at offset 36 of the header block.
        hdr[36..40].copy_from_slice(&2i32.to_le_bytes());
        let mut out = Vec::new();
        write_record(&mut out, &hdr, true);
        let mut title = vec![0u8; 84];
        title[0..4].copy_from_slice(&1i32.to_le_bytes());
        write_record(&mut out, &title, true);
        write_natom(&mut out, 2, true);
        write_coord(&mut out, &[0.0, 1.0], true);
        write_coord(&mut out, &[2.0, 3.0], true);
        write_coord(&mut out, &[4.0, 5.0], true);
        let err = parse_dcd(&out).err().expect("expected error");
        assert!(err.contains("NAMNF=2"), "got: {err}");
        assert!(err.contains("not supported"), "got: {err}");
    }
}
