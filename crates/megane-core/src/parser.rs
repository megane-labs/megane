/// PDB text parser.
///
/// Handles ATOM/HETATM, CRYST1, CONECT, and MODEL/ENDMDL records.
use std::collections::{HashMap, HashSet};

// Re-export element utilities that were historically part of this module.
// New code should import from `crate::atomic` directly.
pub use crate::atomic::{capitalize, symbol_to_atomic_num};

/// Parsed atom data from a single ATOM/HETATM line.
pub struct Atom {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub element: u8,
}

/// Per-frame topology for *heterogeneous* trajectories — those whose frames
/// differ in atom count, unit cell, or elements/bonds. `None` on
/// [`ParsedStructure`] means the trajectory is *uniform* (the common case) and
/// the fast fixed-stride path is used everywhere; nothing here is allocated.
///
/// Every channel is independently optional: a constant-atom NPT run with a
/// changing cell fills only `cells_flat`, keeps the fixed-stride positions
/// path, and reuses frame-0 elements/bonds (`elements_flat`/`bonds_flat` empty).
///
/// All indices below address the EXTRA frames (frame 0 lives in
/// [`ParsedStructure::positions`]/`elements`/`bonds`/`box_matrix`), matching the
/// `frame_positions_flat` convention.
pub struct HeteroFrames {
    /// Prefix-sum of atom counts over EXTRA frames, in atoms. Length
    /// `extra_count + 1`; extra frame `i` occupies
    /// `frame_positions_flat[atom_offsets[i]*3 .. atom_offsets[i+1]*3)`.
    /// Always populated (this is what makes jagged positions sliceable).
    pub atom_offsets: Vec<u32>,
    /// Concatenated per-extra-frame atomic numbers, sliced by `atom_offsets`.
    /// Empty when topology is constant (host reuses frame-0 `elements`).
    pub elements_flat: Vec<u8>,
    /// Per-extra-frame row-major 3×3 cell, 9 floats each; length
    /// `extra_count * 9`. Empty when the cell is constant (host reuses
    /// frame-0 `box_matrix`).
    pub cells_flat: Vec<f32>,
    /// Prefix-sum of bond counts over EXTRA frames, in *pairs*. Length
    /// `extra_count + 1` when populated, else empty (topology constant).
    pub bond_offsets: Vec<u32>,
    /// Concatenated per-extra-frame inferred bonds `[a0,b0,a1,b1,…]`, sliced by
    /// `bond_offsets` (×2). Empty when topology is constant.
    pub bonds_flat: Vec<u32>,
    /// Atom count changes between frames.
    pub varies_atoms: bool,
    /// Unit cell changes between frames.
    pub varies_cell: bool,
    /// Elements (and hence inferred bonds) change between frames.
    pub varies_topology: bool,
    /// Maximum atom count across ALL frames (incl. frame 0). Drives one-time
    /// GPU buffer sizing on the host so per-frame updates never reallocate.
    pub max_atoms: u32,
}

/// Common result type for all structure format parsers.
pub struct ParsedStructure {
    pub n_atoms: usize,
    pub positions: Vec<f32>,
    pub elements: Vec<u8>,
    pub bonds: Vec<(u32, u32)>,
    pub n_file_bonds: usize,
    pub bond_orders: Option<Vec<u8>>,
    pub box_matrix: Option<[f32; 9]>,
    /// World-space lower corner (xlo, ylo, zlo) of the simulation box, i.e. the
    /// origin at which `box_matrix`'s edge vectors are anchored. `None` ⇒ the
    /// box sits at world origin `(0,0,0)`. Atom coordinates in `positions` are
    /// always absolute; this only tells the renderer where to draw the cell.
    /// Only formats that store an explicit box origin (LAMMPS data/dump) set it.
    pub box_origin: Option<[f32; 3]>,
    /// EXTRA frames only (frame 0 lives in `positions`), frame-major flat:
    /// `[extra0: x0,y0,z0,…][extra1: …]…`. Length == `extra_frame_count() * n_atoms * 3`.
    /// A single contiguous allocation so the WASM/PyO3 boundary avoids a flatten copy.
    pub frame_positions_flat: Vec<f32>,
    pub atom_labels: Option<Vec<String>>,
    /// Per-atom chain IDs encoded as raw ASCII bytes (e.g. b'A'=65, b'B'=66).
    /// None when the format does not carry chain information.
    pub chain_ids: Option<Vec<u8>>,
    /// Per-atom B-factors (temperature factors) in Å².
    /// None when the format does not carry B-factor information.
    pub bfactors: Option<Vec<f32>>,
    /// Embedded vector channels (e.g. GRO velocities).
    /// Empty for formats that carry no per-atom vector quantities.
    pub vector_channels: Vec<crate::trajectory::VectorChannel>,
    /// Indices of Cα (alpha-carbon) atoms in the positions array.
    /// Empty for non-protein or formats that do not carry atom names.
    pub ca_indices: Vec<u32>,
    /// Per-Cα chain identifier (ASCII byte, e.g. b'A').
    pub ca_chain_ids: Vec<u8>,
    /// Per-Cα residue sequence number.
    pub ca_res_nums: Vec<u32>,
    /// Per-Cα secondary-structure type: 0 = coil, 1 = helix, 2 = sheet.
    pub ca_ss_type: Vec<u8>,
    /// Crystallographic symmetry operations as raw `x,y,z`-style strings,
    /// captured from a CIF `_symmetry_equiv_pos_as_xyz` /
    /// `_space_group_symop_operation_xyz` loop. Empty for formats that carry
    /// no space-group information. The parser does NOT apply these — it always
    /// returns the asymmetric unit; symmetry expansion is a downstream feature.
    pub symmetry_ops: Vec<String>,
    /// Per-frame topology for heterogeneous trajectories. `None` (the common
    /// case) means uniform: fixed atom count/topology/cell across all frames,
    /// and every consumer takes the fast fixed-stride path.
    pub hetero: Option<HeteroFrames>,
    /// Embedded per-atom scalar channels (charges, selective-dynamics flags,
    /// LAMMPS dump computes, ...) the file carries but megane does not render
    /// yet. Parsed rather than silently discarded (CRITICAL RULE #11).
    pub scalar_channels: Vec<crate::trajectory::ScalarChannel>,
    /// Non-fatal parse warnings (e.g. atoms the file declares but the parser
    /// could not represent). Surfaced to the host so nothing is dropped
    /// silently; empty for a clean parse.
    pub warnings: Vec<String>,
}

