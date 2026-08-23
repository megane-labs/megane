use js_sys::{Float32Array, Float64Array, Object, Reflect, Uint32Array, Uint8Array};
use wasm_bindgen::prelude::*;

use megane_core::{
    amber, bonds, c3xml, cif, cml, dcd, gamess, gro, jcampdx, lammps_data, lammpstrj, magres,
    mmcif, mol, mol2, molden, netcdf, odydata, parser, phonon, psf, top, traj, vasp, xsf, xtc, xyz,
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
        let mut bonds_flat: Vec<u32> = Vec::with_capacity(data.bonds.len() * 2);
        for (a, b) in &data.bonds {
            bonds_flat.push(*a);
            bonds_flat.push(*b);
        }
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

/// Parse an XTC trajectory binary and return frame data.
#[wasm_bindgen]
pub fn parse_xtc_file(data: &[u8]) -> Result<XtcParseResult, JsError> {
    let xtc_data = xtc::parse_xtc(data).map_err(|e| JsError::new(&e))?;
    Ok(XtcParseResult::from_trajectory(xtc_data))
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
    offsets: Vec<usize>,
    n_atoms: usize,
    n_frames: u32,
    timestep_ps: f32,
    has_box: bool,
    box_matrix: Vec<f32>,
    times: Vec<f32>,
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

    pub fn box_matrix(&self) -> Float32Array {
        Float32Array::from(&self.box_matrix[..])
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
        let coords = xtc::decode_frame_at(&self.bytes, offset, self.n_atoms)
            .map_err(|e| JsError::new(&e))?;
        Ok(Float32Array::from(&coords[..]))
    }
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

/// Parse a PDB file text and return structured data for the molecular viewer.
#[wasm_bindgen]
pub fn parse_pdb(text: &str) -> Result<ParseResult, JsError> {
    let data = parser::parse(text).map_err(|e| JsError::new(&e))?;
    Ok(ParseResult::from_parsed(data))
}

/// Parse a GRO file text and return structured data.
#[wasm_bindgen]
pub fn parse_gro(text: &str) -> Result<ParseResult, JsError> {
    let data = gro::parse(text).map_err(|e| JsError::new(&e))?;
    Ok(ParseResult::from_parsed(data))
}

/// Parse an XYZ file text and return structured data.
#[wasm_bindgen]
pub fn parse_xyz(text: &str) -> Result<ParseResult, JsError> {
    let data = xyz::parse(text).map_err(|e| JsError::new(&e))?;
    Ok(ParseResult::from_parsed(data))
}

/// Parse an XCrySDen structure file (`.xsf` / `.axsf`) and return structured
/// data. An `ANIMSTEPS` animation yields a multi-frame structure.
#[wasm_bindgen]
pub fn parse_xsf(text: &str) -> Result<ParseResult, JsError> {
    let data = xsf::parse(text).map_err(|e| JsError::new(&e))?;
    Ok(ParseResult::from_parsed(data))
}

/// Parse a Chemical Markup Language (`.cml`) document and return structured data.
#[wasm_bindgen]
pub fn parse_cml(text: &str) -> Result<ParseResult, JsError> {
    let data = cml::parse(text).map_err(|e| JsError::new(&e))?;
    Ok(ParseResult::from_parsed(data))
}

/// Parse a VASP POSCAR / CONTCAR / XDATCAR (also `.vasp`) text and return
/// structured data. An XDATCAR yields a multi-frame structure.
#[wasm_bindgen]
pub fn parse_vasp(text: &str) -> Result<ParseResult, JsError> {
    let data = vasp::parse(text).map_err(|e| JsError::new(&e))?;
    Ok(ParseResult::from_parsed(data))
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

/// Parse a Molden file (`.molden`) and return structured data. A `[GEOMETRIES] XYZ` block yields a multi-frame structure.
#[wasm_bindgen]
pub fn parse_molden(text: &str) -> Result<ParseResult, JsError> {
    let data = molden::parse(text).map_err(|e| JsError::new(&e))?;
    Ok(ParseResult::from_parsed(data))
}

/// Parse a Chem3D XML (`.c3xml`) document and return structured data.
#[wasm_bindgen]
pub fn parse_c3xml(text: &str) -> Result<ParseResult, JsError> {
    let data = c3xml::parse(text).map_err(|e| JsError::new(&e))?;
    Ok(ParseResult::from_parsed(data))
}
/// Parse a Wavefunction Odyssey (`.xodydata` / `.odydata`) file and return structured data. The XML and text flavours are detected from the content.
#[wasm_bindgen]
pub fn parse_odydata(text: &str) -> Result<ParseResult, JsError> {
    let data = odydata::parse(text).map_err(|e| JsError::new(&e))?;
    Ok(ParseResult::from_parsed(data))
}
/// Parse a CASTEP / Quantum ESPRESSO NMR `.magres` file and return structured data from its `[atoms]` block.
#[wasm_bindgen]
pub fn parse_magres(text: &str) -> Result<ParseResult, JsError> {
    let data = magres::parse(text).map_err(|e| JsError::new(&e))?;
    Ok(ParseResult::from_parsed(data))
}
/// Parse a GAMESS (US / Firefly) output file and return structured data. Each `COORDINATES OF ALL ATOMS ARE` block becomes a frame.
#[wasm_bindgen]
pub fn parse_gamess(text: &str) -> Result<ParseResult, JsError> {
    let data = gamess::parse(text).map_err(|e| JsError::new(&e))?;
    Ok(ParseResult::from_parsed(data))
}
/// Parse a CASTEP `.phonon` lattice-dynamics file and return the periodic structure from its header.
#[wasm_bindgen]
pub fn parse_phonon(text: &str) -> Result<ParseResult, JsError> {
    let data = phonon::parse(text).map_err(|e| JsError::new(&e))?;
    Ok(ParseResult::from_parsed(data))
}

/// Parse an MDL Molfile (V2000) text and return structured data.
#[wasm_bindgen]
pub fn parse_mol(text: &str) -> Result<ParseResult, JsError> {
    let data = mol::parse(text).map_err(|e| JsError::new(&e))?;
    Ok(ParseResult::from_parsed(data))
}

/// Parse a Tripos MOL2 file text and return structured data.
#[wasm_bindgen]
pub fn parse_mol2(text: &str) -> Result<ParseResult, JsError> {
    let data = mol2::parse(text).map_err(|e| JsError::new(&e))?;
    Ok(ParseResult::from_parsed(data))
}

/// Parse a CIF file text and return structured data.
///
/// Auto-detects mmCIF (PDBx/macromolecular) vs small-molecule CIF and routes
/// to the appropriate parser.
#[wasm_bindgen]
pub fn parse_cif(text: &str) -> Result<ParseResult, JsError> {
    let data = if mmcif::is_mmcif(text) {
        mmcif::parse(text)
    } else {
        cif::parse(text)
    }
    .map_err(|e| JsError::new(&e))?;
    Ok(ParseResult::from_parsed(data))
}

/// Parse an mmCIF (PDBx) file text and return structured data.
#[wasm_bindgen]
pub fn parse_mmcif(text: &str) -> Result<ParseResult, JsError> {
    let data = mmcif::parse(text).map_err(|e| JsError::new(&e))?;
    Ok(ParseResult::from_parsed(data))
}

/// Parse a LAMMPS data file text and return structured data.
#[wasm_bindgen]
pub fn parse_lammps_data(text: &str) -> Result<ParseResult, JsError> {
    let data = lammps_data::parse(text).map_err(|e| JsError::new(&e))?;
    Ok(ParseResult::from_parsed(data))
}

/// Parse an AMBER prmtop topology file (topology only, positions at origin).
#[wasm_bindgen]
pub fn parse_prmtop(text: &str) -> Result<ParseResult, JsError> {
    let data = amber::parse_prmtop(text).map_err(|e| JsError::new(&e))?;
    Ok(ParseResult::from_parsed(data))
}

/// Infer bonds using VDW radii (threshold = vdw_sum * 0.6).
/// Returns flat Uint32Array [a0, b0, a1, b1, ...].
#[wasm_bindgen]
pub fn infer_bonds_vdw(positions: &[f32], elements: &[u8], n_atoms: u32) -> Uint32Array {
    let result = bonds::infer_bonds_vdw(positions, elements, n_atoms as usize);
    let mut flat: Vec<u32> = Vec::with_capacity(result.len() * 2);
    for (a, b) in &result {
        flat.push(*a);
        flat.push(*b);
    }
    Uint32Array::from(&flat[..])
}

/// Parse GROMACS .top file and extract bond pairs.
/// Returns flat Uint32Array [a0, b0, a1, b1, ...].
#[wasm_bindgen]
pub fn parse_top_bonds(text: &str, n_atoms: u32) -> Uint32Array {
    let result = top::parse_top_bonds(text, n_atoms as usize);
    let mut flat: Vec<u32> = Vec::with_capacity(result.len() * 2);
    for (a, b) in &result {
        flat.push(*a);
        flat.push(*b);
    }
    Uint32Array::from(&flat[..])
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

    let mut flat: Vec<u32> = Vec::with_capacity(result.len() * 2);
    for (a, b) in &result {
        flat.push(*a);
        flat.push(*b);
    }
    Ok(Uint32Array::from(&flat[..]))
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

/// Parse a LAMMPS dump trajectory (.lammpstrj) and return frame data.
#[wasm_bindgen]
pub fn parse_lammpstrj_file(text: &str) -> Result<XtcParseResult, JsError> {
    let data = lammpstrj::parse_lammpstrj(text).map_err(|e| JsError::new(&e))?;
    Ok(XtcParseResult::from_trajectory(data))
}

/// Parse a LAMMPS dump as a standalone multi-frame **structure** (frame-0
/// topology + extra frames). Element identities are the integer LAMMPS `type`
/// ids used as an atomic-number proxy; bonds are inferred from frame 0.
#[wasm_bindgen]
pub fn parse_lammpstrj_structure(text: &str) -> Result<ParseResult, JsError> {
    let parsed = lammpstrj::parse_lammpstrj_structure(text).map_err(|e| JsError::new(&e))?;
    Ok(ParseResult::from_parsed(parsed))
}

/// Parse a DCD trajectory binary (CHARMM/NAMD/X-PLOR) and return frame data.
#[wasm_bindgen]
pub fn parse_dcd_file(data: &[u8]) -> Result<XtcParseResult, JsError> {
    let dcd_data = dcd::parse_dcd(data).map_err(|e| JsError::new(&e))?;
    Ok(XtcParseResult::from_trajectory(dcd_data))
}

/// Parse an ASE .traj file (ULM binary format) and return structured data.
#[wasm_bindgen]
pub fn parse_traj(data: &[u8]) -> Result<ParseResult, JsError> {
    let parsed = traj::parse_traj(data).map_err(|e| JsError::new(&e))?;
    Ok(ParseResult::from_parsed(parsed))
}

/// Parse an AMBER NetCDF trajectory file (.nc) and return frame data.
#[wasm_bindgen]
pub fn parse_netcdf_file(data: &[u8]) -> Result<XtcParseResult, JsError> {
    let traj_data = netcdf::parse_netcdf(data).map_err(|e| JsError::new(&e))?;
    Ok(XtcParseResult::from_trajectory(traj_data))
}

/// Parse a CHARMM/NAMD PSF topology file and extract bond pairs.
/// Returns flat Uint32Array [a0, b0, a1, b1, ...] with 0-indexed pairs.
#[wasm_bindgen]
pub fn parse_psf_bonds(text: &str, n_atoms: u32) -> Uint32Array {
    let result = psf::parse_psf_bonds(text, n_atoms as usize);
    let mut flat: Vec<u32> = Vec::with_capacity(result.len() * 2);
    for (a, b) in &result {
        flat.push(*a);
        flat.push(*b);
    }
    Uint32Array::from(&flat[..])
}

/// Extract only CONECT bonds from a PDB file text.
/// Returns flat Uint32Array [a0, b0, a1, b1, ...].
#[wasm_bindgen]
pub fn parse_pdb_bonds(text: &str, n_atoms: u32) -> Uint32Array {
    let data = match parser::parse(text) {
        Ok(d) => d,
        Err(_) => return Uint32Array::new_with_length(0),
    };
    // Only return file bonds (CONECT), not inferred ones
    let file_bonds = &data.bonds[..data.n_file_bonds];
    let mut flat: Vec<u32> = Vec::with_capacity(file_bonds.len() * 2);
    for (a, b) in file_bonds {
        flat.push(*a);
        flat.push(*b);
    }
    // Validate atom indices
    let limit = n_atoms;
    let mut valid: Vec<u32> = Vec::new();
    for chunk in flat.chunks(2) {
        if chunk[0] < limit && chunk[1] < limit {
            valid.push(chunk[0]);
            valid.push(chunk[1]);
        }
    }
    Uint32Array::from(&valid[..])
}
