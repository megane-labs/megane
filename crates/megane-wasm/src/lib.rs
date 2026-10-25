use js_sys::{Float32Array, Float64Array, Object, Reflect, Uint32Array, Uint8Array};
use wasm_bindgen::prelude::*;

use megane_core::formats::{self, FormatInput, StructureFormat, TrajectoryFormat};
use megane_core::{
    bonds, dcd, gro, jcampdx, lammps_data, lammpstrj, lines, netcdf, parser, pdb, psf, top, traj,
    writer, xtc, xyz,
};

/// Serialize a slice of `VectorChannel`s into two parallel outputs:
/// - A JSON string describing channel metadata (name, n_frames per channel).
/// - A flat `Vec<f32>` with all channel/frame vectors concatenated in order.
///
/// Layout in the flat buffer: for each channel, for each frame in order,
/// `n_atoms * 3` f32 values.
fn serialize_vector_channels(
    channels: &[megane_core::trajectory::VectorChannel],
) -> (String, Vec<f32>) {
    use std::fmt::Write as FmtWrite;

    let mut meta = String::from("[");
    let mut data: Vec<f32> = Vec::new();

    for (idx, ch) in channels.iter().enumerate() {
        if idx > 0 {
            meta.push(',');
        }
        let _ = write!(
            meta,
            r#"{{"name":"{}", "n_frames":{}}}"#,
            ch.name,
            ch.frames.len()
        );
        for frame in &ch.frames {
            data.extend_from_slice(&frame.vectors);
        }
    }
    meta.push(']');

    (meta, data)
}

/// Serialize a slice of `ScalarChannel`s the same way as vector channels:
/// a JSON metadata string plus one flat `Vec<f32>` of per-channel, per-frame
/// values (`n_atoms` f32 per frame). Channel names come from file content, so
/// they are JSON-escaped.
fn serialize_scalar_channels(
    channels: &[megane_core::trajectory::ScalarChannel],
) -> (String, Vec<f32>) {
    use std::fmt::Write as FmtWrite;

    let mut meta = String::from("[");
    let mut data: Vec<f32> = Vec::new();

    for (idx, ch) in channels.iter().enumerate() {
        if idx > 0 {
            meta.push(',');
        }
        let escaped: String = ch
            .name
            .chars()
            .flat_map(|c| match c {
                '"' | '\\' => vec!['\\', c],
                _ => vec![c],
            })
            .collect();
        let _ = write!(
            meta,
            r#"{{"name":"{}", "n_frames":{}}}"#,
            escaped,
            ch.frames.len()
        );
        for frame in &ch.frames {
            data.extend_from_slice(&frame.values);
        }
    }
    meta.push(']');

    (meta, data)
}

/// Result of parsing a PDB file, exposed to JavaScript via wasm-bindgen.
#[wasm_bindgen]
pub struct ParseResult {
    n_atoms: u32,
    n_bonds: u32,
    n_file_bonds: u32,
    n_frames: u32,
    has_box: bool,
    has_atom_labels: bool,
    has_chain_ids: bool,
    has_bfactors: bool,
    positions: Vec<f32>,
    elements: Vec<u8>,
    bonds: Vec<u32>,
    bond_orders: Vec<u8>,
    box_matrix: Vec<f32>,
    box_origin: Vec<f32>,
    frame_data: Vec<f32>,
    atom_labels: String,
    chain_ids: Vec<u8>,
    bfactors: Vec<f32>,
    vector_channel_count: u32,
    vector_channel_meta: String,
    vector_channel_data: Vec<f32>,
    scalar_channel_count: u32,
    scalar_channel_meta: String,
    scalar_channel_data: Vec<f32>,
    // Non-fatal parse warnings, newline-delimited (empty for a clean parse).
    warnings: String,
    // Cα backbone data for cartoon rendering
    ca_indices: Vec<u32>,
    ca_chain_ids: Vec<u8>,
    ca_res_nums: Vec<u32>,
    ca_ss_type: Vec<u8>,
    // Crystallographic symmetry operations (newline-delimited `x,y,z` strings).
    symmetry_ops: String,
    // Heterogeneous-trajectory side table (empty/false for uniform trajectories).
    heterogeneous: bool,
    varies_atoms: bool,
    varies_cell: bool,
    varies_topology: bool,
    max_atoms: u32,
    frame_atom_offsets: Vec<u32>,
    frame_elements: Vec<u8>,
    frame_cells: Vec<f32>,
    frame_bond_offsets: Vec<u32>,
    frame_bonds: Vec<u32>,
}

#[wasm_bindgen]
impl ParseResult {
    #[wasm_bindgen(getter)]
    pub fn n_atoms(&self) -> u32 {
        self.n_atoms
    }

    #[wasm_bindgen(getter)]
    pub fn n_bonds(&self) -> u32 {
        self.n_bonds
    }

    #[wasm_bindgen(getter)]
    pub fn n_file_bonds(&self) -> u32 {
        self.n_file_bonds
    }

    #[wasm_bindgen(getter)]
    pub fn n_frames(&self) -> u32 {
        self.n_frames
    }

    #[wasm_bindgen(getter)]
    pub fn has_box(&self) -> bool {
        self.has_box
    }

    #[wasm_bindgen(getter)]
    pub fn has_atom_labels(&self) -> bool {
        self.has_atom_labels
    }