impl ParsedStructure {
    /// Number of EXTRA frames stored in `frame_positions_flat` (frame 0 is in `positions`).
    pub fn extra_frame_count(&self) -> usize {
        match &self.hetero {
            // Heterogeneous: frame count is the number of atom-offset segments,
            // independent of any single atom count (positions may be jagged).
            Some(h) => h.atom_offsets.len().saturating_sub(1),
            None if self.n_atoms == 0 => 0,
            None => self.frame_positions_flat.len() / (self.n_atoms * 3),
        }
    }

    /// Flat `[x0,y0,z0,…]` slice for EXTRA frame `i` (overall frame `i + 1`).
    /// Panics if `i >= extra_frame_count()`.
    pub fn frame(&self, i: usize) -> &[f32] {
        match &self.hetero {
            Some(h) => {
                let a = h.atom_offsets[i] as usize * 3;
                let b = h.atom_offsets[i + 1] as usize * 3;
                &self.frame_positions_flat[a..b]
            }
            None => {
                let stride = self.n_atoms * 3;
                &self.frame_positions_flat[i * stride..(i + 1) * stride]
            }
        }
    }

    /// Atom count of EXTRA frame `i`. For uniform trajectories this is always
    /// `n_atoms`; for heterogeneous ones it is derived from `atom_offsets`.
    pub fn frame_atom_count(&self, i: usize) -> usize {
        match &self.hetero {
            Some(h) => (h.atom_offsets[i + 1] - h.atom_offsets[i]) as usize,
            None => self.n_atoms,
        }
    }

    /// Atomic numbers for EXTRA frame `i`, or `None` when topology is constant
    /// (the caller should reuse frame-0 `elements`).
    pub fn frame_elements(&self, i: usize) -> Option<&[u8]> {
        let h = self.hetero.as_ref()?;
        if h.elements_flat.is_empty() {
            return None;
        }
        let a = h.atom_offsets[i] as usize;
        let b = h.atom_offsets[i + 1] as usize;
        Some(&h.elements_flat[a..b])
    }

    /// Row-major 3×3 cell for EXTRA frame `i`, or `None` when the cell is
    /// constant (reuse frame-0 `box_matrix`).
    pub fn frame_cell(&self, i: usize) -> Option<&[f32]> {
        let h = self.hetero.as_ref()?;
        if h.cells_flat.is_empty() {
            return None;
        }
        Some(&h.cells_flat[i * 9..i * 9 + 9])
    }

    /// Inferred bonds `[a,b,…]` for EXTRA frame `i`, or `None` when topology is
    /// constant (reuse frame-0 `bonds`).
    pub fn frame_bonds(&self, i: usize) -> Option<&[u32]> {
        let h = self.hetero.as_ref()?;
        if h.bonds_flat.is_empty() || h.bond_offsets.is_empty() {
            return None;
        }
        let a = h.bond_offsets[i] as usize * 2;
        let b = h.bond_offsets[i + 1] as usize * 2;
        Some(&h.bonds_flat[a..b])
    }
}

/// Secondary-structure range from a PDB HELIX or SHEET record.
struct SsRange {
    chain_id: u8,
    start: u32,
    end: u32,
    ss_type: u8, // 1 = helix, 2 = sheet
}

/// Parse a PDB HELIX record and return a secondary-structure range.
fn parse_helix_range(line: &str) -> Option<SsRange> {
    if line.len() < 37 {
        return None;
    }
    let chain_id = line.as_bytes().get(19).copied().unwrap_or(b' ');
    let start: u32 = line[21..25].trim().parse().ok()?;
    let end: u32 = line[33..37].trim().parse().ok()?;
    Some(SsRange {
        chain_id,
        start,
        end,
        ss_type: 1,
    })
}

/// Parse a PDB SHEET record and return a secondary-structure range.
fn parse_sheet_range(line: &str) -> Option<SsRange> {
    if line.len() < 37 {
        return None;
    }
    let chain_id = line.as_bytes().get(21).copied().unwrap_or(b' ');
    let start: u32 = line[22..26].trim().parse().ok()?;
    let end: u32 = line[33..37].trim().parse().ok()?;
    Some(SsRange {
        chain_id,
        start,
        end,
        ss_type: 2,
    })
}

/// If `line` is an ATOM record for a Cα atom, return (chain_id, res_num).
fn parse_ca_info(line: &str) -> Option<(u8, u32)> {
    if line.len() < 27 {
        return None;
    }
    let atom_name = line[12..16].trim();
    if atom_name != "CA" {
        return None;
    }
    let chain_id = line.as_bytes().get(21).copied().unwrap_or(b' ');
    let res_num: u32 = line[22..26].trim().parse().ok()?;
    Some((chain_id, res_num))
}

/// Parse the element from a PDB ATOM/HETATM line.
///
/// First tries columns 76-78 (element symbol field).
/// Falls back to deriving from the atom name (columns 12-16).
fn parse_element(line: &str) -> u8 {
    let bytes = line.as_bytes();

    // Try element symbol field (columns 77-78, 0-indexed: 76-77)
    if bytes.len() >= 78 {
        let elem_str = line[76..78].trim();
        if !elem_str.is_empty() {
            // Capitalize: first char uppercase, rest lowercase
            let capitalized = capitalize(elem_str);
            let z = symbol_to_atomic_num(&capitalized);
            if z > 0 {
                return z;
            }
        }
    }

    // Fallback: derive from atom name (columns 13-16, 0-indexed: 12-15)
    if bytes.len() >= 16 {
        let atom_name = &line[12..16];
        // Strip digits and spaces, take first alpha characters
        let alpha: String = atom_name.chars().filter(|c| c.is_alphabetic()).collect();
        if !alpha.is_empty() {
            // Try two-char element first, then single char
            if alpha.len() >= 2 {
                let two_char = capitalize(&alpha[..2]);
                let z = symbol_to_atomic_num(&two_char);
                if z > 0 {
                    return z;
                }
            }
            let one_char = alpha[..1].to_uppercase().to_string();
            let z = symbol_to_atomic_num(&one_char);
            if z > 0 {
                return z;
            }
        }
    }

    0 // unknown
}

