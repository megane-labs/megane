/// LAMMPS dump trajectory (.lammpstrj) parser.
///
/// Text-based multi-frame format. [`parse_lammpstrj`] returns trajectory data
/// (positions + box) without topology — element/bond info comes from a separate
/// structure file — for the "attach onto a loaded topology" workflow.
///
/// [`parse_lammpstrj_structure`] instead returns a full [`ParsedStructure`]
/// (structure lane, like `traj.rs`/`xyz.rs`) so a dump can be opened standalone
/// as a multi-frame structure: frame-0 topology is derived from the file, the
/// remaining frames stream into playback. A dump carries no element symbols or
/// masses, so the integer per-atom `type` id is used as the atomic-number proxy
/// (the same convention as the trajectory lane's `TrajHetero::elements_flat`);
/// bonds are inferred by distance from frame 0.
///
/// Supports coordinate columns: xu/yu/zu (unwrapped), x/y/z (unscaled),
/// xs/ys/zs (scaled). ix/iy/iz image flags, when present, are folded into
/// wrapped/scaled coordinates so positions are the absolute ones the file
/// encodes. Atoms are sorted by id within each frame. Also detects and
/// extracts named vector column groups (vx/vy/vz, fx/fy/fz); the structure
/// lane additionally surfaces every remaining numeric per-atom column
/// (q, mol, c_*/f_*/v_* computes, …) as a scalar channel.
use crate::bonds;
use crate::structure::{FrameChange, HeteroFramesBuilder, ParsedStructure};
use crate::trajectory::{ScalarChannel, ScalarFrame, TrajectoryData, VectorChannel, VectorFrame};
use std::collections::HashSet;

/// Type alias kept for backwards compatibility.
pub type LammpstrjData = TrajectoryData;

/// Detected coordinate type.
#[derive(Clone, Copy)]
enum CoordType {
    /// Unscaled Cartesian (x, y, z)
    Unscaled,
    /// Scaled/fractional (xs, ys, zs)
    Scaled,
    /// Unwrapped Cartesian (xu, yu, zu)
    Unwrapped,
}

/// Column indices for a named per-atom vector quantity (e.g. velocity, force).
#[derive(Clone)]
struct VectorColumnGroup {
    name: &'static str,
    x_col: usize,
    y_col: usize,
    z_col: usize,
}

/// Column index + header name of a captured per-atom scalar column.
#[derive(Clone)]
struct ScalarColumn {
    name: String,
    col: usize,
}

/// Column indices for atom data.
struct ColumnLayout {
    id_col: usize,
    /// `type` column index, if present. Used only for heterogeneous dumps to
    /// carry a per-frame element proxy (LAMMPS integer type id) so the host can
    /// map it to a real element for frames that gain/lose atoms.
    type_col: Option<usize>,
    x_col: usize,
    y_col: usize,
    z_col: usize,
    coord_type: CoordType,
    /// `ix`/`iy`/`iz` periodic image flag columns, when the dump carries them.
    /// Folded into wrapped (`x y z`) or scaled (`xs ys zs`) coordinates to
    /// decode the file's absolute-position encoding; unused with `xu yu zu`.
    image_cols: Option<[usize; 3]>,
    /// Optional extra per-atom vector column groups (velocity, force, …).
    vector_groups: Vec<VectorColumnGroup>,
    /// Remaining numeric per-atom columns (q, mol, mass, c_*/f_*/v_* computes,
    /// …), captured by header name so file data is never silently dropped.
    scalar_cols: Vec<ScalarColumn>,
}

fn parse_column_layout(header: &str) -> Result<ColumnLayout, String> {
    // Header looks like: "ITEM: ATOMS id type x y z" or "ITEM: ATOMS id type xs ys zs"
    let cols: Vec<&str> = header.split_whitespace().collect();
    // Skip "ITEM:" and "ATOMS"
    let col_names: Vec<&str> = if cols.len() > 2 && cols[0] == "ITEM:" && cols[1] == "ATOMS" {
        cols[2..].to_vec()
    } else {
        return Err("Invalid ITEM: ATOMS header".to_string());
    };

    let find = |name: &str| -> Option<usize> { col_names.iter().position(|&c| c == name) };

    let id_col = find("id").ok_or("Missing 'id' column in ATOMS header")?;
    let type_col = find("type");

    // Coordinate column preference — pick the encoding that yields absolute
    // positions without inventing anything:
    //   1. xu/yu/zu — already unwrapped/absolute in the file
    //   2. x/y/z    — wrapped Cartesian, decoded with ix/iy/iz image flags
    //                 when present
    //   3. xs/ys/zs — scaled/fractional, cell-converted (+ image flags when
    //                 present)
    // Decoding image flags is reading the file's own absolute-position
    // encoding, not a transformation — the wrap pipeline node re-wraps on
    // demand.
    let (x_col, y_col, z_col, coord_type) = if let (Some(x), Some(y), Some(z)) =
        (find("xu"), find("yu"), find("zu"))
    {
        (x, y, z, CoordType::Unwrapped)
    } else if let (Some(x), Some(y), Some(z)) = (find("x"), find("y"), find("z")) {
        (x, y, z, CoordType::Unscaled)
    } else if let (Some(x), Some(y), Some(z)) = (find("xs"), find("ys"), find("zs")) {
        (x, y, z, CoordType::Scaled)
    } else {
        return Err("Cannot find x/y/z, xs/ys/zs, or xu/yu/zu columns in ATOMS header".to_string());
    };

    let image_cols = match (find("ix"), find("iy"), find("iz")) {
        (Some(ix), Some(iy), Some(iz)) => Some([ix, iy, iz]),
        _ => None,
    };

    // Detect optional vector column groups.
    let mut vector_groups = Vec::new();
    if let (Some(vx), Some(vy), Some(vz)) = (find("vx"), find("vy"), find("vz")) {
        vector_groups.push(VectorColumnGroup {
            name: "velocity",
            x_col: vx,
            y_col: vy,
            z_col: vz,
        });
    }
    if let (Some(fx), Some(fy), Some(fz)) = (find("fx"), find("fy"), find("fz")) {
        vector_groups.push(VectorColumnGroup {
            name: "force",
            x_col: fx,
            y_col: fy,
            z_col: fz,
        });
    }

    // Every remaining column is a per-atom scalar quantity the file asserts;
    // capture it by header name. `element` (a symbol string) and the id/type/
    // coordinate/image-flag/vector names are structural, not scalar data.
    const STRUCTURAL_COLS: &[&str] = &[
        "id", "type", "element", "x", "y", "z", "xs", "ys", "zs", "xu", "yu", "zu", "ix", "iy",
        "iz", "vx", "vy", "vz", "fx", "fy", "fz",
    ];
    let scalar_cols: Vec<ScalarColumn> = col_names
        .iter()
        .enumerate()
        .filter(|(_, name)| !STRUCTURAL_COLS.contains(name))
        .map(|(col, name)| ScalarColumn {
            name: name.to_string(),
            col,
        })
        .collect();

    Ok(ColumnLayout {
        id_col,
        type_col,
        x_col,
        y_col,
        z_col,
        coord_type,
        image_cols,
        vector_groups,
        scalar_cols,
    })
}

/// Cartesian shift encoded by periodic image flags for a given frame cell:
/// `r_abs = r_wrapped + ix·a + iy·b + iz·c`. The rows of `box_matrix` are the
/// cell vectors, so this is triclinic-correct.
#[inline]
fn image_shift(img: [f32; 3], bm: &[f32; 9]) -> [f32; 3] {
    [
        img[0] * bm[0] + img[1] * bm[3] + img[2] * bm[6],
        img[0] * bm[1] + img[1] * bm[4] + img[2] * bm[7],
        img[0] * bm[2] + img[1] * bm[5] + img[2] * bm[8],
    ]
}

/// Decode a frame's `ITEM: BOX BOUNDS` rows into the cell (rows = cell
/// vectors a, b, c) and its true lower corner `(xlo, ylo, zlo)`.
///
/// An orthogonal box is written as `lo hi` per axis. A restricted-triclinic
/// box is written as `lo_bound hi_bound tilt` (tilts `xy`, `xz`, `yz` in row
/// order), where LAMMPS widens the x and y extents to the bounding box of the
/// tilted cell:
///
/// ```text
/// xlo_bound = xlo + MIN(0, xy, xz, xy + xz)    xhi_bound = xhi + MAX(0, xy, xz, xy + xz)
/// ylo_bound = ylo + MIN(0, yz)                 yhi_bound = yhi + MAX(0, yz)
/// ```
///
/// Inverting that is the lossless read of the cell the file asserts, giving
/// `a = (lx, 0, 0)`, `b = (xy, ly, 0)`, `c = (xz, yz, lz)`.
fn cell_from_bounds(lo: [f64; 3], hi: [f64; 3], tilt: Option<[f64; 3]>) -> ([f32; 9], [f32; 3]) {
    let [xy, xz, yz] = tilt.unwrap_or([0.0; 3]);
    let xlo = lo[0] - 0.0f64.min(xy).min(xz).min(xy + xz);
    let xhi = hi[0] - 0.0f64.max(xy).max(xz).max(xy + xz);
    let ylo = lo[1] - 0.0f64.min(yz);
    let yhi = hi[1] - 0.0f64.max(yz);
    let (zlo, zhi) = (lo[2], hi[2]);
    let matrix = [
        (xhi - xlo) as f32,
        0.0,
        0.0,
        xy as f32,
        (yhi - ylo) as f32,
        0.0,
        xz as f32,
        yz as f32,
        (zhi - zlo) as f32,
    ];
    (matrix, [xlo as f32, ylo as f32, zlo as f32])
}

/// Scaled (fractional) dump coordinates to Cartesian, triclinic-correct:
/// `r = origin + xs·a + ys·b + zs·c`, i.e. LAMMPS'
/// `x = xlo + xs·lx + ys·xy + zs·xz`, `y = ylo + ys·ly + zs·yz`,
/// `z = zlo + zs·lz`.
#[inline]
fn scaled_to_cartesian(s: [f32; 3], bm: &[f32; 9], origin: &[f32; 3]) -> [f32; 3] {
    let r = image_shift(s, bm);
    [r[0] + origin[0], r[1] + origin[1], r[2] + origin[2]]
}

/// Parsed header of one LAMMPS dump frame (everything up to the first atom line).
struct FrameHeader {
    n_atoms: usize,
    timestep: f64,
    box_matrix: [f32; 9],
    /// True lower corner `(xlo, ylo, zlo)` of the cell — the origin the cell
    /// vectors start from (for a triclinic box, not the `*_bound` values).
    origin: [f32; 3],
    layout: ColumnLayout,
    /// Line index of the first atom line (line after "ITEM: ATOMS ...").
    atoms_start: usize,
}

