/// PDB text parser.
///
/// Handles ATOM/HETATM, CRYST1, CONECT, HELIX/SHEET, and MODEL/ENDMDL records.
/// The format-neutral result types it fills live in [`crate::structure`].
use std::collections::{HashMap, HashSet};

use crate::atomic::{capitalize, element_from_atom_name_in_residue, symbol_to_atomic_num};
use crate::cell::cell_params_to_matrix;
use crate::structure::{ss_type_at, FrameChange, HeteroFramesBuilder, ParsedStructure, SsRange};

/// Parsed atom data from a single ATOM/HETATM line.
pub struct Atom {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub element: u8,
    /// Alternate-location indicator (column 17), `0` when blank.
    pub altloc: u8,
}

/// Decode a fixed-width PDB number field: plain decimal, or hybrid-36 (the
/// encoding wwPDB tools use once serials pass 99,999 or residue numbers pass
/// 9,999: `A0000` follows `99999`, and `a0000` follows `ZZZZZ`). Overflow
/// markers such as `*****` decode to `None`.
pub(crate) fn hy36_decode(field: &str) -> Option<i32> {
    let s = field.trim();
    if s.is_empty() {
        return None;
    }
    let first = s.as_bytes()[0];
    if first.is_ascii_digit() || first == b'-' || first == b'+' {
        return s.parse().ok();
    }
    let width = field.len() as u32;
    if s.len() as u32 != width || width == 0 {
        return None;
    }
    let (upper, offset) = if first.is_ascii_uppercase() {
        (true, 0i64)
    } else if first.is_ascii_lowercase() {
        (false, 26 * 36i64.pow(width - 1))
    } else {
        return None;
    };
    let mut value: i64 = 0;
    for &c in s.as_bytes() {
        let d = match c {
            b'0'..=b'9' => c - b'0',
            b'A'..=b'Z' if upper => c - b'A' + 10,
            b'a'..=b'z' if !upper => c - b'a' + 10,
            _ => return None,
        };
        value = value * 36 + d as i64;
    }
    // The first letter digit (10) starts the range right after the decimal one.
    let decoded = value - 10 * 36i64.pow(width - 1) + 10i64.pow(width) + offset;
    i32::try_from(decoded).ok()
}

/// Parse a PDB HELIX record and return a secondary-structure range.
fn parse_helix_range(line: &str) -> Option<SsRange> {
    if line.len() < 37 {
        return None;
    }
    let chain_id = line.as_bytes().get(19).copied().unwrap_or(b' ');
    let start = hy36_decode(&line[21..25])?;
    let end = hy36_decode(&line[33..37])?;
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
    let start = hy36_decode(&line[22..26])?;
    let end = hy36_decode(&line[33..37])?;
    Some(SsRange {
        chain_id,
        start,
        end,
        ss_type: 2,
    })
}

/// If `line` is an ATOM record for a Cα atom, return (chain_id, res_num).
/// Residue numbers are signed: expression tags are commonly numbered below 1.
fn parse_ca_info(line: &str) -> Option<(u8, i32)> {
    if line.len() < 27 {
        return None;
    }
    let atom_name = line[12..16].trim();
    if atom_name != "CA" {
        return None;
    }
    let chain_id = line.as_bytes().get(21).copied().unwrap_or(b' ');
    let res_num = hy36_decode(&line[22..26])?;
    Some((chain_id, res_num))
}

/// Parse the element from a PDB ATOM/HETATM line.
///
/// First tries columns 77-78 (element symbol field).
/// Falls back to deriving from the atom name (columns 13-16) read in the
/// context of the residue name (columns 18-21), so a protein Cα "CA" is
/// carbon while a calcium ion residue "CA" is calcium.
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

    // Fallback: derive from atom name (columns 13-16, 0-indexed: 12-15).
    // The residue name spans columns 18-20, with CHARMM-style 4-letter names
    // ("TIP3") spilling into column 21.
    match line.get(12..16) {
        Some(atom_name) => {
            let res_name = line.get(17..21).unwrap_or("");
            element_from_atom_name_in_residue(atom_name, res_name)
        }
        None => 0, // unknown
    }
}