/// Parse an ATOM/HETATM line to extract coordinates and element.
fn parse_atom_line(line: &str) -> Option<(i32, Atom)> {
    if line.len() < 54 {
        return None;
    }

    let serial: i32 = line[6..11].trim().parse().ok()?;
    let x: f32 = line[30..38].trim().parse().ok()?;
    let y: f32 = line[38..46].trim().parse().ok()?;
    let z: f32 = line[46..54].trim().parse().ok()?;
    let element = parse_element(line);

    Some((serial, Atom { x, y, z, element }))
}

/// Parse CRYST1 record and convert cell parameters to a 3x3 matrix.
fn parse_cryst1(line: &str) -> Option<[f32; 9]> {
    if line.len() < 54 {
        return None;
    }

    let a: f32 = line[6..15].trim().parse().ok()?;
    let b: f32 = line[15..24].trim().parse().ok()?;
    let c: f32 = line[24..33].trim().parse().ok()?;
    let alpha: f32 = line[33..40].trim().parse().ok()?;
    let beta: f32 = line[40..47].trim().parse().ok()?;
    let gamma: f32 = line[47..54].trim().parse().ok()?;

    if a <= 0.0 || b <= 0.0 || c <= 0.0 {
        return None;
    }

    Some(cell_params_to_matrix(a, b, c, alpha, beta, gamma))
}

/// Convert crystallographic cell parameters to a 3x3 matrix (row-major).
pub fn cell_params_to_matrix(
    a: f32,
    b: f32,
    c: f32,
    alpha: f32,
    beta: f32,
    gamma: f32,
) -> [f32; 9] {
    let to_rad = std::f32::consts::PI / 180.0;
    let alpha_r = alpha * to_rad;
    let beta_r = beta * to_rad;
    let gamma_r = gamma * to_rad;

    let cos_a = alpha_r.cos();
    let cos_b = beta_r.cos();
    let cos_g = gamma_r.cos();
    let sin_g = gamma_r.sin();

    let cx = c * cos_b;
    let cy = c * (cos_a - cos_b * cos_g) / sin_g;
    let cz = (c * c - cx * cx - cy * cy).max(0.0).sqrt();

    [
        a,
        0.0,
        0.0, // va
        b * cos_g,
        b * sin_g,
        0.0, // vb
        cx,
        cy,
        cz, // vc
    ]
}

/// Parse CONECT record to extract bond pairs.
fn parse_conect_line(line: &str, serial_to_index: &HashMap<i32, usize>) -> Vec<(u32, u32)> {
    let mut bonds = Vec::new();

    let source_str = line.get(6..11).unwrap_or("").trim();
    let source_serial: i32 = match source_str.parse() {
        Ok(s) => s,
        Err(_) => return bonds,
    };
    let source_idx = match serial_to_index.get(&source_serial) {
        Some(&idx) => idx,
        None => return bonds,
    };

    // Up to 4 bonded atoms per CONECT record (columns 11-31, 5 chars each)
    for col_start in (11..31).step_by(5) {
        if col_start + 5 > line.len() {
            break;
        }
        let target_str = line[col_start..col_start + 5].trim();
        if target_str.is_empty() {
            continue;
        }
        let target_serial: i32 = match target_str.parse() {
            Ok(s) => s,
            Err(_) => continue,
        };
        let target_idx = match serial_to_index.get(&target_serial) {
            Some(&idx) => idx,
            None => continue,
        };

        let a = source_idx.min(target_idx) as u32;
        let b = source_idx.max(target_idx) as u32;
        bonds.push((a, b));
    }

    bonds
}

/// Parse a PDB file text into structured data.
pub fn parse(text: &str) -> Result<ParsedStructure, String> {
    parse_impl(text, false)
}

/// Parse ONLY the first model of a (possibly multi-MODEL) PDB into a
/// `ParsedStructure` — topology, elements, bonds, box, Cα/SS, and frame-0
/// coordinates — leaving `frame_positions_flat` empty. Extra models are scanned
/// for records (CONECT/CRYST) but their coordinates are not retained. Backs the
/// lazy PDB decode path (frame 0 renders immediately; extra models stream in).
pub fn parse_frame0(text: &str) -> Result<ParsedStructure, String> {
    parse_impl(text, true)
}

/// Parse model 0 from a (possibly truncated) PDB *prefix* — the first chunk of a
/// large file — for instant first paint. Errors if model 0 is not fully
/// contained (no `ENDMDL` seen AND the prefix is not the whole file), so the
/// caller can grow the prefix or fall back to a full read. Trailing `CONECT`
/// records beyond the prefix are not seen, so bonds are inferred (fine for the
/// large multi-MODEL ensembles this targets).
pub fn parse_frame0_prefix(text: &str, is_whole_file: bool) -> Result<ParsedStructure, String> {
    // A terminated model 0 (first ENDMDL) proves model 0 is fully in the prefix.
    let model0_terminated = text.contains("ENDMDL");
    if !model0_terminated && !is_whole_file {
        return Err("PDB model 0 not fully contained in prefix".into());
    }
    parse_frame0(text)
}

