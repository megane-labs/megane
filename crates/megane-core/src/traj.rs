/// ASE .traj (ULM binary format) parser.
///
/// The ULM format stores frames as binary array data + JSON metadata.
/// Each frame contains atomic positions, elements, and optionally cell vectors.
///
/// Offsets inside a ULM file are absolute, so every read goes through a
/// [`FileView`]: the whole file for [`parse_traj`], or just one frame's bytes
/// for [`TrajIndexBuilder`], which indexes a file that stays on disk.
use std::collections::HashSet;

use crate::bonds;
use crate::structure::{FrameChange, HeteroFramesBuilder, ParsedStructure};
use crate::trajectory::{VectorChannel, VectorFrame};

const ULM_MAGIC: &[u8; 8] = b"- of Ulm";

/// Length of the ULM header (magic, tag, version, item count, table offset).
pub const ULM_HEADER_LEN: usize = 48;

/// Bytes of a .traj file from file offset `base` on.
#[derive(Clone, Copy)]
struct FileView<'a> {
    data: &'a [u8],
    base: u64,
}

impl<'a> FileView<'a> {
    fn whole(data: &'a [u8]) -> Self {
        Self { data, base: 0 }
    }

    /// The `len` bytes at file offset `pos`, if this view holds all of them.
    fn get(&self, pos: u64, len: usize) -> Option<&'a [u8]> {
        let start = usize::try_from(pos.checked_sub(self.base)?).ok()?;
        self.data.get(start..start.checked_add(len)?)
    }

    /// File offset just past the bytes held.
    fn end(&self) -> u64 {
        self.base + self.data.len() as u64
    }
}

// ---------- Binary readers ----------

fn read_bytes<const N: usize>(
    data: FileView<'_>,
    pos: u64,
    type_name: &str,
) -> Result<[u8; N], String> {
    data.get(pos, N)
        .and_then(|s| s.try_into().ok())
        .ok_or_else(|| format!("unexpected EOF reading {} at offset {}", type_name, pos))
}

fn read_i64(data: FileView<'_>, pos: u64, little_endian: bool) -> Result<i64, String> {
    let bytes = read_bytes::<8>(data, pos, "i64")?;
    Ok(if little_endian {
        i64::from_le_bytes(bytes)
    } else {
        i64::from_be_bytes(bytes)
    })
}

fn read_f64(data: FileView<'_>, pos: u64, little_endian: bool) -> Result<f64, String> {
    let bytes = read_bytes::<8>(data, pos, "f64")?;
    Ok(if little_endian {
        f64::from_le_bytes(bytes)
    } else {
        f64::from_be_bytes(bytes)
    })
}

fn read_f32_raw(data: FileView<'_>, pos: u64, little_endian: bool) -> Result<f32, String> {
    let bytes = read_bytes::<4>(data, pos, "f32")?;
    Ok(if little_endian {
        f32::from_le_bytes(bytes)
    } else {
        f32::from_be_bytes(bytes)
    })
}

fn read_i32(data: FileView<'_>, pos: u64, little_endian: bool) -> Result<i32, String> {
    let bytes = read_bytes::<4>(data, pos, "i32")?;
    Ok(if little_endian {
        i32::from_le_bytes(bytes)
    } else {
        i32::from_be_bytes(bytes)
    })
}

// ---------- Array reading helpers ----------

/// An ndarray reference from a frame's JSON: `{"ndarray": [shape, dtype, offset]}`.
struct NdArrayRef {
    shape: Vec<usize>,
    dtype: String,
    offset: u64,
}

impl NdArrayRef {
    fn len(&self) -> usize {
        self.shape.iter().product()
    }

    /// Bytes per element of a dtype this parser reads, if it reads it.
    fn elem_size(&self) -> Option<usize> {
        match self.dtype.as_str() {
            "float64" | "int64" => Some(8),
            "float32" | "int32" => Some(4),
            "int16" => Some(2),
            "uint8" | "int8" => Some(1),
            _ => None,
        }
    }

    /// The array's raw bytes, if `data` holds them.
    fn bytes<'a>(&self, data: FileView<'a>) -> Option<&'a [u8]> {
        let len = self.len().checked_mul(self.elem_size()?)?;
        data.get(self.offset, len)
    }
}

/// Read an ndarray from binary data given its reference.
/// Returns values as Vec<f64> (converted from the source dtype).
fn read_ndarray_f64(
    data: FileView<'_>,
    array: &NdArrayRef,
    little_endian: bool,
) -> Result<Vec<f64>, String> {
    let n_elements = array.len();
    let offset = array.offset;
    let mut result = Vec::with_capacity(n_elements.min(data.data.len()));

    match array.dtype.as_str() {
        "float64" => {
            for i in 0..n_elements as u64 {
                result.push(read_f64(data, offset + i * 8, little_endian)?);
            }
        }
        "float32" => {
            for i in 0..n_elements as u64 {
                result.push(read_f32_raw(data, offset + i * 4, little_endian)? as f64);
            }
        }
        dtype => return Err(format!("unsupported float dtype: {}", dtype)),
    }
    Ok(result)
}

/// Read an ndarray as integers (for atomic numbers etc.)
fn read_ndarray_int(
    data: FileView<'_>,
    array: &NdArrayRef,
    little_endian: bool,
) -> Result<Vec<i64>, String> {
    let n_elements = array.len();
    let offset = array.offset;
    let mut result = Vec::with_capacity(n_elements.min(data.data.len()));

    match array.dtype.as_str() {
        "int64" => {
            for i in 0..n_elements as u64 {
                result.push(read_i64(data, offset + i * 8, little_endian)?);
            }
        }
        "int32" => {
            for i in 0..n_elements as u64 {
                result.push(read_i32(data, offset + i * 4, little_endian)? as i64);
            }
        }
        "uint8" => {
            let bytes = array
                .bytes(data)
                .ok_or("unexpected EOF reading uint8 array")?;
            result.extend(bytes.iter().map(|&b| b as i64));
        }
        "int8" => {
            let bytes = array
                .bytes(data)
                .ok_or("unexpected EOF reading int8 array")?;
            result.extend(bytes.iter().map(|&b| b as i8 as i64));
        }
        "int16" => {
            for i in 0..n_elements as u64 {
                let bytes: [u8; 2] = read_bytes::<2>(data, offset + i * 2, "i16")
                    .map_err(|_| "unexpected EOF reading int16 array".to_string())?;
                let val = if little_endian {
                    i16::from_le_bytes(bytes)
                } else {
                    i16::from_be_bytes(bytes)
                };
                result.push(val as i64);
            }
        }
        dtype => return Err(format!("unsupported integer dtype: {}", dtype)),
    }
    Ok(result)
}

// ---------- JSON metadata parsing ----------

/// Extract ndarray info from a JSON value like {"ndarray": [shape, dtype, offset]}
fn parse_ndarray_ref(value: &serde_json::Value) -> Option<NdArrayRef> {
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
    let offset = arr[2].as_u64()?;

    Some(NdArrayRef {
        shape,
        dtype,
        offset,
    })
}

