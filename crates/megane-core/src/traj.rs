/// ASE .traj (ULM binary format) parser.
///
/// The ULM format stores frames as binary array data + JSON metadata.
/// Each frame contains atomic positions, elements, and optionally cell vectors.
use std::collections::HashSet;

use crate::bonds;
use crate::parser::{HeteroFrames, ParsedStructure};

const ULM_MAGIC: &[u8; 8] = b"- of Ulm";

// ---------- Binary readers ----------

fn read_bytes<const N: usize>(data: &[u8], pos: usize, type_name: &str) -> Result<[u8; N], String> {
    data.get(pos..pos + N)
        .and_then(|s| s.try_into().ok())
        .ok_or_else(|| format!("unexpected EOF reading {} at offset {}", type_name, pos))
}

fn read_i64(data: &[u8], pos: usize, little_endian: bool) -> Result<i64, String> {
    let bytes = read_bytes::<8>(data, pos, "i64")?;
    Ok(if little_endian {
        i64::from_le_bytes(bytes)
    } else {
        i64::from_be_bytes(bytes)
    })
}

fn read_f64(data: &[u8], pos: usize, little_endian: bool) -> Result<f64, String> {
    let bytes = read_bytes::<8>(data, pos, "f64")?;
    Ok(if little_endian {
        f64::from_le_bytes(bytes)
    } else {
        f64::from_be_bytes(bytes)
    })
}

fn read_f32_raw(data: &[u8], pos: usize, little_endian: bool) -> Result<f32, String> {
    let bytes = read_bytes::<4>(data, pos, "f32")?;
    Ok(if little_endian {
        f32::from_le_bytes(bytes)
    } else {
        f32::from_be_bytes(bytes)
    })
}

fn read_i32(data: &[u8], pos: usize, little_endian: bool) -> Result<i32, String> {
    let bytes = read_bytes::<4>(data, pos, "i32")?;
    Ok(if little_endian {
        i32::from_le_bytes(bytes)
    } else {
        i32::from_be_bytes(bytes)
    })
}

// ---------- Array reading helpers ----------

/// Read an ndarray from binary data given shape, dtype, and file offset.
/// Returns values as Vec<f64> (converted from the source dtype).
fn read_ndarray_f64(
    data: &[u8],
    offset: usize,
    shape: &[usize],
    dtype: &str,
    little_endian: bool,
) -> Result<Vec<f64>, String> {
    let n_elements: usize = shape.iter().product();
    let mut result = Vec::with_capacity(n_elements);

    match dtype {
        "float64" => {
            for i in 0..n_elements {
                result.push(read_f64(data, offset + i * 8, little_endian)?);
            }
        }
        "float32" => {
            for i in 0..n_elements {
                result.push(read_f32_raw(data, offset + i * 4, little_endian)? as f64);
            }
        }
        _ => return Err(format!("unsupported float dtype: {}", dtype)),
    }
    Ok(result)
}

/// Read an ndarray as integers (for atomic numbers etc.)
fn read_ndarray_int(
    data: &[u8],
    offset: usize,
    shape: &[usize],
    dtype: &str,
    little_endian: bool,
) -> Result<Vec<i64>, String> {
    let n_elements: usize = shape.iter().product();
    let mut result = Vec::with_capacity(n_elements);

    match dtype {
        "int64" => {
            for i in 0..n_elements {
                result.push(read_i64(data, offset + i * 8, little_endian)?);
            }
        }
        "int32" => {
            for i in 0..n_elements {
                result.push(read_i32(data, offset + i * 4, little_endian)? as i64);
            }
        }
        "uint8" => {
            for i in 0..n_elements {
                if offset + i >= data.len() {
                    return Err("unexpected EOF reading uint8 array".into());
                }
                result.push(data[offset + i] as i64);
            }
        }
        "int8" => {
            for i in 0..n_elements {
                if offset + i >= data.len() {
                    return Err("unexpected EOF reading int8 array".into());
                }
                result.push(data[offset + i] as i8 as i64);
            }
        }
        "int16" => {
            for i in 0..n_elements {
                let pos = offset + i * 2;
                if pos + 2 > data.len() {
                    return Err("unexpected EOF reading int16 array".into());
                }
                let bytes: [u8; 2] = read_bytes::<2>(data, pos, "i16")?;
                let val = if little_endian {
                    i16::from_le_bytes(bytes)
                } else {
                    i16::from_be_bytes(bytes)
                };
                result.push(val as i64);
            }
        }
        _ => return Err(format!("unsupported integer dtype: {}", dtype)),
    }
    Ok(result)
}