/// Read one frame's header block starting at `lines[i]` which must be
/// "ITEM: TIMESTEP". Returns the parsed header and the atom-block start index.
/// Shared by the eager parser, the index scan, and the single-frame decoder so
/// their header handling is byte-identical.
fn read_frame_header(lines: &[&str], i: usize) -> Result<FrameHeader, String> {
    let n_lines = lines.len();
    // lines[i] == "ITEM: TIMESTEP"
    let mut i = i + 1;
    if i >= n_lines {
        return Err("Unexpected end of file after TIMESTEP".to_string());
    }
    let timestep: f64 = lines[i]
        .trim()
        .parse()
        .map_err(|_| format!("Cannot parse timestep at line {}", i + 1))?;

    i += 1;
    if i >= n_lines || lines[i].trim() != "ITEM: NUMBER OF ATOMS" {
        return Err(format!("Expected ITEM: NUMBER OF ATOMS at line {}", i + 1));
    }
    i += 1;
    if i >= n_lines {
        return Err("Unexpected end of file after NUMBER OF ATOMS".to_string());
    }
    let n_atoms: usize = lines[i]
        .trim()
        .parse()
        .map_err(|_| format!("Cannot parse number of atoms at line {}", i + 1))?;

    i += 1;
    if i >= n_lines {
        return Err("Unexpected end of file before BOX BOUNDS".to_string());
    }
    let box_header = lines[i].trim();
    if !box_header.starts_with("ITEM: BOX BOUNDS") {
        return Err(format!("Expected ITEM: BOX BOUNDS at line {}", i + 1));
    }
    let is_triclinic = box_header.contains("xy xz yz");

    let mut lo = [0.0f64; 3];
    let mut hi = [0.0f64; 3];
    let mut tilt = [0.0f64; 3];
    for dim in 0..3 {
        i += 1;
        if i >= n_lines {
            return Err("Unexpected end of file in BOX BOUNDS".to_string());
        }
        let parts: Vec<f64> = lines[i]
            .split_whitespace()
            .filter_map(|s| s.parse().ok())
            .collect();
        if is_triclinic {
            if parts.len() < 3 {
                return Err(format!(
                    "Expected 3 values for triclinic box at line {}",
                    i + 1
                ));
            }
            lo[dim] = parts[0];
            hi[dim] = parts[1];
            tilt[dim] = parts[2];
        } else {
            if parts.len() < 2 {
                return Err(format!(
                    "Expected 2 values for box bounds at line {}",
                    i + 1
                ));
            }
            lo[dim] = parts[0];
            hi[dim] = parts[1];
        }
    }

    let (box_matrix, origin) = cell_from_bounds(lo, hi, is_triclinic.then_some(tilt));

    i += 1;
    if i >= n_lines {
        return Err("Unexpected end of file before ATOMS header".to_string());
    }
    let layout = parse_column_layout(lines[i])?;

    Ok(FrameHeader {
        n_atoms,
        timestep,
        box_matrix,
        origin,
        layout,
        atoms_start: i + 1,
    })
}

/// One decoded atom block: flat positions, per-atom type ids (empty when the
/// dump has no `type` column or the caller does not need them), per-group
/// vectors (in `header.layout.vector_groups` order), per-column scalars (in
/// `header.layout.scalar_cols` order; a column that failed to parse for any
/// atom yields an empty entry), and the index of the line after it.
type AtomBlock = (Vec<f32>, Vec<u8>, Vec<Vec<f32>>, Vec<Vec<f32>>, usize);