/// Shared body of {@link parse} / {@link parse_frame0}. When `frame0_only`, the
/// coordinates of models after the first are not retained, so
/// `frame_positions_flat` comes back empty (topology is still taken from model 0
/// exactly as the full parse does).
fn parse_impl(text: &str, frame0_only: bool) -> Result<ParsedStructure, String> {
    let mut box_matrix: Option<[f32; 9]> = None;
    let mut serial_to_index: HashMap<i32, usize> = HashMap::new();
    let mut conect_bonds: Vec<(u32, u32)> = Vec::new();

    let mut all_models: Vec<Vec<Atom>> = Vec::new();
    let mut current_model: Vec<Atom> = Vec::new();
    let mut current_labels: Vec<String> = Vec::new();
    let mut current_chain_ids: Vec<u8> = Vec::new();
    let mut current_bfactors: Vec<f32> = Vec::new();
    let mut first_model_labels: Vec<String> = Vec::new();
    let mut first_model_chain_ids: Vec<u8> = Vec::new();
    let mut first_model_bfactors: Vec<f32> = Vec::new();
    let mut has_model_record = false;
    let mut model_count: usize = 0;

    // Secondary-structure ranges from HELIX/SHEET records.
    let mut ss_ranges: Vec<SsRange> = Vec::new();
    // Backbone Cα data collected from the first model only.
    let mut raw_ca: Vec<(usize, u8, u32)> = Vec::new(); // (atom_index, chain_id, res_num)

    for line in text.lines() {
        let record = if line.len() >= 6 {
            line[..6].trim_end()
        } else {
            line.trim_end()
        };

        match record {
            "HELIX" => {
                if let Some(r) = parse_helix_range(line) {
                    ss_ranges.push(r);
                }
            }
            "SHEET" => {
                if let Some(r) = parse_sheet_range(line) {
                    ss_ranges.push(r);
                }
            }
            "MODEL" => {
                has_model_record = true;
                current_model = Vec::new();
                current_labels = Vec::new();
                current_chain_ids = Vec::new();
                current_bfactors = Vec::new();
            }
            "ENDMDL" => {
                if model_count == 0 {
                    first_model_labels = std::mem::take(&mut current_labels);
                    first_model_chain_ids = std::mem::take(&mut current_chain_ids);
                    first_model_bfactors = std::mem::take(&mut current_bfactors);
                }
                all_models.push(std::mem::take(&mut current_model));
                model_count += 1;
            }
            "CRYST1" if box_matrix.is_none() => {
                box_matrix = parse_cryst1(line);
            }
            "ATOM" | "HETATM" => {
                if let Some((serial, atom)) = parse_atom_line(line) {
                    // Build serial→index map from first model only
                    if !has_model_record || model_count == 0 {
                        serial_to_index.insert(serial, current_model.len());
                    }
                    // Collect Cα info from first model
                    if !has_model_record || model_count == 0 {
                        if let Some((chain_id, res_num)) = parse_ca_info(line) {
                            raw_ca.push((current_model.len(), chain_id, res_num));
                        }
                    }
                    // Frame-0-only parse: don't retain extra models' coordinates
                    // or per-atom metadata (they are decoded lazily on demand).
                    if frame0_only && model_count >= 1 {
                        continue;
                    }
                    // Extract residue label: resName (cols 17-20) + resSeq (cols 22-26)
                    let res_name = if line.len() >= 20 {
                        line[17..20].trim()
                    } else {
                        ""
                    };
                    let res_seq = if line.len() >= 26 {
                        line[22..26].trim()
                    } else {
                        ""
                    };
                    current_labels.push(format!("{}{}", res_name, res_seq));
                    // parse_atom_line guarantees line.len() >= 54, so col 21 is always safe
                    current_chain_ids.push(line.as_bytes()[21]);
                    // Extract B-factor (cols 60-66, 0-indexed); absent in truncated lines
                    let bfactor = if line.len() >= 66 {
                        line[60..66].trim().parse::<f32>().unwrap_or(0.0)
                    } else {
                        0.0
                    };
                    current_bfactors.push(bfactor);
                    current_model.push(atom);
                }
            }
            "CONECT" => {
                let bonds = parse_conect_line(line, &serial_to_index);
                conect_bonds.extend(bonds);
            }
            _ => {}
        }
    }

    // If no MODEL/ENDMDL, treat all atoms as a single model
    if !has_model_record && !current_model.is_empty() {
        first_model_labels = current_labels;
        first_model_chain_ids = current_chain_ids;
        first_model_bfactors = current_bfactors;
        all_models.push(current_model);
    }

    if all_models.is_empty() || all_models[0].is_empty() {
        return Err("PDB file contains no ATOM or HETATM records".to_string());
    }

    let first_model = &all_models[0];
    let n_atoms = first_model.len();

    // Build positions and elements from first model
    let mut positions = Vec::with_capacity(n_atoms * 3);
    let mut elements = Vec::with_capacity(n_atoms);
    for atom in first_model {
        positions.push(atom.x);
        positions.push(atom.y);
        positions.push(atom.z);
        elements.push(atom.element);
    }

    // Deduplicate CONECT bonds
    let mut bond_set: HashSet<(u32, u32)> = HashSet::new();
    let mut unique_bonds: Vec<(u32, u32)> = Vec::new();
    for (a, b) in &conect_bonds {
        if bond_set.insert((*a, *b)) {
            unique_bonds.push((*a, *b));
        }
    }
    let n_file_bonds = unique_bonds.len();

    // Infer bonds using cell-list spatial search
    let inferred = crate::bonds::infer_bonds(&positions, &elements, n_atoms, &bond_set);
    unique_bonds.extend(inferred);

    // Build flat frame positions from additional models (frame 0 is `positions`).
    // Models used to be dropped when their atom count differed from model 0; now
    // every model is kept and, when counts diverge, a `HeteroFrames` side table
    // carries per-model positions/elements (e.g. a multi-MODEL ensemble with a
    // changing ligand). Uniform ensembles (constant atom count — the NMR norm)
    // allocate no side table and keep the fixed-stride fast path.
    let extra_models = all_models.len().saturating_sub(1);
    let mut frame_positions_flat: Vec<f32> = Vec::with_capacity(extra_models * n_atoms * 3);
    let mut atom_offsets: Vec<u32> = vec![0];
    let mut per_frame_elements: Vec<Vec<u8>> = Vec::new();
    let mut varies_atoms = false;
    let mut recording_topo = false;
    let mut max_atoms = n_atoms;
    // In `frame0_only` mode the extra models were intentionally not retained
    // (empty vecs), so skip the flat-frame / side-table build entirely.
    if !frame0_only {
        for (ei, model) in all_models.iter().skip(1).enumerate() {
            let m_atoms = model.len();
            for atom in model {
                frame_positions_flat.push(atom.x);
                frame_positions_flat.push(atom.y);
                frame_positions_flat.push(atom.z);
            }
            let last = *atom_offsets.last().unwrap();
            atom_offsets.push(last + m_atoms as u32);
            max_atoms = max_atoms.max(m_atoms);
            if m_atoms != n_atoms {
                varies_atoms = true;
            }
            // Lazily record per-model elements, backfilling earlier (uniform)
            // models with model-0 elements the first time a count diverges.
            if varies_atoms && !recording_topo {
                for _ in 0..ei {
                    per_frame_elements.push(elements.clone());
                }
                recording_topo = true;
            }
            if recording_topo {
                per_frame_elements.push(model.iter().map(|a| a.element).collect());
            }
        }
    }

    // Assemble the side table only when atom counts diverge across models. PDB
    // multi-MODEL shares a single global CRYST1, so the cell never varies per
    // model (varies_cell stays false).
    let hetero = if varies_atoms {
        let empty_bonds: HashSet<(u32, u32)> = HashSet::new();
        let mut elements_flat: Vec<u8> = Vec::new();
        let mut bonds_flat: Vec<u32> = Vec::new();
        let mut bond_offsets: Vec<u32> = Vec::with_capacity(per_frame_elements.len() + 1);
        bond_offsets.push(0);
        for (k, elems) in per_frame_elements.iter().enumerate() {
            let a = atom_offsets[k] as usize * 3;
            let b = atom_offsets[k + 1] as usize * 3;
            let fpos = &frame_positions_flat[a..b];
            let fbonds = crate::bonds::infer_bonds(fpos, elems, elems.len(), &empty_bonds);
            for (u, v) in &fbonds {
                bonds_flat.push(*u);
                bonds_flat.push(*v);
            }
            let last = *bond_offsets.last().unwrap();
            bond_offsets.push(last + fbonds.len() as u32);
            elements_flat.extend_from_slice(elems);
        }
        Some(HeteroFrames {
            atom_offsets,
            elements_flat,
            cells_flat: Vec::new(),
            bond_offsets,
            bonds_flat,
            varies_atoms: true,
            varies_cell: false,
            varies_topology: true,
            max_atoms: max_atoms as u32,
        })
    } else {
        None
    };

    // Check if any labels are non-empty
    let atom_labels = if first_model_labels.iter().any(|l| !l.is_empty()) {
        Some(first_model_labels)
    } else {
        None
    };

    // Build Cα backbone arrays with SS type annotation.
    let mut ca_indices = Vec::with_capacity(raw_ca.len());
    let mut ca_chain_ids = Vec::with_capacity(raw_ca.len());
    let mut ca_res_nums = Vec::with_capacity(raw_ca.len());
    let mut ca_ss_type = Vec::with_capacity(raw_ca.len());
    for (idx, chain_id, res_num) in raw_ca {
        let ss = ss_ranges
            .iter()
            .find(|r| r.chain_id == chain_id && res_num >= r.start && res_num <= r.end)
            .map(|r| r.ss_type)
            .unwrap_or(0);
        ca_indices.push(idx as u32);
        ca_chain_ids.push(chain_id);
        ca_res_nums.push(res_num);
        ca_ss_type.push(ss);
    }

    // Only expose chain IDs when at least one is non-space (multi-chain PDB)
    let chain_ids = if first_model_chain_ids.iter().any(|&c| c != b' ' && c != 0) {
        Some(first_model_chain_ids)
    } else {
        None
    };

    // Only expose B-factors when at least one is non-zero
    let bfactors = if first_model_bfactors.iter().any(|&b| b != 0.0) {
        Some(first_model_bfactors)
    } else {
        None
    };

    Ok(ParsedStructure {
        n_atoms,
        positions,
        elements,
        bonds: unique_bonds,
        n_file_bonds,
        bond_orders: None,
        box_matrix,
        box_origin: None,
        frame_positions_flat,
        atom_labels,
        chain_ids,
        bfactors,
        vector_channels: vec![],
        ca_indices,
        ca_chain_ids,
        ca_res_nums,
        ca_ss_type,
        symmetry_ops: Vec::new(),
        scalar_channels: Vec::new(),
        warnings: Vec::new(),
        hetero,
    })
}