// ---------- JSON metadata parsing ----------

/// Extract ndarray info from a JSON value like {"ndarray": [shape, dtype, offset]}
fn parse_ndarray_ref(value: &serde_json::Value) -> Option<(Vec<usize>, String, usize)> {
    let obj = value.as_object()?;
    let arr = obj.get("ndarray")?.as_array()?;
    if arr.len() != 3 {
        return None;
    }

    // shape can be a single int or array of ints
    let shape = match &arr[0] {
        serde_json::Value::Array(dims) => dims
            .iter()
            .filter_map(|d| d.as_u64().map(|v| v as usize))
            .collect(),
        serde_json::Value::Number(n) => vec![n.as_u64()? as usize],
        _ => return None,
    };

    let dtype = arr[1].as_str()?.to_string();
    let offset = arr[2].as_u64()? as usize;

    Some((shape, dtype, offset))
}

/// Read JSON metadata section at the given file offset.
/// Returns the parsed JSON value.
fn read_json_metadata(
    data: &[u8],
    offset: usize,
    little_endian: bool,
) -> Result<serde_json::Value, String> {
    let json_len = read_i64(data, offset, little_endian)? as usize;
    let json_start = offset + 8;
    let json_end = json_start + json_len;
    if json_end > data.len() {
        return Err(format!(
            "JSON metadata extends past EOF: {}+{} > {}",
            json_start,
            json_len,
            data.len()
        ));
    }
    let json_str = std::str::from_utf8(&data[json_start..json_end])
        .map_err(|e| format!("invalid UTF-8 in JSON: {}", e))?;
    serde_json::from_str(json_str).map_err(|e| format!("JSON parse error: {}", e))
}

/// Extract positions (float array) from a frame's JSON metadata.
fn extract_positions(
    data: &[u8],
    json: &serde_json::Value,
    little_endian: bool,
) -> Result<Vec<f32>, String> {
    // Try "positions." key (ndarray reference)
    if let Some(val) = json.get("positions.") {
        if let Some((shape, dtype, offset)) = parse_ndarray_ref(val) {
            let raw = read_ndarray_f64(data, offset, &shape, &dtype, little_endian)?;
            return Ok(raw.iter().map(|&v| v as f32).collect());
        }
    }

    // Try "positions" as inline list
    if let Some(arr) = json.get("positions").and_then(|v| v.as_array()) {
        let mut positions = Vec::new();
        for row in arr {
            if let Some(coords) = row.as_array() {
                for c in coords {
                    positions.push(c.as_f64().unwrap_or(0.0) as f32);
                }
            }
        }
        if !positions.is_empty() {
            return Ok(positions);
        }
    }

    Err("no positions found in frame".into())
}

/// Extract atomic numbers from a frame's JSON metadata.
fn extract_numbers(
    data: &[u8],
    json: &serde_json::Value,
    little_endian: bool,
) -> Result<Vec<u8>, String> {
    // Try "numbers." key (ndarray reference)
    if let Some(val) = json.get("numbers.") {
        if let Some((shape, dtype, offset)) = parse_ndarray_ref(val) {
            let raw = read_ndarray_int(data, offset, &shape, &dtype, little_endian)?;
            return Ok(raw.iter().map(|&v| v.clamp(0, 255) as u8).collect());
        }
    }

    // Try "numbers" as inline list
    if let Some(arr) = json.get("numbers").and_then(|v| v.as_array()) {
        return Ok(arr
            .iter()
            .map(|v| v.as_u64().unwrap_or(0).clamp(0, 255) as u8)
            .collect());
    }

    Err("no atomic numbers found in frame".into())
}