/// Parse an ATOM/HETATM line to extract coordinates and element. The serial is
/// `None` when the field holds no number (e.g. `*****` past 99,999 atoms): the
/// atom is still read, only CONECT records cannot point at it.
fn parse_atom_line(line: &str) -> Option<(Option<i32>, Atom)> {
    if line.len() < 54 {
        return None;
    }

    let serial = hy36_decode(&line[6..11]);
    let x: f32 = line[30..38].trim().parse().ok()?;
    let y: f32 = line[38..46].trim().parse().ok()?;
    let z: f32 = line[46..54].trim().parse().ok()?;
    let element = parse_element(line);
    // `line.len() >= 54`, so column 17 is always present.
    let altloc = match line.as_bytes()[16] {
        b' ' => 0,
        c => c,
    };

    Some((
        serial,
        Atom {
            x,
            y,
            z,
            element,
            altloc,
        },
    ))
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

/// Parse CONECT record to extract bond pairs.
fn parse_conect_line(line: &str, serial_to_index: &HashMap<i32, usize>) -> Vec<(u32, u32)> {
    let mut bonds = Vec::new();

    let source_serial = match line.get(6..11).and_then(hy36_decode) {
        Some(s) => s,
        None => return bonds,
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
        let target_serial = match hy36_decode(&line[col_start..col_start + 5]) {
            Some(s) => s,
            None => continue,
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
    let mut raw_ca: Vec<(usize, u8, i32)> = Vec::new(); // (atom_index, chain_id, res_num)

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
                    if let Some(serial) = serial {
                        if !has_model_record || model_count == 0 {
                            serial_to_index.insert(serial, current_model.len());
                        }
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
        // A CRYST1 with no atoms is an empty cell — the Build panel's "Empty
        // Box" starting point — not a broken file. Anything without atoms or
        // a cell carries nothing to show and stays an error.
        if box_matrix.is_none() {
            return Err("PDB file contains no ATOM or HETATM records".to_string());
        }
        all_models = vec![Vec::new()];
        first_model_labels = Vec::new();
        first_model_chain_ids = Vec::new();
        first_model_bfactors = Vec::new();
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

    // Infer bonds using cell-list spatial search, except where the file's
    // own records rule a pair out: atoms whose connectivity CONECT already
    // declares, and atoms of different alternate conformers.
    let inferred = crate::bonds::infer_bonds(&positions, &elements, n_atoms, &bond_set);
    let altlocs: Vec<u8> = first_model.iter().map(|a| a.altloc).collect();
    let inferred =
        crate::bonds::drop_inferred_ruled_out_by_file(inferred, &unique_bonds, &altlocs, n_atoms);
    unique_bonds.extend(inferred);

    // Build flat frame positions from additional models (frame 0 is `positions`).
    // Models used to be dropped when their atom count differed from model 0; now
    // every model is kept and, when counts diverge, a `HeteroFrames` side table
    // carries per-model positions/elements (e.g. a multi-MODEL ensemble with a
    // changing ligand). Uniform ensembles (constant atom count — the NMR norm)
    // allocate no side table and keep the fixed-stride fast path.
    let extra_models = all_models.len().saturating_sub(1);
    let mut frames = HeteroFramesBuilder::with_capacity(n_atoms, extra_models);
    // In `frame0_only` mode the extra models were intentionally not retained
    // (empty vecs), so skip the flat-frame / side-table build entirely.
    if !frame0_only {
        for model in all_models.iter().skip(1) {
            // PDB never reports a topology change on its own: only an atom-count
            // change makes the ensemble heterogeneous (elements are then
            // recorded per model, earlier models backfilled with model 0's).
            // PDB multi-MODEL shares a single global CRYST1, so the cell never
            // varies per model either.
            frames.push_frame_iter(
                model.iter().flat_map(|a| [a.x, a.y, a.z]),
                || model.iter().map(|a| a.element).collect(),
                None,
                FrameChange::default(),
            );
        }
    }
    let (frame_positions_flat, hetero) = frames.finish(&elements, None);

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
        let ss = ss_type_at(&ss_ranges, chain_id, res_num);
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
        box_matrix,
        frame_positions_flat,
        atom_labels,
        chain_ids,
        bfactors,
        ca_indices,
        ca_chain_ids,
        ca_res_nums,
        ca_ss_type,
        hetero,
        ..Default::default()
    })
}

// ---------- Lazy / streaming support (multi-MODEL PDB) ----------

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
    /// Byte offset just past model 0's `ENDMDL` line (the whole text when the
    /// file has no MODEL records).
    pub frame0_end: u64,
    /// Byte offset just past the last `ENDMDL` line: the records after it
    /// (CONECT, MASTER, END) belong to every model. [`parse_frame0`] of
    /// `text[..frame0_end] + text[tail_start..]` equals `parse_frame0(text)`
    /// unless `frame0_needs_whole_file`.
    pub tail_start: u64,
    /// A record model 0's parse reads (CONECT, CRYST1, HELIX, SHEET) sits
    /// between two later models, so model 0 must be parsed from the whole text.
    pub frame0_needs_whole_file: bool,
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
    let mut builder = PdbIndexBuilder::default();
    crate::lines::for_each_line(text, |line, start, end| {
        builder.push_line(line, start, end);
        Ok(())
    })?;
    builder.finish(text.len() as u64)
}

/// The [`build_index`] scan, fed one line at a time (see `crate::lines`), so a
/// file can be indexed window by window without being held whole.
#[derive(Default)]
pub struct PdbIndexBuilder {
    first_n_atoms: Option<usize>,
    offsets: Vec<u64>,
    has_model_record: bool,
    /// `MODEL` line offset of the current model.
    current_offset: u64,
    current_count: usize,
    heterogeneous: bool,
    frame0_end: u64,
    last_endmdl_end: u64,
    /// A model-0-relevant record was seen since the last `ENDMDL` after model 0.
    record_since_endmdl: bool,
    frame0_needs_whole_file: bool,
}

impl PdbIndexBuilder {
    /// Take the next line (without its line break), spanning bytes `start..end`.
    pub fn push_line(&mut self, line: &str, start: u64, end: u64) {
        let record = if line.len() >= 6 {
            line.get(..6).unwrap_or(line).trim_end()
        } else {
            line.trim_end()
        };
        match record {
            "MODEL" => {
                self.has_model_record = true;
                self.current_offset = start;
                self.current_count = 0;
                if self.record_since_endmdl {
                    self.frame0_needs_whole_file = true;
                }
            }
            "ENDMDL" => {
                match self.first_n_atoms {
                    None => {
                        // model 0 = eager snapshot
                        self.first_n_atoms = Some(self.current_count);
                        self.frame0_end = end;
                    }
                    Some(n0) => {
                        if self.current_count != n0 {
                            self.heterogeneous = true;
                        }
                        self.offsets.push(self.current_offset);
                    }
                }
                self.current_count = 0;
                self.last_endmdl_end = end;
                self.record_since_endmdl = false;
            }
            "ATOM" | "HETATM" if is_countable_atom_line(line) => {
                self.current_count += 1;
            }
            "CONECT" | "CRYST1" | "HELIX" | "SHEET" if self.first_n_atoms.is_some() => {
                self.record_since_endmdl = true;
            }
            _ => {}
        }
    }

    /// The index of everything pushed so far, for a `file_len`-byte file.
    pub fn finish(self, file_len: u64) -> Result<PdbIndex, String> {
        // No MODEL/ENDMDL: all atoms are a single implicit model, no extra frames.
        if !self.has_model_record {
            if self.current_count == 0 {
                return Err("PDB file contains no ATOM or HETATM records".into());
            }
            return Ok(PdbIndex {
                n_atoms: self.current_count,
                n_extra_frames: 0,
                offsets: Vec::new(),
                heterogeneous: false,
                frame0_end: file_len,
                tail_start: file_len,
                frame0_needs_whole_file: false,
            });
        }
        let n_atoms = self.first_n_atoms.ok_or("PDB file contains no models")?;
        if n_atoms == 0 {
            return Err("PDB file contains no ATOM or HETATM records".into());
        }
        Ok(PdbIndex {
            n_atoms,
            n_extra_frames: self.offsets.len(),
            offsets: self.offsets.iter().map(|&o| o as usize).collect(),
            heterogeneous: self.heterogeneous,
            frame0_end: self.frame0_end,
            tail_start: self.last_endmdl_end,
            frame0_needs_whole_file: self.frame0_needs_whole_file,
        })
    }

    /// Byte offset of each extra model's `MODEL` line, as file offsets.
    pub fn file_offsets(&self) -> &[u64] {
        &self.offsets
    }
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

    /// The Build panel's "Empty Box" template starts from a PDB that is only a
    /// `CRYST1` record: no atoms, just the cell to build into.
    fn models(n_models: usize, between: &str) -> String {
        let mut text = String::from(
            "HEADER    TEST\nCRYST1   10.000   10.000   10.000  90.00  90.00  90.00 P 1\n",
        );
        for m in 0..n_models {
            text += &format!("MODEL     {:>4}\n", m + 1);
            for a in 0..3 {
                text += &format!(
                    "ATOM  {:>5}  O   HOH A{:>4}    {:8.3}{:8.3}{:8.3}  1.00  0.00           O  \n",
                    a + 1,
                    1,
                    a as f32 * 3.0 + m as f32,
                    0.0,
                    0.0
                );
            }
            text += "ENDMDL\n";
            if m == 0 {
                text += between;
            }
        }
        text += "CONECT    1    2\nEND\n";
        text
    }

    #[test]
    fn windowed_model_index_matches_the_whole_text_index() {
        let text = models(5, "");
        let whole = build_index(&text).unwrap();
        assert_eq!(whole.n_extra_frames, 4);
        for window in [1, 13, 100, text.len()] {
            let mut b = PdbIndexBuilder::default();
            crate::lines::feed_in_windows(&text, window, |l, s, e| {
                b.push_line(l, s, e);
                Ok(())
            })
            .unwrap();
            let got = b.finish(text.len() as u64).unwrap();
            assert_eq!(got.offsets, whole.offsets);
            assert_eq!(got.frame0_end, whole.frame0_end);
            assert_eq!(got.tail_start, whole.tail_start);
            assert!(!got.frame0_needs_whole_file);
        }
    }

    #[test]
    fn model0_parses_from_its_head_and_the_trailing_records() {
        let text = models(4, "");
        let idx = build_index(&text).unwrap();
        let mut head_tail = text[..idx.frame0_end as usize].to_string();
        head_tail += &text[idx.tail_start as usize..];
        assert!(head_tail.contains("CONECT"));
        let a = parse_frame0(&head_tail).unwrap();
        let b = parse_frame0(&text).unwrap();
        assert_eq!(a.positions, b.positions);
        assert_eq!(a.bonds, b.bonds);
        assert_eq!(a.n_file_bonds, b.n_file_bonds);
        assert_eq!(a.box_matrix, b.box_matrix);
    }

    #[test]
    fn a_record_between_later_models_needs_the_whole_file_for_model0() {
        let idx = build_index(&models(3, "CONECT    1    3\n")).unwrap();
        assert!(idx.frame0_needs_whole_file);
        // Without MODEL records the whole text is model 0.
        let single =
            "ATOM      1  O   HOH A   1       0.000   0.000   0.000  1.00  0.00           O  \n";
        let idx = build_index(single).unwrap();
        assert_eq!(idx.frame0_end, single.len() as u64);
        assert_eq!(idx.n_extra_frames, 0);
    }

    #[test]
    fn parses_a_cryst1_only_file_as_an_empty_cell() {
        let text = "REMARK   empty box\nCRYST1   10.000   10.000   10.000  90.00  90.00  90.00 P 1           1\nEND\n";
        let s = parse(text).expect("a cell without atoms is a valid structure");
        assert_eq!(s.n_atoms, 0);
        assert!(s.positions.is_empty());
        assert!(s.elements.is_empty());
        assert!(s.bonds.is_empty());
        assert_eq!(s.n_file_bonds, 0);
        let cell = s.box_matrix.expect("CRYST1 survives without atoms");
        assert!((cell[0] - 10.0).abs() < 1e-4);
        assert!((cell[4] - 10.0).abs() < 1e-4);
        assert!((cell[8] - 10.0).abs() < 1e-4);
        assert_eq!(s.extra_frame_count(), 0);
        assert!(s.atom_labels.is_none());
    }

    #[test]
    fn a_file_with_neither_atoms_nor_a_cell_is_still_an_error() {
        match parse("REMARK   nothing here\nEND\n") {
            Err(err) => assert!(err.contains("no ATOM or HETATM"), "{err}"),
            Ok(_) => panic!("a file with neither atoms nor a cell must not parse"),
        }
    }

    #[test]
    fn hy36_decodes_decimal_and_hybrid36_fields() {
        assert_eq!(hy36_decode("    1"), Some(1));
        assert_eq!(hy36_decode("99999"), Some(99_999));
        assert_eq!(hy36_decode("A0000"), Some(100_000));
        assert_eq!(hy36_decode("A0001"), Some(100_001));
        assert_eq!(hy36_decode("ZZZZZ"), Some(43_770_015));
        assert_eq!(hy36_decode("a0000"), Some(43_770_016));
        // 4-wide residue numbers: A000 follows 9999.
        assert_eq!(hy36_decode("9999"), Some(9_999));
        assert_eq!(hy36_decode("A000"), Some(10_000));
        assert_eq!(hy36_decode("  -3"), Some(-3));
        // Overflow markers, blanks, mixed case and stray characters are not numbers.
        assert_eq!(hy36_decode("*****"), None);
        assert_eq!(hy36_decode("     "), None);
        assert_eq!(hy36_decode("Aa000"), None);
        assert_eq!(hy36_decode("A00 0"), None);
        assert_eq!(hy36_decode("A000 "), None);
    }

    fn atom_line(serial: &str, x: f32) -> String {
        format!(
            "HETATM{serial:>5}  O   HOH A   1    {x:8.3}   0.000   0.000  1.00  0.00           O  \n"
        )
    }

    #[test]
    fn keeps_atoms_whose_serial_is_hybrid36_or_an_overflow_marker() {
        // Files past 99,999 atoms write the serial as hybrid-36 (wwPDB, Phenix,
        // OpenMM) or as "*****" (VMD); every one of those atoms must survive.
        let mut pdb = String::new();
        // 10 Å apart, so no bond is distance-inferred for the unnumbered atom.
        pdb += &atom_line("99999", 0.0);
        pdb += &atom_line("A0000", 10.0);
        pdb += &atom_line("*****", 20.0);
        pdb += &atom_line("A0001", 30.0);
        pdb += "CONECT99999A0000\nCONECTA0000A0001\nEND\n";
        let s = parse(&pdb).unwrap();
        assert_eq!(s.n_atoms, 4);
        assert!((s.positions[6] - 20.0).abs() < 1e-4);
        // Both CONECT records resolve through the hybrid-36 serials.
        assert_eq!(s.n_file_bonds, 2);
        let mut bonds = s.bonds.clone();
        bonds.sort();
        assert_eq!(bonds, vec![(0, 1), (1, 3)]);
    }

    #[test]
    fn reads_hybrid36_residue_numbers_for_the_backbone() {
        let line = |name: &str, res: &str, x: f32| {
            format!(
                "ATOM  {:>5}  {name:<3} ALA A{res:>4}    {x:8.3}   0.000   0.000  1.00  0.00           C  \n",
                1
            )
        };
        let pdb = line("CA", "9999", 0.0) + &line("CA", "A000", 3.8) + "END\n";
        let s = parse(&pdb).unwrap();
        assert_eq!(s.ca_res_nums, vec![9_999, 10_000]);
    }

    /// Expression tags are numbered below 1 (`HIS A  -2`, `MET A   0`). Their
    /// Cα atoms belong to the backbone like any other, and a HELIX/SHEET that
    /// starts in the tag still covers them.
    #[test]
    fn keeps_negative_residue_numbers_on_the_backbone_and_in_ss_ranges() {
        let pdb = "\
HELIX    1   1 HIS A   -2  MET A    1  1                                   4
SHEET    1   A 1 GLY B  -5  GLY B  -4  0
ATOM      1  CA  HIS A  -2       0.000   0.000   0.000  1.00  0.00           C
ATOM      2  CA  HIS A  -1       3.800   0.000   0.000  1.00  0.00           C
ATOM      3  CA  MET A   0       7.600   0.000   0.000  1.00  0.00           C
ATOM      4  CA  MET A   1      11.400   0.000   0.000  1.00  0.00           C
ATOM      5  CA  GLY B  -5       0.000   9.000   0.000  1.00  0.00           C
ATOM      6  CA  GLY B  -4       3.800   9.000   0.000  1.00  0.00           C
ATOM      7  CA  GLY B  -3       7.600   9.000   0.000  1.00  0.00           C
END
";
        let s = parse(pdb).unwrap();
        assert_eq!(s.ca_indices, vec![0, 1, 2, 3, 4, 5, 6]);
        assert_eq!(s.ca_res_nums, vec![-2, -1, 0, 1, -5, -4, -3]);
        assert_eq!(s.ca_chain_ids, b"AAAABBB".to_vec());
        assert_eq!(s.ca_ss_type, vec![1, 1, 1, 1, 2, 2, 0]);
    }

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

    #[test]
    fn test_pdb_element_from_name_uses_residue_context() {
        // No element columns (77-78): the atom name is read in the context of
        // its residue, so a protein Cα is carbon, not calcium.
        let pdb = "\
ATOM      1  CA  ALA A   1      17.047  14.099   3.625
ATOM      2  HG  SER A   2      16.967  12.784   4.338
ATOM      3  SG  CYS A   3      15.685  12.755   5.133
ATOM      4  OH2 TIP3W   4      10.000  10.000  10.000
HETATM    5 CA    CA A 101      12.000  12.000  12.000
HETATM    6 ZN    ZN A 102      13.000  13.000  13.000
END
";
        let result = parse(pdb).expect("parse failed");
        assert_eq!(result.elements, vec![6, 1, 16, 8, 20, 30]);
        // An explicit element column still wins over the name guess.
        assert_eq!(
            parse_element(
                "HETATM    5 CA    CA A 101      12.000  12.000  12.000  1.00  0.00           C  "
            ),
            6
        );
        // A name field that cannot be sliced resolves to unknown, not a panic.
        assert_eq!(parse_element("ATOM      1 ABC\u{e9} ALA A   1"), 0);
    }

    /// SER with two alternate conformers of its side chain. On main the
    /// inference also bonded CB A to CB B, CB A to OG B, and OG A to OG B.
    const SER_ALTLOC_PDB: &str = "\
ATOM      1  N   SER A   1       0.000   0.000   0.000  1.00  0.00           N
ATOM      2  CA  SER A   1       1.460   0.000   0.000  1.00  0.00           C
ATOM      3  CB ASER A   1       2.000   1.400   0.000  0.50  0.00           C
ATOM      4  CB BSER A   1       2.000   1.200   0.600  0.50  0.00           C
ATOM      5  OG ASER A   1       3.400   1.500   0.000  0.50  0.00           O
ATOM      6  OG BSER A   1       3.300   1.000   1.100  0.50  0.00           O
END
";

    #[test]
    fn test_inferred_bonds_never_join_alternate_conformers() {
        let s = parse(SER_ALTLOC_PDB).unwrap();
        let mut bonds = s.bonds.clone();
        bonds.sort_unstable();
        // N-CA; CA to both CB conformers; each CB to its own OG.
        assert_eq!(bonds, vec![(0, 1), (1, 2), (1, 3), (2, 4), (3, 5)]);
        assert_eq!(s.n_file_bonds, 0);
    }

    /// A disulfide declared by CONECT next to undeclared CB atoms, and a
    /// ligand whose CONECT records give C1-C2 and C2-O3 but not C1-O3, even
    /// though C1 and O3 sit within the C-O cutoff.
    const CONECT_PARTIAL_PDB: &str = "\
ATOM      1  CB  CYS A   1       0.000   0.000   0.000  1.00  0.00           C
ATOM      2  SG  CYS A   1       1.810   0.000   0.000  1.00  0.00           S
ATOM      3  SG  CYS A   2       3.840   0.000   0.000  1.00  0.00           S
ATOM      4  CB  CYS A   2       5.650   0.000   0.000  1.00  0.00           C
HETATM    5  C1  LIG B   1      10.000   0.000   0.000  1.00  0.00           C
HETATM    6  C2  LIG B   1      11.500   0.000   0.000  1.00  0.00           C
HETATM    7  O3  LIG B   1      10.750   1.300   0.000  1.00  0.00           O
CONECT    2    3
CONECT    3    2
CONECT    5    6
CONECT    6    5    7
CONECT    7    6
END
";

    #[test]
    fn test_inference_is_not_layered_on_file_declared_atoms() {
        let s = parse(CONECT_PARTIAL_PDB).unwrap();
        assert_eq!(s.n_file_bonds, 3);
        let (file, inferred) = s.bonds.split_at(s.n_file_bonds);
        let mut file = file.to_vec();
        file.sort_unstable();
        assert_eq!(file, vec![(1, 2), (4, 5), (5, 6)]);
        // SG-CB is still inferred: only one of the two atoms has file bonds.
        let mut inferred = inferred.to_vec();
        inferred.sort_unstable();
        assert_eq!(inferred, vec![(0, 1), (2, 3)]);
        // C1-O3: both atoms' connectivity is declared, so nothing is added.
        assert!(!s.bonds.contains(&(4, 6)));
    }

    #[test]
    fn test_parse_atom_line_reads_altloc() {
        let (_, a) = parse_atom_line(SER_ALTLOC_PDB.lines().nth(2).unwrap()).unwrap();
        assert_eq!(a.altloc, b'A');
        let (_, a) = parse_atom_line(SER_ALTLOC_PDB.lines().next().unwrap()).unwrap();
        assert_eq!(a.altloc, 0);
    }
}