    /// Per-atom labels as newline-delimited string.
    #[wasm_bindgen(getter)]
    pub fn atom_labels(&self) -> String {
        self.atom_labels.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn has_chain_ids(&self) -> bool {
        self.has_chain_ids
    }

    #[wasm_bindgen(getter)]
    pub fn has_bfactors(&self) -> bool {
        self.has_bfactors
    }

    /// Per-atom chain IDs as Uint8Array (raw ASCII bytes, e.g. 65='A').
    pub fn chain_ids(&self) -> Uint8Array {
        Uint8Array::from(&self.chain_ids[..])
    }

    /// Per-atom B-factors as Float32Array.
    pub fn bfactors(&self) -> Float32Array {
        Float32Array::from(&self.bfactors[..])
    }

    /// Number of embedded vector channels (0 when none).
    #[wasm_bindgen(getter)]
    pub fn vector_channel_count(&self) -> u32 {
        self.vector_channel_count
    }

    /// JSON array describing each channel: `[{"name":"velocity","n_frames":1}, ...]`
    #[wasm_bindgen(getter)]
    pub fn vector_channel_meta(&self) -> String {
        self.vector_channel_meta.clone()
    }

    /// Number of embedded per-atom scalar channels (0 when none).
    #[wasm_bindgen(getter)]
    pub fn scalar_channel_count(&self) -> u32 {
        self.scalar_channel_count
    }

    /// JSON array describing each scalar channel:
    /// `[{"name":"charge","n_frames":1}, ...]`
    #[wasm_bindgen(getter)]
    pub fn scalar_channel_meta(&self) -> String {
        self.scalar_channel_meta.clone()
    }

    /// All scalar channel data concatenated as Float32Array.
    /// Layout: channel0_frame0, channel0_frame1, …, channel1_frame0, …
    /// Each frame is n_atoms floats.
    pub fn scalar_channel_data(&self) -> Float32Array {
        Float32Array::from(&self.scalar_channel_data[..])
    }

    /// Non-fatal parse warnings as a newline-delimited string.
    /// Empty for a clean parse.
    #[wasm_bindgen(getter)]
    pub fn warnings(&self) -> String {
        self.warnings.clone()
    }

    /// Atom positions as Float32Array [x0,y0,z0, x1,y1,z1, ...]
    pub fn positions(&self) -> Float32Array {
        Float32Array::from(&self.positions[..])
    }

    /// Atomic numbers as Uint8Array
    pub fn elements(&self) -> Uint8Array {
        Uint8Array::from(&self.elements[..])
    }

    /// Bond pairs as Uint32Array [a0,b0, a1,b1, ...]
    pub fn bonds(&self) -> Uint32Array {
        Uint32Array::from(&self.bonds[..])
    }

    /// Bond orders as Uint8Array (all 1 for PDB files)
    pub fn bond_orders(&self) -> Uint8Array {
        Uint8Array::from(&self.bond_orders[..])
    }

    /// Cell matrix as Float32Array (9 floats, row-major 3x3)
    pub fn box_matrix(&self) -> Float32Array {
        Float32Array::from(&self.box_matrix[..])
    }

    /// Box origin (lower corner) as Float32Array (3 floats), or empty when the
    /// format carries no explicit origin (⇒ treat as (0,0,0)).
    pub fn box_origin(&self) -> Float32Array {
        Float32Array::from(&self.box_origin[..])
    }

    /// All additional frame positions concatenated as Float32Array
    /// (n_frames * n_atoms * 3 floats)
    pub fn frame_data(&self) -> Float32Array {
        Float32Array::from(&self.frame_data[..])
    }

    /// All vector channel data concatenated as Float32Array.
    /// Layout: channel0_frame0, channel0_frame1, …, channel1_frame0, …
    /// Each frame is n_atoms * 3 floats.
    pub fn vector_channel_data(&self) -> Float32Array {
        Float32Array::from(&self.vector_channel_data[..])
    }

    /// Number of Cα atoms in the backbone (0 when not a protein or format has no atom names).
    #[wasm_bindgen(getter)]
    pub fn ca_count(&self) -> u32 {
        self.ca_indices.len() as u32
    }

    /// Indices of Cα atoms into the positions array.
    pub fn ca_indices(&self) -> Uint32Array {
        Uint32Array::from(&self.ca_indices[..])
    }

    /// Per-Cα chain identifier as ASCII byte (e.g. 65 = b'A').
    pub fn ca_chain_ids(&self) -> Uint8Array {
        Uint8Array::from(&self.ca_chain_ids[..])
    }

    /// Per-Cα residue sequence number.
    pub fn ca_res_nums(&self) -> Uint32Array {
        Uint32Array::from(&self.ca_res_nums[..])
    }

    /// Per-Cα secondary-structure type: 0 = coil, 1 = helix, 2 = sheet.
    pub fn ca_ss_type(&self) -> Uint8Array {
        Uint8Array::from(&self.ca_ss_type[..])
    }

    /// Number of crystallographic symmetry operations (0 when none).
    #[wasm_bindgen(getter)]
    pub fn symmetry_op_count(&self) -> u32 {
        if self.symmetry_ops.is_empty() {
            0
        } else {
            self.symmetry_ops.split('\n').count() as u32
        }
    }

    /// Symmetry operations as a newline-delimited string of `x,y,z` operations.
    /// Empty when the format carries no space-group information.
    #[wasm_bindgen(getter)]
    pub fn symmetry_ops(&self) -> String {
        self.symmetry_ops.clone()
    }

    /// True when the trajectory's frames differ in atom count, cell, or
    /// elements. When false the host takes the fast fixed-topology path and
    /// all `frame_*` heterogeneous getters below are empty.
    #[wasm_bindgen(getter)]
    pub fn heterogeneous(&self) -> bool {
        self.heterogeneous
    }

    /// True when the per-frame atom count changes.
    #[wasm_bindgen(getter)]
    pub fn varies_atoms(&self) -> bool {
        self.varies_atoms
    }

    /// True when the per-frame unit cell changes.
    #[wasm_bindgen(getter)]
    pub fn varies_cell(&self) -> bool {
        self.varies_cell
    }

    /// True when per-frame elements/bonds change.
    #[wasm_bindgen(getter)]
    pub fn varies_topology(&self) -> bool {
        self.varies_topology
    }

    /// Maximum atom count across all frames (drives host GPU buffer sizing).
    #[wasm_bindgen(getter)]
    pub fn max_atoms(&self) -> u32 {
        self.max_atoms
    }

    /// Prefix-sum atom offsets (in atoms) over the EXTRA frames; length
    /// `n_frames + 1`. Empty for uniform trajectories.
    pub fn frame_atom_offsets(&self) -> Uint32Array {
        Uint32Array::from(&self.frame_atom_offsets[..])
    }

    /// Concatenated per-extra-frame atomic numbers, sliced by
    /// `frame_atom_offsets`. Empty when topology is constant (reuse frame 0).
    pub fn frame_elements(&self) -> Uint8Array {
        Uint8Array::from(&self.frame_elements[..])
    }

    /// Per-extra-frame row-major 3×3 cells (9 floats each). Empty when the cell
    /// is constant (reuse `box_matrix`).
    pub fn frame_cells(&self) -> Float32Array {
        Float32Array::from(&self.frame_cells[..])
    }

    /// Prefix-sum bond offsets (in pairs) over the EXTRA frames; length
    /// `n_frames + 1` when populated. Empty when topology is constant.
    pub fn frame_bond_offsets(&self) -> Uint32Array {
        Uint32Array::from(&self.frame_bond_offsets[..])
    }

    /// Concatenated per-extra-frame bonds `[a0,b0,…]`, sliced by
    /// `frame_bond_offsets` (×2). Empty when topology is constant.
    pub fn frame_bonds(&self) -> Uint32Array {
        Uint32Array::from(&self.frame_bonds[..])
    }
}

impl ParseResult {
    fn from_parsed(data: parser::ParsedStructure) -> Self {
        let n_bonds = data.bonds.len() as u32;
        let bonds_flat = bonds::flatten_pairs(&data.bonds);
        let bond_orders = data
            .bond_orders
            .unwrap_or_else(|| vec![1u8; data.bonds.len()]);
        let has_box = data.box_matrix.is_some();
        let box_matrix = data.box_matrix.map(|m| m.to_vec()).unwrap_or_default();
        let box_origin = data.box_origin.map(|o| o.to_vec()).unwrap_or_default();
        // Core already stores extra frames as one contiguous buffer — move it out,
        // no flatten copy and no 2× peak. Derive the frame count from the moved
        // buffer to avoid borrowing `data` after earlier partial moves.
        let n_atoms_usize = data.n_atoms;
        let frame_data: Vec<f32> = data.frame_positions_flat;
        // Unpack the heterogeneous side table (None → uniform fast path).
        let hetero = data.hetero;
        let n_frames = match &hetero {
            // Heterogeneous frames are jagged, so derive the count from the
            // atom-offset segments rather than a fixed stride.
            Some(h) => h.atom_offsets.len().saturating_sub(1) as u32,
            None if n_atoms_usize == 0 => 0,
            None => (frame_data.len() / (n_atoms_usize * 3)) as u32,
        };
        let (
            heterogeneous,
            varies_atoms,
            varies_cell,
            varies_topology,
            max_atoms,
            frame_atom_offsets,
            frame_elements,
            frame_cells,
            frame_bond_offsets,
            frame_bonds,
        ) = match hetero {
            Some(h) => (
                true,
                h.varies_atoms,
                h.varies_cell,
                h.varies_topology,
                h.max_atoms,
                h.atom_offsets,
                h.elements_flat,
                h.cells_flat,
                h.bond_offsets,
                h.bonds_flat,
            ),
            None => (
                false,
                false,
                false,
                false,
                n_atoms_usize as u32,
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
            ),
        };
        let has_atom_labels = data.atom_labels.is_some();
        let atom_labels = data.atom_labels.map(|l| l.join("\n")).unwrap_or_default();
        let has_chain_ids = data.chain_ids.is_some();
        let chain_ids = data.chain_ids.unwrap_or_default();
        let has_bfactors = data.bfactors.is_some();
        let bfactors = data.bfactors.unwrap_or_default();

        let vector_channel_count = data.vector_channels.len() as u32;
        let (vector_channel_meta, vector_channel_data) =
            serialize_vector_channels(&data.vector_channels);
        let scalar_channel_count = data.scalar_channels.len() as u32;
        let (scalar_channel_meta, scalar_channel_data) =
            serialize_scalar_channels(&data.scalar_channels);

        Self {
            n_atoms: data.n_atoms as u32,
            n_bonds,
            n_file_bonds: data.n_file_bonds as u32,
            n_frames,
            has_box,
            has_atom_labels,
            has_chain_ids,
            has_bfactors,
            positions: data.positions,
            elements: data.elements,
            bonds: bonds_flat,
            bond_orders,
            box_matrix,
            box_origin,
            frame_data,
            atom_labels,
            chain_ids,
            bfactors,
            vector_channel_count,
            vector_channel_meta,
            vector_channel_data,
            scalar_channel_count,
            scalar_channel_meta,
            scalar_channel_data,
            warnings: data.warnings.join("\n"),
            ca_indices: data.ca_indices,
            ca_chain_ids: data.ca_chain_ids,
            ca_res_nums: data.ca_res_nums,
            ca_ss_type: data.ca_ss_type,
            symmetry_ops: data.symmetry_ops.join("\n"),
            heterogeneous,
            varies_atoms,
            varies_cell,
            varies_topology,
            max_atoms,
            frame_atom_offsets,
            frame_elements,
            frame_cells,
            frame_bond_offsets,
            frame_bonds,
        }
    }
}

/// Result of parsing an XTC trajectory file.
#[wasm_bindgen]
pub struct XtcParseResult {
    n_atoms: u32,
    n_frames: u32,
    timestep_ps: f32,
    has_box: bool,
    box_matrix: Vec<f32>,
    box_origin: Vec<f32>,
    frame_data: Vec<f32>,
    vector_channel_count: u32,
    vector_channel_meta: String,
    vector_channel_data: Vec<f32>,
    // Heterogeneous side table (empty/false for the uniform fast path).
    heterogeneous: bool,
    varies_atoms: bool,
    varies_cell: bool,
    varies_topology: bool,
    max_atoms: u32,
    frame_atom_offsets: Vec<u32>,
    frame_elements: Vec<u8>,
    frame_cells: Vec<f32>,
}

#[wasm_bindgen]
impl XtcParseResult {
    #[wasm_bindgen(getter)]
    pub fn n_atoms(&self) -> u32 {
        self.n_atoms
    }

    #[wasm_bindgen(getter)]
    pub fn n_frames(&self) -> u32 {
        self.n_frames
    }

    #[wasm_bindgen(getter)]
    pub fn timestep_ps(&self) -> f32 {
        self.timestep_ps
    }

    #[wasm_bindgen(getter)]
    pub fn has_box(&self) -> bool {
        self.has_box
    }

    pub fn box_matrix(&self) -> Float32Array {
        Float32Array::from(&self.box_matrix[..])
    }

    /// Box origin (lower corner, 3 floats), or empty ⇒ (0,0,0).
    pub fn box_origin(&self) -> Float32Array {
        Float32Array::from(&self.box_origin[..])
    }

    /// All frame positions concatenated (n_frames * n_atoms * 3 floats).
    pub fn frame_data(&self) -> Float32Array {
        Float32Array::from(&self.frame_data[..])
    }