/// Read one frame's atom block into flat positions, per-group vectors (in
/// `header.layout.vector_groups` order), and per-column scalars. Returns
/// `(positions, types, group_vectors, scalars, next_line_index)`. Shared by
/// the eager parser and the single-frame decoder.
///
/// `expected_n_atoms` is a hint for capacity only; the frame's own
/// `header.n_atoms` governs how many lines are read, so a dump whose atom count
/// changes between frames (GCMC / deposition) is parsed instead of rejected.
/// `want_types` captures the `type` column into the returned type vector (used
/// only for heterogeneous dumps); `want_scalars` captures the extra numeric
/// columns (used by the structure lane).
fn read_atom_block(
    lines: &[&str],
    header: &FrameHeader,
    expected_n_atoms: usize,
    want_types: bool,
    want_scalars: bool,
) -> Result<AtomBlock, String> {
    let layout = &header.layout;
    let n_atoms = header.n_atoms;
    let _ = expected_n_atoms; // capacity hint only; frames may differ in count.
    let n_lines = lines.len();
    let capture_types = want_types && layout.type_col.is_some();
    let capture_scalars = want_scalars && !layout.scalar_cols.is_empty();
    // Image flags only apply to wrapped/scaled coordinates; xu/yu/zu is
    // already absolute.
    let image_cols = match layout.coord_type {
        CoordType::Unwrapped => None,
        _ => layout.image_cols,
    };
    let mut max_col = [layout.id_col, layout.x_col, layout.y_col, layout.z_col]
        .iter()
        .copied()
        .max()
        .unwrap();
    if capture_types {
        max_col = max_col.max(layout.type_col.unwrap());
    }
    if let Some(ic) = &image_cols {
        max_col = max_col.max(ic[0]).max(ic[1]).max(ic[2]);
    }

    // `NUMBER OF ATOMS` is a header claim: reserve no more atoms than the
    // lines left can hold (one atom per line), so a huge count fails on the
    // missing lines below instead of on the allocation.
    let cap = n_atoms.min(n_lines.saturating_sub(header.atoms_start));
    // (id, x, y, z, type) — type is 0 when not captured.
    let mut atoms: Vec<(usize, f32, f32, f32, u8)> = Vec::with_capacity(cap);
    let mut atoms_sorted = true;
    let mut prev_id: usize = 0;
    let mut frame_vec_atoms: Vec<Vec<(usize, f32, f32, f32)>> = layout
        .vector_groups
        .iter()
        .map(|_| Vec::with_capacity(cap))
        .collect();
    // Per-column unsorted scalar buffer (empty when scalars aren't wanted).
    let mut frame_scalar_atoms: Vec<Vec<(usize, f32)>> = if capture_scalars {
        layout
            .scalar_cols
            .iter()
            .map(|_| Vec::with_capacity(cap))
            .collect()
    } else {
        Vec::new()
    };

    let mut parts: Vec<&str> = Vec::new();
    let mut i = header.atoms_start;
    for _ in 0..n_atoms {
        if i >= n_lines {
            return Err("Unexpected end of file in atom data".to_string());
        }
        parts.clear();
        parts.extend(lines[i].split_whitespace());
        if parts.len() <= max_col {
            return Err(format!(
                "Not enough columns at line {} (expected at least {}, got {})",
                i + 1,
                max_col + 1,
                parts.len()
            ));
        }

        let id: usize = parts[layout.id_col]
            .parse()
            .map_err(|_| format!("Cannot parse atom id at line {}", i + 1))?;
        let mut x: f32 = parts[layout.x_col]
            .parse()
            .map_err(|_| format!("Cannot parse x at line {}", i + 1))?;
        let mut y: f32 = parts[layout.y_col]
            .parse()
            .map_err(|_| format!("Cannot parse y at line {}", i + 1))?;
        let mut z: f32 = parts[layout.z_col]
            .parse()
            .map_err(|_| format!("Cannot parse z at line {}", i + 1))?;

        if let CoordType::Scaled = layout.coord_type {
            [x, y, z] = scaled_to_cartesian([x, y, z], &header.box_matrix, &header.origin);
        }

        // Decode the absolute position the file encodes as wrapped coordinate
        // + image flags, using this frame's cell.
        if let Some(ic) = &image_cols {
            let img_x: f32 = parts[ic[0]]
                .parse()
                .map_err(|_| format!("Cannot parse image flag at line {}", i + 1))?;
            let img_y: f32 = parts[ic[1]]
                .parse()
                .map_err(|_| format!("Cannot parse image flag at line {}", i + 1))?;
            let img_z: f32 = parts[ic[2]]
                .parse()
                .map_err(|_| format!("Cannot parse image flag at line {}", i + 1))?;
            let shift = image_shift([img_x, img_y, img_z], &header.box_matrix);
            x += shift[0];
            y += shift[1];
            z += shift[2];
        }

        // LAMMPS type ids are small positive integers; clamp to the u8 element
        // proxy (systems with >255 types are unheard of for visualization).
        let type_id: u8 = if capture_types {
            parts[layout.type_col.unwrap()]
                .parse::<u32>()
                .map(|t| t.min(255) as u8)
                .unwrap_or(0)
        } else {
            0
        };

        if id < prev_id {
            atoms_sorted = false;
        }
        prev_id = id;
        atoms.push((id, x, y, z, type_id));

        for (gi, group) in layout.vector_groups.iter().enumerate() {
            let max_vcol = group.x_col.max(group.y_col).max(group.z_col);
            if parts.len() > max_vcol {
                let vx: f32 = match parts[group.x_col].parse() {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let vy: f32 = match parts[group.y_col].parse() {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let vz: f32 = match parts[group.z_col].parse() {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                frame_vec_atoms[gi].push((id, vx, vy, vz));
            }
        }

        if capture_scalars {
            for (si, sc) in layout.scalar_cols.iter().enumerate() {
                if parts.len() > sc.col {
                    if let Ok(v) = parts[sc.col].parse::<f32>() {
                        frame_scalar_atoms[si].push((id, v));
                    }
                }
            }
        }
        i += 1;
    }

    if !atoms_sorted {
        atoms.sort_by_key(|a| a.0);
    }

    let mut positions = Vec::with_capacity(n_atoms * 3);
    let mut types = if capture_types {
        Vec::with_capacity(n_atoms)
    } else {
        Vec::new()
    };
    for (_, x, y, z, t) in &atoms {
        positions.push(*x);
        positions.push(*y);
        positions.push(*z);
        if capture_types {
            types.push(*t);
        }
    }

    let mut group_vectors: Vec<Vec<f32>> = Vec::with_capacity(layout.vector_groups.len());
    for mut vatoms in frame_vec_atoms.into_iter() {
        if vatoms.len() == n_atoms {
            if !atoms_sorted {
                vatoms.sort_by_key(|a| a.0);
            }
            let mut flat = Vec::with_capacity(n_atoms * 3);
            for (_, vx, vy, vz) in &vatoms {
                flat.push(*vx);
                flat.push(*vy);
                flat.push(*vz);
            }
            group_vectors.push(flat);
        } else {
            group_vectors.push(Vec::new());
        }
    }

    // Only a column that parsed for every atom becomes a full value list;
    // otherwise an empty entry so the caller can skip (and warn about) it.
    let mut scalars: Vec<Vec<f32>> = Vec::with_capacity(frame_scalar_atoms.len());
    for mut satoms in frame_scalar_atoms.into_iter() {
        if satoms.len() == n_atoms {
            if !atoms_sorted {
                satoms.sort_by_key(|a| a.0);
            }
            scalars.push(satoms.into_iter().map(|(_, v)| v).collect());
        } else {
            scalars.push(Vec::new());
        }
    }

    Ok((positions, types, group_vectors, scalars, i))
}

/// Lightweight index over a LAMMPS dump: per-frame byte offsets + channel names,
/// built without parsing any coordinates. Backs lazy/streaming decode.
pub struct LammpstrjIndex {
    pub n_atoms: usize,
    pub n_frames: usize,
    pub timestep_ps: f32,
    pub box_matrix: Option<[f32; 9]>,
    /// World-space lower corner (frame-0 xlo,ylo,zlo) of the box. `None` ⇒
    /// origin at `(0,0,0)`. Keeps offset dumps rendering inside their cell.
    pub box_origin: Option<[f32; 3]>,
    /// Byte offset of each frame's "ITEM: TIMESTEP" line.
    pub offsets: Vec<usize>,
    /// Vector channel names (velocity/force) from the first frame's layout.
    pub vector_channel_names: Vec<String>,
    /// Every frame's box, when it is not the same in all of them (an NPT run);
    /// `None` for a constant cell, as `parse_lammpstrj` builds no per-frame
    /// cell table then. Read from the `BOX BOUNDS` headers the scan already
    /// parses, so a lazy host can give each frame its own cell.
    pub frame_cells: Option<Vec<[f32; 9]>>,
    /// True when some frame's atom count differs from frame 0. The lazy
    /// positions-only decoder can't represent a jagged trajectory, so the host
    /// reparses the whole dump eagerly (building the `TrajHetero` side table).
    /// Detected cheaply from the `NUMBER OF ATOMS` header, no coordinate decode.
    pub heterogeneous: bool,
}

/// One decoded LAMMPS frame: positions plus each vector channel's flat data
/// (parallel to the index's `vector_channel_names`).
pub struct DecodedLammpstrjFrame {
    pub positions: Vec<f32>,
    pub vectors: Vec<Vec<f32>>,
}

/// Scan a LAMMPS dump and record each frame's byte offset without decoding
/// coordinates (reads headers, skips atom lines). O(lines) per frame.
pub fn build_index(text: &str) -> Result<LammpstrjIndex, String> {
    let mut builder = LammpstrjIndexBuilder::default();
    crate::lines::for_each_line(text, |line, start, _end| builder.push_line(line, start))?;
    builder.finish()
}

/// Lines in a frame header: TIMESTEP + value, NUMBER OF ATOMS + count,
/// BOX BOUNDS + 3 rows, and the ATOMS column header.
const FRAME_HEADER_LINES: usize = 9;

/// Where the LAMMPS index scan is.
#[derive(Default)]
enum LammpstrjScan {
    /// Between frames, looking for `ITEM: TIMESTEP`.
    #[default]
    Seek,
    /// Collecting the header of a frame starting at `start`.
    Header { start: u64, lines: Vec<String> },
    /// Skipping `remaining` atom lines.
    Atoms { remaining: usize },
}

/// The [`build_index`] scan, fed one line at a time (see `crate::lines`), so a
/// dump can be indexed window by window without being held whole.
#[derive(Default)]
pub struct LammpstrjIndexBuilder {
    scan: LammpstrjScan,
    offsets: Vec<u64>,
    timesteps: Vec<f64>,
    n_atoms: usize,
    box_matrix: Option<[f32; 9]>,
    box_origin: Option<[f32; 3]>,
    vector_channel_names: Vec<String>,
    /// Recorded from the first frame whose box differs from frame 0's.
    cells: Vec<[f32; 9]>,
    varies_cell: bool,
    heterogeneous: bool,
}

impl LammpstrjIndexBuilder {
    /// Take the next line (without its line break), starting at byte `start`.
    pub fn push_line(&mut self, line: &str, start: u64) -> Result<(), String> {
        match std::mem::take(&mut self.scan) {
            LammpstrjScan::Seek => {
                if line.trim() == "ITEM: TIMESTEP" {
                    self.scan = LammpstrjScan::Header {
                        start,
                        lines: vec![line.to_string()],
                    };
                }
            }
            LammpstrjScan::Header { start, mut lines } => {
                lines.push(line.to_string());
                if lines.len() < FRAME_HEADER_LINES {
                    self.scan = LammpstrjScan::Header { start, lines };
                } else {
                    self.add_frame(start, &lines)?;
                }
            }
            LammpstrjScan::Atoms { remaining } => {
                if remaining > 1 {
                    self.scan = LammpstrjScan::Atoms {
                        remaining: remaining - 1,
                    };
                }
            }
        }
        Ok(())
    }

    fn add_frame(&mut self, start: u64, lines: &[String]) -> Result<(), String> {
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let header = read_frame_header(&refs, 0)?;
        if self.offsets.is_empty() {
            self.n_atoms = header.n_atoms;
            self.box_matrix = Some(header.box_matrix);
            self.box_origin = Some(header.origin);
            self.vector_channel_names = header
                .layout
                .vector_groups
                .iter()
                .map(|g| g.name.to_string())
                .collect();
        } else if header.n_atoms != self.n_atoms {
            // A jagged dump is admitted here (not rejected); the host falls back
            // to an eager parse because the positions-only lazy decoder can't
            // stream frames whose atom count differs from frame 0.
            self.heterogeneous = true;
        }
        // The per-frame cell table `parse_lammpstrj` builds, the same way:
        // backfill frame 0's box the first time a frame's box differs.
        if !self.varies_cell && self.box_matrix != Some(header.box_matrix) {
            self.varies_cell = true;
            self.cells.extend(std::iter::repeat_n(
                self.box_matrix.unwrap_or(header.box_matrix),
                self.offsets.len(),
            ));
        }
        if self.varies_cell {
            self.cells.push(header.box_matrix);
        }
        self.offsets.push(start);
        // Only the first two time stamps set the time step.
        if self.timesteps.len() < 2 {
            self.timesteps.push(header.timestep);
        }
        // Skip the atom lines without parsing.
        if header.n_atoms > 0 {
            self.scan = LammpstrjScan::Atoms {
                remaining: header.n_atoms,
            };
        }
        Ok(())
    }

    /// The index of everything pushed so far.
    pub fn finish(self) -> Result<LammpstrjIndex, String> {
        if let LammpstrjScan::Header { lines, .. } = &self.scan {
            // A header cut off by the end of the file fails exactly as the
            // whole-text reader does.
            let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
            read_frame_header(&refs, 0)?;
        }
        if self.offsets.is_empty() {
            return Err("No frames found in file".to_string());
        }
        let timestep_ps = if self.timesteps.len() >= 2 {
            (self.timesteps[1] - self.timesteps[0]).abs() as f32
        } else {
            0.0
        };
        Ok(LammpstrjIndex {
            n_atoms: self.n_atoms,
            n_frames: self.offsets.len(),
            timestep_ps,
            box_matrix: self.box_matrix,
            box_origin: self.box_origin,
            offsets: self.offsets.iter().map(|&o| o as usize).collect(),
            vector_channel_names: self.vector_channel_names,
            frame_cells: self.varies_cell.then_some(self.cells),
            heterogeneous: self.heterogeneous,
        })
    }

    /// Byte offset of each frame's `ITEM: TIMESTEP` line, as file offsets.
    pub fn file_offsets(&self) -> &[u64] {
        &self.offsets
    }
}

/// Decode a single LAMMPS frame's positions (and vector channels) given the
/// byte offset of its "ITEM: TIMESTEP" line (from `build_index`).
pub fn decode_frame_at(
    text: &str,
    byte_offset: usize,
    expected_n_atoms: usize,
) -> Result<DecodedLammpstrjFrame, String> {
    if byte_offset > text.len() {
        return Err("frame offset past end of data".to_string());
    }
    let slice = &text[byte_offset..];
    // Only this frame is needed, so stop after its header + atom lines instead of
    // collecting every line to EOF (which made streaming all frames O(n_frames²)).
    // A LAMMPS dump header is a fixed ~9 lines (TIMESTEP, NUMBER OF ATOMS, BOX
    // BOUNDS + 3 rows, ATOMS); 16 is a generous upper bound covering triclinic.
    const HEADER_MARGIN: usize = 16;
    let lines: Vec<&str> = slice
        .lines()
        .take(expected_n_atoms.saturating_add(HEADER_MARGIN))
        .collect();
    if lines.is_empty() || lines[0].trim() != "ITEM: TIMESTEP" {
        return Err("frame offset is not at an ITEM: TIMESTEP boundary".to_string());
    }
    let header = read_frame_header(&lines, 0)?;
    let (positions, _types, vectors, _scalars, _next) =
        read_atom_block(&lines, &header, expected_n_atoms, false, false)?;
    Ok(DecodedLammpstrjFrame { positions, vectors })
}

/// Parse a LAMMPS dump trajectory text.
pub fn parse_lammpstrj(text: &str) -> Result<LammpstrjData, String> {
    let lines: Vec<&str> = text.lines().collect();
    let n_lines = lines.len();
    if n_lines == 0 {
        return Err("Empty file".to_string());
    }

    // Frame-major flat coordinates (frame count unknown up front → amortized growth).
    let mut frame_positions_flat: Vec<f32> = Vec::new();
    let mut n_frames: usize = 0;
    let mut timesteps: Vec<f64> = Vec::new();
    let mut n_atoms: usize = 0; // frame-0 atom count (the base topology)
    let mut box_matrix: Option<[f32; 9]> = None; // frame-0 box (representative)
    let mut box_origin: Option<[f32; 3]> = None; // frame-0 box origin (lower corner)
    let mut i = 0;
    // Heterogeneous-frame tracking (variable atom count / cell / type). Nothing
    // is recorded until a channel is seen to vary, so a uniform dump keeps the
    // fixed-stride fast path and allocates no side table.
    let mut atom_offsets: Vec<u32> = vec![0];
    let mut per_frame_boxes: Vec<[f32; 9]> = Vec::new();
    let mut per_frame_types: Vec<Vec<u8>> = Vec::new();
    let mut varies_atoms = false;
    let mut varies_cell = false;
    let mut varies_topology = false;
    let mut recording_types = false;
    let mut recording_cell = false;
    let mut max_atoms = 0usize;
    let mut frame0_types: Vec<u8> = Vec::new();
    // Reused across every atom line so each line's split does not allocate a Vec.
    let mut parts: Vec<&str> = Vec::new();
    // Accumulated vector frames keyed by channel name from the first frame's layout.
    // Outer Vec = one entry per named group; inner Vec<VectorFrame> = one entry per frame.
    let mut vec_group_names: Vec<&'static str> = Vec::new();
    let mut vec_group_frames: Vec<Vec<VectorFrame>> = Vec::new();

    while i < n_lines {
        let line = lines[i].trim();

        if line != "ITEM: TIMESTEP" {
            i += 1;
            continue;
        }

        // Read timestep value
        i += 1;
        if i >= n_lines {
            break;
        }
        let ts: f64 = lines[i]
            .trim()
            .parse()
            .map_err(|_| format!("Cannot parse timestep at line {}", i + 1))?;
        timesteps.push(ts);

        // ITEM: NUMBER OF ATOMS
        i += 1;
        if i >= n_lines || lines[i].trim() != "ITEM: NUMBER OF ATOMS" {
            return Err(format!("Expected ITEM: NUMBER OF ATOMS at line {}", i + 1));
        }
        i += 1;
        if i >= n_lines {
            return Err("Unexpected end of file after NUMBER OF ATOMS".to_string());
        }
        let frame_n_atoms: usize = lines[i]
            .trim()
            .parse()
            .map_err(|_| format!("Cannot parse number of atoms at line {}", i + 1))?;

        if n_frames == 0 {
            n_atoms = frame_n_atoms;
            max_atoms = frame_n_atoms;
        } else {
            max_atoms = max_atoms.max(frame_n_atoms);
            if frame_n_atoms != n_atoms {
                varies_atoms = true;
            }
        }

        // ITEM: BOX BOUNDS
        i += 1;
        if i >= n_lines {
            return Err("Unexpected end of file before BOX BOUNDS".to_string());
        }
        let box_header = lines[i].trim();
        if !box_header.starts_with("ITEM: BOX BOUNDS") {
            return Err(format!("Expected ITEM: BOX BOUNDS at line {}", i + 1));
        }
        let is_triclinic = box_header.contains("xy xz yz");

        // Read 3 lines of box bounds
        let mut lo = [0.0f64; 3];
        let mut hi = [0.0f64; 3];
        let mut tilt = [0.0f64; 3]; // xy, xz, yz
        for dim in 0..3 {
            i += 1;
            if i >= n_lines {
                return Err("Unexpected end of file in BOX BOUNDS".to_string());
            }
            let parts: Vec<f64> = lines[i]
                .split_whitespace()
                .filter_map(|s| s.parse().ok())
                .collect();
            if is_triclinic {
                if parts.len() < 3 {
                    return Err(format!(
                        "Expected 3 values for triclinic box at line {}",
                        i + 1
                    ));
                }
                lo[dim] = parts[0];
                hi[dim] = parts[1];
                tilt[dim] = parts[2];
            } else {
                if parts.len() < 2 {
                    return Err(format!(
                        "Expected 2 values for box bounds at line {}",
                        i + 1
                    ));
                }
                lo[dim] = parts[0];
                hi[dim] = parts[1];
            }
        }

        // Build this frame's box matrix. Frame 0 becomes the representative
        // `box_matrix`; a per-frame side table is recorded only when it varies.
        let (frame_box, frame_origin) = cell_from_bounds(lo, hi, is_triclinic.then_some(tilt));
        if box_matrix.is_none() {
            box_matrix = Some(frame_box);
            box_origin = Some(frame_origin);
        }
        // Detect a per-frame cell change; backfill earlier frames with frame 0's
        // box the first time it diverges.
        if !varies_cell && Some(frame_box) != box_matrix {
            varies_cell = true;
        }
        if varies_cell && !recording_cell {
            per_frame_boxes.extend(std::iter::repeat_n(box_matrix.unwrap(), n_frames));
            recording_cell = true;
        }
        if recording_cell {
            per_frame_boxes.push(frame_box);
        }

        // ITEM: ATOMS header
        i += 1;
        if i >= n_lines {
            return Err("Unexpected end of file before ATOMS header".to_string());
        }
        let layout = parse_column_layout(lines[i])?;

        // On the first frame, initialise vector group tracking from the layout.
        if n_frames == 0 {
            vec_group_names = layout.vector_groups.iter().map(|g| g.name).collect();
            vec_group_frames = layout.vector_groups.iter().map(|_| Vec::new()).collect();
        }

        // Whether to capture the per-atom `type` column this frame: frame 0
        // (always, to seed the backfill) or any frame once the atom count has
        // diverged (GCMC/deposition) — its new atoms need per-frame elements.
        let capture_types =
            layout.type_col.is_some() && (n_frames == 0 || varies_atoms || varies_topology);

        // Image flags only apply to wrapped/scaled coordinates; xu/yu/zu is
        // already absolute.
        let image_cols = match layout.coord_type {
            CoordType::Unwrapped => None,
            _ => layout.image_cols,
        };

        // Minimum column count for the mandatory id/x/y/z fields — constant for the
        // whole frame, so compute it once instead of per atom line.
        let mut max_col = [layout.id_col, layout.x_col, layout.y_col, layout.z_col]
            .iter()
            .copied()
            .max()
            .unwrap();
        if capture_types {
            max_col = max_col.max(layout.type_col.unwrap());
        }
        if let Some(ic) = &image_cols {
            max_col = max_col.max(ic[0]).max(ic[1]).max(ic[2]);
        }

        // Resolve each layout vector group to its accumulation slot once per frame
        // (was a linear name scan per atom per group).
        let group_slots: Vec<Option<usize>> = layout
            .vector_groups
            .iter()
            .map(|g| vec_group_names.iter().position(|&n| n == g.name))
            .collect();

        // Read atom lines — accumulate both positions and per-group vector data.
        // The header's count is reserved only as far as the lines left can
        // hold it (one atom per line); a larger count fails on the missing lines.
        let cap = frame_n_atoms.min(n_lines.saturating_sub(i + 1));
        // (id, x, y, z, type) — type is 0 when not captured this frame.
        let mut atoms: Vec<(usize, f32, f32, f32, u8)> = Vec::with_capacity(cap);
        // Track whether atom ids arrive already ascending so we can skip the sort.
        let mut atoms_sorted = true;
        let mut prev_id: usize = 0;
        // Per-group unsorted vector buffer for this frame.
        let mut frame_vec_atoms: Vec<Vec<(usize, f32, f32, f32)>> = layout
            .vector_groups
            .iter()
            .map(|_| Vec::with_capacity(cap))
            .collect();

        for _ in 0..frame_n_atoms {
            i += 1;
            if i >= n_lines {
                return Err("Unexpected end of file in atom data".to_string());
            }
            parts.clear();
            parts.extend(lines[i].split_whitespace());
            if parts.len() <= max_col {
                return Err(format!(
                    "Not enough columns at line {} (expected at least {}, got {})",
                    i + 1,
                    max_col + 1,
                    parts.len()
                ));
            }

            let id: usize = parts[layout.id_col]
                .parse()
                .map_err(|_| format!("Cannot parse atom id at line {}", i + 1))?;
            let mut x: f32 = parts[layout.x_col]
                .parse()
                .map_err(|_| format!("Cannot parse x at line {}", i + 1))?;
            let mut y: f32 = parts[layout.y_col]
                .parse()
                .map_err(|_| format!("Cannot parse y at line {}", i + 1))?;
            let mut z: f32 = parts[layout.z_col]
                .parse()
                .map_err(|_| format!("Cannot parse z at line {}", i + 1))?;

            // Convert scaled coordinates to Cartesian
            if let CoordType::Scaled = layout.coord_type {
                [x, y, z] = scaled_to_cartesian([x, y, z], &frame_box, &frame_origin);
            }

            // Decode the absolute position the file encodes as wrapped
            // coordinate + image flags, using this frame's cell.
            if let Some(ic) = &image_cols {
                let img_x: f32 = parts[ic[0]]
                    .parse()
                    .map_err(|_| format!("Cannot parse image flag at line {}", i + 1))?;
                let img_y: f32 = parts[ic[1]]
                    .parse()
                    .map_err(|_| format!("Cannot parse image flag at line {}", i + 1))?;
                let img_z: f32 = parts[ic[2]]
                    .parse()
                    .map_err(|_| format!("Cannot parse image flag at line {}", i + 1))?;
                let shift = image_shift([img_x, img_y, img_z], &frame_box);
                x += shift[0];
                y += shift[1];
                z += shift[2];
            }

            let type_id: u8 = if capture_types {
                parts[layout.type_col.unwrap()]
                    .parse::<u32>()
                    .map(|t| t.min(255) as u8)
                    .unwrap_or(0)
            } else {
                0
            };

            if id < prev_id {
                atoms_sorted = false;
            }
            prev_id = id;
            atoms.push((id, x, y, z, type_id));

            // Collect per-group vector values for this atom.
            // Groups are indexed by their slot in frame_vec_atoms, which mirrors
            // vec_group_names (initialised from the first frame). The slot was
            // resolved once per frame (group_slots) to guard against column
            // reordering in later frames without a per-atom name scan.
            for (gi, group) in layout.vector_groups.iter().enumerate() {
                if let Some(slot) = group_slots[gi] {
                    let max_vcol = group.x_col.max(group.y_col).max(group.z_col);
                    if parts.len() > max_vcol {
                        let vx: f32 = match parts[group.x_col].parse() {
                            Ok(v) => v,
                            Err(_) => continue,
                        };
                        let vy: f32 = match parts[group.y_col].parse() {
                            Ok(v) => v,
                            Err(_) => continue,
                        };
                        let vz: f32 = match parts[group.z_col].parse() {
                            Ok(v) => v,
                            Err(_) => continue,
                        };
                        frame_vec_atoms[slot].push((id, vx, vy, vz));
                    }
                }
            }
        }

        // Sort by atom id for consistent ordering (skip when already ascending).
        // Stable-sort over unique ids, so skipping when sorted is behavior-identical.
        if !atoms_sorted {
            atoms.sort_by_key(|a| a.0);
        }

        // Flatten to [x0, y0, z0, x1, y1, z1, ...] straight into the flat buffer.
        for (_, x, y, z, _) in &atoms {
            frame_positions_flat.push(*x);
            frame_positions_flat.push(*y);
            frame_positions_flat.push(*z);
        }
        let last_off = *atom_offsets.last().unwrap();
        atom_offsets.push(last_off + frame_n_atoms as u32);

        // Frame 0's types seed the backfill; capture them once.
        if n_frames == 0 && capture_types {
            frame0_types = atoms.iter().map(|a| a.4).collect();
        }
        // Record per-frame types once the topology (atom count) varies, backfilling
        // earlier frames with frame 0's types (same composition up to that point).
        if varies_atoms && !recording_types {
            per_frame_types.extend(std::iter::repeat_with(|| frame0_types.clone()).take(n_frames));
            recording_types = true;
            varies_topology = true;
        }
        if recording_types {
            if capture_types {
                per_frame_types.push(atoms.iter().map(|a| a.4).collect());
            } else {
                // Defensive: a later frame with no type column reuses frame 0's.
                per_frame_types.push(frame0_types.clone());
            }
        }

        let frame_idx = n_frames;
        n_frames += 1;

        // Build a sorted, flat vector array for each group and append as a VectorFrame.
        // Only emit a frame entry when all n_atoms parsed successfully. Vector atoms
        // are collected in the same id order as `atoms`, so they share its sortedness.
        for (slot, mut vatoms) in frame_vec_atoms.into_iter().enumerate() {
            if vatoms.len() == frame_n_atoms {
                if !atoms_sorted {
                    vatoms.sort_by_key(|a| a.0);
                }
                let mut flat = Vec::with_capacity(frame_n_atoms * 3);
                for (_, vx, vy, vz) in &vatoms {
                    flat.push(*vx);
                    flat.push(*vy);
                    flat.push(*vz);
                }
                vec_group_frames[slot].push(VectorFrame {
                    frame: frame_idx,
                    vectors: flat,
                });
            }
        }

        i += 1;
    }

    if n_frames == 0 {
        return Err("No frames found in file".to_string());
    }

    // Calculate timestep in ps from first two frames
    let timestep_ps = if timesteps.len() >= 2 {
        let dt = (timesteps[1] - timesteps[0]).abs();
        // LAMMPS timestep units vary by unit system; store raw value
        // User's structure file determines units. Just use the step difference.
        dt as f32
    } else {
        0.0
    };

    // Vector channels assume a fixed per-atom stride, so they are incompatible
    // with a variable atom count — drop them for heterogeneous-atom dumps.
    let vector_channels: Vec<VectorChannel> = if varies_atoms {
        Vec::new()
    } else {
        vec_group_names
            .into_iter()
            .zip(vec_group_frames)
            .filter(|(_, frames)| frames.len() == n_frames)
            .map(|(name, frames)| VectorChannel {
                name: name.to_string(),
                frames,
            })
            .collect()
    };

    // Assemble the side table only when a channel varies. Positions stay in a
    // single flat buffer; `atom_offsets` (all frames) makes them sliceable when
    // jagged. Element/type ids ride `elements_flat`; the cell rides `cells_flat`.
    let hetero = if varies_atoms || varies_cell || varies_topology {
        let elements_flat: Vec<u8> = if varies_atoms || varies_topology {
            per_frame_types.into_iter().flatten().collect()
        } else {
            Vec::new()
        };
        let cells_flat: Vec<f32> = if varies_cell {
            per_frame_boxes.iter().flatten().copied().collect()
        } else {
            Vec::new()
        };
        // When only the cell varies, positions are fixed-stride; drop the
        // all-frames atom_offsets so the host takes the cheaper stride path.
        let atom_offsets = if varies_atoms {
            atom_offsets
        } else {
            Vec::new()
        };
        Some(crate::trajectory::TrajHetero {
            atom_offsets,
            elements_flat,
            cells_flat,
            varies_atoms,
            varies_cell,
            varies_topology,
            max_atoms: max_atoms as u32,
        })
    } else {
        None
    };

    Ok(LammpstrjData {
        n_atoms,
        n_frames,
        timestep_ps,
        box_matrix,
        box_origin,
        frame_positions_flat,
        vector_channels,
        hetero,
    })
}

/// Parse a LAMMPS dump as a standalone multi-frame **structure** (structure
/// lane), mirroring `traj.rs`/`xyz.rs`: frame 0 becomes the topology
/// (`positions`/`elements`/`box_matrix`/`bonds`) and the remaining frames stream
/// into `frame_positions_flat`. Element identities are the integer LAMMPS `type`
/// ids used as an atomic-number proxy (a dump carries no symbols/masses); when a
/// dump has no `type` column, atoms fall back to element 0. Bonds are inferred
/// by distance from frame 0. Variable atom count / cell / type dumps populate a
/// [`HeteroFrames`] side table exactly as the other multi-frame structure
/// parsers do; a uniform dump keeps `hetero: None`. Extra numeric per-atom dump
/// columns (q, mol, computes, …) surface as frame-synced `scalar_channels`.
pub fn parse_lammpstrj_structure(text: &str) -> Result<ParsedStructure, String> {
    let lines: Vec<&str> = text.lines().collect();
    let n_lines = lines.len();
    if n_lines == 0 {
        return Err("Empty file".to_string());
    }

    // Frame-0 topology.
    let mut n_atoms = 0usize;
    let mut positions: Vec<f32> = Vec::new();
    let mut elements: Vec<u8> = Vec::new();
    let mut box_matrix: Option<[f32; 9]> = None;
    // Frame-0 world-space box lower corner (xlo, ylo, zlo) so an offset box
    // renders wrapped around the atoms rather than anchored at world origin.
    let mut box_origin: Option<[f32; 3]> = None;

    // Extra frames (frame 0 lives in the fields above) and their side tables,
    // recorded lazily once a channel is seen to vary, so a uniform dump
    // allocates nothing — the same builder as `traj.rs`/`xyz.rs`. Re-seeded
    // with frame 0's atom count once frame 0 is read.
    let mut frames = HeteroFramesBuilder::new(0);
    let mut frame_idx = 0usize;
    // Scalar channel accumulation, keyed by column name from the first frame's
    // layout (mirrors the trajectory lane's vector channel handling). Outer Vec
    // = one entry per column; inner Vec<ScalarFrame> = one entry per frame.
    let mut scalar_names: Vec<String> = Vec::new();
    let mut scalar_frames: Vec<Vec<ScalarFrame>> = Vec::new();

    let mut i = 0usize;
    while i < n_lines {
        if lines[i].trim() != "ITEM: TIMESTEP" {
            i += 1;
            continue;
        }
        let header = read_frame_header(&lines, i)?;
        let frame_atoms = header.n_atoms;
        let frame_box = header.box_matrix;
        // want_types=true so the `type` column (when present) becomes the
        // per-atom element proxy; want_scalars=true so extra numeric columns
        // become scalar channels. read_atom_block already applies scaled-coord
        // conversion, image-flag decoding, and id-sorting.
        let (frame_positions, frame_types, _vectors, frame_scalars, next) =
            read_atom_block(&lines, &header, frame_atoms, true, true)?;
        // A dump without a `type` column yields empty types → all element 0.
        let frame_elements: Vec<u8> = if frame_types.len() == frame_atoms {
            frame_types
        } else {
            vec![0u8; frame_atoms]
        };

        if frame_idx == 0 {
            n_atoms = frame_atoms;
            frames = HeteroFramesBuilder::new(frame_atoms);
            positions = frame_positions;
            elements = frame_elements;
            box_matrix = Some(frame_box);
            box_origin = Some(header.origin);
        } else {
            let change = FrameChange {
                topology: !frames.varies_topology() && frame_elements != elements,
                cell: !frames.varies_cell() && Some(frame_box) != box_matrix,
            };
            frames.push_frame(
                &frame_positions,
                move || frame_elements,
                Some(frame_box),
                change,
            );
        }

        // Frame 0's layout defines the scalar channel set; later frames map
        // their columns to it by name (guards against column reordering).
        if frame_idx == 0 {
            scalar_names = header
                .layout
                .scalar_cols
                .iter()
                .map(|sc| sc.name.clone())
                .collect();
            scalar_frames = scalar_names.iter().map(|_| Vec::new()).collect();
        }
        for (si, values) in frame_scalars.into_iter().enumerate() {
            if values.len() != frame_atoms {
                continue; // column failed to parse for some atom this frame
            }
            let name = &header.layout.scalar_cols[si].name;
            if let Some(slot) = scalar_names.iter().position(|n| n == name) {
                scalar_frames[slot].push(ScalarFrame {
                    frame: frame_idx,
                    values,
                });
            }
        }

        frame_idx += 1;
        i = next;
    }

    if frame_idx == 0 {
        return Err("No frames found in file".to_string());
    }
    // An atom-count change also makes the element list (and inferred bonds)
    // vary; `finish` folds that into `varies_topology`.
    let varies_atoms = frames.varies_atoms();

    // Infer frame-0 bonds by distance (a dump embeds no connectivity).
    let empty_bonds: HashSet<(u32, u32)> = HashSet::new();
    let bonds = bonds::infer_bonds(&positions, &elements, n_atoms, &empty_bonds);

    // Emit a scalar channel only when the atom count is fixed and the column
    // parsed in every frame — jagged per-frame values have no fixed-stride
    // representation, and a partially-present column would desync from
    // playback. Skipped columns are reported once, aggregated.
    let mut scalar_channels: Vec<ScalarChannel> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    if !scalar_names.is_empty() {
        if varies_atoms {
            warnings.push(format!(
                "Skipped per-atom dump columns (atom count varies between frames): {}",
                scalar_names.join(", ")
            ));
        } else {
            let mut skipped: Vec<String> = Vec::new();
            for (name, frames) in scalar_names.into_iter().zip(scalar_frames) {
                if frames.len() == frame_idx {
                    scalar_channels.push(ScalarChannel { name, frames });
                } else {
                    skipped.push(name);
                }
            }
            if !skipped.is_empty() {
                warnings.push(format!(
                    "Skipped per-atom dump columns (missing or non-numeric in some frames): {}",
                    skipped.join(", ")
                ));
            }
        }
    }

    // Assemble the side table only when a channel varies (uniform → None).
    let (frame_positions_flat, hetero) = frames.finish(&elements, box_matrix);

    Ok(ParsedStructure {
        n_atoms,
        positions,
        elements,
        bonds,
        n_file_bonds: 0,
        box_matrix,
        box_origin,
        frame_positions_flat,
        scalar_channels,
        warnings,
        hetero,
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_dump() -> &'static str {
        "ITEM: TIMESTEP\n\
         0\n\
         ITEM: NUMBER OF ATOMS\n\
         3\n\
         ITEM: BOX BOUNDS pp pp pp\n\
         0.0 10.0\n\
         0.0 10.0\n\
         0.0 10.0\n\
         ITEM: ATOMS id type x y z\n\
         1 1 1.0 2.0 3.0\n\
         3 2 7.0 8.0 9.0\n\
         2 2 4.0 5.0 6.0\n\
         ITEM: TIMESTEP\n\
         100\n\
         ITEM: NUMBER OF ATOMS\n\
         3\n\
         ITEM: BOX BOUNDS pp pp pp\n\
         0.0 10.0\n\
         0.0 10.0\n\
         0.0 10.0\n\
         ITEM: ATOMS id type x y z\n\
         2 2 4.1 5.1 6.1\n\
         1 1 1.1 2.1 3.1\n\
         3 2 7.1 8.1 9.1\n"
    }

    #[test]
    fn windowed_dump_index_matches_the_whole_text_index() {
        for name in ["water.lammpstrj", "hetero_atoms.lammpstrj"] {
            let text = std::fs::read_to_string(format!(
                "{}/../../tests/fixtures/{name}",
                env!("CARGO_MANIFEST_DIR")
            ))
            .unwrap();
            let whole = build_index(&text).unwrap();
            for window in [1, 31, 512, text.len()] {
                let mut b = LammpstrjIndexBuilder::default();
                crate::lines::feed_in_windows(&text, window, |l, s, _| b.push_line(l, s)).unwrap();
                let got = b.finish().unwrap();
                assert_eq!(got.offsets, whole.offsets, "{name} @ {window}");
                assert_eq!(got.n_atoms, whole.n_atoms);
                assert_eq!(got.timestep_ps, whole.timestep_ps);
                assert_eq!(got.box_matrix, whole.box_matrix);
                assert_eq!(got.box_origin, whole.box_origin);
                assert_eq!(got.vector_channel_names, whole.vector_channel_names);
                assert_eq!(got.heterogeneous, whole.heterogeneous);
            }
        }
    }

    /// `NUMBER OF ATOMS` is a header claim: a dump declaring 10^11 atoms with
    /// one atom line must fail on the missing lines, not reserve room for
    /// every declared atom (which aborted the process).
    #[test]
    fn a_declared_atom_count_past_the_file_is_an_error_not_an_allocation() {
        let text = "ITEM: TIMESTEP\n0\nITEM: NUMBER OF ATOMS\n100000000000\n\
                    ITEM: BOX BOUNDS pp pp pp\n0 1\n0 1\n0 1\n\
                    ITEM: ATOMS id type x y z\n1 1 0 0 0\n";
        let err = parse_lammpstrj(text).err().expect("eager parse rejects it");
        assert!(err.contains("Unexpected end of file"), "{err}");
        let err = parse_lammpstrj_structure(text)
            .err()
            .expect("structure lane rejects it");
        assert!(err.contains("Unexpected end of file"), "{err}");
        // The single-frame decoder takes the count from the index; a count at
        // the top of `usize` must not overflow its line budget.
        let offset = 0;
        assert!(decode_frame_at(text, offset, usize::MAX).is_err());
    }

    #[test]
    fn a_header_cut_off_at_the_end_fails_like_the_whole_text_scan() {
        let text = "ITEM: TIMESTEP\n0\nITEM: NUMBER OF ATOMS\n";
        let err = build_index(text).err().unwrap();
        assert!(err.contains("NUMBER OF ATOMS"), "{err}");
        assert!(build_index("nothing here\n").is_err());
    }

    #[test]
    fn test_parse_basic() {
        let data = parse_lammpstrj(sample_dump()).unwrap();
        assert_eq!(data.n_atoms, 3);
        assert_eq!(data.n_frames, 2);
        assert_eq!(data.timestep_ps, 100.0);
    }

    #[test]
    fn test_box_origin_zero_for_origin_box() {
        // sample_dump()'s box runs 0..10 in every dim → origin (0,0,0).
        let data = parse_lammpstrj(sample_dump()).unwrap();
        assert_eq!(data.box_origin, Some([0.0, 0.0, 0.0]));
        // The index (streaming path) must agree with the eager parse.
        let idx = build_index(sample_dump()).unwrap();
        assert_eq!(idx.box_origin, Some([0.0, 0.0, 0.0]));
    }

    #[test]
    fn test_box_origin_offset_box() {
        // An offset dump (box far from the world origin): the frame-0 lower
        // corner must be preserved so the cell renders around the atoms.
        let text = "ITEM: TIMESTEP\n0\n\
                    ITEM: NUMBER OF ATOMS\n2\n\
                    ITEM: BOX BOUNDS pp pp pp\n160.0 240.0\n0.0 150.0\n600.0 900.0\n\
                    ITEM: ATOMS id type x y z\n\
                    1 1 165.0 10.0 605.0\n\
                    2 2 200.0 75.0 750.0\n";
        let data = parse_lammpstrj(text).unwrap();
        assert_eq!(data.box_origin, Some([160.0, 0.0, 600.0]));
        // Edge lengths only in box_matrix.
        let bm = data.box_matrix.unwrap();
        assert!((bm[0] - 80.0).abs() < 1e-5);
        assert!((bm[8] - 300.0).abs() < 1e-5);
        // The streaming index carries the same origin.
        let idx = build_index(text).unwrap();
        assert_eq!(idx.box_origin, Some([160.0, 0.0, 600.0]));
    }

    #[test]
    fn test_atom_sorting() {
        let data = parse_lammpstrj(sample_dump()).unwrap();
        // Frame 0: atoms sorted by id (1, 2, 3)
        let f0 = data.frame(0);
        assert_eq!(f0[0], 1.0); // atom 1 x
        assert_eq!(f0[1], 2.0); // atom 1 y
        assert_eq!(f0[2], 3.0); // atom 1 z
        assert_eq!(f0[3], 4.0); // atom 2 x
        assert_eq!(f0[6], 7.0); // atom 3 x

        // Frame 1: also sorted by id
        let f1 = data.frame(1);
        assert_eq!(f1[0], 1.1); // atom 1 x
        assert_eq!(f1[3], 4.1); // atom 2 x
        assert_eq!(f1[6], 7.1); // atom 3 x
    }

    #[test]
    fn test_ascending_ids_skip_sort() {
        // Atom ids already ascending (1, 2, 3) — exercises the skip-sort branch.
        let text = "ITEM: TIMESTEP\n0\n\
                    ITEM: NUMBER OF ATOMS\n3\n\
                    ITEM: BOX BOUNDS pp pp pp\n0.0 10.0\n0.0 10.0\n0.0 10.0\n\
                    ITEM: ATOMS id type x y z\n\
                    1 1 1.0 2.0 3.0\n\
                    2 2 4.0 5.0 6.0\n\
                    3 2 7.0 8.0 9.0\n";
        let data = parse_lammpstrj(text).unwrap();
        assert_eq!(data.n_atoms, 3);
        assert_eq!(data.n_frames, 1);
        let f0 = data.frame(0);
        assert_eq!(f0[0], 1.0); // atom 1 x stays first
        assert_eq!(f0[3], 4.0); // atom 2 x
        assert_eq!(f0[6], 7.0); // atom 3 x
    }

    #[test]
    fn test_box_matrix() {
        let data = parse_lammpstrj(sample_dump()).unwrap();
        let bm = data.box_matrix.unwrap();
        assert_eq!(bm[0], 10.0); // lx
        assert_eq!(bm[4], 10.0); // ly
        assert_eq!(bm[8], 10.0); // lz
    }

    #[test]
    fn test_uniform_dump_keeps_fast_path() {
        // Constant atoms/box/type → uniform fast path, no side table.
        let data = parse_lammpstrj(sample_dump()).unwrap();
        assert!(data.hetero.is_none());
    }

    #[test]
    fn test_variable_atom_count_dump() {
        // Frame 0 has 2 atoms; frame 1 grows a third (GCMC insertion).
        let text = "ITEM: TIMESTEP\n0\n\
                    ITEM: NUMBER OF ATOMS\n2\n\
                    ITEM: BOX BOUNDS pp pp pp\n0.0 10.0\n0.0 10.0\n0.0 10.0\n\
                    ITEM: ATOMS id type x y z\n\
                    1 1 1.0 0.0 0.0\n\
                    2 1 2.0 0.0 0.0\n\
                    ITEM: TIMESTEP\n100\n\
                    ITEM: NUMBER OF ATOMS\n3\n\
                    ITEM: BOX BOUNDS pp pp pp\n0.0 10.0\n0.0 10.0\n0.0 10.0\n\
                    ITEM: ATOMS id type x y z\n\
                    1 1 1.1 0.0 0.0\n\
                    2 1 2.1 0.0 0.0\n\
                    3 2 3.0 0.0 0.0\n";
        let data = parse_lammpstrj(text).unwrap();
        assert_eq!(data.n_atoms, 2); // frame-0 base
        assert_eq!(data.n_frames, 2);
        let h = data.hetero.as_ref().expect("side table");
        assert!(h.varies_atoms);
        assert!(h.varies_topology);
        assert_eq!(h.max_atoms, 3);
        assert_eq!(data.frame_atom_count(0), 2);
        assert_eq!(data.frame_atom_count(1), 3);
        // Frame 1 positions are jagged (9 floats for 3 atoms).
        let f1 = data.frame(1);
        assert_eq!(f1.len(), 9);
        assert!((f1[6] - 3.0).abs() < 1e-5); // the inserted atom
                                             // Per-frame element/type ids: frame 1 carries type 2 for the new atom.
        let e1 = data.frame_elements(1).expect("per-frame types");
        assert_eq!(e1, &[1u8, 1u8, 2u8]);
    }

    #[test]
    fn test_variable_cell_dump() {
        // Constant atom count, per-frame box grows (NPT-style) → varies_cell only.
        let text = "ITEM: TIMESTEP\n0\n\
                    ITEM: NUMBER OF ATOMS\n1\n\
                    ITEM: BOX BOUNDS pp pp pp\n0.0 10.0\n0.0 10.0\n0.0 10.0\n\
                    ITEM: ATOMS id type x y z\n\
                    1 1 1.0 0.0 0.0\n\
                    ITEM: TIMESTEP\n100\n\
                    ITEM: NUMBER OF ATOMS\n1\n\
                    ITEM: BOX BOUNDS pp pp pp\n0.0 12.0\n0.0 12.0\n0.0 12.0\n\
                    ITEM: ATOMS id type x y z\n\
                    1 1 1.1 0.0 0.0\n";
        let data = parse_lammpstrj(text).unwrap();
        let h = data.hetero.as_ref().expect("side table");
        assert!(h.varies_cell);
        assert!(!h.varies_atoms);
        assert!(data.frame_elements(0).is_none()); // atom count constant
        assert!((data.box_matrix.unwrap()[0] - 10.0).abs() < 1e-5);
        assert!((data.frame_cell(0).unwrap()[0] - 10.0).abs() < 1e-5);
        assert!((data.frame_cell(1).unwrap()[0] - 12.0).abs() < 1e-5);
    }

    #[test]
    fn test_scaled_coords() {
        let text = "ITEM: TIMESTEP\n\
                    0\n\
                    ITEM: NUMBER OF ATOMS\n\
                    2\n\
                    ITEM: BOX BOUNDS pp pp pp\n\
                    0.0 10.0\n\
                    0.0 20.0\n\
                    0.0 30.0\n\
                    ITEM: ATOMS id type xs ys zs\n\
                    1 1 0.5 0.5 0.5\n\
                    2 1 0.0 0.0 0.0\n";
        let data = parse_lammpstrj(text).unwrap();
        let f0 = data.frame(0);
        // atom 1: 0.5*10+0 = 5.0, 0.5*20+0 = 10.0, 0.5*30+0 = 15.0
        assert!((f0[0] - 5.0).abs() < 1e-5);
        assert!((f0[1] - 10.0).abs() < 1e-5);
        assert!((f0[2] - 15.0).abs() < 1e-5);
        // atom 2: 0.0
        assert!((f0[3]).abs() < 1e-5);
    }

    #[test]
    fn test_triclinic_box() {
        let text = "ITEM: TIMESTEP\n\
                    0\n\
                    ITEM: NUMBER OF ATOMS\n\
                    1\n\
                    ITEM: BOX BOUNDS xy xz yz pp pp pp\n\
                    0.0 10.0 1.0\n\
                    0.0 10.0 0.5\n\
                    0.0 10.0 0.0\n\
                    ITEM: ATOMS id type x y z\n\
                    1 1 5.0 5.0 5.0\n";
        let data = parse_lammpstrj(text).unwrap();
        let bm = data.box_matrix.unwrap();
        // xy=1.0, xz=0.5, yz=0.0
        assert!((bm[3] - 1.0).abs() < 1e-5); // xy
        assert!((bm[6] - 0.5).abs() < 1e-5); // xz
    }

    #[test]
    fn test_empty_file() {
        let result = parse_lammpstrj("");
        assert!(result.is_err());
    }

    #[test]
    fn test_single_frame() {
        let text = "ITEM: TIMESTEP\n\
                    0\n\
                    ITEM: NUMBER OF ATOMS\n\
                    1\n\
                    ITEM: BOX BOUNDS pp pp pp\n\
                    0.0 10.0\n\
                    0.0 10.0\n\
                    0.0 10.0\n\
                    ITEM: ATOMS id type x y z\n\
                    1 1 5.0 5.0 5.0\n";
        let data = parse_lammpstrj(text).unwrap();
        assert_eq!(data.n_frames, 1);
        assert_eq!(data.timestep_ps, 0.0); // single frame → no dt
        assert!(data.vector_channels.is_empty());
    }

    #[test]
    fn test_vector_columns_velocity() {
        let text = "ITEM: TIMESTEP\n\
                    0\n\
                    ITEM: NUMBER OF ATOMS\n\
                    2\n\
                    ITEM: BOX BOUNDS pp pp pp\n\
                    0.0 10.0\n\
                    0.0 10.0\n\
                    0.0 10.0\n\
                    ITEM: ATOMS id type x y z vx vy vz\n\
                    1 1 1.0 2.0 3.0 0.1 0.2 0.3\n\
                    2 2 4.0 5.0 6.0 0.4 0.5 0.6\n\
                    ITEM: TIMESTEP\n\
                    100\n\
                    ITEM: NUMBER OF ATOMS\n\
                    2\n\
                    ITEM: BOX BOUNDS pp pp pp\n\
                    0.0 10.0\n\
                    0.0 10.0\n\
                    0.0 10.0\n\
                    ITEM: ATOMS id type x y z vx vy vz\n\
                    1 1 1.1 2.1 3.1 0.11 0.21 0.31\n\
                    2 2 4.1 5.1 6.1 0.41 0.51 0.61\n";
        let data = parse_lammpstrj(text).unwrap();
        assert_eq!(data.n_frames, 2);
        assert_eq!(data.vector_channels.len(), 1);
        let ch = &data.vector_channels[0];
        assert_eq!(ch.name, "velocity");
        assert_eq!(ch.frames.len(), 2);
        // Frame 0, atom 1 (id=1 → index 0 after sort)
        assert!((ch.frames[0].vectors[0] - 0.1).abs() < 1e-4);
        assert!((ch.frames[0].vectors[1] - 0.2).abs() < 1e-4);
        assert!((ch.frames[0].vectors[2] - 0.3).abs() < 1e-4);
        // Frame 1, atom 1
        assert!((ch.frames[1].vectors[0] - 0.11).abs() < 1e-4);
    }

    #[test]
    fn test_no_vector_columns() {
        let data = parse_lammpstrj(sample_dump()).unwrap();
        assert!(data.vector_channels.is_empty());
    }

    fn velocity_dump() -> &'static str {
        "ITEM: TIMESTEP\n\
         0\n\
         ITEM: NUMBER OF ATOMS\n\
         2\n\
         ITEM: BOX BOUNDS pp pp pp\n\
         0.0 10.0\n\
         0.0 10.0\n\
         0.0 10.0\n\
         ITEM: ATOMS id type x y z vx vy vz\n\
         1 1 1.0 2.0 3.0 0.1 0.2 0.3\n\
         2 2 4.0 5.0 6.0 0.4 0.5 0.6\n\
         ITEM: TIMESTEP\n\
         100\n\
         ITEM: NUMBER OF ATOMS\n\
         2\n\
         ITEM: BOX BOUNDS pp pp pp\n\
         0.0 10.0\n\
         0.0 10.0\n\
         0.0 10.0\n\
         ITEM: ATOMS id type x y z vx vy vz\n\
         1 1 1.1 2.1 3.1 0.11 0.21 0.31\n\
         2 2 4.1 5.1 6.1 0.41 0.51 0.61\n"
    }

    #[test]
    fn build_index_and_decode_frame_at_match_eager() {
        // Cover: unsorted-id dump (sample_dump), and a dump with a vector channel.
        for text in [sample_dump(), velocity_dump()] {
            let eager = parse_lammpstrj(text).unwrap();
            let idx = build_index(text).unwrap();

            assert_eq!(idx.n_frames, eager.n_frames);
            assert_eq!(idx.n_atoms, eager.n_atoms);
            assert_eq!(idx.offsets.len(), eager.n_frames);
            assert_eq!(idx.offsets[0], 0);
            assert!((idx.timestep_ps - eager.timestep_ps).abs() < 1e-6);
            assert_eq!(idx.vector_channel_names.len(), eager.vector_channels.len());

            for i in 0..idx.n_frames {
                let f = decode_frame_at(text, idx.offsets[i], idx.n_atoms).unwrap();
                // Positions must be BYTE-IDENTICAL to the eager parse's frame i.
                assert_eq!(f.positions, eager.frame(i).to_vec(), "frame {i} positions");
                // Each vector channel must match the eager channel of the same name.
                for (ci, name) in idx.vector_channel_names.iter().enumerate() {
                    let ch = eager
                        .vector_channels
                        .iter()
                        .find(|c| &c.name == name)
                        .expect("channel present in eager result");
                    assert_eq!(
                        f.vectors[ci], ch.frames[i].vectors,
                        "frame {i} channel {name}"
                    );
                }
            }
        }
    }

    #[test]
    fn decode_frame_at_rejects_non_boundary_offset() {
        let text = sample_dump();
        // Offset 5 lands mid-header, not on an ITEM: TIMESTEP boundary.
        assert!(decode_frame_at(text, 5, 3).is_err());
    }

    #[test]
    fn build_index_flags_variable_atom_count() {
        // A GCMC-style dump: build_index admits every frame (no error) and flags
        // heterogeneity so the host falls back to an eager parse.
        let text = "ITEM: TIMESTEP\n0\n\
                    ITEM: NUMBER OF ATOMS\n2\n\
                    ITEM: BOX BOUNDS pp pp pp\n0.0 10.0\n0.0 10.0\n0.0 10.0\n\
                    ITEM: ATOMS id type x y z\n\
                    1 1 1.0 0.0 0.0\n\
                    2 1 2.0 0.0 0.0\n\
                    ITEM: TIMESTEP\n100\n\
                    ITEM: NUMBER OF ATOMS\n3\n\
                    ITEM: BOX BOUNDS pp pp pp\n0.0 10.0\n0.0 10.0\n0.0 10.0\n\
                    ITEM: ATOMS id type x y z\n\
                    1 1 1.1 0.0 0.0\n\
                    2 1 2.1 0.0 0.0\n\
                    3 2 3.0 0.0 0.0\n";
        let idx = build_index(text).unwrap();
        assert!(idx.heterogeneous);
        assert_eq!(idx.n_frames, 2);
        assert_eq!(idx.n_atoms, 2); // frame-0 base

        // A uniform dump stays non-heterogeneous.
        let uni = build_index(sample_dump()).unwrap();
        assert!(!uni.heterogeneous);
    }

    #[test]
    fn build_index_records_a_changing_cell_like_the_eager_parse() {
        // Box 10 → 10 → 12 → 14: the index keeps frame 0's box as the
        // representative cell and every frame's box once one differs.
        let mut text = String::new();
        for (f, edge) in [10.0f32, 10.0, 12.0, 14.0].iter().enumerate() {
            text += &format!(
                "ITEM: TIMESTEP\n{f}\nITEM: NUMBER OF ATOMS\n1\n\
                 ITEM: BOX BOUNDS pp pp pp\n0 {edge}\n0 {edge}\n0 {edge}\n\
                 ITEM: ATOMS id type x y z\n1 1 1 1 1\n"
            );
        }
        let eager = parse_lammpstrj(&text).unwrap();
        let idx = build_index(&text).unwrap();
        assert!(!idx.heterogeneous);
        assert_eq!(idx.box_matrix, eager.box_matrix);
        let cells = idx.frame_cells.expect("per-frame cells");
        assert_eq!(
            cells.iter().map(|c| c[0]).collect::<Vec<_>>(),
            [10.0, 10.0, 12.0, 14.0]
        );
        for (f, cell) in cells.iter().enumerate() {
            assert_eq!(Some(&cell[..]), eager.frame_cell(f));
        }
        // A box that stays put records no per-frame table.
        assert!(build_index(sample_dump()).unwrap().frame_cells.is_none());
    }

    #[test]
    fn structure_uniform_splits_frame0_topology() {
        let s = parse_lammpstrj_structure(sample_dump()).unwrap();
        assert_eq!(s.n_atoms, 3);
        // Frame 0 topology: id-sorted positions and type-id element proxies.
        assert_eq!(
            s.positions,
            vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0]
        );
        assert_eq!(s.elements, vec![1u8, 2u8, 2u8]); // types of atoms 1,2,3
        assert!(s.box_matrix.is_some());
        // Box anchored at world origin → box_origin (0,0,0).
        assert_eq!(s.box_origin, Some([0.0, 0.0, 0.0]));
        // One extra frame beyond frame 0; uniform → no side table.
        assert_eq!(s.extra_frame_count(), 1);
        assert!(s.hetero.is_none());
        // Extra frame (frame 1) rides frame_positions_flat, id-sorted.
        assert_eq!(
            s.frame_positions_flat,
            vec![1.1, 2.1, 3.1, 4.1, 5.1, 6.1, 7.1, 8.1, 9.1]
        );
    }

    #[test]
    fn structure_no_type_column_falls_back_to_element_zero() {
        let text = "ITEM: TIMESTEP\n0\n\
                    ITEM: NUMBER OF ATOMS\n2\n\
                    ITEM: BOX BOUNDS pp pp pp\n0.0 10.0\n0.0 10.0\n0.0 10.0\n\
                    ITEM: ATOMS id x y z\n\
                    1 1.0 0.0 0.0\n\
                    2 2.0 0.0 0.0\n";
        let s = parse_lammpstrj_structure(text).unwrap();
        assert_eq!(s.n_atoms, 2);
        assert_eq!(s.elements, vec![0u8, 0u8]);
        assert!(s.hetero.is_none());
    }

    #[test]
    fn structure_variable_atoms_builds_hetero_side_table() {
        // GCMC-style dump: frame 0 has 2 atoms, frame 1 grows a third.
        let text = "ITEM: TIMESTEP\n0\n\
                    ITEM: NUMBER OF ATOMS\n2\n\
                    ITEM: BOX BOUNDS pp pp pp\n0.0 10.0\n0.0 10.0\n0.0 10.0\n\
                    ITEM: ATOMS id type x y z\n\
                    1 1 1.0 0.0 0.0\n\
                    2 1 2.0 0.0 0.0\n\
                    ITEM: TIMESTEP\n100\n\
                    ITEM: NUMBER OF ATOMS\n3\n\
                    ITEM: BOX BOUNDS pp pp pp\n0.0 10.0\n0.0 10.0\n0.0 10.0\n\
                    ITEM: ATOMS id type x y z\n\
                    1 1 1.1 0.0 0.0\n\
                    2 1 2.1 0.0 0.0\n\
                    3 2 3.0 0.0 0.0\n";
        let s = parse_lammpstrj_structure(text).unwrap();
        assert_eq!(s.n_atoms, 2); // frame-0 base topology
        assert_eq!(s.elements, vec![1u8, 1u8]);
        assert_eq!(s.extra_frame_count(), 1);
        let h = s.hetero.as_ref().expect("side table");
        assert!(h.varies_atoms);
        assert!(h.varies_topology);
        assert_eq!(h.max_atoms, 3);
        // Extra frame's element proxies (the 3-atom frame), incl. the new type 2.
        assert_eq!(h.elements_flat, vec![1u8, 1u8, 2u8]);
        // Its jagged positions (9 floats) are sliceable via atom_offsets.
        assert_eq!(h.atom_offsets, vec![0, 3]);
    }

    #[test]
    fn structure_variable_cell_records_cells_only() {
        // NPT-style dump: constant atom count, growing box → varies_cell only.
        let text = "ITEM: TIMESTEP\n0\n\
                    ITEM: NUMBER OF ATOMS\n1\n\
                    ITEM: BOX BOUNDS pp pp pp\n0.0 10.0\n0.0 10.0\n0.0 10.0\n\
                    ITEM: ATOMS id type x y z\n\
                    1 1 1.0 0.0 0.0\n\
                    ITEM: TIMESTEP\n100\n\
                    ITEM: NUMBER OF ATOMS\n1\n\
                    ITEM: BOX BOUNDS pp pp pp\n0.0 12.0\n0.0 12.0\n0.0 12.0\n\
                    ITEM: ATOMS id type x y z\n\
                    1 1 1.1 0.0 0.0\n";
        let s = parse_lammpstrj_structure(text).unwrap();
        let h = s.hetero.as_ref().expect("side table");
        assert!(h.varies_cell);
        assert!(!h.varies_atoms);
        assert!(!h.varies_topology);
        assert!(h.elements_flat.is_empty()); // topology constant
                                             // Frame-0 box on the struct; extra frame's grown box in cells_flat.
        assert!((s.box_matrix.unwrap()[0] - 10.0).abs() < 1e-5);
        assert_eq!(h.cells_flat.len(), 9); // one extra frame
        assert!((h.cells_flat[0] - 12.0).abs() < 1e-5);
    }

    #[test]
    fn structure_captures_offset_box_origin() {
        // A box whose lower corner is far from world zero must surface its
        // origin so the renderer draws the cell wrapped around the atoms.
        let text = "ITEM: TIMESTEP\n0\n\
                    ITEM: NUMBER OF ATOMS\n1\n\
                    ITEM: BOX BOUNDS pp pp pp\n160.0 200.0\n0.0 40.0\n600.0 640.0\n\
                    ITEM: ATOMS id type x y z\n\
                    1 1 165.0 5.0 605.0\n";
        let s = parse_lammpstrj_structure(text).unwrap();
        assert_eq!(s.box_origin, Some([160.0, 0.0, 600.0]));
    }

    #[test]
    fn structure_empty_file_errors() {
        assert!(parse_lammpstrj_structure("").is_err());
    }

    #[test]
    fn image_flags_decode_absolute_coords_orthorhombic() {
        // Wrapped x/y/z + ix/iy/iz: absolute = wrapped + i·L per axis.
        let text = "ITEM: TIMESTEP\n0\n\
                    ITEM: NUMBER OF ATOMS\n2\n\
                    ITEM: BOX BOUNDS pp pp pp\n0.0 10.0\n0.0 20.0\n0.0 30.0\n\
                    ITEM: ATOMS id type x y z ix iy iz\n\
                    1 1 1.0 2.0 3.0 1 0 -1\n\
                    2 1 4.0 5.0 6.0 0 2 0\n";
        let data = parse_lammpstrj(text).unwrap();
        let f0 = data.frame(0);
        assert!((f0[0] - 11.0).abs() < 1e-4); // 1.0 + 1*10
        assert!((f0[1] - 2.0).abs() < 1e-4);
        assert!((f0[2] - (-27.0)).abs() < 1e-4); // 3.0 - 1*30
        assert!((f0[3] - 4.0).abs() < 1e-4);
        assert!((f0[4] - 45.0).abs() < 1e-4); // 5.0 + 2*20
        assert!((f0[5] - 6.0).abs() < 1e-4);
        // Structure lane decodes identically, and the flag columns themselves
        // are structural — they must not surface as scalar channels.
        let s = parse_lammpstrj_structure(text).unwrap();
        assert!((s.positions[0] - 11.0).abs() < 1e-4);
        assert!((s.positions[4] - 45.0).abs() < 1e-4);
        assert!(s.scalar_channels.is_empty());
        assert!(s.warnings.is_empty());
    }

    #[test]
    fn image_flags_decode_triclinic_cell() {
        // Tilted cell a=(10,0,0), b=(2,10,0), c=(1,0.5,10), whose bounding box
        // LAMMPS writes as x 0..13, y 0..10.5: the shift is ix·a + iy·b + iz·c,
        // not a per-axis multiple.
        let text = "ITEM: TIMESTEP\n0\n\
                    ITEM: NUMBER OF ATOMS\n2\n\
                    ITEM: BOX BOUNDS xy xz yz pp pp pp\n\
                    0.0 13.0 2.0\n\
                    0.0 10.5 1.0\n\
                    0.0 10.0 0.5\n\
                    ITEM: ATOMS id type x y z ix iy iz\n\
                    1 1 1.0 1.0 1.0 1 1 1\n\
                    2 1 2.0 2.0 2.0 0 0 -1\n";
        let data = parse_lammpstrj(text).unwrap();
        let bm = data.box_matrix.unwrap();
        assert!((bm[0] - 10.0).abs() < 1e-5); // lx after tilt recovery
        let f0 = data.frame(0);
        // atom 1: (1,1,1) + a + b + c = (14, 11.5, 11)
        assert!((f0[0] - 14.0).abs() < 1e-4);
        assert!((f0[1] - 11.5).abs() < 1e-4);
        assert!((f0[2] - 11.0).abs() < 1e-4);
        // atom 2: (2,2,2) - c = (1, 1.5, -8)
        assert!((f0[3] - 1.0).abs() < 1e-4);
        assert!((f0[4] - 1.5).abs() < 1e-4);
        assert!((f0[5] - (-8.0)).abs() < 1e-4);
        // Structure lane matches.
        let s = parse_lammpstrj_structure(text).unwrap();
        assert_eq!(s.positions, f0.to_vec());
    }

    /// Cell a=(10,0,0), b=(2,10,0), c=(1,0.5,10) at the origin, as LAMMPS
    /// writes it: the x/y bounds are the tilted cell's bounding box.
    const TRICLINIC_SCALED: &str = "ITEM: TIMESTEP\n0\n\
                    ITEM: NUMBER OF ATOMS\n3\n\
                    ITEM: BOX BOUNDS xy xz yz pp pp pp\n\
                    0.0 13.0 2.0\n\
                    0.0 10.5 1.0\n\
                    0.0 10.0 0.5\n\
                    ITEM: ATOMS id type xs ys zs\n\
                    1 1 0.0 1.0 0.0\n\
                    2 1 0.5 0.0 0.0\n\
                    3 1 0.0 0.0 1.0\n";

    fn assert_close(got: &[f32], want: &[f32]) {
        assert_eq!(got.len(), want.len(), "{got:?} vs {want:?}");
        for (g, w) in got.iter().zip(want) {
            assert!((g - w).abs() < 1e-4, "{got:?} vs {want:?}");
        }
    }

    #[test]
    fn triclinic_bounds_recover_the_true_cell() {
        let cell = [10.0, 0.0, 0.0, 2.0, 10.0, 0.0, 1.0, 0.5, 10.0];
        let data = parse_lammpstrj(TRICLINIC_SCALED).unwrap();
        assert_close(&data.box_matrix.unwrap(), &cell);
        assert_eq!(data.box_origin, Some([0.0, 0.0, 0.0]));
        let s = parse_lammpstrj_structure(TRICLINIC_SCALED).unwrap();
        assert_close(&s.box_matrix.unwrap(), &cell);
        assert_eq!(s.box_origin, Some([0.0, 0.0, 0.0]));
        let idx = build_index(TRICLINIC_SCALED).unwrap();
        assert_close(&idx.box_matrix.unwrap(), &cell);
        assert_eq!(idx.box_origin, Some([0.0, 0.0, 0.0]));
    }

    #[test]
    fn triclinic_scaled_coords_follow_the_tilt() {
        // xs ys zs = (0,1,0) is the tip of b, (0.5,0,0) is a/2, (0,0,1) is c.
        let want = [2.0, 10.0, 0.0, 5.0, 0.0, 0.0, 1.0, 0.5, 10.0];
        let data = parse_lammpstrj(TRICLINIC_SCALED).unwrap();
        assert_close(data.frame(0), &want);
        let s = parse_lammpstrj_structure(TRICLINIC_SCALED).unwrap();
        assert_close(&s.positions, &want);
        let idx = build_index(TRICLINIC_SCALED).unwrap();
        let lazy = decode_frame_at(TRICLINIC_SCALED, idx.offsets[0], idx.n_atoms).unwrap();
        assert_close(&lazy.positions, &want);
    }

    #[test]
    fn triclinic_negative_tilt_keeps_the_true_lower_corner() {
        // a=(10,0,0), b=(-2,10,0), c=(0,-1,10) with its lower corner at
        // (5, 1, 0): LAMMPS writes xlo_bound = 5 + MIN(0,-2,0,-2) = 3,
        // xhi_bound = 15 + MAX(0,-2,0,-2) = 15, ylo_bound = 1 - 1 = 0.
        let text = "ITEM: TIMESTEP\n0\n\
                    ITEM: NUMBER OF ATOMS\n1\n\
                    ITEM: BOX BOUNDS xy xz yz pp pp pp\n\
                    3.0 15.0 -2.0\n\
                    0.0 11.0 0.0\n\
                    0.0 10.0 -1.0\n\
                    ITEM: ATOMS id type xs ys zs\n\
                    1 1 0.0 1.0 1.0\n";
        let data = parse_lammpstrj(text).unwrap();
        assert_close(
            &data.box_matrix.unwrap(),
            &[10.0, 0.0, 0.0, -2.0, 10.0, 0.0, 0.0, -1.0, 10.0],
        );
        assert_eq!(data.box_origin, Some([5.0, 1.0, 0.0]));
        // origin + b + c = (5 - 2 + 0, 1 + 10 - 1, 0 + 10) = (3, 10, 10)
        assert_close(data.frame(0), &[3.0, 10.0, 10.0]);
        let s = parse_lammpstrj_structure(text).unwrap();
        assert_eq!(s.box_origin, Some([5.0, 1.0, 0.0]));
        assert_close(&s.positions, &[3.0, 10.0, 10.0]);
        assert_eq!(build_index(text).unwrap().box_origin, Some([5.0, 1.0, 0.0]));
    }

    #[test]
    fn unwrapped_columns_win_over_wrapped() {
        // Both x/y/z and xu/yu/zu present: xu (already absolute) is
        // authoritative, and the image flags are ignored alongside it.
        let text = "ITEM: TIMESTEP\n0\n\
                    ITEM: NUMBER OF ATOMS\n1\n\
                    ITEM: BOX BOUNDS pp pp pp\n0.0 10.0\n0.0 10.0\n0.0 10.0\n\
                    ITEM: ATOMS id type x y z xu yu zu ix iy iz\n\
                    1 1 1.0 2.0 3.0 11.0 22.0 33.0 1 1 1\n";
        let data = parse_lammpstrj(text).unwrap();
        let f0 = data.frame(0);
        assert_eq!(f0, &[11.0, 22.0, 33.0]);
        let s = parse_lammpstrj_structure(text).unwrap();
        assert_eq!(s.positions, vec![11.0, 22.0, 33.0]);
        // The alternate coordinate encodings are not scalar data.
        assert!(s.scalar_channels.is_empty());
    }

    #[test]
    fn scaled_coords_with_image_flags() {
        let text = "ITEM: TIMESTEP\n0\n\
                    ITEM: NUMBER OF ATOMS\n1\n\
                    ITEM: BOX BOUNDS pp pp pp\n0.0 10.0\n0.0 10.0\n0.0 10.0\n\
                    ITEM: ATOMS id type xs ys zs ix iy iz\n\
                    1 1 0.5 0.25 0.75 1 0 2\n";
        let data = parse_lammpstrj(text).unwrap();
        let f0 = data.frame(0);
        // scaled→Cartesian first, then the image shift: 0.5*10 + 1*10 = 15, …
        assert!((f0[0] - 15.0).abs() < 1e-4);
        assert!((f0[1] - 2.5).abs() < 1e-4);
        assert!((f0[2] - 27.5).abs() < 1e-4);
    }

    #[test]
    fn decode_frame_at_matches_eager_for_image_flag_dump() {
        // Two frames with different cells: the lazy decoder must apply each
        // frame's own cell to its image flags, exactly like the eager parse.
        let text = "ITEM: TIMESTEP\n0\n\
                    ITEM: NUMBER OF ATOMS\n2\n\
                    ITEM: BOX BOUNDS pp pp pp\n0.0 10.0\n0.0 10.0\n0.0 10.0\n\
                    ITEM: ATOMS id type x y z ix iy iz\n\
                    1 1 1.0 2.0 3.0 1 0 0\n\
                    2 1 4.0 5.0 6.0 0 -1 0\n\
                    ITEM: TIMESTEP\n100\n\
                    ITEM: NUMBER OF ATOMS\n2\n\
                    ITEM: BOX BOUNDS pp pp pp\n0.0 12.0\n0.0 12.0\n0.0 12.0\n\
                    ITEM: ATOMS id type x y z ix iy iz\n\
                    1 1 1.5 2.5 3.5 1 0 0\n\
                    2 1 4.5 5.5 6.5 0 -1 0\n";
        let eager = parse_lammpstrj(text).unwrap();
        assert!((eager.frame(0)[0] - 11.0).abs() < 1e-4); // 1.0 + 10
        assert!((eager.frame(1)[0] - 13.5).abs() < 1e-4); // 1.5 + 12
        let idx = build_index(text).unwrap();
        for i in 0..idx.n_frames {
            let f = decode_frame_at(text, idx.offsets[i], idx.n_atoms).unwrap();
            assert_eq!(f.positions, eager.frame(i).to_vec(), "frame {i}");
        }
    }

    #[test]
    fn structure_extra_columns_become_scalar_channels() {
        // q / mol / c_pe columns: one frame-synced ScalarChannel each, values
        // id-sorted like positions.
        let text = "ITEM: TIMESTEP\n0\n\
                    ITEM: NUMBER OF ATOMS\n2\n\
                    ITEM: BOX BOUNDS pp pp pp\n0.0 10.0\n0.0 10.0\n0.0 10.0\n\
                    ITEM: ATOMS id type x y z q mol c_pe\n\
                    2 1 4.0 5.0 6.0 -0.5 1 2.0\n\
                    1 1 1.0 2.0 3.0 0.5 1 1.0\n\
                    ITEM: TIMESTEP\n100\n\
                    ITEM: NUMBER OF ATOMS\n2\n\
                    ITEM: BOX BOUNDS pp pp pp\n0.0 10.0\n0.0 10.0\n0.0 10.0\n\
                    ITEM: ATOMS id type x y z q mol c_pe\n\
                    1 1 1.1 2.1 3.1 0.6 1 1.5\n\
                    2 1 4.1 5.1 6.1 -0.6 1 2.5\n";
        let s = parse_lammpstrj_structure(text).unwrap();
        assert!(s.warnings.is_empty());
        assert_eq!(s.scalar_channels.len(), 3);
        let names: Vec<&str> = s.scalar_channels.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["q", "mol", "c_pe"]);
        let q = &s.scalar_channels[0];
        assert_eq!(q.frames.len(), 2);
        assert_eq!(q.frames[0].frame, 0);
        assert_eq!(q.frames[0].values, vec![0.5, -0.5]); // id-sorted
        assert_eq!(q.frames[1].frame, 1);
        assert_eq!(q.frames[1].values, vec![0.6, -0.6]);
        let mol = &s.scalar_channels[1];
        assert_eq!(mol.frames[0].values, vec![1.0, 1.0]);
        let pe = &s.scalar_channels[2];
        assert_eq!(pe.frames[1].values, vec![1.5, 2.5]);
    }

    #[test]
    fn structure_variable_atoms_skips_scalar_channels_with_warning() {
        // Jagged atom counts have no fixed-stride scalar representation: the
        // columns are skipped and reported once, aggregated.
        let text = "ITEM: TIMESTEP\n0\n\
                    ITEM: NUMBER OF ATOMS\n2\n\
                    ITEM: BOX BOUNDS pp pp pp\n0.0 10.0\n0.0 10.0\n0.0 10.0\n\
                    ITEM: ATOMS id type x y z q mol\n\
                    1 1 1.0 0.0 0.0 0.5 1\n\
                    2 1 2.0 0.0 0.0 -0.5 1\n\
                    ITEM: TIMESTEP\n100\n\
                    ITEM: NUMBER OF ATOMS\n3\n\
                    ITEM: BOX BOUNDS pp pp pp\n0.0 10.0\n0.0 10.0\n0.0 10.0\n\
                    ITEM: ATOMS id type x y z q mol\n\
                    1 1 1.1 0.0 0.0 0.5 1\n\
                    2 1 2.1 0.0 0.0 -0.5 1\n\
                    3 2 3.0 0.0 0.0 0.0 2\n";
        let s = parse_lammpstrj_structure(text).unwrap();
        assert!(s.hetero.is_some());
        assert!(s.scalar_channels.is_empty());
        assert_eq!(s.warnings.len(), 1);
        assert!(s.warnings[0].contains("q"));
        assert!(s.warnings[0].contains("mol"));
    }

    #[test]
    fn structure_disappearing_column_skipped_with_warning() {
        // Frame 1 drops the q column: the channel would desync from playback,
        // so it is skipped and reported.
        let text = "ITEM: TIMESTEP\n0\n\
                    ITEM: NUMBER OF ATOMS\n1\n\
                    ITEM: BOX BOUNDS pp pp pp\n0.0 10.0\n0.0 10.0\n0.0 10.0\n\
                    ITEM: ATOMS id type x y z q\n\
                    1 1 1.0 0.0 0.0 0.5\n\
                    ITEM: TIMESTEP\n100\n\
                    ITEM: NUMBER OF ATOMS\n1\n\
                    ITEM: BOX BOUNDS pp pp pp\n0.0 10.0\n0.0 10.0\n0.0 10.0\n\
                    ITEM: ATOMS id type x y z\n\
                    1 1 1.1 0.0 0.0\n";
        let s = parse_lammpstrj_structure(text).unwrap();
        assert!(s.scalar_channels.is_empty());
        assert_eq!(s.warnings.len(), 1);
        assert!(s.warnings[0].contains("q"));
    }

    #[test]
    fn plain_wrapped_dump_unchanged() {
        // A dump with neither image flags nor unwrapped columns keeps its
        // coordinates exactly as written (and no scalar channels/warnings).
        let data = parse_lammpstrj(sample_dump()).unwrap();
        assert_eq!(
            data.frame(0),
            &[1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0]
        );
        let s = parse_lammpstrj_structure(sample_dump()).unwrap();
        assert_eq!(
            s.positions,
            vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0]
        );
        assert!(s.scalar_channels.is_empty());
        assert!(s.warnings.is_empty());
    }
}