/// Borrow the raw bytes backing a frame's `cell.` ndarray, without decoding.
///
/// Used on the hot parse loop to detect an *unchanged* cell with a byte compare
/// instead of decoding 9 floats every frame — the cell is written to every ASE
/// frame, so for a uniform trajectory this is the difference between a cheap
/// `memcmp` and a full per-frame decode. Returns `None` when the frame carries
/// no `cell.` ndarray reference.
fn cell_raw_bytes<'a>(data: &'a [u8], json: &serde_json::Value) -> Option<&'a [u8]> {
    let val = json.get("cell.")?;
    let (shape, dtype, offset) = parse_ndarray_ref(val)?;
    let n_elements: usize = shape.iter().product();
    let elem_size = match dtype.as_str() {
        "float64" => 8,
        "float32" => 4,
        _ => return None,
    };
    let len = n_elements.checked_mul(elem_size)?;
    data.get(offset..offset + len)
}

/// Extract cell matrix from a frame's JSON metadata.
fn extract_cell(data: &[u8], json: &serde_json::Value, little_endian: bool) -> Option<[f32; 9]> {
    // Try "cell." key (ndarray reference)
    if let Some(val) = json.get("cell.") {
        if let Some((shape, dtype, offset)) = parse_ndarray_ref(val) {
            if let Ok(raw) = read_ndarray_f64(data, offset, &shape, &dtype, little_endian) {
                if raw.len() >= 9 {
                    let mut mat = [0f32; 9];
                    for (i, &v) in raw.iter().take(9).enumerate() {
                        mat[i] = v as f32;
                    }
                    // Check if cell is non-zero
                    if mat.iter().any(|&v| v.abs() > 1e-10) {
                        return Some(mat);
                    }
                }
            }
        }
    }

    // Try "cell" as inline list (3x3)
    if let Some(arr) = json.get("cell").and_then(|v| v.as_array()) {
        let mut mat = [0f32; 9];
        let mut idx = 0;
        for row in arr {
            if let Some(cols) = row.as_array() {
                for c in cols {
                    if idx < 9 {
                        mat[idx] = c.as_f64().unwrap_or(0.0) as f32;
                        idx += 1;
                    }
                }
            }
        }
        if idx == 9 && mat.iter().any(|&v| v.abs() > 1e-10) {
            return Some(mat);
        }
    }

    None
}

// ---------- Public API ----------