    /// Number of embedded vector channels (0 when none).
    #[wasm_bindgen(getter)]
    pub fn vector_channel_count(&self) -> u32 {
        self.vector_channel_count
    }

    /// JSON array describing each channel: `[{"name":"velocity","n_frames":N}, ...]`
    #[wasm_bindgen(getter)]
    pub fn vector_channel_meta(&self) -> String {
        self.vector_channel_meta.clone()
    }

    /// All vector channel data concatenated as Float32Array.
    pub fn vector_channel_data(&self) -> Float32Array {
        Float32Array::from(&self.vector_channel_data[..])
    }

    /// True when frames vary in cell (all formats) or atom count / type (LAMMPS).
    /// When false, the `frame_*` heterogeneous getters below are empty.
    #[wasm_bindgen(getter)]
    pub fn heterogeneous(&self) -> bool {
        self.heterogeneous
    }

    #[wasm_bindgen(getter)]
    pub fn varies_atoms(&self) -> bool {
        self.varies_atoms
    }

    #[wasm_bindgen(getter)]
    pub fn varies_cell(&self) -> bool {
        self.varies_cell
    }

    #[wasm_bindgen(getter)]
    pub fn varies_topology(&self) -> bool {
        self.varies_topology
    }

    #[wasm_bindgen(getter)]
    pub fn max_atoms(&self) -> u32 {
        self.max_atoms
    }

    /// Prefix-sum of per-frame atom counts (length n_frames+1). Empty when the
    /// atom count is fixed (positions are fixed-stride).
    pub fn frame_atom_offsets(&self) -> Uint32Array {
        Uint32Array::from(&self.frame_atom_offsets[..])
    }

    /// Concatenated per-frame element/type ids. Empty when topology is constant.
    pub fn frame_elements(&self) -> Uint8Array {
        Uint8Array::from(&self.frame_elements[..])
    }