// ---------- Lazy / streaming support (multi-MODEL PDB) ----------

/// Byte offset of each line, so the index scan can record where each model
/// begins in the raw text (for lazy per-model decode from that offset).
fn line_byte_starts(text: &str) -> Vec<usize> {
    let mut starts = Vec::new();
    let mut pos = 0usize;
    for line in text.split('\n') {
        starts.push(pos);
        pos += line.len() + 1;
    }
    starts
}

/// Lightweight index over a multi-MODEL PDB: byte offset of each EXTRA model
/// (models 1..N; model 0 is the eager snapshot), built without retaining
/// coordinates. Models whose atom count differs from model 0 are skipped,
/// exactly as the eager parser drops them.
pub struct PdbIndex {
    pub n_atoms: usize,
    /// Number of extra models (excludes model 0).
    pub n_extra_frames: usize,
    /// Byte offset of each extra model's `MODEL` record line.
    pub offsets: Vec<usize>,
    /// True when some model's atom count differs from model 0. The lazy
    /// positions-only decode path cannot represent a jagged ensemble, so the
    /// host falls back to an eager parse (which builds the `HeteroFrames` side
    /// table). Detected cheaply from ATOM/HETATM counts, no coordinate decode.
    pub heterogeneous: bool,
}

/// Cheap per-model atom-count test used only by {@link build_index}: an
/// ATOM/HETATM line long enough for `parse_atom_line` to accept. This avoids
/// float-parsing every atom just to count them, so indexing a large
/// single-model PDB stays O(lines) instead of paying a full extra parse.
/// Well-formed PDBs (the norm) count identically to the eager parser.
fn is_countable_atom_line(line: &str) -> bool {
    line.len() >= 54
}

/// Scan a multi-MODEL PDB and record each EXTRA model's byte offset without
/// retaining coordinates. Models whose atom count differs from model 0 are
/// dropped, matching the eager parser so extra-model indices line up.
pub fn build_index(text: &str) -> Result<PdbIndex, String> {
    let starts = line_byte_starts(text);
    let mut first_n_atoms: Option<usize> = None;
    let mut offsets: Vec<usize> = Vec::new();
    let mut has_model_record = false;
    let mut current_offset = 0usize; // MODEL line offset of the current model
    let mut current_count = 0usize;
    let mut heterogeneous = false;

    for (i, line) in text.lines().enumerate() {
        let record = if line.len() >= 6 {
            line[..6].trim_end()
        } else {
            line.trim_end()
        };
        match record {
            "MODEL" => {
                has_model_record = true;
                current_offset = starts[i];
                current_count = 0;
            }
            "ENDMDL" => {
                match first_n_atoms {
                    None => first_n_atoms = Some(current_count), // model 0 = eager snapshot
                    Some(n0) => {
                        if current_count != n0 {
                            heterogeneous = true;
                        }
                        offsets.push(current_offset);
                    }
                }
                current_count = 0;
            }
            "ATOM" | "HETATM" if is_countable_atom_line(line) => {
                current_count += 1;
            }
            _ => {}
        }
    }

    // No MODEL/ENDMDL: all atoms are a single implicit model, no extra frames.
    if !has_model_record {
        if current_count == 0 {
            return Err("PDB file contains no ATOM or HETATM records".into());
        }
        return Ok(PdbIndex {
            n_atoms: current_count,
            n_extra_frames: 0,
            offsets: Vec::new(),
            heterogeneous: false,
        });
    }

    let n_atoms = first_n_atoms.ok_or("PDB file contains no models")?;
    if n_atoms == 0 {
        return Err("PDB file contains no ATOM or HETATM records".into());
    }
    Ok(PdbIndex {
        n_atoms,
        n_extra_frames: offsets.len(),
        offsets,
        heterogeneous,
    })
}