/// Parse an ASE .traj file (ULM binary format) and return a ParsedStructure.
///
/// Frame 0 defines the base topology (elements, bonds, cell) carried on the
/// struct. Extra-frame positions are collected into `frame_positions_flat`.
///
/// Trajectories whose frames differ in atom count, unit cell, or elements are
/// supported: such variation is captured in `ParsedStructure::hetero`
/// (`None` for the common uniform case, which keeps the fast fixed-stride
/// path). See [`HeteroFrames`] for the per-frame layout.
pub fn parse_traj(data: &[u8]) -> Result<ParsedStructure, String> {
    if data.len() < 48 {
        return Err("file too small for ULM header".into());
    }

    // Validate magic
    if &data[0..8] != ULM_MAGIC {
        return Err("not a ULM file (bad magic)".into());
    }

    // Determine endianness: ULM header integers are written in the machine's
    // native byte order.  We try little-endian first (the common case) and
    // fall back to big-endian if the values look unreasonable.
    let (little_endian_header, version, nitems, pos0) = {
        let hdr_v = read_bytes::<8>(data, 24, "version")?;
        let hdr_n = read_bytes::<8>(data, 32, "nitems")?;
        let hdr_p = read_bytes::<8>(data, 40, "pos0")?;

        let v_le = i64::from_le_bytes(hdr_v);
        let n_le = i64::from_le_bytes(hdr_n);
        let p_le = i64::from_le_bytes(hdr_p);

        if v_le > 0 && v_le <= 10 && n_le > 0 && n_le < 1_000_000_000 && p_le > 0 {
            (true, v_le, n_le as usize, p_le as usize)
        } else {
            let v_be = i64::from_be_bytes(hdr_v);
            let n_be = i64::from_be_bytes(hdr_n);
            let p_be = i64::from_be_bytes(hdr_p);
            if v_be > 0 && v_be <= 10 && n_be > 0 {
                (false, v_be, n_be as usize, p_be as usize)
            } else {
                return Err(format!(
                    "cannot determine ULM endianness (version_le={}, version_be={})",
                    v_le, v_be
                ));
            }
        }
    };

    let _ = version; // We support all known versions

    // Read offset table
    if pos0 + nitems * 8 > data.len() {
        return Err("offset table extends past EOF".into());
    }
    let mut offsets = Vec::with_capacity(nitems);
    for i in 0..nitems {
        let off = read_i64(data, pos0 + i * 8, little_endian_header)? as usize;
        offsets.push(off);
    }

    if offsets.is_empty() {
        return Err("no frames in .traj file".into());
    }

    // Parse first frame to get element info
    let first_json = read_json_metadata(data, offsets[0], little_endian_header)?;

    // Check _little_endian flag in JSON (may differ from header endianness)
    let array_le = first_json
        .get("_little_endian")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    let elements = extract_numbers(data, &first_json, array_le)?;
    let n_atoms = elements.len();

    if n_atoms == 0 {
        return Err("zero atoms in first frame".into());
    }

    let box_matrix = extract_cell(data, &first_json, array_le);

    // Collect positions: frame 0 into `positions`, the rest flat into
    // `frame_positions_flat`. While scanning we also classify whether the
    // trajectory is *heterogeneous* (atom count / cell / elements change).
    //
    // ULM back-reference semantics (verified against ASE-written fixtures):
    // `cell` is written into every frame's dict, but `numbers`/`pbc` appear
    // only in the header frame and whenever the element list changes (which is
    // also whenever the atom count changes). So topology variation is detected
    // by an O(1) key-presence check plus a compare only when the key reappears,
    // and cell variation by comparing the per-frame 9-float cell — both cheap
    // enough that the uniform (fast) path is not regressed.
    //
    // Per-frame element/cell snapshots are accumulated *lazily*: nothing is
    // recorded until the corresponding channel is first seen to vary, at which
    // point the earlier (uniform) frames are backfilled. A uniform trajectory
    // therefore allocates no side tables at all.
    let mut cur_numbers: Vec<u8> = elements.clone();
    let mut cur_cell: Option<[f32; 9]> = box_matrix;
    // Frame-0 cell "signature", used to detect an unchanged cell cheaply on
    // later frames without decoding. ASE stores the cell either as a `cell.`
    // ndarray reference (large/aligned data → compare the raw bytes; the JSON
    // itself can't be compared because the byte offset differs per frame) or
    // inline as a small `cell` JSON array (→ compare the parsed value).
    let cell0_bytes: Option<Vec<u8>> = cell_raw_bytes(data, &first_json).map(<[u8]>::to_vec);
    let cell0_inline: Option<serde_json::Value> = first_json.get("cell").cloned();

    let mut varies_atoms = false;
    let mut varies_cell = false;
    let mut varies_topology = false;
    let mut max_atoms = n_atoms;

    let extra = nitems.saturating_sub(1);
    let mut positions: Vec<f32> = Vec::new();
    let mut frame_positions_flat: Vec<f32> = Vec::with_capacity(extra * n_atoms * 3);
    let mut atom_offsets: Vec<u32> = Vec::with_capacity(extra + 1);
    atom_offsets.push(0);
    // Per-extra-frame snapshots (populated only after variation is detected).
    let mut per_frame_elements: Vec<Vec<u8>> = Vec::new();
    let mut per_frame_cells: Vec<[f32; 9]> = Vec::new();
    let mut recording_topo = false;
    let mut recording_cell = false;

    for (i, &off) in offsets.iter().enumerate() {
        let json = if i == 0 {
            first_json.clone()
        } else {
            read_json_metadata(data, off, little_endian_header)?
        };
        let frame_le = json
            .get("_little_endian")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        // Refresh carry-forward numbers/cell when this frame re-emits them.
        if i > 0 {
            // `numbers` appears only in header frames (rare), so a single
            // presence check keeps the uniform path a cheap O(1) miss.
            if json.get("numbers.").is_some() || json.get("numbers").is_some() {
                if let Ok(nums) = extract_numbers(data, &json, frame_le) {
                    if nums != cur_numbers {
                        varies_topology = true;
                    }
                    cur_numbers = nums;
                }
            }
            // `cell` is written every frame. Detect the unchanged (uniform)
            // case cheaply — a byte compare for ndarray cells, a value compare
            // for inline cells — and decode only when the cell actually differs.
            // A frame that omits the cell carries the previous value forward.
            let has_ndarray_cell = json.get("cell.").is_some();
            let has_inline_cell = json.get("cell").is_some();
            if has_ndarray_cell || has_inline_cell {
                let changed = if has_ndarray_cell {
                    cell_raw_bytes(data, &json) != cell0_bytes.as_deref()
                } else {
                    json.get("cell") != cell0_inline.as_ref()
                };
                if changed {
                    varies_cell = true;
                    cur_cell = extract_cell(data, &json, frame_le);
                } else {
                    cur_cell = box_matrix; // byte/value-identical to frame 0
                }
            }
        }

        let pos = extract_positions(data, &json, frame_le)?;
        if pos.len() % 3 != 0 {
            return Err(format!(
                "frame {} has {} coordinates (not a multiple of 3)",
                i,
                pos.len()
            ));
        }
        let frame_atoms = pos.len() / 3;
        if frame_atoms > max_atoms {
            max_atoms = frame_atoms;
        }

        if i == 0 {
            positions = pos;
            continue;
        }

        // Extra frame `ei` (overall frame `i`).
        let ei = i - 1;
        if frame_atoms != n_atoms {
            varies_atoms = true;
        }
        frame_positions_flat.extend_from_slice(&pos);
        let last = *atom_offsets.last().unwrap();
        atom_offsets.push(last + frame_atoms as u32);

        // Lazily record per-frame topology once it (or the atom count) varies.
        if (varies_atoms || varies_topology) && !recording_topo {
            // Backfill earlier extra frames — all had frame-0 topology/count.
            for _ in 0..ei {
                per_frame_elements.push(elements.clone());
            }
            recording_topo = true;
        }
        if recording_topo {
            let mut snap = cur_numbers.clone();
            // Keep element slices aligned with `atom_offsets` even if a header
            // is malformed (ASE always co-writes numbers with a count change).
            if snap.len() != frame_atoms {
                snap.resize(frame_atoms, 0);
            }
            per_frame_elements.push(snap);
        }

        // Lazily record per-frame cell once it varies.
        if varies_cell && !recording_cell {
            let base = box_matrix.unwrap_or([0.0; 9]);
            for _ in 0..ei {
                per_frame_cells.push(base);
            }
            recording_cell = true;
        }
        if recording_cell {
            per_frame_cells.push(cur_cell.unwrap_or([0.0; 9]));
        }
    }

    // Infer bonds from first frame (frame-0 topology lives on the struct).
    let empty_bonds: HashSet<(u32, u32)> = HashSet::new();
    let bonds = bonds::infer_bonds(&positions, &elements, n_atoms, &empty_bonds);

    // Assemble the heterogeneous side-table only when some channel varies.
    let hetero = if varies_atoms || varies_cell || varies_topology {
        let (elements_flat, bonds_flat, bond_offsets) = if varies_atoms || varies_topology {
            let mut elements_flat: Vec<u8> = Vec::new();
            let mut bonds_flat: Vec<u32> = Vec::new();
            let mut bond_offsets: Vec<u32> = Vec::with_capacity(extra + 1);
            bond_offsets.push(0);
            for (k, elems) in per_frame_elements.iter().enumerate() {
                let a = atom_offsets[k] as usize * 3;
                let b = atom_offsets[k + 1] as usize * 3;
                let fpos = &frame_positions_flat[a..b];
                let fatoms = elems.len();
                let fbonds = bonds::infer_bonds(fpos, elems, fatoms, &empty_bonds);
                for (u, v) in &fbonds {
                    bonds_flat.push(*u);
                    bonds_flat.push(*v);
                }
                let last = *bond_offsets.last().unwrap();
                bond_offsets.push(last + fbonds.len() as u32);
                elements_flat.extend_from_slice(elems);
            }
            (elements_flat, bonds_flat, bond_offsets)
        } else {
            (Vec::new(), Vec::new(), Vec::new())
        };
        let cells_flat = if varies_cell {
            let mut cf = Vec::with_capacity(per_frame_cells.len() * 9);
            for c in &per_frame_cells {
                cf.extend_from_slice(c);
            }
            cf
        } else {
            Vec::new()
        };
        Some(HeteroFrames {
            atom_offsets,
            elements_flat,
            cells_flat,
            bond_offsets,
            bonds_flat,
            varies_atoms,
            varies_cell,
            varies_topology,
            max_atoms: max_atoms as u32,
        })
    } else {
        None
    };

    Ok(ParsedStructure {
        n_atoms,
        positions,
        elements,
        bonds,
        n_file_bonds: 0,
        bond_orders: None,
        box_matrix,
        box_origin: None,
        frame_positions_flat,
        atom_labels: None,
        chain_ids: None,
        bfactors: None,
        vector_channels: vec![],
        ca_indices: vec![],
        ca_chain_ids: vec![],
        ca_res_nums: vec![],
        ca_ss_type: vec![],
        symmetry_ops: Vec::new(),
        scalar_channels: Vec::new(),
        warnings: Vec::new(),
        hetero,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_traj() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/water.traj"
        );
        let data = match std::fs::read(path) {
            Ok(d) => d,
            Err(_) => {
                eprintln!("skipping test: water.traj not found (run generate_test_traj.py)");
                return;
            }
        };
        let result = parse_traj(&data).expect("parse traj");
        assert_eq!(result.n_atoms, 3); // water: O + 2H
        assert!(result.extra_frame_count() >= 1); // at least 1 extra frame beyond frame 0
        assert_eq!(result.positions.len(), 9); // 3 atoms * 3 coords
        assert!(result.elements.contains(&8)); // oxygen
        assert!(result.elements.contains(&1)); // hydrogen
                                               // Regression guard: a uniform trajectory must NOT allocate the hetero
                                               // side-table (this is what keeps the fast path allocation-identical).
        assert!(
            result.hetero.is_none(),
            "uniform .traj must stay on fast path"
        );
    }

    /// Read a fixture, or return `None` (skipping the test) if it's missing.
    fn read_fixture(name: &str) -> Option<Vec<u8>> {
        let path = format!(
            "{}/../../tests/fixtures/{}",
            env!("CARGO_MANIFEST_DIR"),
            name
        );
        match std::fs::read(&path) {
            Ok(d) => Some(d),
            Err(_) => {
                eprintln!("skipping test: {name} not found (run generate_test_traj.py)");
                None
            }
        }
    }

    #[test]
    fn test_parse_traj_variable_cell() {
        let Some(data) = read_fixture("water_var_cell.traj") else {
            return;
        };
        let result = parse_traj(&data).expect("parse var-cell traj");
        assert_eq!(result.n_atoms, 3);
        assert_eq!(result.extra_frame_count(), 4);
        let h = result.hetero.as_ref().expect("hetero present");
        // Only the cell varies — atoms/topology are constant.
        assert!(h.varies_cell);
        assert!(!h.varies_atoms);
        assert!(!h.varies_topology);
        assert_eq!(h.max_atoms, 3);
        // Cell channel populated; topology channels empty (reuse frame 0).
        assert_eq!(h.cells_flat.len(), 4 * 9);
        assert!(h.elements_flat.is_empty());
        assert!(h.bonds_flat.is_empty());
        // The per-frame cell diagonal grows (L = 10 + 0.5*frame).
        let cell0 = result.box_matrix.expect("frame 0 cell")[0];
        let cell_last = result.frame_cell(3).expect("frame 3 cell")[0];
        assert!(
            cell_last > cell0,
            "cell should expand: {cell_last} > {cell0}"
        );
    }

    #[test]
    fn test_parse_traj_variable_atoms() {
        let Some(data) = read_fixture("water_var_atoms.traj") else {
            return;
        };
        let result = parse_traj(&data).expect("parse var-atoms traj");
        assert_eq!(result.n_atoms, 3); // frame 0 = 1 water
        assert_eq!(result.extra_frame_count(), 4);
        let h = result.hetero.as_ref().expect("hetero present");
        assert!(h.varies_atoms);
        assert!(h.varies_topology); // atom-count change implies topology change
        assert_eq!(h.max_atoms, 15); // last frame = 5 waters
                                     // atom_offsets must be strictly increasing (jagged frames).
        for w in h.atom_offsets.windows(2) {
            assert!(w[1] > w[0], "atom_offsets must be monotonic");
        }
        // Extra frames grow: 6, 9, 12, 15 atoms.
        assert_eq!(result.frame_atom_count(0), 6);
        assert_eq!(result.frame_atom_count(3), 15);
        assert_eq!(result.frame(3).len(), 15 * 3);
        // Per-frame elements/bonds present and correctly sized.
        assert_eq!(result.frame_elements(3).expect("elements").len(), 15);
        assert!(!result.frame_bonds(3).expect("bonds").is_empty());
    }

    #[test]
    fn test_cell_raw_bytes() {
        // 72 bytes of cell data starting at offset 4.
        let mut data = vec![0u8; 4];
        data.extend((0u8..72).collect::<Vec<u8>>());
        let json: serde_json::Value =
            serde_json::json!({ "cell.": { "ndarray": [[3, 3], "float64", 4] } });
        let raw = cell_raw_bytes(&data, &json).expect("cell bytes present");
        assert_eq!(raw.len(), 72); // 9 float64
        assert_eq!(raw[0], 0);
        assert_eq!(raw[71], 71);

        // float32 cell → 36 bytes.
        let json32: serde_json::Value =
            serde_json::json!({ "cell.": { "ndarray": [[3, 3], "float32", 4] } });
        assert_eq!(cell_raw_bytes(&data, &json32).unwrap().len(), 36);

        // Missing `cell.` key → None (inline cells take the value-compare path).
        assert!(cell_raw_bytes(&data, &serde_json::json!({})).is_none());
        // Unsupported dtype → None.
        let json_bad: serde_json::Value =
            serde_json::json!({ "cell.": { "ndarray": [[3, 3], "int32", 4] } });
        assert!(cell_raw_bytes(&data, &json_bad).is_none());
    }

    #[test]
    fn test_parse_traj_variable_topology() {
        let Some(data) = read_fixture("water_var_topology.traj") else {
            return;
        };
        let result = parse_traj(&data).expect("parse var-topology traj");
        assert_eq!(result.n_atoms, 3);
        assert_eq!(result.extra_frame_count(), 4);
        let h = result.hetero.as_ref().expect("hetero present");
        assert!(h.varies_topology);
        assert!(!h.varies_atoms); // count stays 3
        assert_eq!(h.max_atoms, 3);
        // Frame 0 is OH2 (O present); frame 1 is OHF (F=9 present).
        assert!(result.elements.contains(&8));
        let f1 = result.frame_elements(0).expect("frame-1 elements");
        assert_eq!(f1.len(), 3);
        assert!(f1.contains(&9), "OHF frame should contain fluorine");
    }
}