    /// Concatenated per-frame row-major 3×3 cells (9 floats each). Empty when the
    /// cell is constant across the trajectory.
    pub fn frame_cells(&self) -> Float32Array {
        Float32Array::from(&self.frame_cells[..])
    }
}

impl XtcParseResult {
    /// Build the FFI result from a core `TrajectoryData`, unpacking its optional
    /// heterogeneous side table. Shared by every trajectory `parse_*` so the
    /// uniform fast path (empty side table) stays byte-identical.
    fn from_trajectory(data: megane_core::trajectory::TrajectoryData) -> Self {
        let has_box = data.box_matrix.is_some();
        let box_matrix = data.box_matrix.map(|m| m.to_vec()).unwrap_or_default();
        let box_origin = data.box_origin.map(|o| o.to_vec()).unwrap_or_default();
        let n_atoms = data.n_atoms as u32;
        let n_frames = data.n_frames as u32;
        let timestep_ps = data.timestep_ps;
        let vector_channel_count = data.vector_channels.len() as u32;
        let (vector_channel_meta, vector_channel_data) =
            serialize_vector_channels(&data.vector_channels);
        let frame_data = data.frame_positions_flat;
        let (
            heterogeneous,
            varies_atoms,
            varies_cell,
            varies_topology,
            max_atoms,
            frame_atom_offsets,
            frame_elements,
            frame_cells,
        ) = match data.hetero {
            Some(h) => (
                true,
                h.varies_atoms,
                h.varies_cell,
                h.varies_topology,
                h.max_atoms,
                h.atom_offsets,
                h.elements_flat,
                h.cells_flat,
            ),
            None => (
                false,
                false,
                false,
                false,
                n_atoms,
                Vec::new(),
                Vec::new(),
                Vec::new(),
            ),
        };
        Self {
            n_atoms,
            n_frames,
            timestep_ps,
            has_box,
            box_matrix,
            box_origin,
            frame_data,
            vector_channel_count,
            vector_channel_meta,
            vector_channel_data,
            heterogeneous,
            varies_atoms,
            varies_cell,
            varies_topology,
            max_atoms,
            frame_atom_offsets,
            frame_elements,
            frame_cells,
        }
    }
}

/// Generates one `#[wasm_bindgen]` trajectory parser per
/// `megane_core::for_each_trajectory_format!` entry (`parse_xtc_file`,
/// `parse_dcd_file`, …), using the entry's WASM name.
macro_rules! wasm_trajectory_parsers {
    ($( $(#[doc = $doc:tt])* $variant:ident => $wasm:ident / $py:ident($arg:ident: $ty:ty); )*) => {
        $(
            $(#[doc = $doc])*
            #[wasm_bindgen]
            pub fn $wasm($arg: $ty) -> Result<XtcParseResult, JsError> {
                let data = TrajectoryFormat::$variant
                    .parse($arg.into())
                    .map_err(|e| JsError::new(&e))?;
                Ok(XtcParseResult::from_trajectory(data))
            }
        )*
    };
}

megane_core::for_each_trajectory_format!(wasm_trajectory_parsers);

/// Frame `frame`'s cell from an index's per-frame cell table (row-major 3×3,
/// Å), or empty when the cell is constant (every frame then uses the index's
/// `box_matrix`, frame 0's box) or `frame` is out of range.
fn frame_cell_array(cells: Option<&[[f32; 9]]>, frame: u32) -> Float32Array {
    match cells.and_then(|c| c.get(frame as usize)) {
        Some(c) => Float32Array::from(&c[..]),
        None => Float32Array::new_with_length(0),
    }
}

/// Persistent XTC decoder for lazy/streaming playback.
///
/// Owns the whole XTC file in wasm memory and holds a lightweight frame index
/// (built once in the constructor without decompressing coordinates). The JS
/// side keeps one of these alive per open trajectory and calls `decode_frame`
/// on demand, so frame 0 can render immediately while later frames stream in.
#[wasm_bindgen]
pub struct XtcDecoder {
    bytes: Vec<u8>,
    offsets: Vec<u64>,
    n_atoms: usize,
    n_frames: u32,
    timestep_ps: f32,
    has_box: bool,
    box_matrix: Vec<f32>,
    times: Vec<f32>,
    frame_cells: Option<Vec<[f32; 9]>>,
}

#[wasm_bindgen]
impl XtcDecoder {
    /// Build the frame index from the file bytes. The bytes are moved into wasm
    /// memory and retained for the decoder's lifetime.
    #[wasm_bindgen(constructor)]
    pub fn new(data: Vec<u8>) -> Result<XtcDecoder, JsError> {
        let idx = xtc::build_index(&data).map_err(|e| JsError::new(&e))?;
        let has_box = idx.box_matrix.is_some();
        let box_matrix = idx.box_matrix.map(|m| m.to_vec()).unwrap_or_default();
        Ok(XtcDecoder {
            bytes: data,
            offsets: idx.offsets,
            n_atoms: idx.n_atoms,
            n_frames: idx.n_frames as u32,
            timestep_ps: idx.timestep_ps,
            has_box,
            box_matrix,
            times: idx.times,
            frame_cells: idx.frame_cells,
        })
    }

    #[wasm_bindgen(getter)]
    pub fn n_atoms(&self) -> u32 {
        self.n_atoms as u32
    }

    #[wasm_bindgen(getter)]
    pub fn n_frames(&self) -> u32 {
        self.n_frames
    }

    #[wasm_bindgen(getter)]
    pub fn timestep_ps(&self) -> f32 {
        self.timestep_ps
    }

    #[wasm_bindgen(getter)]
    pub fn has_box(&self) -> bool {
        self.has_box
    }

    /// Frame 0's box (row-major 3×3, Å), as `parse_xtc_file` reports it.
    pub fn box_matrix(&self) -> Float32Array {
        Float32Array::from(&self.box_matrix[..])
    }

    /// True when the box changes between frames (an NPT run): each frame's
    /// own box is then `frame_cell(frame)`.
    #[wasm_bindgen(getter)]
    pub fn varying_cells(&self) -> bool {
        self.frame_cells.is_some()
    }

    /// Frame `frame`'s box; empty unless the box changes between frames.
    pub fn frame_cell(&self, frame: u32) -> Float32Array {
        frame_cell_array(self.frame_cells.as_deref(), frame)
    }

    /// Box origin — always empty for XTC (coordinates are absolute, box at
    /// origin). Present for interface parity with the LAMMPS-dump decoder.
    pub fn box_origin(&self) -> Float32Array {
        Float32Array::new_with_length(0)
    }

    /// Per-frame time stamps (ps).
    pub fn times(&self) -> Float32Array {
        Float32Array::from(&self.times[..])
    }

    /// Decode a single frame's positions (Å), `n_atoms * 3` floats.
    pub fn decode_frame(&self, frame: u32) -> Result<Float32Array, JsError> {
        let offset = *self
            .offsets
            .get(frame as usize)
            .ok_or_else(|| JsError::new("frame index out of range"))?;
        let coords = xtc::decode_frame_at(&self.bytes, offset as usize, self.n_atoms)
            .map_err(|e| JsError::new(&e))?;
        Ok(Float32Array::from(&coords[..]))
    }
}

/// Builds an XTC frame index from windows of a file the host never loads
/// whole (see `xtc::XtcIndexBuilder`): call `scan` with the file's bytes from
/// `next_offset` on until `next_offset` reaches the file's length, then
/// `finish`. Each frame is then decoded from its own bytes
/// (`offsets[i]..offsets[i + 1]`, the last one to the end of the file) with
/// `decode_trajectory_frame0(bytes, "xtc", n_atoms)`.
#[wasm_bindgen]
pub struct XtcIndexer {
    builder: Option<xtc::XtcIndexBuilder>,
    index: Option<xtc::XtcIndex>,
}

#[wasm_bindgen]
impl XtcIndexer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> XtcIndexer {
        XtcIndexer {
            builder: Some(xtc::XtcIndexBuilder::new()),
            index: None,
        }
    }

    /// File offset the next window must start at (a byte count, exact below 2^53).
    #[wasm_bindgen(getter)]
    pub fn next_offset(&self) -> f64 {
        self.builder.as_ref().map_or(0, |b| b.next_offset()) as f64
    }

    /// Index the frames whose headers lie in `window`; `at_eof` says it runs
    /// to the end of the file. Returns how many frames it held.
    pub fn scan(&mut self, window: &[u8], at_eof: bool) -> Result<u32, JsError> {
        let builder = self
            .builder
            .as_mut()
            .ok_or_else(|| JsError::new("XtcIndexer already finished"))?;
        let found = builder.scan(window, at_eof).map_err(|e| JsError::new(&e))?;
        Ok(found as u32)
    }

    /// Close the index of a `file_len`-byte file; the getters below read it.
    pub fn finish(&mut self, file_len: f64) -> Result<(), JsError> {
        let builder = self
            .builder
            .take()
            .ok_or_else(|| JsError::new("XtcIndexer already finished"))?;
        self.index = Some(
            builder
                .finish(file_len as u64)
                .map_err(|e| JsError::new(&e))?,
        );
        Ok(())
    }

    fn finished(&self) -> Result<&xtc::XtcIndex, JsError> {
        self.index
            .as_ref()
            .ok_or_else(|| JsError::new("XtcIndexer not finished"))
    }

    #[wasm_bindgen(getter)]
    pub fn n_atoms(&self) -> Result<u32, JsError> {
        Ok(self.finished()?.n_atoms as u32)
    }

    #[wasm_bindgen(getter)]
    pub fn n_frames(&self) -> Result<u32, JsError> {
        Ok(self.finished()?.n_frames as u32)
    }

    #[wasm_bindgen(getter)]
    pub fn timestep_ps(&self) -> Result<f32, JsError> {
        Ok(self.finished()?.timestep_ps)
    }

    #[wasm_bindgen(getter)]
    pub fn has_box(&self) -> Result<bool, JsError> {
        Ok(self.finished()?.box_matrix.is_some())
    }

    /// Frame 0's box (row-major 3×3, Å); empty without one.
    pub fn box_matrix(&self) -> Result<Float32Array, JsError> {
        let index = self.finished()?;
        Ok(match index.box_matrix {
            Some(m) => Float32Array::from(&m[..]),
            None => Float32Array::new_with_length(0),
        })
    }

    /// True when the box changes between frames (an NPT run): each frame's
    /// own box is then `frame_cell(frame)`.
    #[wasm_bindgen(getter)]
    pub fn varying_cells(&self) -> Result<bool, JsError> {
        Ok(self.finished()?.frame_cells.is_some())
    }

    /// Frame `frame`'s box; empty unless the box changes between frames.
    pub fn frame_cell(&self, frame: u32) -> Result<Float32Array, JsError> {
        Ok(frame_cell_array(
            self.finished()?.frame_cells.as_deref(),
            frame,
        ))
    }

    /// Byte offset of each frame in the file.
    pub fn offsets(&self) -> Result<Float64Array, JsError> {
        let offsets: Vec<f64> = self.finished()?.offsets.iter().map(|&o| o as f64).collect();
        Ok(Float64Array::from(&offsets[..]))
    }

    /// Per-frame time stamps (ps).
    pub fn times(&self) -> Result<Float32Array, JsError> {
        Ok(Float32Array::from(&self.finished()?.times[..]))
    }
}

impl Default for XtcIndexer {
    fn default() -> Self {
        Self::new()
    }
}

/// One of the three line-fed index builders behind [`TextFrameIndexer`].
enum TextIndexBuilder {
    Xyz(xyz::XyzIndexBuilder),
    Pdb(pdb::PdbIndexBuilder),
    Lammpstrj(lammpstrj::LammpstrjIndexBuilder),
}

/// The finished index of a [`TextFrameIndexer`].
enum TextIndex {
    Xyz(xyz::XyzIndex),
    Pdb(pdb::PdbIndex),
    Lammpstrj(lammpstrj::LammpstrjIndex),
}

/// Builds the frame index of a multi-frame text file — XYZ frames
/// (`"xyz"`), PDB models (`"pdb"`) or LAMMPS dump frames (`"lammpstrj"`) —
/// from windows of a file the host never loads whole, the way [`XtcIndexer`]
/// does for XTC: call `scan` with the file's bytes from `next_offset` on until
/// `next_offset` reaches the file's length, then `finish`. Each frame is then
/// decoded from its own bytes (`offsets[i]..offsets[i + 1]`, the last one up
/// to `frames_end`) with [`decode_text_frame`].
#[wasm_bindgen]
pub struct TextFrameIndexer {
    builder: Option<TextIndexBuilder>,
    index: Option<TextIndex>,
    /// File offsets of the frames the index decodes (extra frames for a
    /// structure, every frame for a dump).
    offsets: Vec<u64>,
    next_offset: u64,
}

#[wasm_bindgen]
impl TextFrameIndexer {
    #[wasm_bindgen(constructor)]
    pub fn new(kind: &str) -> Result<TextFrameIndexer, JsError> {
        let builder = match kind {
            "xyz" => TextIndexBuilder::Xyz(Default::default()),
            "pdb" => TextIndexBuilder::Pdb(Default::default()),
            "lammpstrj" => TextIndexBuilder::Lammpstrj(Default::default()),
            _ => return Err(JsError::new("unsupported text index kind")),
        };
        Ok(TextFrameIndexer {
            builder: Some(builder),
            index: None,
            offsets: Vec::new(),
            next_offset: 0,
        })
    }

    /// File offset the next window must start at (a byte count, exact below 2^53).
    #[wasm_bindgen(getter)]
    pub fn next_offset(&self) -> f64 {
        self.next_offset as f64
    }

    /// Index the complete lines in `window`, the file's bytes from
    /// `next_offset` on; `at_eof` says it runs to the end of the file. Returns
    /// how many bytes it used: 0 when the window holds no complete line (the
    /// host then reads a larger one).
    pub fn scan(&mut self, window: &[u8], at_eof: bool) -> Result<u32, JsError> {
        let builder = self
            .builder
            .as_mut()
            .ok_or_else(|| JsError::new("TextFrameIndexer already finished"))?;
        let used =
            lines::scan_window(
                window,
                at_eof,
                self.next_offset,
                |line, start, end| match builder {
                    TextIndexBuilder::Xyz(b) => b.push_line(line, start, end),
                    TextIndexBuilder::Pdb(b) => {
                        b.push_line(line, start, end);
                        Ok(())
                    }
                    TextIndexBuilder::Lammpstrj(b) => b.push_line(line, start),
                },
            )
            .map_err(|e| JsError::new(&e))?;
        self.next_offset += used as u64;
        Ok(used as u32)
    }

    /// Close the index of a `file_len`-byte file; the getters below read it.
    pub fn finish(&mut self, file_len: f64) -> Result<(), JsError> {
        let builder = self
            .builder
            .take()
            .ok_or_else(|| JsError::new("TextFrameIndexer already finished"))?;
        let index = match builder {
            TextIndexBuilder::Xyz(b) => {
                self.offsets = b.file_offsets().to_vec();
                b.finish().map(TextIndex::Xyz)
            }
            TextIndexBuilder::Pdb(b) => {
                self.offsets = b.file_offsets().to_vec();
                b.finish(file_len as u64).map(TextIndex::Pdb)
            }
            TextIndexBuilder::Lammpstrj(b) => {
                self.offsets = b.file_offsets().to_vec();
                b.finish().map(TextIndex::Lammpstrj)
            }
        }
        .map_err(|e| JsError::new(&e))?;
        self.index = Some(index);
        Ok(())
    }

    fn finished(&self) -> Result<&TextIndex, JsError> {
        self.index
            .as_ref()
            .ok_or_else(|| JsError::new("TextFrameIndexer not finished"))
    }

    #[wasm_bindgen(getter)]
    pub fn n_atoms(&self) -> Result<u32, JsError> {
        Ok(match self.finished()? {
            TextIndex::Xyz(i) => i.n_atoms,
            TextIndex::Pdb(i) => i.n_atoms,
            TextIndex::Lammpstrj(i) => i.n_atoms,
        } as u32)
    }

    /// Number of frames in `offsets` (extra frames for XYZ / PDB, every frame
    /// for a dump).
    #[wasm_bindgen(getter)]
    pub fn n_frames(&self) -> Result<u32, JsError> {
        self.finished()?;
        Ok(self.offsets.len() as u32)
    }

    /// True when frames vary in atom count (or, for XYZ, cell / per-frame
    /// properties): the host reparses such a file eagerly.
    #[wasm_bindgen(getter)]
    pub fn heterogeneous(&self) -> Result<bool, JsError> {
        Ok(match self.finished()? {
            TextIndex::Xyz(i) => i.heterogeneous,
            TextIndex::Pdb(i) => i.heterogeneous,
            TextIndex::Lammpstrj(i) => i.heterogeneous,
        })
    }

    /// Byte offset of each indexed frame in the file.
    pub fn offsets(&self) -> Result<Float64Array, JsError> {
        self.finished()?;
        let offsets: Vec<f64> = self.offsets.iter().map(|&o| o as f64).collect();
        Ok(Float64Array::from(&offsets[..]))
    }

    /// Where the last frame's bytes end: the start of a PDB's trailing
    /// records, else the end of the file.
    pub fn frames_end(&self, file_len: f64) -> Result<f64, JsError> {
        Ok(match self.finished()? {
            TextIndex::Pdb(i) if !i.offsets.is_empty() => i.tail_start as f64,
            _ => file_len,
        })
    }

    /// Byte offset just past frame 0 (XYZ / PDB): `file[..frame0_end]` holds it.
    #[wasm_bindgen(getter)]
    pub fn frame0_end(&self) -> Result<f64, JsError> {
        Ok(match self.finished()? {
            TextIndex::Xyz(i) => i.frame0_end,
            TextIndex::Pdb(i) => i.frame0_end,
            TextIndex::Lammpstrj(_) => 0,
        } as f64)
    }

    /// PDB only: where the records shared by every model (CONECT, …) start;
    /// model 0 parses from `file[..frame0_end] + file[tail_start..]`.
    #[wasm_bindgen(getter)]
    pub fn tail_start(&self) -> Result<f64, JsError> {
        Ok(match self.finished()? {
            TextIndex::Pdb(i) => i.tail_start as f64,
            _ => 0.0,
        })
    }

    /// PDB only: model 0 cannot be parsed from its head and tail (a record it
    /// reads sits between later models), so the host parses the whole file.
    #[wasm_bindgen(getter)]
    pub fn frame0_needs_whole_file(&self) -> Result<bool, JsError> {
        Ok(matches!(self.finished()?, TextIndex::Pdb(i) if i.frame0_needs_whole_file))
    }

    #[wasm_bindgen(getter)]
    pub fn timestep_ps(&self) -> Result<f32, JsError> {
        Ok(match self.finished()? {
            TextIndex::Lammpstrj(i) => i.timestep_ps,
            _ => 1.0,
        })
    }

    #[wasm_bindgen(getter)]
    pub fn has_box(&self) -> Result<bool, JsError> {
        Ok(matches!(self.finished()?, TextIndex::Lammpstrj(i) if i.box_matrix.is_some()))
    }

    /// Dump only: frame 0's box (row-major 3×3, Å); empty without one.
    pub fn box_matrix(&self) -> Result<Float32Array, JsError> {
        Ok(match self.finished()? {
            TextIndex::Lammpstrj(lammpstrj::LammpstrjIndex {
                box_matrix: Some(m),
                ..
            }) => Float32Array::from(&m[..]),
            _ => Float32Array::new_with_length(0),
        })
    }

    /// Dump only: frame 0's box origin (3 floats), or empty ⇒ (0,0,0).
    pub fn box_origin(&self) -> Result<Float32Array, JsError> {
        Ok(match self.finished()? {
            TextIndex::Lammpstrj(lammpstrj::LammpstrjIndex {
                box_origin: Some(o),
                ..
            }) => Float32Array::from(&o[..]),
            _ => Float32Array::new_with_length(0),
        })
    }

    /// Dump only: true when the box changes between frames (an NPT run): each
    /// frame's own box is then `frame_cell(frame)`.
    #[wasm_bindgen(getter)]
    pub fn varying_cells(&self) -> Result<bool, JsError> {
        Ok(matches!(
            self.finished()?,
            TextIndex::Lammpstrj(lammpstrj::LammpstrjIndex {
                frame_cells: Some(_),
                ..
            })
        ))
    }

    /// Dump only: frame `frame`'s box; empty unless the box changes between
    /// frames.
    pub fn frame_cell(&self, frame: u32) -> Result<Float32Array, JsError> {
        let cells = match self.finished()? {
            TextIndex::Lammpstrj(i) => i.frame_cells.as_deref(),
            _ => None,
        };
        Ok(frame_cell_array(cells, frame))
    }

    /// Dump only: newline-joined vector channel names (velocity/force).
    #[wasm_bindgen(getter)]
    pub fn vector_channel_names(&self) -> Result<String, JsError> {
        Ok(match self.finished()? {
            TextIndex::Lammpstrj(i) => i.vector_channel_names.join("\n"),
            _ => String::new(),
        })
    }
}

/// One frame decoded by [`decode_text_frame`].
#[wasm_bindgen]
pub struct DecodedTextFrame {
    positions: Vec<f32>,
    vectors: Vec<f32>,
}

#[wasm_bindgen]
impl DecodedTextFrame {
    /// Positions (Å), `n_atoms * 3` floats.
    pub fn positions(&self) -> Float32Array {
        Float32Array::from(&self.positions[..])
    }

    /// A dump's vector channels (velocity/force), concatenated in channel
    /// order; empty for XYZ / PDB.
    pub fn vectors(&self) -> Float32Array {
        Float32Array::from(&self.vectors[..])
    }
}

/// Decode one frame of a multi-frame text file from just its bytes (from its
/// offset in a [`TextFrameIndexer`] index): an XYZ frame, a PDB model or a
/// LAMMPS dump frame of `n_atoms` atoms.
#[wasm_bindgen]
pub fn decode_text_frame(
    kind: &str,
    data: &[u8],
    n_atoms: u32,
) -> Result<DecodedTextFrame, JsError> {
    let text = std::str::from_utf8(data).map_err(|_| JsError::new("file is not valid UTF-8"))?;
    let n = n_atoms as usize;
    let (positions, vectors) = match kind {
        "xyz" => (xyz::decode_frame_at(text, 0, n), Vec::new()),
        "pdb" => (pdb::decode_model_at(text, 0, n), Vec::new()),
        "lammpstrj" => {
            let frame = lammpstrj::decode_frame_at(text, 0, n).map_err(|e| JsError::new(&e))?;
            (Ok(frame.positions), frame.vectors.concat())
        }
        _ => return Err(JsError::new("unsupported text frame kind")),
    };
    Ok(DecodedTextFrame {
        positions: positions.map_err(|e| JsError::new(&e))?,
        vectors,
    })
}

enum BinaryLayout {
    Dcd(dcd::DcdLayout),
    Netcdf(netcdf::NetcdfLayout),
}

/// Where the frames of a DCD (`"dcd"`) or AMBER NetCDF (`"netcdf"`)
/// trajectory are, from the file's first bytes: every frame sits at a fixed
/// offset, so the host reads `frame_len` bytes from `frame_start(i)` and
/// `decode`s them, without ever holding the file. The constructor fails when
/// `head` is too short for the header (the host reads a longer head) or the
/// file is not one of these.
#[wasm_bindgen]
pub struct BinaryFrameLayout {
    inner: BinaryLayout,
}

#[wasm_bindgen]
impl BinaryFrameLayout {
    #[wasm_bindgen(constructor)]
    pub fn new(kind: &str, head: &[u8], file_len: f64) -> Result<BinaryFrameLayout, JsError> {
        let len = file_len as u64;
        let inner = match kind {
            "dcd" => BinaryLayout::Dcd(dcd::read_layout(head, len).map_err(|e| JsError::new(&e))?),
            "netcdf" => {
                BinaryLayout::Netcdf(netcdf::read_layout(head, len).map_err(|e| JsError::new(&e))?)
            }
            _ => return Err(JsError::new("unsupported binary trajectory kind")),
        };
        Ok(BinaryFrameLayout { inner })
    }

    #[wasm_bindgen(getter)]
    pub fn n_atoms(&self) -> u32 {
        match &self.inner {
            BinaryLayout::Dcd(l) => l.n_atoms as u32,
            BinaryLayout::Netcdf(l) => l.n_atoms as u32,
        }
    }

    #[wasm_bindgen(getter)]
    pub fn n_frames(&self) -> u32 {
        match &self.inner {
            BinaryLayout::Dcd(l) => l.n_frames as u32,
            BinaryLayout::Netcdf(l) => l.n_frames as u32,
        }
    }

    /// The time step the header gives (DCD); NaN when it comes from the
    /// frames' own `time` (NetCDF: see `netcdf_timestep`).
    #[wasm_bindgen(getter)]
    pub fn timestep_ps(&self) -> f32 {
        match &self.inner {
            BinaryLayout::Dcd(l) => l.timestep_ps,
            BinaryLayout::Netcdf(_) => f32::NAN,
        }
    }

    /// Each frame carries a unit cell.
    #[wasm_bindgen(getter)]
    pub fn has_cell(&self) -> bool {
        match &self.inner {
            BinaryLayout::Dcd(l) => l.has_cell,
            BinaryLayout::Netcdf(l) => l.has_cell(),
        }
    }

    /// File offset of frame `i`'s bytes.
    pub fn frame_start(&self, i: u32) -> f64 {
        (match &self.inner {
            BinaryLayout::Dcd(l) => l.frames_start + i as u64 * l.frame_bytes,
            BinaryLayout::Netcdf(l) => l.record_start + i as u64 * l.recsize,
        }) as f64
    }

    /// How many bytes from `frame_start(i)` a frame's decode reads.
    #[wasm_bindgen(getter)]
    pub fn frame_len(&self) -> f64 {
        (match &self.inner {
            BinaryLayout::Dcd(l) => l.frame_bytes,
            BinaryLayout::Netcdf(l) => l.record_span(),
        }) as f64
    }

    /// Decode frame `i` from its bytes (read from `frame_start(i)`).
    pub fn decode(&self, bytes: &[u8], i: u32) -> Result<DecodedBinaryFrame, JsError> {
        let (positions, cell, time) = match &self.inner {
            BinaryLayout::Dcd(l) => {
                let (positions, cell) =
                    dcd::decode_layout_frame(l, bytes).map_err(|e| JsError::new(&e))?;
                (positions, cell, None)
            }
            BinaryLayout::Netcdf(l) => {
                let f = netcdf::decode_layout_record(l, bytes, i as usize)
                    .map_err(|e| JsError::new(&e))?;
                (f.positions, f.cell, f.time)
            }
        };
        Ok(DecodedBinaryFrame {
            positions,
            cell,
            time,
        })
    }
}

/// The index of an ASE `.traj` that stays in its File, built one frame at a
/// time (see `megane_core::traj::TrajIndexBuilder`): the host reads the
/// header, then `table_start..table_end`, then each frame from `next_start`
/// to the end of its JSON (the 8 bytes at `json_offset(i)` give its length
/// through `json_len`), and later reads `frame_start(f)..frame_end(f)` to
/// `decode` extra frame `f`. File offsets cross as f64 so files past 4 GiB
/// index too.
#[wasm_bindgen]
pub struct TrajFileIndexer {
    inner: traj::TrajIndexBuilder,
}

#[wasm_bindgen]
impl TrajFileIndexer {
    /// `head` is the file's first bytes (at least the 48-byte header).
    #[wasm_bindgen(constructor)]
    pub fn new(head: &[u8], file_len: f64) -> Result<TrajFileIndexer, JsError> {
        let inner =
            traj::TrajIndexBuilder::new(head, file_len as u64).map_err(|e| JsError::new(&e))?;
        Ok(TrajFileIndexer { inner })
    }

    #[wasm_bindgen(getter)]
    pub fn table_start(&self) -> f64 {
        self.inner.table_range().0 as f64
    }

    #[wasm_bindgen(getter)]
    pub fn table_end(&self) -> f64 {
        self.inner.table_range().1 as f64
    }

    pub fn set_table(&mut self, table: &[u8]) -> Result<(), JsError> {
        self.inner.set_table(table).map_err(|e| JsError::new(&e))
    }

    /// Frames in the file, frame 0 included.
    #[wasm_bindgen(getter)]
    pub fn n_items(&self) -> u32 {
        self.inner.n_items() as u32
    }

    pub fn json_offset(&self, item: u32) -> Result<f64, JsError> {
        self.inner
            .json_offset(item as usize)
            .map(|o| o as f64)
            .ok_or_else(|| JsError::new("frame index out of range"))
    }

    pub fn json_len(&self, bytes: &[u8]) -> Result<f64, JsError> {
        self.inner
            .json_len(bytes)
            .map(|l| l as f64)
            .map_err(|e| JsError::new(&e))
    }

    /// Where the next frame to add starts.
    #[wasm_bindgen(getter)]
    pub fn next_start(&self) -> f64 {
        self.inner.next_start() as f64
    }

    pub fn add_frame(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        self.inner.add_frame(bytes).map_err(|e| JsError::new(&e))
    }

    /// Frame 0's snapshot, once frame 0 is added.
    pub fn frame0(&mut self) -> Result<ParseResult, JsError> {
        self.inner
            .take_frame0()
            .map(ParseResult::from_parsed)
            .ok_or_else(|| JsError::new("frame 0 is not indexed"))
    }

    #[wasm_bindgen(getter)]
    pub fn n_atoms(&self) -> u32 {
        self.inner.n_atoms() as u32
    }

    /// Frames after frame 0.
    #[wasm_bindgen(getter)]
    pub fn n_frames(&self) -> u32 {
        self.inner.n_frames() as u32
    }

    /// A frame's atom count or elements differ from frame 0's: the host
    /// parses the file whole instead.
    #[wasm_bindgen(getter)]
    pub fn heterogeneous(&self) -> bool {
        self.inner.heterogeneous()
    }

    /// The cell changes between frames, so each frame carries its own.
    #[wasm_bindgen(getter)]
    pub fn varying_cells(&self) -> bool {
        self.inner.varying_cells()
    }

    /// Extra frame `frame`'s cell (row-major 3×3, Å); empty unless cells vary.
    pub fn frame_cell(&self, frame: u32) -> Float32Array {
        match self.inner.frame_cell(frame as usize) {
            Some(m) => Float32Array::from(&m[..]),
            None => Float32Array::new_with_length(0),
        }
    }

    pub fn frame_start(&self, frame: u32) -> Result<f64, JsError> {
        self.range(frame).map(|r| r.0)
    }

    pub fn frame_end(&self, frame: u32) -> Result<f64, JsError> {
        self.range(frame).map(|r| r.1)
    }

    /// Extra frame `frame`'s positions (Å) from its bytes.
    pub fn decode(&self, frame: u32, bytes: &[u8]) -> Result<Float32Array, JsError> {
        let positions = self
            .inner
            .decode(frame as usize, bytes)
            .map_err(|e| JsError::new(&e))?;
        Ok(Float32Array::from(&positions[..]))
    }
}

impl TrajFileIndexer {
    fn range(&self, frame: u32) -> Result<(f64, f64), JsError> {
        self.inner
            .frame_range(frame as usize)
            .map(|(s, e)| (s as f64, e as f64))
            .ok_or_else(|| JsError::new("frame index out of range"))
    }
}

/// One frame decoded by [`BinaryFrameLayout::decode`].
#[wasm_bindgen]
pub struct DecodedBinaryFrame {
    positions: Vec<f32>,
    cell: Option<[f32; 9]>,
    time: Option<f32>,
}

#[wasm_bindgen]
impl DecodedBinaryFrame {
    /// Positions (Å), `n_atoms * 3` floats.
    pub fn positions(&self) -> Float32Array {
        Float32Array::from(&self.positions[..])
    }

    /// This frame's cell (row-major 3×3, Å); empty without one.
    pub fn cell(&self) -> Float32Array {
        match &self.cell {
            Some(m) => Float32Array::from(&m[..]),
            None => Float32Array::new_with_length(0),
        }
    }

    /// This frame's time (ps); NaN without one.
    #[wasm_bindgen(getter)]
    pub fn time(&self) -> f32 {
        self.time.unwrap_or(f32::NAN)
    }
}

/// The time step (ps) of an AMBER NetCDF trajectory from its first two
/// frames' `time` (NaN when a frame has none), as the eager reader computes it.
#[wasm_bindgen]
pub fn netcdf_timestep(n_frames: u32, t0: f32, t1: f32) -> f32 {
    let has_time = !t0.is_nan();
    let opt = |t: f32| (!t.is_nan()).then_some(t);
    netcdf::netcdf_timestep(n_frames as usize, has_time, [opt(t0), opt(t1)])
}

/// Persistent LAMMPS-dump decoder for lazy/streaming playback (text format).
///
/// Owns the dump text and a frame byte-offset index; decodes one frame's
/// positions (and any velocity/force vector channels) on demand.
#[wasm_bindgen]
pub struct LammpstrjDecoder {
    text: String,
    offsets: Vec<usize>,
    n_atoms: usize,
    n_frames: u32,
    timestep_ps: f32,
    has_box: bool,
    box_matrix: Vec<f32>,
    box_origin: Vec<f32>,
    /// Newline-joined vector channel names (velocity/force), in decode order.
    vector_channel_names: Vec<String>,
    heterogeneous: bool,
    frame_cells: Option<Vec<[f32; 9]>>,
}

#[wasm_bindgen]
impl LammpstrjDecoder {
    #[wasm_bindgen(constructor)]
    pub fn new(data: Vec<u8>) -> Result<LammpstrjDecoder, JsError> {
        let text = String::from_utf8(data).map_err(|_| JsError::new("dump is not valid UTF-8"))?;
        let idx = lammpstrj::build_index(&text).map_err(|e| JsError::new(&e))?;
        let has_box = idx.box_matrix.is_some();
        let box_matrix = idx.box_matrix.map(|m| m.to_vec()).unwrap_or_default();
        let box_origin = idx.box_origin.map(|o| o.to_vec()).unwrap_or_default();
        Ok(LammpstrjDecoder {
            text,
            offsets: idx.offsets,
            n_atoms: idx.n_atoms,
            n_frames: idx.n_frames as u32,
            timestep_ps: idx.timestep_ps,
            has_box,
            box_matrix,
            box_origin,
            vector_channel_names: idx.vector_channel_names,
            heterogeneous: idx.heterogeneous,
            frame_cells: idx.frame_cells,
        })
    }

    #[wasm_bindgen(getter)]
    pub fn n_atoms(&self) -> u32 {
        self.n_atoms as u32
    }
    #[wasm_bindgen(getter)]
    pub fn n_frames(&self) -> u32 {
        self.n_frames
    }
    /// True when the dump's atom count varies between frames — the host must
    /// discard this positions-only decoder and reparse the dump eagerly.
    #[wasm_bindgen(getter)]
    pub fn heterogeneous(&self) -> bool {
        self.heterogeneous
    }
    #[wasm_bindgen(getter)]
    pub fn timestep_ps(&self) -> f32 {
        self.timestep_ps
    }
    #[wasm_bindgen(getter)]
    pub fn has_box(&self) -> bool {
        self.has_box
    }
    pub fn box_matrix(&self) -> Float32Array {
        Float32Array::from(&self.box_matrix[..])
    }
    /// Box origin (lower corner, 3 floats), or empty ⇒ (0,0,0).
    pub fn box_origin(&self) -> Float32Array {
        Float32Array::from(&self.box_origin[..])
    }
    /// True when the box changes between frames (an NPT run): each frame's
    /// own box is then `frame_cell(frame)`.
    #[wasm_bindgen(getter)]
    pub fn varying_cells(&self) -> bool {
        self.frame_cells.is_some()
    }
    /// Frame `frame`'s box; empty unless the box changes between frames.
    pub fn frame_cell(&self, frame: u32) -> Float32Array {
        frame_cell_array(self.frame_cells.as_deref(), frame)
    }
    /// Number of per-atom vector channels (velocity/force).
    #[wasm_bindgen(getter)]
    pub fn vector_channel_count(&self) -> u32 {
        self.vector_channel_names.len() as u32
    }
    /// Newline-joined vector channel names, in decode order.
    #[wasm_bindgen(getter)]
    pub fn vector_channel_names(&self) -> String {
        self.vector_channel_names.join("\n")
    }

    /// Decode a single frame's positions (Å), `n_atoms * 3` floats.
    pub fn decode_frame(&self, frame: u32) -> Result<Float32Array, JsError> {
        let offset = *self
            .offsets
            .get(frame as usize)
            .ok_or_else(|| JsError::new("frame index out of range"))?;
        let decoded = lammpstrj::decode_frame_at(&self.text, offset, self.n_atoms)
            .map_err(|e| JsError::new(&e))?;
        Ok(Float32Array::from(&decoded.positions[..]))
    }

    /// Decode a single frame's vector channels, concatenated in channel order:
    /// `[channel0 (n_atoms*3), channel1 (n_atoms*3), ...]`. Empty if none.
    pub fn decode_frame_vectors(&self, frame: u32) -> Result<Float32Array, JsError> {
        let offset = *self
            .offsets
            .get(frame as usize)
            .ok_or_else(|| JsError::new("frame index out of range"))?;
        let decoded = lammpstrj::decode_frame_at(&self.text, offset, self.n_atoms)
            .map_err(|e| JsError::new(&e))?;
        let mut flat: Vec<f32> = Vec::new();
        for v in &decoded.vectors {
            flat.extend_from_slice(v);
        }
        Ok(Float32Array::from(&flat[..]))
    }
}

/// Persistent decoder for the extra frames of a multi-frame structure file
/// (XYZ frames or PDB models). Owns the text and a per-frame byte-offset index,
/// and parses frame 0 (via `frame0()`) from the SAME held copy — so one worker
/// round-trip (one file read) yields both the index and the eager snapshot.
#[wasm_bindgen]
pub struct StructureFrameDecoder {
    text: String,
    kind: String,
    offsets: Vec<usize>,
    n_atoms: usize,
    n_frames: u32,
    heterogeneous: bool,
}

#[wasm_bindgen]
impl StructureFrameDecoder {
    /// `kind` selects the format ("xyz" or "pdb"). The bytes move into wasm memory.
    #[wasm_bindgen(constructor)]
    pub fn new(data: Vec<u8>, kind: &str) -> Result<StructureFrameDecoder, JsError> {
        let text = String::from_utf8(data).map_err(|_| JsError::new("file is not valid UTF-8"))?;
        let (offsets, n_atoms, heterogeneous) = match kind {
            "xyz" => {
                let idx = xyz::build_index(&text).map_err(|e| JsError::new(&e))?;
                (idx.offsets, idx.n_atoms, idx.heterogeneous)
            }
            "pdb" => {
                let idx = parser::build_index(&text).map_err(|e| JsError::new(&e))?;
                (idx.offsets, idx.n_atoms, idx.heterogeneous)
            }
            _ => return Err(JsError::new("unsupported structure decoder kind")),
        };
        let n_frames = offsets.len() as u32;
        Ok(StructureFrameDecoder {
            text,
            kind: kind.to_string(),
            offsets,
            n_atoms,
            n_frames,
            heterogeneous,
        })
    }

    #[wasm_bindgen(getter)]
    pub fn n_atoms(&self) -> u32 {
        self.n_atoms as u32
    }
    /// Number of EXTRA frames (excludes the eager snapshot frame 0).
    #[wasm_bindgen(getter)]
    pub fn n_frames(&self) -> u32 {
        self.n_frames
    }

    /// True when the file is heterogeneous (a frame's atom count or per-frame
    /// cell differs from frame 0). The positions-only lazy decode below cannot
    /// represent such frames, so the host discards this decoder and reparses the
    /// whole file eagerly (which builds the full `HeteroFrames` side table).
    #[wasm_bindgen(getter)]
    pub fn heterogeneous(&self) -> bool {
        self.heterogeneous
    }

    /// Parse frame 0 (the eager snapshot: topology + frame-0 coordinates) from
    /// the held text, WITHOUT re-reading the file. Lets one worker round-trip
    /// return both the index and frame 0 for instant first paint.
    pub fn frame0(&self) -> Result<ParseResult, JsError> {
        let data = match self.kind.as_str() {
            "pdb" => parser::parse_frame0(&self.text),
            _ => xyz::parse_frame0(&self.text),
        }
        .map_err(|e| JsError::new(&e))?;
        Ok(ParseResult::from_parsed(data))
    }

    /// Decode extra frame `i` (0-indexed into the extra frames) → positions (Å).
    pub fn decode_frame(&self, frame: u32) -> Result<Float32Array, JsError> {
        let offset = *self
            .offsets
            .get(frame as usize)
            .ok_or_else(|| JsError::new("frame index out of range"))?;
        let coords = match self.kind.as_str() {
            "pdb" => parser::decode_model_at(&self.text, offset, self.n_atoms),
            _ => xyz::decode_frame_at(&self.text, offset, self.n_atoms),
        }
        .map_err(|e| JsError::new(&e))?;
        Ok(Float32Array::from(&coords[..]))
    }
}

/// Parse ONLY frame 0 from a bounded PREFIX of a large multi-frame structure
/// file (XYZ / PDB), for size-independent first paint. Errors if frame 0 is not
/// fully contained in the prefix (the JS side then grows the prefix or falls back
/// to a full read). `is_whole_file` is true when the prefix already covers the
/// entire file.
#[wasm_bindgen]
pub fn parse_structure_prefix(
    text: &str,
    kind: &str,
    is_whole_file: bool,
) -> Result<ParseResult, JsError> {
    let data = match kind {
        "pdb" => parser::parse_frame0_prefix(text, is_whole_file),
        "xyz" => xyz::parse_frame0(text), // errors if frame 0's atom lines are truncated
        _ => return Err(JsError::new("unsupported structure prefix kind")),
    }
    .map_err(|e| JsError::new(&e))?;
    Ok(ParseResult::from_parsed(data))
}

/// Parse ONLY frame 0 of an ASE `.traj` from the file's first bytes (`head`)
/// and last bytes (`tail`) of `total_len`, for a first paint while the rest of
/// the file is still on its way (the VSCode host sends head and tail first).
/// Errors when frame 0 or its offset-table entry is not in those bytes; the
/// JS side then waits for the whole file.
#[wasm_bindgen]
pub fn parse_traj_frame0(
    head: &[u8],
    tail: &[u8],
    total_len: usize,
) -> Result<ParseResult, JsError> {
    let data = megane_core::traj::parse_traj_frame0(head, tail, total_len)
        .map_err(|e| JsError::new(&e))?;
    Ok(ParseResult::from_parsed(data))
}

/// Decode ONLY frame 0 (positions, Å) from a bounded PREFIX of a large
/// trajectory (XTC / LAMMPS dump), for size-independent first paint. Frame 0 is
/// at the start of the file, so a bounded prefix contains it. Errors if the
/// prefix is too small to hold frame 0 (the JS side then grows it or falls back
/// to a full read). `data` is the raw prefix bytes (UTF-8 text for LAMMPS dump).
#[wasm_bindgen]
pub fn decode_trajectory_frame0(
    data: Vec<u8>,
    kind: &str,
    n_atoms: u32,
) -> Result<Float32Array, JsError> {
    let n = n_atoms as usize;
    let coords: Vec<f32> = match kind {
        "lammpstrj" => {
            let text = String::from_utf8_lossy(&data);
            let off = text
                .find("ITEM: TIMESTEP")
                .ok_or_else(|| JsError::new("no frame in prefix"))?;
            lammpstrj::decode_frame_at(&text, off, n)
                .map(|f| f.positions)
                .map_err(|e| JsError::new(&e))?
        }
        "xtc" => xtc::decode_frame_at(&data, 0, n).map_err(|e| JsError::new(&e))?,
        _ => return Err(JsError::new("unsupported trajectory frame0 kind")),
    };
    Ok(Float32Array::from(&coords[..]))
}

/// Generates one `#[wasm_bindgen]` structure parser per
/// `megane_core::for_each_structure_format!` entry (`parse_pdb`, `parse_gro`,
/// …). The registry is shared with the Python binding, so both hosts expose
/// the same formats under the same names.
macro_rules! wasm_structure_parsers {
    ($( $(#[doc = $doc:tt])* $variant:ident => $binding:ident($arg:ident: $ty:ty); )*) => {
        $(
            $(#[doc = $doc])*
            #[wasm_bindgen]
            pub fn $binding($arg: $ty) -> Result<ParseResult, JsError> {
                let data = StructureFormat::$variant
                    .parse($arg.into())
                    .map_err(|e| JsError::new(&e))?;
                Ok(ParseResult::from_parsed(data))
            }
        )*
    };
}

megane_core::for_each_structure_format!(wasm_structure_parsers);

/// Parse a structure file's raw bytes, choosing the format from its extension
/// (`".pdb"`, `"gro"`, …; an unknown extension reads as PDB, like the browser's
/// dispatch). Text formats are decoded from UTF-8 inside WASM, so the page can
/// hand over the bytes it read instead of first making a JS string of the file
/// (which the worker would then hold a second copy of).
#[wasm_bindgen]
pub fn parse_structure_bytes(ext: &str, data: &[u8]) -> Result<ParseResult, JsError> {
    let format = StructureFormat::from_extension(ext).unwrap_or(StructureFormat::Pdb);
    let parsed = format
        .parse(FormatInput::Bytes(data))
        .map_err(|e| JsError::new(&e))?;
    Ok(ParseResult::from_parsed(parsed))
}

/// The shared format registry as JSON (`megane_core::formats::registry_json`):
/// every structure / trajectory format with its exported function names,
/// encoding, and file extensions. Lets host tests check the exports and the
/// extension tables against the one source of truth.
#[wasm_bindgen]
pub fn format_registry() -> String {
    formats::registry_json()
}

/// A decoded JCAMP-DX spectrum, exposed to JavaScript.
///
/// A spectrum has no coordinates, so it deliberately does NOT reuse
/// `ParseResult` — nothing about atoms, bonds, or a unit cell applies. The
/// host turns this into the `spectrum` pipeline data type.
#[wasm_bindgen]
pub struct SpectrumResult {
    #[wasm_bindgen(getter_with_clone)]
    pub title: String,
    #[wasm_bindgen(getter_with_clone)]
    pub data_type: String,
    #[wasm_bindgen(getter_with_clone)]
    pub x_units: String,
    #[wasm_bindgen(getter_with_clone)]
    pub y_units: String,
    pub n_points: usize,
    /// Non-fatal parse warnings, newline-delimited (empty for a clean parse).
    #[wasm_bindgen(getter_with_clone)]
    pub warnings: String,
    x: Vec<f64>,
    y: Vec<f64>,
}

#[wasm_bindgen]
impl SpectrumResult {
    /// Abscissa values (wavenumber, ppm, m/z, … — see `x_units`).
    pub fn x(&self) -> Float64Array {
        Float64Array::from(&self.x[..])
    }

    /// Ordinate values (transmittance, absorbance, … — see `y_units`).
    pub fn y(&self) -> Float64Array {
        Float64Array::from(&self.y[..])
    }
}

/// Parse a JCAMP-DX spectrum (`.jdx` / `.jcamp`) and return its decoded
/// abscissa/ordinate arrays. Handles the AFFN, SQZ, DIF, and DUP encodings of
/// an `(X++(Y..Y))` table as well as `(XY..XY)` peak tables.
#[wasm_bindgen]
pub fn parse_jcampdx(text: &str) -> Result<SpectrumResult, JsError> {
    let s = jcampdx::parse(text).map_err(|e| JsError::new(&e))?;
    Ok(SpectrumResult {
        title: s.title,
        data_type: s.data_type,
        x_units: s.x_units,
        y_units: s.y_units,
        n_points: s.x.len(),
        warnings: s.warnings.join("\n"),
        x: s.x,
        y: s.y,
    })
}

/// Infer bonds using VDW radii (threshold = vdw_sum * 0.6).
/// Returns flat Uint32Array [a0, b0, a1, b1, ...].
#[wasm_bindgen]
pub fn infer_bonds_vdw(positions: &[f32], elements: &[u8], n_atoms: u32) -> Uint32Array {
    let result = bonds::infer_bonds_vdw(positions, elements, n_atoms as usize);
    Uint32Array::from(&bonds::flatten_pairs(&result)[..])
}

/// Serialize a structure as `xyz` (extended XYZ when a cell is given), `pdb`,
/// `mol`, `cif` or `poscar` text — the inverse of the parsers, used by the
/// Builder's export. `cif` and `poscar` need a cell and fail without one.
/// Empty `bond_orders` / `box_matrix` / `box_origin` / `atom_labels` /
/// `chain_ids` mean "absent"; `atom_labels` is newline-delimited like
/// `ParseResult`.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn write_structure(
    format: &str,
    positions: &[f32],
    elements: &[u8],
    bonds: &[u32],
    bond_orders: &[u8],
    box_matrix: &[f32],
    box_origin: &[f32],
    atom_labels: &str,
    chain_ids: &[u8],
) -> Result<String, JsError> {
    let cell = if box_matrix.len() == 9 {
        let mut m = [0.0f32; 9];
        m.copy_from_slice(box_matrix);
        Some(m)
    } else {
        None
    };
    let origin = (box_origin.len() == 3).then(|| [box_origin[0], box_origin[1], box_origin[2]]);
    let labels: Option<Vec<String>> = if atom_labels.is_empty() {
        None
    } else {
        Some(atom_labels.split('\n').map(str::to_string).collect())
    };
    let view = writer::StructureView {
        positions,
        elements,
        bonds,
        bond_orders: (!bond_orders.is_empty()).then_some(bond_orders),
        box_matrix: cell,
        box_origin: origin,
        atom_labels: labels.as_deref(),
        chain_ids: (!chain_ids.is_empty()).then_some(chain_ids),
    };
    writer::write(format, &view).map_err(|e| JsError::new(&e))
}

/// The default AddBond source for a structure filename: `"structure"` for
/// formats that embed bonds, `"distance"` (VDW inference) otherwise.
/// Shared policy with the Python host (`megane_core::bonds::default_bond_source`).
#[wasm_bindgen]
pub fn default_bond_source(filename: &str) -> String {
    bonds::default_bond_source(filename).to_string()
}

/// Parse GROMACS .top file and extract bond pairs.
/// Returns flat Uint32Array [a0, b0, a1, b1, ...].
#[wasm_bindgen]
pub fn parse_top_bonds(text: &str, n_atoms: u32) -> Uint32Array {
    let result = top::parse_top_bonds(text, n_atoms as usize);
    Uint32Array::from(&bonds::flatten_pairs(&result)[..])
}

/// Parse a GROMACS `.top` text with `#include` resolution.
///
/// `include_files` is a plain JS object mapping include path (string) to file
/// content (string).  Missing keys are silently skipped (matches how system
/// forcefield includes behave in practice).
///
/// Returns a flat `Uint32Array` `[a0, b0, a1, b1, ...]` of 0-indexed bond
/// pairs, or throws if a circular include is detected.
#[wasm_bindgen]
pub fn parse_top_bonds_with_includes(
    text: &str,
    include_files: &Object,
    n_atoms: u32,
) -> Result<Uint32Array, JsError> {
    use std::collections::HashMap;

    let mut files: HashMap<String, String> = HashMap::new();
    let keys = Object::keys(include_files);
    for i in 0..keys.length() {
        let key = keys.get(i);
        let key_str = key.as_string().unwrap_or_default();
        if let Ok(val) = Reflect::get(include_files, &key) {
            if let Some(s) = val.as_string() {
                files.insert(key_str, s);
            }
        }
    }

    let vfs = top::VirtualTopFileSystem::new(files);
    let result =
        top::parse_top_bonds_with_fs(text, &vfs, n_atoms as usize).map_err(|e| JsError::new(&e))?;
    Ok(Uint32Array::from(&bonds::flatten_pairs(&result)[..]))
}

/// Extract atom labels from a structure file text.
/// Returns newline-delimited labels string.
#[wasm_bindgen]
pub fn extract_labels(text: &str, format: &str) -> String {
    let result = match format {
        "gro" => gro::parse(text),
        "xyz" => xyz::parse(text),
        "lammps_data" => lammps_data::parse(text),
        _ => parser::parse(text),
    };
    match result {
        Ok(data) => data.atom_labels.map(|l| l.join("\n")).unwrap_or_default(),
        Err(_) => String::new(),
    }
}

/// Parse a CHARMM/NAMD PSF topology file and extract bond pairs.
/// Returns flat Uint32Array [a0, b0, a1, b1, ...] with 0-indexed pairs.
#[wasm_bindgen]
pub fn parse_psf_bonds(text: &str, n_atoms: u32) -> Uint32Array {
    let result = psf::parse_psf_bonds(text, n_atoms as usize);
    Uint32Array::from(&bonds::flatten_pairs(&result)[..])
}

/// Extract only CONECT bonds from a PDB file text.
/// Returns flat Uint32Array [a0, b0, a1, b1, ...].
#[wasm_bindgen]
pub fn parse_pdb_bonds(text: &str, n_atoms: u32) -> Uint32Array {
    let data = match parser::parse(text) {
        Ok(d) => d,
        Err(_) => return Uint32Array::new_with_length(0),
    };
    // Only return file bonds (CONECT), not inferred ones, and drop any pair
    // that indexes past the caller's atom count.
    let valid: Vec<(u32, u32)> = data.bonds[..data.n_file_bonds]
        .iter()
        .copied()
        .filter(|&(a, b)| a < n_atoms && b < n_atoms)
        .collect();
    Uint32Array::from(&bonds::flatten_pairs(&valid)[..])
}