/// Decode a single PDB model's positions (Å) given its `MODEL`-record byte
/// offset. Reads ATOM/HETATM lines (matching the eager parser's acceptance)
/// until `ENDMDL` or `expected_n_atoms` atoms have been collected.
pub fn decode_model_at(
    text: &str,
    byte_offset: usize,
    expected_n_atoms: usize,
) -> Result<Vec<f32>, String> {
    if byte_offset > text.len() {
        return Err("model offset past end of data".into());
    }
    let slice = &text[byte_offset..];
    let mut positions = Vec::with_capacity(expected_n_atoms * 3);
    for line in slice.lines() {
        let record = if line.len() >= 6 {
            line[..6].trim_end()
        } else {
            line.trim_end()
        };
        match record {
            "ENDMDL" => break,
            "ATOM" | "HETATM" => {
                if let Some((_serial, atom)) = parse_atom_line(line) {
                    positions.push(atom.x);
                    positions.push(atom.y);
                    positions.push(atom.z);
                    if positions.len() == expected_n_atoms * 3 {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    if positions.len() != expected_n_atoms * 3 {
        return Err(format!(
            "decoded {} atoms, expected {}",
            positions.len() / 3,
            expected_n_atoms
        ));
    }
    Ok(positions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_minimal_pdb() {
        let pdb = "CRYST1   40.960   18.650   22.520  90.00  90.77  90.00 P 21          4\nATOM      1  N   THR A   1      17.047  14.099   3.625  1.00 13.79           N  \nATOM      2  CA  THR A   1      16.967  12.784   4.338  1.00 10.80           C  \nATOM      3  C   THR A   1      15.685  12.755   5.133  1.00  9.19           C  \nEND\n";
        let result = parse(pdb).expect("parse failed");
        assert_eq!(result.n_atoms, 3);
        assert_eq!(result.elements[0], 7); // N
        assert_eq!(result.elements[1], 6); // C
        assert_eq!(result.elements[2], 6); // C
        assert!((result.positions[0] - 17.047).abs() < 0.01);
        assert!((result.positions[1] - 14.099).abs() < 0.01);
        assert!(result.box_matrix.is_some());
        let bm = result.box_matrix.unwrap();
        assert!((bm[0] - 40.96).abs() < 0.1);
    }

    #[test]
    fn test_parse_pdb_with_conect() {
        let pdb = "ATOM      1  O   HOH     1       0.000   0.000   0.000  1.00  0.00           O  \nATOM      2  H1  HOH     1       0.757   0.587   0.000  1.00  0.00           H  \nATOM      3  H2  HOH     1      -0.757   0.587   0.000  1.00  0.00           H  \nCONECT    1    2    3\nEND\n";
        let result = parse(pdb).expect("parse failed");
        assert_eq!(result.n_atoms, 3);
        assert!(result.n_file_bonds >= 2);
    }

    #[test]
    fn coarse_grained_ubiquitin_fixture_is_a_bead_chain() {
        // Written by tests/fixtures/generate_1ubq_cg.py and overlaid on the
        // all-atom 1ubq.pdb by the "Coarse-Grained Overlay" template.
        let result = parse(include_str!("../../../tests/fixtures/1ubq_cg.pdb")).unwrap();
        assert_eq!(result.n_atoms, 76, "one bead per ubiquitin residue");
        // 75 CONECT records join consecutive beads; nothing is distance-inferred
        // on top of them (parser-purity rule: file bonds win outright).
        assert_eq!(result.n_file_bonds, 75);
        assert_eq!(result.bonds.len(), 75);
        for (a, b) in result.bonds.iter() {
            assert_eq!(*b, *a + 1, "beads bond only to the next residue");
        }
        // Beads are pseudo-atoms written as carbon.
        assert!(result.elements.iter().all(|&z| z == 6));
    }

    #[test]
    fn test_parse_pdb_multi_model() {
        let pdb = "MODEL        1\nATOM      1  CA  ALA A   1       1.000   2.000   3.000  1.00  0.00           C  \nENDMDL\nMODEL        2\nATOM      1  CA  ALA A   1       4.000   5.000   6.000  1.00  0.00           C  \nENDMDL\n";
        let result = parse(pdb).expect("parse failed");
        assert_eq!(result.n_atoms, 1);
        // Frame 0 stays in `positions`; the second MODEL is the one extra frame.
        assert!((result.positions[0] - 1.0).abs() < 0.01);
        assert_eq!(result.extra_frame_count(), 1);
        let extra = result.frame(0);
        assert!((extra[0] - 4.0).abs() < 0.01);
        assert!((extra[1] - 5.0).abs() < 0.01);
        assert!((extra[2] - 6.0).abs() < 0.01);
    }

    #[test]
    fn test_parse_empty_pdb_errors() {
        let result = parse("REMARK test\nEND\n");
        assert!(result.is_err());
    }

    // A 3-model PDB whose middle model has a mismatched atom count. It used to be
    // dropped by both paths; now the eager parser captures it as a heterogeneous
    // extra frame and the lazy index flags the file so the host falls back to eager.
    const MULTI_MODEL_PDB: &str = "\
CRYST1   10.000   10.000   10.000  90.00  90.00  90.00 P 1           1
MODEL        1
ATOM      1  O   HOH A   1       0.000   0.000   0.000  1.00  0.00           O
ATOM      2  H1  HOH A   1       1.000   0.000   0.000  1.00  0.00           H
ENDMDL
MODEL        2
ATOM      1  O   HOH A   1       2.000   0.000   0.000  1.00  0.00           O
ENDMDL
MODEL        3
ATOM      1  O   HOH A   1       3.000   0.000   0.000  1.00  0.00           O
ATOM      2  H1  HOH A   1       4.000   0.000   0.000  1.00  0.00           H
ENDMDL
";

    // A 3-model, 2-atom PDB with constant topology across all models — the NMR
    // ensemble norm, which must keep the uniform fast path (hetero == None).
    const UNIFORM_MODEL_PDB: &str = "\
CRYST1   10.000   10.000   10.000  90.00  90.00  90.00 P 1           1
MODEL        1
ATOM      1  O   HOH A   1       0.000   0.000   0.000  1.00  0.00           O
ATOM      2  H1  HOH A   1       1.000   0.000   0.000  1.00  0.00           H
ENDMDL
MODEL        2
ATOM      1  O   HOH A   1       2.000   0.000   0.000  1.00  0.00           O
ATOM      2  H1  HOH A   1       2.500   0.000   0.000  1.00  0.00           H
ENDMDL
MODEL        3
ATOM      1  O   HOH A   1       3.000   0.000   0.000  1.00  0.00           O
ATOM      2  H1  HOH A   1       3.500   0.000   0.000  1.00  0.00           H
ENDMDL
";

    #[test]
    fn uniform_multi_model_keeps_fast_path() {
        let eager = parse(UNIFORM_MODEL_PDB).unwrap();
        assert!(
            eager.hetero.is_none(),
            "uniform ensemble must not allocate a side table"
        );
        assert_eq!(eager.extra_frame_count(), 2);
        let idx = build_index(UNIFORM_MODEL_PDB).unwrap();
        assert!(!idx.heterogeneous);
        assert_eq!(idx.n_extra_frames, 2);
        // Lazy positions-only decode matches the eager frames for the uniform case.
        for k in 0..idx.n_extra_frames {
            let p = decode_model_at(UNIFORM_MODEL_PDB, idx.offsets[k], idx.n_atoms).unwrap();
            assert_eq!(p, eager.frame(k).to_vec(), "extra model {k}");
        }
    }

    #[test]
    fn heterogeneous_multi_model_builds_side_table() {
        let eager = parse(MULTI_MODEL_PDB).unwrap();
        // Both mismatched and matched extra models are now retained.
        assert_eq!(eager.extra_frame_count(), 2);
        let h = eager.hetero.as_ref().expect("heterogeneous side table");
        assert!(h.varies_atoms);
        assert!(h.varies_topology);
        assert_eq!(h.max_atoms, 2);
        // Extra frame 0 (model 2) has 1 atom; extra frame 1 (model 3) has 2.
        assert_eq!(eager.frame_atom_count(0), 1);
        assert_eq!(eager.frame_atom_count(1), 2);
        assert!((eager.frame(0)[0] - 2.0).abs() < 1e-5);
        // The lazy index flags heterogeneity so the host reparses eagerly.
        let idx = build_index(MULTI_MODEL_PDB).unwrap();
        assert!(idx.heterogeneous);
        assert_eq!(idx.n_extra_frames, 2);
    }

    #[test]
    fn lazy_frame0_matches_eager() {
        let eager = parse(UNIFORM_MODEL_PDB).unwrap();
        let f0 = parse_frame0(UNIFORM_MODEL_PDB).unwrap();
        // Frame-0 snapshot is byte-identical to the eager model 0 (topology + coords).
        assert_eq!(f0.positions, eager.positions);
        assert_eq!(f0.elements, eager.elements);
        assert_eq!(f0.n_atoms, eager.n_atoms);
        assert_eq!(f0.box_matrix, eager.box_matrix);
        assert!(f0.frame_positions_flat.is_empty());
        assert!(f0.hetero.is_none());
    }

    #[test]
    fn decode_model_at_errors_on_insufficient_atoms() {
        let idx = build_index(MULTI_MODEL_PDB).unwrap();
        // A model that stops at ENDMDL before the expected atom count is reached
        // (here: asking for more atoms than the model holds) is rejected.
        assert!(decode_model_at(MULTI_MODEL_PDB, idx.offsets[0], idx.n_atoms + 1).is_err());
        // An offset past the end of the data is rejected outright.
        assert!(decode_model_at(MULTI_MODEL_PDB, MULTI_MODEL_PDB.len() + 1, idx.n_atoms).is_err());
    }

    #[test]
    fn parse_frame0_prefix_requires_model0_terminated() {
        // A prefix cut off before model 0's ENDMDL (and not the whole file) is
        // rejected so the caller grows the prefix / falls back.
        let cut = MULTI_MODEL_PDB.find("ENDMDL").unwrap();
        let truncated = &MULTI_MODEL_PDB[..cut];
        assert!(parse_frame0_prefix(truncated, false).is_err());
        // A prefix that includes model 0's ENDMDL parses model 0 identically to
        // the eager frame-0 snapshot.
        let end = MULTI_MODEL_PDB.find("ENDMDL").unwrap() + "ENDMDL\n".len();
        let prefix = &MULTI_MODEL_PDB[..end];
        let got = parse_frame0_prefix(prefix, false).unwrap();
        let eager = parse(MULTI_MODEL_PDB).unwrap();
        assert_eq!(got.positions, eager.positions);
        assert_eq!(got.n_atoms, eager.n_atoms);
        // A single-model file (no MODEL records) parses as the whole structure
        // when the prefix is the whole file.
        let single = "\
ATOM      1  O   HOH A   1       0.000   0.000   0.000  1.00  0.00           O
ATOM      2  H1  HOH A   1       1.000   0.000   0.000  1.00  0.00           H
END
";
        assert!(parse_frame0_prefix(single, true).is_ok());
    }

    #[test]
    fn parse_frame0_prefix_picks_up_trailing_conect() {
        // The JS prefix reader concatenates head(model 0) + tail(CONECT section);
        // CONECT is written once after the last model and applies to model 0's
        // serials, so frame 0 must gain those explicit bonds.
        let text = "\
CRYST1   10.000   10.000   10.000  90.00  90.00  90.00 P 1           1
MODEL        1
ATOM      1  O   HOH A   1       0.000   0.000   0.000  1.00  0.00           O
ATOM      2  H1  HOH A   1       3.500   0.000   0.000  1.00  0.00           H
ENDMDL
CONECT    1    2
END
";
        let got = parse_frame0_prefix(text, false).unwrap();
        assert_eq!(got.n_atoms, 2);
        // The two atoms are 3.5 Å apart (beyond the inferred-bond cutoff), so the
        // only bond present is the explicit CONECT one.
        assert_eq!(got.n_file_bonds, 1);
    }

    #[test]
    fn build_index_single_model_has_no_extra_frames() {
        let single = "\
ATOM      1  O   HOH A   1       0.000   0.000   0.000  1.00  0.00           O
ATOM      2  H1  HOH A   1       1.000   0.000   0.000  1.00  0.00           H
END
";
        let idx = build_index(single).unwrap();
        assert_eq!(idx.n_atoms, 2);
        assert_eq!(idx.n_extra_frames, 0);
    }

    #[test]
    fn test_parse_1crn_fixture() {
        let text = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/1crn.pdb"
        ))
        .expect("read fixture");
        let result = parse(&text).expect("parse failed");
        assert_eq!(result.n_atoms, 327);
        assert!(!result.bonds.is_empty());
        assert!(result.elements.contains(&6)); // C
        assert!(result.elements.contains(&7)); // N
        assert!(result.elements.contains(&8)); // O
        assert!(result.elements.contains(&16)); // S
    }

    #[test]
    fn test_parse_helix_range() {
        // HELIX record: initChainID at col 19, initSeqNum at cols 21-25, endChainID at 31, endSeqNum at 33-37
        let line = "HELIX    1   1 SER A    7  GLY A   18  1                                  12";
        let r = parse_helix_range(line).expect("should parse");
        assert_eq!(r.chain_id, b'A');
        assert_eq!(r.start, 7);
        assert_eq!(r.end, 18);
        assert_eq!(r.ss_type, 1); // helix
    }

    #[test]
    fn test_parse_sheet_range() {
        // SHEET record: initChainID at col 21, initSeqNum at cols 22-26, endChainID at 32, endSeqNum at 33-37
        let line = "SHEET    1   A 2 GLY A  20  TYR A  24  0";
        let r = parse_sheet_range(line).expect("should parse");
        assert_eq!(r.chain_id, b'A');
        assert_eq!(r.start, 20);
        assert_eq!(r.end, 24);
        assert_eq!(r.ss_type, 2); // sheet
    }

    #[test]
    fn test_parse_ca_info_detects_alpha_carbon() {
        let line =
            "ATOM      2  CA  THR A   1      16.967  12.784   4.338  1.00 10.80           C  ";
        let info = parse_ca_info(line).expect("should detect Cα");
        assert_eq!(info.0, b'A'); // chain ID
        assert_eq!(info.1, 1); // residue number
    }

    #[test]
    fn test_parse_ca_info_rejects_non_ca() {
        let line =
            "ATOM      1  N   THR A   1      17.047  14.099   3.625  1.00 13.79           N  ";
        assert!(parse_ca_info(line).is_none());
    }

    #[test]
    fn test_pdb_with_helix_and_sheet() {
        // Minimal PDB with HELIX/SHEET records and a few backbone atoms.
        let pdb = "\
HELIX    1   1 THR A    1  ALA A    2  1                                   2
SHEET    1   A 1 GLY A   3  GLY A   4  0
ATOM      1  N   THR A   1       1.000   0.000   0.000  1.00  0.00           N
ATOM      2  CA  THR A   1       2.000   0.000   0.000  1.00  0.00           C
ATOM      3  N   ALA A   2       3.000   0.000   0.000  1.00  0.00           N
ATOM      4  CA  ALA A   2       4.000   0.000   0.000  1.00  0.00           C
ATOM      5  N   GLY A   3       5.000   0.000   0.000  1.00  0.00           N
ATOM      6  CA  GLY A   3       6.000   0.000   0.000  1.00  0.00           C
ATOM      7  N   GLY A   4       7.000   0.000   0.000  1.00  0.00           N
ATOM      8  CA  GLY A   4       8.000   0.000   0.000  1.00  0.00           C
END
";
        let result = parse(pdb).expect("parse failed");
        assert_eq!(result.n_atoms, 8);
        // Cα atoms: indices 1 (THR 1), 3 (ALA 2), 5 (GLY 3), 7 (GLY 4)
        assert_eq!(result.ca_indices.len(), 4);
        assert_eq!(result.ca_indices[0], 1); // THR A 1 → index 1
        assert_eq!(result.ca_indices[1], 3); // ALA A 2 → index 3
        assert_eq!(result.ca_indices[2], 5); // GLY A 3 → index 5
        assert_eq!(result.ca_indices[3], 7); // GLY A 4 → index 7
                                             // SS types: THR 1 → helix(1), ALA 2 → helix(1), GLY 3 → sheet(2), GLY 4 → sheet(2)
        assert_eq!(result.ca_ss_type[0], 1); // helix
        assert_eq!(result.ca_ss_type[1], 1); // helix
        assert_eq!(result.ca_ss_type[2], 2); // sheet
        assert_eq!(result.ca_ss_type[3], 2); // sheet
                                             // All chain IDs should be b'A'
        assert!(result.ca_chain_ids.iter().all(|&c| c == b'A'));
    }

    #[test]
    fn test_pdb_no_helix_sheet_all_coil() {
        // PDB with Cα but no HELIX/SHEET → all coil (0)
        let pdb = "\
ATOM      1  CA  ALA A   1       1.000   0.000   0.000  1.00  0.00           C
ATOM      2  CA  GLY A   2       2.000   0.000   0.000  1.00  0.00           C
END
";
        let result = parse(pdb).expect("parse failed");
        assert_eq!(result.ca_indices.len(), 2);
        assert!(result.ca_ss_type.iter().all(|&t| t == 0)); // all coil
    }

    #[test]
    fn test_parse_ca_info_cb_is_not_ca() {
        // CB (beta carbon) should not be detected as Cα
        let line =
            "ATOM      5  CB  THR A   1      16.000  12.000   4.000  1.00  0.00           C  ";
        assert!(parse_ca_info(line).is_none());
    }

    #[test]
    fn test_parse_pdb_chain_id_and_bfactor() {
        // Standard 80-col line: chain B, B-factor 42.50
        let pdb = "ATOM      1  CA  ALA B   1      17.047  14.099   3.625  1.00 42.50           C  \nEND\n";
        let result = parse(pdb).expect("parse failed");
        let chain_ids = result.chain_ids.expect("chain_ids should be Some");
        assert_eq!(chain_ids[0], b'B');
        let bfactors = result.bfactors.expect("bfactors should be Some");
        assert!((bfactors[0] - 42.5).abs() < 0.01);
    }

    #[test]
    fn test_parse_pdb_truncated_no_bfactor() {
        // 54-char line: valid coordinates but no occupancy/B-factor columns
        // (exactly at the minimum length accepted by parse_atom_line)
        let pdb = "ATOM      1  CA  ALA A   1      17.047  14.099   3.625\nEND\n";
        let result = parse(pdb).expect("parse failed");
        assert_eq!(result.n_atoms, 1);
        // No non-zero B-factor => bfactors should be None
        assert!(result.bfactors.is_none());
    }
}