/// Read the length of the JSON metadata section at file offset `offset`.
fn read_json_len(data: FileView<'_>, offset: u64, little_endian: bool) -> Result<usize, String> {
    let len = read_i64(data, offset, little_endian)?;
    usize::try_from(len).map_err(|_| format!("negative JSON metadata length at offset {}", offset))
}

/// Read JSON metadata section at the given file offset.
/// Returns the parsed JSON value.
fn read_json_metadata(
    data: FileView<'_>,
    offset: u64,
    little_endian: bool,
) -> Result<serde_json::Value, String> {
    let json_len = read_json_len(data, offset, little_endian)?;
    let json_start = offset + 8;
    let bytes = data.get(json_start, json_len).ok_or_else(|| {
        format!(
            "JSON metadata extends past EOF: {}+{} > {}",
            json_start,
            json_len,
            data.end()
        )
    })?;
    let json_str =
        std::str::from_utf8(bytes).map_err(|e| format!("invalid UTF-8 in JSON: {}", e))?;
    serde_json::from_str(json_str).map_err(|e| format!("JSON parse error: {}", e))
}

/// The byte order of a frame's arrays (`_little_endian`, which may differ
/// from the header's).
fn arrays_little_endian(json: &serde_json::Value) -> bool {
    json.get("_little_endian")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// Extract a per-atom `(n, 3)` float array stored under `key` in a frame's
/// JSON object: as an ndarray reference (`"<key>."`) or an inline list.
/// `None` when the frame does not carry it.
fn extract_vec3(
    data: FileView<'_>,
    json: &serde_json::Value,
    key: &str,
    little_endian: bool,
) -> Option<Result<Vec<f32>, String>> {
    // Try the "<key>." ndarray reference
    if let Some(array) = json.get(format!("{key}.")).and_then(parse_ndarray_ref) {
        return Some(
            read_ndarray_f64(data, &array, little_endian)
                .map(|raw| raw.iter().map(|&v| v as f32).collect()),
        );
    }

    // Try "<key>" as inline list
    let arr = json.get(key).and_then(|v| v.as_array())?;
    let mut values = Vec::new();
    for row in arr {
        if let Some(coords) = row.as_array() {
            for c in coords {
                values.push(c.as_f64().unwrap_or(0.0) as f32);
            }
        }
    }
    (!values.is_empty()).then_some(Ok(values))
}

/// Extract positions (float array) from a frame's JSON metadata.
fn extract_positions(
    data: FileView<'_>,
    json: &serde_json::Value,
    little_endian: bool,
) -> Result<Vec<f32>, String> {
    extract_vec3(data, json, "positions", little_endian)
        .unwrap_or_else(|| Err("no positions found in frame".into()))
}

/// The per-atom vector arrays a frame may carry besides its positions, as
/// `(channel name, parent object, key)`: ASE writes `momenta` with the atoms and
/// the calculator's `forces` in its `calculator.` child object. Momenta are
/// kept as momenta: turning them into velocities needs masses the file
/// usually leaves to ASE's element table.
const TRAJ_VECTOR_CHANNELS: [(&str, Option<&str>, &str); 2] = [
    ("momenta", None, "momenta"),
    ("force", Some("calculator."), "forces"),
];

/// Frame `json`'s array for [`TRAJ_VECTOR_CHANNELS`] entry `k`, if it
/// carries one of `n_atoms * 3` floats.
fn extract_frame_vector(
    data: FileView<'_>,
    json: &serde_json::Value,
    k: usize,
    n_atoms: usize,
    little_endian: bool,
) -> Option<Vec<f32>> {
    let (_, parent, key) = TRAJ_VECTOR_CHANNELS[k];
    let obj = match parent {
        Some(p) => json.get(p)?,
        None => json,
    };
    extract_vec3(data, obj, key, little_endian)?
        .ok()
        .filter(|v| v.len() == n_atoms * 3)
}

/// Extract atomic numbers from a frame's JSON metadata.
fn extract_numbers(
    data: FileView<'_>,
    json: &serde_json::Value,
    little_endian: bool,
) -> Result<Vec<u8>, String> {
    // Try "numbers." key (ndarray reference)
    if let Some(val) = json.get("numbers.") {
        if let Some(array) = parse_ndarray_ref(val) {
            let raw = read_ndarray_int(data, &array, little_endian)?;
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
fn cell_raw_bytes<'a>(data: FileView<'a>, json: &serde_json::Value) -> Option<&'a [u8]> {
    let array = parse_ndarray_ref(json.get("cell.")?)?;
    match array.dtype.as_str() {
        "float64" | "float32" => array.bytes(data),
        _ => None,
    }
}

/// Extract cell matrix from a frame's JSON metadata.
fn extract_cell(
    data: FileView<'_>,
    json: &serde_json::Value,
    little_endian: bool,
) -> Option<[f32; 9]> {
    // Try "cell." key (ndarray reference)
    if let Some(val) = json.get("cell.") {
        if let Some(array) = parse_ndarray_ref(val) {
            if let Ok(raw) = read_ndarray_f64(data, &array, little_endian) {
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

/// The ULM header fields the parser needs.
#[derive(Clone, Copy)]
struct UlmHeader {
    little_endian: bool,
    nitems: usize,
    pos0: u64,
}

/// Validate the magic and read the header (the first 48 bytes).
fn read_ulm_header(data: &[u8]) -> Result<UlmHeader, String> {
    if data.len() < ULM_HEADER_LEN {
        return Err("file too small for ULM header".into());
    }

    // Validate magic
    if &data[0..8] != ULM_MAGIC {
        return Err("not a ULM file (bad magic)".into());
    }

    // Determine endianness: ULM header integers are written in the machine's
    // native byte order.  We try little-endian first (the common case) and
    // fall back to big-endian if the values look unreasonable. Every known
    // version is supported, so the version is only used for this check.
    let view = FileView::whole(data);
    let hdr_v = read_bytes::<8>(view, 24, "version")?;
    let hdr_n = read_bytes::<8>(view, 32, "nitems")?;
    let hdr_p = read_bytes::<8>(view, 40, "pos0")?;

    let v_le = i64::from_le_bytes(hdr_v);
    let n_le = i64::from_le_bytes(hdr_n);
    let p_le = i64::from_le_bytes(hdr_p);

    if v_le > 0 && v_le <= 10 && n_le > 0 && n_le < 1_000_000_000 && p_le > 0 {
        return Ok(UlmHeader {
            little_endian: true,
            nitems: n_le as usize,
            pos0: p_le as u64,
        });
    }
    let v_be = i64::from_be_bytes(hdr_v);
    let n_be = i64::from_be_bytes(hdr_n);
    let p_be = i64::from_be_bytes(hdr_p);
    if v_be > 0 && v_be <= 10 && n_be > 0 && n_be < 1_000_000_000 && p_be > 0 {
        Ok(UlmHeader {
            little_endian: false,
            nitems: n_be as usize,
            pos0: p_be as u64,
        })
    } else {
        Err(format!(
            "cannot determine ULM endianness (version_le={}, version_be={})",
            v_le, v_be
        ))
    }
}

/// Read the offset table (`nitems` entries at `pos0`): where each frame's JSON sits.
fn read_offsets(data: FileView<'_>, header: UlmHeader) -> Result<Vec<u64>, String> {
    let mut offsets = Vec::with_capacity(header.nitems.min(data.data.len() / 8));
    for i in 0..header.nitems as u64 {
        let off = read_i64(data, header.pos0 + i * 8, header.little_endian)?;
        offsets.push(u64::try_from(off).map_err(|_| format!("negative offset for frame {}", i))?);
    }
    Ok(offsets)
}

/// Frame 0's metadata and the topology it defines.
struct Frame0 {
    json: serde_json::Value,
    /// Byte order of the frame's arrays (`_little_endian`, which may differ
    /// from the header's).
    array_le: bool,
    elements: Vec<u8>,
    box_matrix: Option<[f32; 9]>,
}

/// Read frame 0 (its JSON at `offset`, and the elements and cell it carries).
fn read_frame0(
    data: FileView<'_>,
    offset: u64,
    little_endian_header: bool,
) -> Result<Frame0, String> {
    let json = read_json_metadata(data, offset, little_endian_header)?;
    let array_le = arrays_little_endian(&json);

    let elements = extract_numbers(data, &json, array_le)?;
    if elements.is_empty() {
        return Err("zero atoms in first frame".into());
    }
    let box_matrix = extract_cell(data, &json, array_le);
    Ok(Frame0 {
        json,
        array_le,
        elements,
        box_matrix,
    })
}

/// Check that frame `frame` stores one position per atom of its `numbers`:
/// a frame whose arrays disagree is corrupt, and reading it would index past
/// the shorter one.
fn check_frame_positions(frame: usize, n_coords: usize, n_atoms: usize) -> Result<(), String> {
    if Some(n_coords) != n_atoms.checked_mul(3) {
        return Err(format!(
            "frame {frame} has {n_coords} coordinates for {n_atoms} atoms (expected {})",
            n_atoms.saturating_mul(3)
        ));
    }
    Ok(())
}

/// Frame 0's snapshot: its positions, elements and cell, and bonds inferred
/// from them (the format carries none).
fn frame0_structure(data: FileView<'_>, frame0: Frame0) -> Result<ParsedStructure, String> {
    let Frame0 {
        json,
        array_le,
        elements,
        box_matrix,
    } = frame0;
    let positions = extract_positions(data, &json, array_le)?;
    check_frame_positions(0, positions.len(), elements.len())?;
    let n_atoms = elements.len();
    let bonds = bonds::infer_bonds(&positions, &elements, n_atoms, &HashSet::new());
    Ok(ParsedStructure {
        n_atoms,
        positions,
        elements,
        bonds,
        n_file_bonds: 0,
        box_matrix,
        ..Default::default()
    })
}

/// How frame 0 stores its cell, to tell later frames' unchanged cells apart
/// cheaply. ASE stores the cell either as a `cell.` ndarray reference
/// (large/aligned data → compare the raw bytes; the JSON itself can't be
/// compared because the byte offset differs per frame) or inline as a small
/// `cell` JSON array (→ compare the parsed value).
struct CellSignature {
    bytes: Option<Vec<u8>>,
    inline: Option<serde_json::Value>,
}

impl CellSignature {
    fn of(data: FileView<'_>, json: &serde_json::Value) -> Self {
        Self {
            bytes: cell_raw_bytes(data, json).map(<[u8]>::to_vec),
            inline: json.get("cell").cloned(),
        }
    }

    /// The cell a later frame carries: `None` when it omits one (the previous
    /// cell carries forward), else whether it differs from frame 0's and, if
    /// it does, its value. The value is only decoded when it differs.
    fn compare(
        &self,
        data: FileView<'_>,
        json: &serde_json::Value,
        little_endian: bool,
    ) -> Option<(bool, Option<[f32; 9]>)> {
        let has_ndarray_cell = json.get("cell.").is_some();
        if !has_ndarray_cell && json.get("cell").is_none() {
            return None;
        }
        let changed = if has_ndarray_cell {
            cell_raw_bytes(data, json) != self.bytes.as_deref()
        } else {
            json.get("cell") != self.inline.as_ref()
        };
        Some((
            changed,
            changed
                .then(|| extract_cell(data, json, little_endian))
                .flatten(),
        ))
    }
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
    let header = read_ulm_header(data)?;
    let little_endian_header = header.little_endian;
    let view = FileView::whole(data);

    // Read offset table
    if header.pos0 + header.nitems as u64 * 8 > data.len() as u64 {
        return Err("offset table extends past EOF".into());
    }
    let offsets = read_offsets(view, header)?;
    if offsets.is_empty() {
        return Err("no frames in .traj file".into());
    }

    // Parse first frame to get element info
    let Frame0 {
        json: first_json,
        elements,
        box_matrix,
        ..
    } = read_frame0(view, offsets[0], little_endian_header)?;
    let n_atoms = elements.len();

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
    let cell0 = CellSignature::of(view, &first_json);

    let extra = offsets.len().saturating_sub(1);
    let mut positions: Vec<f32> = Vec::new();
    // The table length is a header claim and later frames may be smaller than
    // frame 0, so reserve no more frame-0-sized frames than the file could
    // hold as float32 positions; past that the buffer grows as frames arrive.
    let fit = data.len() / n_atoms.saturating_mul(12).max(1);
    let mut frames = HeteroFramesBuilder::with_capacity(n_atoms, extra.min(fit));
    // Per-atom momenta / forces each frame carries (TRAJ_VECTOR_CHANNELS order).
    let mut vector_frames: Vec<Vec<VectorFrame>> =
        TRAJ_VECTOR_CHANNELS.iter().map(|_| Vec::new()).collect();

    for (i, &off) in offsets.iter().enumerate() {
        let json = if i == 0 {
            first_json.clone()
        } else {
            read_json_metadata(view, off, little_endian_header)?
        };
        let frame_le = arrays_little_endian(&json);

        // Refresh carry-forward numbers/cell when this frame re-emits them.
        // These are this frame's variation verdicts (a numbers change against
        // the carried-forward list; a cell whose raw bytes / inline value
        // differ from frame 0's), handed to the builder below.
        let mut change = FrameChange::default();
        if i > 0 {
            // `numbers` appears only in header frames (rare), so a single
            // presence check keeps the uniform path a cheap O(1) miss.
            if json.get("numbers.").is_some() || json.get("numbers").is_some() {
                if let Ok(nums) = extract_numbers(view, &json, frame_le) {
                    if nums != cur_numbers {
                        change.topology = true;
                    }
                    cur_numbers = nums;
                }
            }
            // `cell` is written every frame. Detect the unchanged (uniform)
            // case cheaply and decode only when the cell actually differs.
            // A frame that omits the cell carries the previous value forward.
            if let Some((changed, cell)) = cell0.compare(view, &json, frame_le) {
                change.cell = changed;
                // byte/value-identical to frame 0, or the changed cell
                cur_cell = if changed { cell } else { box_matrix };
            }
        }

        let pos = extract_positions(view, &json, frame_le)?;
        // Each frame's positions belong to its (carried-forward) numbers.
        check_frame_positions(i, pos.len(), cur_numbers.len())?;
        for (k, channel) in vector_frames.iter_mut().enumerate() {
            if let Some(vectors) = extract_frame_vector(view, &json, k, pos.len() / 3, frame_le) {
                channel.push(VectorFrame { frame: i, vectors });
            }
        }
        if i == 0 {
            positions = pos;
            continue;
        }

        // Extra frame `i - 1`. Per-frame elements are the carried-forward
        // numbers (the builder keeps the snapshot aligned with the frame's atom
        // count even if a header is malformed — ASE always co-writes numbers
        // with a count change).
        frames.push_frame(&pos, || cur_numbers.clone(), cur_cell, change);
    }

    // Infer bonds from first frame (frame-0 topology lives on the struct).
    let empty_bonds: HashSet<(u32, u32)> = HashSet::new();
    let bonds = bonds::infer_bonds(&positions, &elements, n_atoms, &empty_bonds);

    // Momenta / forces become frame-synced vector channels when every frame
    // carries them with a fixed atom count (channels assume a fixed per-atom
    // stride); otherwise frame 0's values are kept and a warning says so, as
    // for extXYZ properties.
    let complete_frames = offsets.len();
    let varies_atoms = frames.varies_atoms();
    let mut vector_channels: Vec<VectorChannel> = Vec::new();
    let mut partial: Vec<&str> = Vec::new();
    for ((name, _, _), mut channel_frames) in TRAJ_VECTOR_CHANNELS.into_iter().zip(vector_frames) {
        if channel_frames.is_empty() {
            continue;
        }
        if varies_atoms || channel_frames.len() != complete_frames {
            partial.push(name);
            channel_frames.retain(|f| f.frame == 0);
            if channel_frames.is_empty() {
                continue;
            }
        }
        vector_channels.push(VectorChannel {
            name: name.to_string(),
            frames: channel_frames,
        });
    }
    let mut warnings = Vec::new();
    if !partial.is_empty() {
        warnings.push(format!(
            "per-atom arrays not stored for every frame (or the atom count changes): {}; only frame-0 values were kept",
            partial.join(", ")
        ));
    }

    // Assemble the heterogeneous side-table only when some channel varies.
    let (frame_positions_flat, hetero) = frames.finish(&elements, box_matrix);

    Ok(ParsedStructure {
        n_atoms,
        positions,
        elements,
        bonds,
        n_file_bonds: 0,
        box_matrix,
        frame_positions_flat,
        vector_channels,
        warnings,
        hetero,
        ..Default::default()
    })
}

/// Parse frame 0 of an ASE .traj from the start and the end of the file
/// alone, for a first paint before the rest of the file has arrived.
///
/// Frame 0 is written right after the 48-byte header, but the offset table
/// that locates it sits at `pos0`, which ASE rewrites near the end of the file
/// as frames are appended. `head` is the file's first bytes and `tail` its
/// last `tail.len()` bytes of `total_len`; the table's first entry is read
/// from whichever holds it, everything else from `head`. Any read that falls
/// outside them fails (as an EOF) rather than reading a gap, so the caller
/// falls back to the full [`parse_traj`].
///
/// The result is exactly [`parse_traj`]'s frame-0 snapshot (positions,
/// elements, cell, inferred bonds) without the extra frames.
pub fn parse_traj_frame0(
    head: &[u8],
    tail: &[u8],
    total_len: usize,
) -> Result<ParsedStructure, String> {
    let header = read_ulm_header(head)?;
    if header.pos0 + header.nitems as u64 * 8 > total_len as u64 {
        return Err("offset table extends past EOF".into());
    }
    let tail_start = total_len
        .checked_sub(tail.len())
        .ok_or("tail is longer than the file")? as u64;
    let head = FileView::whole(head);
    let tail = FileView {
        data: tail,
        base: tail_start,
    };
    let offset0 = if head.get(header.pos0, 8).is_some() {
        read_i64(head, header.pos0, header.little_endian)?
    } else if header.pos0 >= tail_start {
        read_i64(tail, header.pos0, header.little_endian)?
    } else {
        return Err("the frame offset table is in neither the head nor the tail".into());
    };
    let offset0 = u64::try_from(offset0).map_err(|_| "negative offset for frame 0")?;
    let frame0 = read_frame0(head, offset0, header.little_endian)?;
    frame0_structure(head, frame0)
}

/// The index of an ASE .traj that stays in its file, built one frame at a
/// time from just the bytes each frame takes, so the file is never held
/// whole: the host reads the header ([`TrajIndexBuilder::new`]), then the
/// offset table ([`TrajIndexBuilder::set_table`]), then every frame's bytes in
/// order ([`TrajIndexBuilder::add_frame`]), and afterwards decodes a frame from
/// its bytes again when it is shown ([`TrajIndexBuilder::decode`]).
///
/// A frame's bytes are [`TrajIndexBuilder::frame_range`]: from the end of the
/// previous frame's JSON (the start of the file for frame 0) to the end of its
/// own JSON. ASE writes a frame's arrays right before its JSON, so they hold
/// them; a file whose arrays sit elsewhere is rejected, and the host parses it
/// whole instead.
///
/// The index holds frame 0's topology, each frame's byte range and, when the
/// cell changes between frames (an NPT run), each frame's cell. A frame whose
/// atom count or elements differ from frame 0's makes the file
/// [`heterogeneous`](TrajIndexBuilder::heterogeneous): the per-frame topology
/// is then the full parse's job.
pub struct TrajIndexBuilder {
    header: UlmHeader,
    file_len: u64,
    offsets: Vec<u64>,
    /// End of each added frame's JSON; frame `i`'s bytes start where frame `i - 1`'s end.
    ends: Vec<u64>,
    n_atoms: usize,
    cur_numbers: Vec<u8>,
    box0: Option<[f32; 9]>,
    cell0: Option<CellSignature>,
    cur_cell: Option<[f32; 9]>,
    /// Every frame's cell, once one differs from frame 0's (the frames before
    /// it backfilled with frame 0's).
    cells: Option<Vec<Option<[f32; 9]>>>,
    heterogeneous: bool,
    frame0: Option<ParsedStructure>,
}

impl TrajIndexBuilder {
    /// Read the header from the file's first bytes (at least
    /// [`ULM_HEADER_LEN`]) of `file_len`.
    pub fn new(head: &[u8], file_len: u64) -> Result<Self, String> {
        let header = read_ulm_header(head)?;
        if header.pos0 + header.nitems as u64 * 8 > file_len {
            return Err("offset table extends past EOF".into());
        }
        Ok(Self {
            header,
            file_len,
            offsets: Vec::new(),
            ends: Vec::new(),
            n_atoms: 0,
            cur_numbers: Vec::new(),
            box0: None,
            cell0: None,
            cur_cell: None,
            cells: None,
            heterogeneous: false,
            frame0: None,
        })
    }

    /// The offset table's byte range, for [`set_table`](Self::set_table).
    pub fn table_range(&self) -> (u64, u64) {
        let start = self.header.pos0;
        (start, start + self.header.nitems as u64 * 8)
    }

    /// Read the offset table from its bytes ([`table_range`](Self::table_range)).
    pub fn set_table(&mut self, table: &[u8]) -> Result<(), String> {
        let view = FileView {
            data: table,
            base: self.header.pos0,
        };
        let offsets = read_offsets(view, self.header)?;
        if offsets.is_empty() {
            return Err("no frames in .traj file".into());
        }
        if offsets.iter().any(|&o| o + 8 > self.file_len) {
            return Err("frame offset past EOF".into());
        }
        if offsets.windows(2).any(|w| w[1] <= w[0]) {
            return Err("frames are not stored in order".into());
        }
        self.offsets = offsets;
        Ok(())
    }

    /// Frames in the file, frame 0 included.
    pub fn n_items(&self) -> usize {
        self.offsets.len()
    }

    /// Where frame `item`'s JSON sits: its length is the 8 bytes there.
    pub fn json_offset(&self, item: usize) -> Option<u64> {
        self.offsets.get(item).copied()
    }

    /// The length of a frame's JSON, from the 8 bytes at its
    /// [`json_offset`](Self::json_offset).
    pub fn json_len(&self, bytes: &[u8]) -> Result<usize, String> {
        read_json_len(FileView::whole(bytes), 0, self.header.little_endian)
    }

    /// Where the next frame to add starts: the end of the previous one.
    pub fn next_start(&self) -> u64 {
        self.ends.last().copied().unwrap_or(0)
    }

    /// Add the next frame from its bytes, from [`next_start`](Self::next_start)
    /// to the end of its JSON.
    pub fn add_frame(&mut self, bytes: &[u8]) -> Result<(), String> {
        let item = self.ends.len();
        let offset = *self
            .offsets
            .get(item)
            .ok_or("every frame is already added")?;
        let view = FileView {
            data: bytes,
            base: self.next_start(),
        };
        let json_len = read_json_len(view, offset, self.header.little_endian)?;
        let json = read_json_metadata(view, offset, self.header.little_endian)?;
        let frame_le = arrays_little_endian(&json);
        let n_coords = self.positions_in_view(view, &json, item)?;

        if item == 0 {
            let frame0 = read_frame0(view, offset, self.header.little_endian)?;
            self.cell0 = Some(CellSignature::of(view, &frame0.json));
            self.box0 = frame0.box_matrix;
            self.cur_cell = frame0.box_matrix;
            self.cur_numbers = frame0.elements.clone();
            let structure = frame0_structure(view, frame0)?;
            self.n_atoms = structure.n_atoms;
            self.frame0 = Some(structure);
        } else {
            // A frame re-emits its numbers only when they change (see
            // `parse_traj`); the atom count changes with them.
            if json.get("numbers.").is_some() || json.get("numbers").is_some() {
                let nums = extract_numbers(view, &json, frame_le)?;
                if nums != self.cur_numbers {
                    self.heterogeneous = true;
                }
                self.cur_numbers = nums;
            }
            check_frame_positions(item, n_coords, self.cur_numbers.len())?;
            let cell0 = self.cell0.as_ref().ok_or("frame 0 is not added yet")?;
            if let Some((changed, cell)) = cell0.compare(view, &json, frame_le) {
                self.cur_cell = if changed { cell } else { self.box0 };
                if changed && self.cells.is_none() {
                    self.cells = Some(vec![self.box0; item - 1]);
                }
            }
            if let Some(cells) = self.cells.as_mut() {
                // A frame without a cell after frames with one is per-frame
                // topology too, for the full parse.
                if self.cur_cell.is_none() {
                    self.heterogeneous = true;
                }
                cells.push(self.cur_cell);
            }
        }
        if n_coords != self.n_atoms * 3 {
            self.heterogeneous = true;
        }
        self.ends.push(offset + 8 + json_len as u64);
        Ok(())
    }

    /// The number of coordinates frame `item` stores, checking that its
    /// positions array lies in the frame's bytes.
    fn positions_in_view(
        &self,
        view: FileView<'_>,
        json: &serde_json::Value,
        item: usize,
    ) -> Result<usize, String> {
        if let Some(array) = json.get("positions.").and_then(parse_ndarray_ref) {
            if array.elem_size().is_none() || array.bytes(view).is_none() {
                return Err(format!("frame {item}'s positions are not stored with it"));
            }
            return Ok(array.len());
        }
        let inline = extract_positions(view, json, true)?;
        Ok(inline.len())
    }

    /// Frame 0's snapshot, once frame 0 is added (taken: a second call gets `None`).
    pub fn take_frame0(&mut self) -> Option<ParsedStructure> {
        self.frame0.take()
    }

    /// Atoms in frame 0.
    pub fn n_atoms(&self) -> usize {
        self.n_atoms
    }

    /// Frames after frame 0.
    pub fn n_frames(&self) -> usize {
        self.offsets.len().saturating_sub(1)
    }

    /// Whether a frame's atom count or elements differ from frame 0's.
    pub fn heterogeneous(&self) -> bool {
        self.heterogeneous
    }

    /// Whether the cell changes between frames, so each frame carries its own.
    pub fn varying_cells(&self) -> bool {
        self.cells.is_some()
    }

    /// Extra frame `frame`'s cell when the cell varies (0-indexed after frame 0).
    pub fn frame_cell(&self, frame: usize) -> Option<[f32; 9]> {
        *self.cells.as_ref()?.get(frame)?
    }

    /// The byte range holding extra frame `frame` (0-indexed after frame 0).
    pub fn frame_range(&self, frame: usize) -> Option<(u64, u64)> {
        let end = *self.ends.get(frame + 1)?;
        Some((self.ends[frame], end))
    }

    /// Whether every frame has been added.
    pub fn is_complete(&self) -> bool {
        !self.offsets.is_empty() && self.ends.len() == self.offsets.len()
    }

    /// Decode extra frame `frame`'s positions from its bytes
    /// ([`frame_range`](Self::frame_range)).
    pub fn decode(&self, frame: usize, bytes: &[u8]) -> Result<Vec<f32>, String> {
        let (start, _) = self.frame_range(frame).ok_or("frame index out of range")?;
        let view = FileView {
            data: bytes,
            base: start,
        };
        let json = read_json_metadata(view, self.offsets[frame + 1], self.header.little_endian)?;
        let positions = extract_positions(view, &json, arrays_little_endian(&json))?;
        if positions.len() != self.n_atoms * 3 {
            return Err(format!(
                "frame {} has {} coordinates, expected {}",
                frame + 1,
                positions.len(),
                self.n_atoms * 3
            ));
        }
        Ok(positions)
    }
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

    /// `parse_traj_frame0` on a head/tail split must reproduce `parse_traj`'s
    /// frame-0 snapshot exactly.
    fn assert_frame0_matches(data: &[u8], head_len: usize, tail_len: usize) {
        let full = parse_traj(data).expect("full parse");
        let head = &data[..head_len.min(data.len())];
        let tail = &data[data.len() - tail_len.min(data.len())..];
        let partial = parse_traj_frame0(head, tail, data.len()).expect("frame-0 parse");
        assert_eq!(partial.n_atoms, full.n_atoms);
        assert_eq!(partial.positions, full.positions);
        assert_eq!(partial.elements, full.elements);
        assert_eq!(partial.bonds, full.bonds);
        assert_eq!(partial.box_matrix, full.box_matrix);
        assert_eq!(partial.extra_frame_count(), 0);
    }

    #[test]
    fn test_parse_traj_frame0_matches_full_parse() {
        for name in ["water.traj", "bond_change.traj"] {
            let Some(data) = read_fixture(name) else {
                continue;
            };
            // The whole file as the head; a head holding only frame 0 plus the
            // tail holding the offset table.
            assert_frame0_matches(&data, data.len(), 0);
            let header = read_ulm_header(&data).unwrap();
            let table_len = data.len() - header.pos0 as usize;
            let frame0_end = read_i64(
                FileView::whole(&data),
                header.pos0 + 8,
                header.little_endian,
            )
            .map(|o| o as usize)
            .unwrap_or(data.len());
            assert_frame0_matches(&data, frame0_end, table_len);
        }
    }

    #[test]
    fn test_parse_traj_frame0_rejects_what_it_cannot_see() {
        let Some(data) = read_fixture("water.traj") else {
            return;
        };
        let header = read_ulm_header(&data).unwrap();
        // The offset table falls in the gap between head and tail.
        let err = parse_traj_frame0(&data[..64], &data[data.len() - 1..], data.len())
            .err()
            .expect("table in the gap must fail");
        assert!(err.contains("neither the head nor the tail"), "{err}");
        // Frame 0's JSON is past the head: reported as EOF, not read from a gap.
        let tail = &data[header.pos0 as usize..];
        assert!(parse_traj_frame0(&data[..64], tail, data.len()).is_err());
        // A tail longer than the file, a table past EOF, and a non-ULM head.
        assert!(parse_traj_frame0(&data, &data, 10).is_err());
        assert!(parse_traj_frame0(&data, &[], header.pos0 as usize).is_err());
        assert!(parse_traj_frame0(
            b"not a ulm file at all, but long enough to hold a header....",
            &[],
            60
        )
        .is_err());
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

    /// The offset table's length is a header claim, so the extra-frame buffer
    /// is reserved for no more frames of frame 0's size than the file's bytes
    /// could hold. A 100 000-atom frame 0 followed by 20 000 one-atom frames
    /// used to reserve 6·10^9 floats (24 GB) up front and abort the process.
    #[test]
    fn extra_frames_are_not_reserved_at_frame0_size_beyond_the_file() {
        const N: usize = 100_000;
        const K: usize = 20_000;
        let mut out = vec![0u8; ULM_HEADER_LEN];
        out[..8].copy_from_slice(ULM_MAGIC);
        out[24..32].copy_from_slice(&1i64.to_le_bytes());
        out[32..40].copy_from_slice(&((K + 1) as i64).to_le_bytes());
        let numbers_at = out.len();
        out.extend(std::iter::repeat_n(1u8, N));
        let positions_at = out.len();
        for i in 0..N {
            for v in [i as f32 * 5.0, 0.0, 0.0] {
                out.extend(v.to_le_bytes());
            }
        }
        let mut offsets = Vec::with_capacity(K + 1);
        let mut push_json = |out: &mut Vec<u8>, json: &str| {
            offsets.push(out.len() as i64);
            out.extend((json.len() as i64).to_le_bytes());
            out.extend(json.as_bytes());
        };
        push_json(
            &mut out,
            &format!(
                r#"{{"numbers.": {{"ndarray": [[{N}], "uint8", {numbers_at}]}}, "positions.": {{"ndarray": [[{N}, 3], "float32", {positions_at}]}}}}"#
            ),
        );
        for _ in 0..K {
            push_json(&mut out, r#"{"numbers": [1], "positions": [[0, 0, 0]]}"#);
        }
        let pos0 = out.len() as i64;
        out[40..48].copy_from_slice(&pos0.to_le_bytes());
        for o in offsets {
            out.extend(o.to_le_bytes());
        }

        let s = parse_traj(&out).expect("parse");
        assert_eq!(s.n_atoms, N);
        assert_eq!(s.extra_frame_count(), K);
        assert!(s.hetero.as_ref().expect("atom count varies").varies_atoms);
        assert!(
            s.frame_positions_flat.capacity() * 4 <= out.len(),
            "reserved {} floats for a {}-byte file",
            s.frame_positions_flat.capacity(),
            out.len()
        );
    }

    #[test]
    fn test_cell_raw_bytes() {
        // 72 bytes of cell data starting at offset 4.
        let mut data = vec![0u8; 4];
        data.extend((0u8..72).collect::<Vec<u8>>());
        let json: serde_json::Value =
            serde_json::json!({ "cell.": { "ndarray": [[3, 3], "float64", 4] } });
        let raw = cell_raw_bytes(FileView::whole(&data), &json).expect("cell bytes present");
        assert_eq!(raw.len(), 72); // 9 float64
        assert_eq!(raw[0], 0);
        assert_eq!(raw[71], 71);

        // float32 cell → 36 bytes.
        let json32: serde_json::Value =
            serde_json::json!({ "cell.": { "ndarray": [[3, 3], "float32", 4] } });
        assert_eq!(
            cell_raw_bytes(FileView::whole(&data), &json32)
                .unwrap()
                .len(),
            36
        );

        // Missing `cell.` key → None (inline cells take the value-compare path).
        assert!(cell_raw_bytes(FileView::whole(&data), &serde_json::json!({})).is_none());
        // Unsupported dtype → None.
        let json_bad: serde_json::Value =
            serde_json::json!({ "cell.": { "ndarray": [[3, 3], "int32", 4] } });
        assert!(cell_raw_bytes(FileView::whole(&data), &json_bad).is_none());
    }

    /// Index `data` the way a host reading the file frame by frame does.
    fn index_in_frames(data: &[u8]) -> Result<TrajIndexBuilder, String> {
        let mut index = TrajIndexBuilder::new(&data[..ULM_HEADER_LEN], data.len() as u64)?;
        let (start, end) = index.table_range();
        index.set_table(&data[start as usize..end as usize])?;
        for item in 0..index.n_items() {
            let at = index.json_offset(item).unwrap() as usize;
            let len = index.json_len(&data[at..at + 8])?;
            index.add_frame(&data[index.next_start() as usize..at + 8 + len])?;
        }
        assert!(index.is_complete());
        Ok(index)
    }

    /// Decode every extra frame from just its own bytes.
    fn decode_all(index: &TrajIndexBuilder, data: &[u8]) -> Vec<Vec<f32>> {
        (0..index.n_frames())
            .map(|f| {
                let (start, end) = index.frame_range(f).unwrap();
                index
                    .decode(f, &data[start as usize..end as usize])
                    .unwrap()
            })
            .collect()
    }

    #[test]
    fn test_index_in_frames_matches_full_parse() {
        for name in ["water.traj", "bond_change.traj"] {
            let Some(data) = read_fixture(name) else {
                continue;
            };
            let full = parse_traj(&data).unwrap();
            let mut index = index_in_frames(&data).unwrap();
            assert!(!index.heterogeneous(), "{name}");
            assert!(!index.varying_cells(), "{name}");
            assert_eq!(index.n_atoms(), full.n_atoms);
            assert_eq!(index.n_frames(), full.extra_frame_count());
            let frame0 = index.take_frame0().unwrap();
            assert!(index.take_frame0().is_none());
            assert_eq!(frame0.positions, full.positions);
            assert_eq!(frame0.elements, full.elements);
            assert_eq!(frame0.bonds, full.bonds);
            assert_eq!(frame0.box_matrix, full.box_matrix);
            for (f, positions) in decode_all(&index, &data).iter().enumerate() {
                assert_eq!(positions.as_slice(), full.frame(f), "{name} frame {f}");
                assert_eq!(index.frame_cell(f), None);
            }
        }
    }

    #[test]
    fn test_index_in_frames_carries_a_varying_cell() {
        let Some(data) = read_fixture("water_var_cell.traj") else {
            return;
        };
        let full = parse_traj(&data).unwrap();
        let index = index_in_frames(&data).unwrap();
        assert!(!index.heterogeneous());
        assert!(index.varying_cells());
        for (f, positions) in decode_all(&index, &data).iter().enumerate() {
            assert_eq!(positions.as_slice(), full.frame(f));
            let want: Option<[f32; 9]> = full.frame_cell(f).map(|c| c.try_into().unwrap());
            assert_eq!(index.frame_cell(f), want, "frame {f}");
        }
    }

    #[test]
    fn test_index_in_frames_flags_changing_atoms_and_elements() {
        for name in ["water_var_atoms.traj", "water_var_topology.traj"] {
            let Some(data) = read_fixture(name) else {
                continue;
            };
            assert!(index_in_frames(&data).unwrap().heterogeneous(), "{name}");
        }
    }

    /// A two-frame little-endian ULM file: frame 1's positions sit at
    /// `frame1_positions_at` (inside frame 1 when it is past frame 0's JSON).
    fn two_frame_file(frame1_positions_at: Option<u64>) -> Vec<u8> {
        let mut out = vec![0u8; ULM_HEADER_LEN];
        out[..8].copy_from_slice(ULM_MAGIC);
        out[24..32].copy_from_slice(&1i64.to_le_bytes());
        out[32..40].copy_from_slice(&2i64.to_le_bytes());
        let mut offsets = Vec::new();
        for frame in 0..2u64 {
            let positions_at = out.len() as u64;
            for v in [frame as f64, 0.0, 0.0] {
                out.extend(v.to_le_bytes());
            }
            let at = match frame {
                0 => positions_at,
                _ => frame1_positions_at.unwrap_or(positions_at),
            };
            let numbers = if frame == 0 {
                r#""numbers": [8], "#
            } else {
                ""
            };
            let json =
                format!(r#"{{{numbers}"positions.": {{"ndarray": [[1, 3], "float64", {at}]}}}}"#);
            offsets.push(out.len() as i64);
            out.extend((json.len() as i64).to_le_bytes());
            out.extend(json.as_bytes());
        }
        let pos0 = out.len() as i64;
        out[40..48].copy_from_slice(&pos0.to_le_bytes());
        for o in offsets {
            out.extend(o.to_le_bytes());
        }
        out
    }

    /// A little-endian ULM file of `frames`, each `(numbers, n_positions)`:
    /// the `numbers` it re-emits (frame 0 must) and how many positions rows
    /// it stores, written right before its JSON.
    fn ulm_frames(frames: &[(Option<&[u8]>, usize)]) -> Vec<u8> {
        let mut out = vec![0u8; ULM_HEADER_LEN];
        out[..8].copy_from_slice(ULM_MAGIC);
        out[24..32].copy_from_slice(&1i64.to_le_bytes());
        out[32..40].copy_from_slice(&(frames.len() as i64).to_le_bytes());
        let mut offsets = Vec::new();
        for (numbers, n_positions) in frames {
            let at = out.len();
            for i in 0..n_positions * 3 {
                out.extend((i as f64).to_le_bytes());
            }
            let numbers = numbers
                .map(|n| format!(r#""numbers": {n:?}, "#))
                .unwrap_or_default();
            let json = format!(
                r#"{{{numbers}"positions.": {{"ndarray": [[{n_positions}, 3], "float64", {at}]}}}}"#
            );
            offsets.push(out.len() as i64);
            out.extend((json.len() as i64).to_le_bytes());
            out.extend(json.as_bytes());
        }
        let pos0 = out.len() as i64;
        out[40..48].copy_from_slice(&pos0.to_le_bytes());
        for o in offsets {
            out.extend(o.to_le_bytes());
        }
        out
    }

    #[test]
    fn frame0_positions_must_match_its_numbers() {
        // Three atoms but one (or two) positions: reading on would index past
        // the positions (frame 0's bond inference panicked).
        for n_positions in [1, 2] {
            let data = ulm_frames(&[(Some(&[8, 1, 1]), n_positions)]);
            let want = format!("frame 0 has {} coordinates for 3 atoms", n_positions * 3);
            let err = parse_traj(&data).err().unwrap();
            assert!(err.contains(&want), "{err}");
            let err = parse_traj_frame0(&data, &data, data.len()).err().unwrap();
            assert!(err.contains(&want), "{err}");
            let err = index_in_frames(&data).err().unwrap();
            assert!(err.contains(&want), "{err}");
        }
        // More positions than atoms is as corrupt.
        let data = ulm_frames(&[(Some(&[8]), 2)]);
        let err = parse_traj(&data).err().unwrap();
        assert!(err.contains("6 coordinates for 1 atoms"), "{err}");
    }

    #[test]
    fn every_frame_positions_must_match_its_numbers() {
        // Frame 1 keeps frame 0's single atom but stores two positions.
        let data = ulm_frames(&[(Some(&[8]), 1), (None, 2)]);
        let err = parse_traj(&data).err().unwrap();
        assert!(
            err.contains("frame 1 has 6 coordinates for 1 atoms"),
            "{err}"
        );
        let err = index_in_frames(&data).err().unwrap();
        assert!(
            err.contains("frame 1 has 6 coordinates for 1 atoms"),
            "{err}"
        );
        // Re-emitting numbers for the new atom count is a valid change.
        let data = ulm_frames(&[(Some(&[8]), 1), (Some(&[8, 1]), 2)]);
        let full = parse_traj(&data).unwrap();
        assert_eq!(full.frame(0).len(), 6);
        assert!(index_in_frames(&data).unwrap().heterogeneous());
    }

    #[test]
    fn test_index_rejects_a_frame_whose_arrays_are_elsewhere() {
        let ok = two_frame_file(None);
        let index = index_in_frames(&ok).unwrap();
        assert_eq!(decode_all(&index, &ok), vec![vec![1.0, 0.0, 0.0]]);
        assert_eq!(parse_traj(&ok).unwrap().frame(0), &[1.0, 0.0, 0.0]);

        // Frame 1 points back at frame 0's positions: fine for the full parse,
        // but not in frame 1's bytes, so the index refuses the file.
        let back = two_frame_file(Some(ULM_HEADER_LEN as u64));
        assert_eq!(parse_traj(&back).unwrap().frame(0), &[0.0, 0.0, 0.0]);
        let err = index_in_frames(&back).err().unwrap();
        assert!(err.contains("not stored with it"), "{err}");
    }

    #[test]
    fn test_index_rejects_bad_tables_and_misuse() {
        let data = two_frame_file(None);
        let mut index = TrajIndexBuilder::new(&data, data.len() as u64).unwrap();
        let (start, end) = index.table_range();
        assert_eq!(end - start, 16);
        // An offset past EOF, frames out of order, and an empty table.
        let past: Vec<u8> = [8i64, 1 << 40]
            .iter()
            .flat_map(|o| o.to_le_bytes())
            .collect();
        assert!(index.set_table(&past).unwrap_err().contains("past EOF"));
        let backwards: Vec<u8> = [100i64, 50].iter().flat_map(|o| o.to_le_bytes()).collect();
        assert!(index
            .set_table(&backwards)
            .unwrap_err()
            .contains("in order"));
        assert!(index.set_table(&[0u8; 8]).is_err());
        // A table past EOF, a negative JSON length, and decoding out of range.
        assert!(TrajIndexBuilder::new(&data, 60).is_err());
        assert!(index.json_len(&(-1i64).to_le_bytes()).is_err());
        assert!(index.decode(0, &data).is_err());
        assert_eq!(index.frame_range(0), None);
        assert!(!index.is_complete());
        // Adding a frame past the last one.
        let mut full = index_in_frames(&data).unwrap();
        assert!(full.add_frame(&data).unwrap_err().contains("already added"));
        // Decoding a frame from bytes that do not hold it.
        assert!(full.decode(0, &data[..10]).is_err());
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

    /// A little-endian ULM file of water-like frames: each frame
    /// `(momenta, forces)` says whether it stores momenta and calculator
    /// forces. Frame f's momentum component k is `f + k`, its force `-k`.
    fn ulm_with_vectors(frames: &[(bool, bool)]) -> Vec<u8> {
        let mut out = vec![0u8; ULM_HEADER_LEN];
        out[..8].copy_from_slice(ULM_MAGIC);
        out[24..32].copy_from_slice(&1i64.to_le_bytes());
        out[32..40].copy_from_slice(&(frames.len() as i64).to_le_bytes());
        let mut offsets = Vec::new();
        for (f, &(momenta, forces)) in frames.iter().enumerate() {
            let mut array = |values: Vec<f64>| {
                let at = out.len();
                for v in values {
                    out.extend(v.to_le_bytes());
                }
                format!(r#"{{"ndarray": [[2, 3], "float64", {at}]}}"#)
            };
            let positions = array(vec![0.0, 0.0, 0.0, 0.96, 0.0, 0.0]);
            let mut json = format!(r#"{{"numbers": [8, 1], "positions.": {positions}"#);
            if momenta {
                let m = array((0..6).map(|k| (f + k) as f64).collect());
                json += &format!(r#", "momenta.": {m}"#);
            }
            if forces {
                let fs = array((0..6).map(|k| -(k as f64)).collect());
                json += &format!(
                    r#", "calculator.": {{"name": "emt", "energy": 1.5, "forces.": {fs}}}"#
                );
            }
            json += "}";
            offsets.push(out.len() as i64);
            out.extend((json.len() as i64).to_le_bytes());
            out.extend(json.as_bytes());
        }
        let pos0 = out.len() as i64;
        out[40..48].copy_from_slice(&pos0.to_le_bytes());
        for o in offsets {
            out.extend(o.to_le_bytes());
        }
        out
    }

    #[test]
    fn momenta_and_calculator_forces_become_vector_channels() {
        let s = parse_traj(&ulm_with_vectors(&[(true, true), (true, true)])).unwrap();
        let names: Vec<&str> = s.vector_channels.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["momenta", "force"]);
        let (momenta, force) = (&s.vector_channels[0], &s.vector_channels[1]);
        for f in 0..2 {
            assert_eq!(momenta.frames[f].frame, f);
            let want: Vec<f32> = (0..6).map(|k| (f + k) as f32).collect();
            assert_eq!(momenta.frames[f].vectors, want);
            assert_eq!(
                force.frames[f].vectors,
                [-0.0, -1.0, -2.0, -3.0, -4.0, -5.0]
            );
        }
        assert!(s.warnings.is_empty());
    }

    #[test]
    fn vectors_missing_from_some_frames_keep_frame_0_with_a_warning() {
        // Frame 1 has no calculator: forces are kept for frame 0 only, and
        // momenta (in every frame) stay frame-synced.
        let s = parse_traj(&ulm_with_vectors(&[(true, true), (true, false)])).unwrap();
        assert_eq!(s.vector_channels[0].name, "momenta");
        assert_eq!(s.vector_channels[0].frames.len(), 2);
        assert_eq!(s.vector_channels[1].name, "force");
        assert_eq!(s.vector_channels[1].frames.len(), 1);
        assert_eq!(s.vector_channels[1].frames[0].frame, 0);
        assert_eq!(s.warnings.len(), 1);
        assert!(s.warnings[0].contains("force"), "{:?}", s.warnings);
        // Only a later frame storing them: nothing frame 0 could show.
        let s = parse_traj(&ulm_with_vectors(&[(false, false), (true, false)])).unwrap();
        assert!(s.vector_channels.is_empty());
        assert!(s.warnings[0].contains("momenta"));
        // No arrays at all: no channels and nothing to warn about.
        let s = parse_traj(&ulm_with_vectors(&[(false, false), (false, false)])).unwrap();
        assert!(s.vector_channels.is_empty());
        assert!(s.warnings.is_empty());
    }
}
