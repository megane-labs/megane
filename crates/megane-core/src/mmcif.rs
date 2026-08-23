/// mmCIF (PDBx/macromolecular CIF) text parser.
///
/// Handles the dot-notation tag scheme used by the PDB: `_atom_site.Cartn_x`
/// rather than the underscore-separated scheme of small-molecule CIF
/// (`_atom_site_Cartn_x`).  Extracts Cartesian coordinates, element symbols,
/// atom names, chain IDs, B-factors, multi-model ensembles as trajectory
/// frames, file-declared connectivity (`_struct_conn`), and Cα backbone data
/// with secondary structure (`_struct_conf`/`_struct_sheet_range`) for
/// cartoon rendering.
use std::collections::{HashMap, HashSet};

use crate::atomic::{capitalize, symbol_to_atomic_num};
use crate::bonds;
use crate::parser::{cell_params_to_matrix, HeteroFrames, ParsedStructure};

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/// Return `true` when `text` looks like an mmCIF file.
///
/// Heuristic: the first 500 lines are scanned for `_atom_site.` (dot-notation)
/// or `_entry.id`, both of which are unique to the PDBx/mmCIF dictionary.
pub fn is_mmcif(text: &str) -> bool {
    for line in text.lines().take(500) {
        let t = line.trim();
        if t.starts_with('_') {
            let lower = t.to_ascii_lowercase();
            if lower.starts_with("_atom_site.")
                || lower.starts_with("_entry.id")
                || lower.starts_with("_struct.entry_id")
            {
                return true;
            }
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Loop column tracking
// ---------------------------------------------------------------------------

/// Column indices for the `_atom_site` loop in mmCIF format.
struct AtomSiteColumns {
    group_pdb: Option<usize>,
    type_symbol: Option<usize>,
    label_atom_id: Option<usize>,
    label_asym_id: Option<usize>,
    auth_asym_id: Option<usize>,
    label_seq_id: Option<usize>,
    auth_seq_id: Option<usize>,
    cartn_x: Option<usize>,
    cartn_y: Option<usize>,
    cartn_z: Option<usize>,
    b_iso: Option<usize>,
    model_num: Option<usize>,
}

impl AtomSiteColumns {
    fn new() -> Self {
        Self {
            group_pdb: None,
            type_symbol: None,
            label_atom_id: None,
            label_asym_id: None,
            auth_asym_id: None,
            label_seq_id: None,
            auth_seq_id: None,
            cartn_x: None,
            cartn_y: None,
            cartn_z: None,
            b_iso: None,
            model_num: None,
        }
    }

    fn assign(&mut self, idx: usize, tag: &str) {
        let t = tag.to_ascii_lowercase();
        match t.as_str() {
            "_atom_site.group_pdb" => self.group_pdb = Some(idx),
            "_atom_site.type_symbol" => self.type_symbol = Some(idx),
            "_atom_site.label_atom_id" => self.label_atom_id = Some(idx),
            "_atom_site.label_asym_id" => self.label_asym_id = Some(idx),
            "_atom_site.auth_asym_id" => self.auth_asym_id = Some(idx),
            "_atom_site.label_seq_id" => self.label_seq_id = Some(idx),
            "_atom_site.auth_seq_id" => self.auth_seq_id = Some(idx),
            "_atom_site.cartn_x" => self.cartn_x = Some(idx),
            "_atom_site.cartn_y" => self.cartn_y = Some(idx),
            "_atom_site.cartn_z" => self.cartn_z = Some(idx),
            "_atom_site.b_iso_or_equiv" => self.b_iso = Some(idx),
            "_atom_site.pdbx_pdb_model_num" => self.model_num = Some(idx),
            _ => {}
        }
    }

    fn has_cartesian(&self) -> bool {
        self.cartn_x.is_some() && self.cartn_y.is_some() && self.cartn_z.is_some()
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Return `true` for mmCIF "missing value" tokens (`?` or `.`).
fn is_missing(s: &str) -> bool {
    s == "?" || s == "."
}

/// Parse a float field, returning `None` for missing values or parse errors.
fn parse_float_field(s: &str) -> Option<f32> {
    if is_missing(s) {
        None
    } else {
        s.parse().ok()
    }
}

/// Parse a u32 field, returning `None` for missing values or parse errors.
fn parse_u32_field(s: &str) -> Option<u32> {
    if is_missing(s) {
        None
    } else {
        s.parse().ok()
    }
}

/// Strip surrounding single- or double-quote characters from a CIF token.
fn strip_quotes(s: &str) -> &str {
    if (s.starts_with('\'') && s.ends_with('\'')) || (s.starts_with('"') && s.ends_with('"')) {
        &s[1..s.len() - 1]
    } else {
        s
    }
}

/// Extract element atomic number from a type_symbol field (`C`, `N`, `FE`, …).
fn element_from_type_symbol(s: &str) -> u8 {
    let cleaned: String = s.chars().take_while(|c| c.is_alphabetic()).collect();
    if cleaned.is_empty() {
        return 0;
    }
    let cap = capitalize(&cleaned);
    let z = symbol_to_atomic_num(&cap);
    if z > 0 {
        return z;
    }
    let first = capitalize(&cleaned[..1]);
    symbol_to_atomic_num(&first)
}

// ---------------------------------------------------------------------------
// Category row collection (_struct_conn, _struct_conf, _struct_sheet_range)
// ---------------------------------------------------------------------------

/// Collect the rows of a dot-notation mmCIF category (e.g. `_struct_conn.`).
///
/// Handles both the `loop_` form and the single-record key-value form PDB
/// entries use when a category holds exactly one row. Returns the lowercased
/// tag names and the quote-stripped row values.
fn collect_category_rows(lines: &[&str], prefix: &str) -> (Vec<String>, Vec<Vec<String>>) {
    let mut kv_tags: Vec<String> = Vec::new();
    let mut kv_row: Vec<String> = Vec::new();

    let mut i = 0;
    while i < lines.len() {
        let t = lines[i].trim();
        if t == "loop_" {
            // Read the loop header and decide whether it is the target category.
            let mut j = i + 1;
            let mut header: Vec<String> = Vec::new();
            while j < lines.len() {
                let h = lines[j].trim();
                if h.starts_with('#') {
                    j += 1;
                    continue;
                }
                if h.starts_with('_') {
                    let tag = h
                        .split_whitespace()
                        .next()
                        .unwrap_or("")
                        .to_ascii_lowercase();
                    header.push(tag);
                    j += 1;
                } else {
                    break;
                }
            }
            let is_target = header.iter().any(|h| h.starts_with(prefix));
            i = j;
            if !is_target {
                continue;
            }
            // Read data rows until the loop terminates.
            let mut rows: Vec<Vec<String>> = Vec::new();
            while i < lines.len() {
                let d = lines[i].trim();
                if d.is_empty()
                    || d.starts_with("loop_")
                    || d.starts_with("data_")
                    || d.starts_with('#')
                    || d.starts_with('_')
                {
                    break;
                }
                // Semicolon-delimited multi-line strings are skipped whole.
                if d.starts_with(';') {
                    i += 1;
                    while i < lines.len() && !lines[i].trim().starts_with(';') {
                        i += 1;
                    }
                    i += 1;
                    continue;
                }
                let fields: Vec<String> = d
                    .split_whitespace()
                    .map(|s| strip_quotes(s).to_string())
                    .collect();
                if fields.len() >= header.len() {
                    rows.push(fields);
                }
                i += 1;
            }
            return (header, rows);
        }
        if t.to_ascii_lowercase().starts_with(prefix) {
            // Single-record key-value form: `_struct_conn.conn_type_id disulf`.
            let parts: Vec<&str> = t.splitn(2, char::is_whitespace).collect();
            if parts.len() == 2 {
                kv_tags.push(parts[0].to_ascii_lowercase());
                kv_row.push(strip_quotes(parts[1].trim()).to_string());
            }
        }
        i += 1;
    }

    if kv_tags.is_empty() {
        (Vec::new(), Vec::new())
    } else {
        (kv_tags, vec![kv_row])
    }
}

/// Find the column index of a lowercased `tag` in a category header.
fn col(tags: &[String], tag: &str) -> Option<usize> {
    tags.iter().position(|t| t == tag)
}

/// Fetch a row field by optional column index, treating absent columns as the
/// mmCIF missing token.
fn field(row: &[String], idx: Option<usize>) -> &str {
    idx.and_then(|i| row.get(i))
        .map(String::as_str)
        .unwrap_or("?")
}

// ---------------------------------------------------------------------------
// _struct_conn (file-declared connectivity)
// ---------------------------------------------------------------------------

/// Residue-level addressing of one first-model atom site, used to resolve the
/// partner references in `_struct_conn` rows.
struct AtomAddress {
    label_asym: String,
    auth_asym: String,
    label_seq: Option<u32>,
    auth_seq: Option<u32>,
}

/// Resolve one `_struct_conn` partner to an atom index. label_* addressing is
/// preferred; auth_* is the fallback when the label sequence id is missing
/// (`.`/`?`, e.g. waters, ions, and other HETATM sites).
fn resolve_conn_partner(
    label_asym: &str,
    label_seq: &str,
    atom_id: &str,
    auth_asym: &str,
    auth_seq: &str,
    label_map: &HashMap<(String, u32, String), u32>,
    auth_map: &HashMap<(String, u32, String), u32>,
) -> Option<u32> {
    if is_missing(atom_id) {
        return None;
    }
    if let Some(seq) = parse_u32_field(label_seq) {
        if let Some(&idx) = label_map.get(&(label_asym.to_string(), seq, atom_id.to_string())) {
            return Some(idx);
        }
    }
    if let Some(seq) = parse_u32_field(auth_seq) {
        let chain = if is_missing(auth_asym) || auth_asym.is_empty() {
            label_asym
        } else {
            auth_asym
        };
        if let Some(&idx) = auth_map.get(&(chain.to_string(), seq, atom_id.to_string())) {
            return Some(idx);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// _struct_conf / _struct_sheet_range (secondary structure)
// ---------------------------------------------------------------------------

/// Secondary-structure range from `_struct_conf` or `_struct_sheet_range`.
struct SsRange {
    chain_id: u8,
    start: u32,
    end: u32,
    ss_type: u8, // 1 = helix, 2 = sheet
}

/// Build one SS range, preferring label_* addressing and falling back to
/// auth_* when the label sequence ids are missing.
fn ss_range_from_fields(
    label_asym: &str,
    label_beg: &str,
    label_end: &str,
    auth_asym: &str,
    auth_beg: &str,
    auth_end: &str,
    ss_type: u8,
) -> Option<SsRange> {
    let (chain, beg, end) = match (parse_u32_field(label_beg), parse_u32_field(label_end)) {
        (Some(b), Some(e)) => (label_asym, b, e),
        _ => {
            let b = parse_u32_field(auth_beg)?;
            let e = parse_u32_field(auth_end)?;
            let chain = if is_missing(auth_asym) || auth_asym.is_empty() {
                label_asym
            } else {
                auth_asym
            };
            (chain, b, e)
        }
    };
    let chain_id = if is_missing(chain) {
        b' '
    } else {
        chain.as_bytes().first().copied().unwrap_or(b' ')
    };
    Some(SsRange {
        chain_id,
        start: beg.min(end),
        end: beg.max(end),
        ss_type,
    })
}

/// Extract helix/sheet residue ranges from the `_struct_conf` and
/// `_struct_sheet_range` categories.
fn extract_ss_ranges(lines: &[&str]) -> Vec<SsRange> {
    let mut ranges: Vec<SsRange> = Vec::new();

    // _struct_conf: HELX_* rows are helices; the occasional STRN row is a
    // strand. Turns/bends render as coil and are ignored.
    let (tags, rows) = collect_category_rows(lines, "_struct_conf.");
    let c_type = col(&tags, "_struct_conf.conf_type_id");
    let c_asym = col(&tags, "_struct_conf.beg_label_asym_id");
    let c_beg = col(&tags, "_struct_conf.beg_label_seq_id");
    let c_end = col(&tags, "_struct_conf.end_label_seq_id");
    let c_auth_asym = col(&tags, "_struct_conf.beg_auth_asym_id");
    let c_auth_beg = col(&tags, "_struct_conf.beg_auth_seq_id");
    let c_auth_end = col(&tags, "_struct_conf.end_auth_seq_id");
    for row in &rows {
        let conf_type = field(row, c_type).to_ascii_uppercase();
        let ss_type = if conf_type.starts_with("HELX") {
            1
        } else if conf_type.starts_with("STRN") {
            2
        } else {
            continue;
        };
        if let Some(r) = ss_range_from_fields(
            field(row, c_asym),
            field(row, c_beg),
            field(row, c_end),
            field(row, c_auth_asym),
            field(row, c_auth_beg),
            field(row, c_auth_end),
            ss_type,
        ) {
            ranges.push(r);
        }
    }

    // _struct_sheet_range: every row is a sheet strand.
    let (tags, rows) = collect_category_rows(lines, "_struct_sheet_range.");
    let s_asym = col(&tags, "_struct_sheet_range.beg_label_asym_id");
    let s_beg = col(&tags, "_struct_sheet_range.beg_label_seq_id");
    let s_end = col(&tags, "_struct_sheet_range.end_label_seq_id");
    let s_auth_asym = col(&tags, "_struct_sheet_range.beg_auth_asym_id");
    let s_auth_beg = col(&tags, "_struct_sheet_range.beg_auth_seq_id");
    let s_auth_end = col(&tags, "_struct_sheet_range.end_auth_seq_id");
    for row in &rows {
        if let Some(r) = ss_range_from_fields(
            field(row, s_asym),
            field(row, s_beg),
            field(row, s_end),
            field(row, s_auth_asym),
            field(row, s_auth_beg),
            field(row, s_auth_end),
            2,
        ) {
            ranges.push(r);
        }
    }

    ranges
}

// ---------------------------------------------------------------------------
// Public parser
// ---------------------------------------------------------------------------

/// Parse an mmCIF text and return a `ParsedStructure`.
///
/// All models (`_atom_site.pdbx_PDB_model_num`) are kept: the first model
/// number seen supplies the base structure and every later model becomes an
/// extra trajectory frame (with a `HeteroFrames` side table when atom counts
/// differ). Topology, labels, chain/SS data, and `_struct_conn` connectivity
/// come from the first model only, matching the PDB parser.
pub fn parse(text: &str) -> Result<ParsedStructure, String> {
    let lines: Vec<&str> = text.lines().collect();

    // --- Cell parameters (dot-notation key-value) ---
    let mut cell_a: Option<f32> = None;
    let mut cell_b: Option<f32> = None;
    let mut cell_c: Option<f32> = None;
    let mut cell_alpha: Option<f32> = None;
    let mut cell_beta: Option<f32> = None;
    let mut cell_gamma: Option<f32> = None;

    for line in &lines {
        let trimmed = line.trim();
        if trimmed.starts_with('#') || trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with('_') {
            let parts: Vec<&str> = trimmed.splitn(2, char::is_whitespace).collect();
            if parts.len() >= 2 {
                let tag = parts[0].to_ascii_lowercase();
                let val = parts[1].trim();
                if !is_missing(val) {
                    let v: Option<f32> = val.parse().ok();
                    match tag.as_str() {
                        "_cell.length_a" => cell_a = v,
                        "_cell.length_b" => cell_b = v,
                        "_cell.length_c" => cell_c = v,
                        "_cell.angle_alpha" => cell_alpha = v,
                        "_cell.angle_beta" => cell_beta = v,
                        "_cell.angle_gamma" => cell_gamma = v,
                        _ => {}
                    }
                }
            }
        }
    }

    let box_matrix = match (cell_a, cell_b, cell_c, cell_alpha, cell_beta, cell_gamma) {
        (Some(a), Some(b), Some(c), Some(alpha), Some(beta), Some(gamma))
            if a > 0.0 && b > 0.0 && c > 0.0 =>
        {
            Some(cell_params_to_matrix(a, b, c, alpha, beta, gamma))
        }
        _ => None,
    };

    // _struct_conn rows are collected up front so per-atom addressing data is
    // only gathered when the file actually declares connectivity.
    let (conn_tags, conn_rows) = collect_category_rows(&lines, "_struct_conn.");
    let need_conn_addressing = !conn_rows.is_empty();

    // --- Atom site data ---
    // Per-model storage: index 0 is the base structure, later models become
    // extra trajectory frames.
    let mut model_nums: Vec<u32> = Vec::new();
    let mut model_positions: Vec<Vec<f32>> = Vec::new();
    let mut model_elements: Vec<Vec<u8>> = Vec::new();
    // First-model metadata only.
    let mut atom_labels: Vec<String> = Vec::new();
    let mut chain_ids: Vec<u8> = Vec::new();
    let mut bfactors: Vec<f32> = Vec::new();
    let mut ca_indices: Vec<u32> = Vec::new();
    let mut ca_chain_ids: Vec<u8> = Vec::new();
    let mut ca_res_nums: Vec<u32> = Vec::new();
    let mut addr: Vec<AtomAddress> = Vec::new();

    let mut i = 0;
    while i < lines.len() {
        let trimmed = lines[i].trim();

        if trimmed == "loop_" {
            i += 1;
            let mut cols = AtomSiteColumns::new();
            let mut col_count = 0usize;
            let mut is_atom_site = false;

            // Read loop header (all lines starting with `_`)
            while i < lines.len() {
                let t = lines[i].trim();
                if t.starts_with('#') {
                    i += 1;
                    continue;
                }
                if t.starts_with('_') {
                    let lower = t.to_ascii_lowercase();
                    // Strip inline comments after the tag name
                    let tag = lower.split_whitespace().next().unwrap_or("");
                    if tag.starts_with("_atom_site.") {
                        is_atom_site = true;
                        cols.assign(col_count, tag);
                    }
                    col_count += 1;
                    i += 1;
                } else {
                    break;
                }
            }

            if !is_atom_site || !cols.has_cartesian() || col_count == 0 {
                continue;
            }

            // Read data rows
            while i < lines.len() {
                let t = lines[i].trim();

                // End of loop conditions
                if t.is_empty()
                    || t.starts_with("loop_")
                    || t.starts_with("data_")
                    || t.starts_with('#')
                    || t.starts_with('_')
                {
                    break;
                }

                // Handle semicolon-delimited multi-line strings (skip the whole block)
                if t.starts_with(';') {
                    i += 1;
                    while i < lines.len() && !lines[i].trim().starts_with(';') {
                        i += 1;
                    }
                    i += 1; // skip closing ';'
                    continue;
                }

                let raw_fields: Vec<&str> = t.split_whitespace().collect();
                if raw_fields.len() < col_count {
                    i += 1;
                    continue;
                }

                // Coordinates
                let x = cols
                    .cartn_x
                    .and_then(|c| raw_fields.get(c))
                    .and_then(|s| parse_float_field(s));
                let y = cols
                    .cartn_y
                    .and_then(|c| raw_fields.get(c))
                    .and_then(|s| parse_float_field(s));
                let z = cols
                    .cartn_z
                    .and_then(|c| raw_fields.get(c))
                    .and_then(|s| parse_float_field(s));

                let (x, y, z) = match (x, y, z) {
                    (Some(x), Some(y), Some(z)) => (x, y, z),
                    _ => {
                        i += 1;
                        continue;
                    }
                };

                // Element
                let elem = cols
                    .type_symbol
                    .and_then(|c| raw_fields.get(c))
                    .map(|s| element_from_type_symbol(strip_quotes(s)))
                    .unwrap_or(0);

                // Model membership: rows are grouped by model number; the
                // first number seen is the base structure.
                let m = cols
                    .model_num
                    .and_then(|c| raw_fields.get(c))
                    .and_then(|s| parse_u32_field(s))
                    .unwrap_or(1);
                let mi = match model_nums.iter().position(|&n| n == m) {
                    Some(p) => p,
                    None => {
                        model_nums.push(m);
                        model_positions.push(Vec::new());
                        model_elements.push(Vec::new());
                        model_nums.len() - 1
                    }
                };

                // Per-atom metadata comes from the first model only.
                if mi == 0 {
                    // Atom name
                    let atom_name = cols
                        .label_atom_id
                        .and_then(|c| raw_fields.get(c))
                        .map(|s| strip_quotes(s))
                        .filter(|s| !is_missing(s))
                        .map(|s| s.to_string())
                        .unwrap_or_default();

                    // Chain ID: label_asym_id preferred, auth_asym_id as fallback
                    let chain_byte = cols
                        .label_asym_id
                        .and_then(|c| raw_fields.get(c))
                        .map(|s| strip_quotes(s))
                        .filter(|s| !is_missing(s))
                        .and_then(|s| s.as_bytes().first().copied())
                        .or_else(|| {
                            cols.auth_asym_id
                                .and_then(|c| raw_fields.get(c))
                                .map(|s| strip_quotes(s))
                                .filter(|s| !is_missing(s))
                                .and_then(|s| s.as_bytes().first().copied())
                        })
                        .unwrap_or(b' ');

                    // B-factor
                    let bfac = cols
                        .b_iso
                        .and_then(|c| raw_fields.get(c))
                        .and_then(|s| parse_float_field(s))
                        .unwrap_or(0.0);

                    // Cα tracking (ATOM records only, atom name == "CA")
                    let is_atom = cols
                        .group_pdb
                        .and_then(|c| raw_fields.get(c))
                        .map(|s| strip_quotes(s).eq_ignore_ascii_case("ATOM"))
                        .unwrap_or(true); // assume ATOM if column absent

                    let label_seq = cols
                        .label_seq_id
                        .and_then(|c| raw_fields.get(c))
                        .and_then(|s| parse_u32_field(s));
                    let auth_seq = cols
                        .auth_seq_id
                        .and_then(|c| raw_fields.get(c))
                        .and_then(|s| parse_u32_field(s));

                    if is_atom && atom_name == "CA" {
                        let atom_idx = model_elements[0].len() as u32;
                        ca_indices.push(atom_idx);
                        ca_chain_ids.push(chain_byte);
                        ca_res_nums.push(label_seq.or(auth_seq).unwrap_or(0));
                    }

                    // Residue addressing for _struct_conn partner resolution.
                    if need_conn_addressing {
                        let asym_str = |c: Option<usize>| {
                            c.and_then(|c| raw_fields.get(c))
                                .map(|s| strip_quotes(s))
                                .filter(|s| !is_missing(s))
                                .unwrap_or("")
                                .to_string()
                        };
                        addr.push(AtomAddress {
                            label_asym: asym_str(cols.label_asym_id),
                            auth_asym: asym_str(cols.auth_asym_id),
                            label_seq,
                            auth_seq,
                        });
                    }

                    atom_labels.push(atom_name);
                    chain_ids.push(chain_byte);
                    bfactors.push(bfac);
                }

                model_elements[mi].push(elem);
                model_positions[mi].push(x);
                model_positions[mi].push(y);
                model_positions[mi].push(z);

                i += 1;
            }

            // Stop after first atom_site block that yielded atoms
            if model_elements.first().is_some_and(|e| !e.is_empty()) {
                break;
            }
        } else {
            i += 1;
        }
    }

    let n_atoms = model_elements.first().map(Vec::len).unwrap_or(0);
    if n_atoms == 0 {
        return Err("mmCIF file contains no atom sites with Cartesian coordinates".to_string());
    }

    let mut pos_iter = model_positions.into_iter();
    let positions = pos_iter.next().unwrap();
    let extra_positions: Vec<Vec<f32>> = pos_iter.collect();
    let mut elem_iter = model_elements.into_iter();
    let elements = elem_iter.next().unwrap();
    let extra_elements: Vec<Vec<u8>> = elem_iter.collect();

    // Extra models become trajectory frames. Uniform atom counts (the NMR
    // norm) keep the fixed-stride fast path; jagged ensembles get a
    // `HeteroFrames` side table, mirroring the PDB parser.
    let mut frame_positions_flat: Vec<f32> = Vec::new();
    let mut atom_offsets: Vec<u32> = vec![0];
    let mut varies_atoms = false;
    let mut max_atoms = n_atoms;
    for pos in &extra_positions {
        let m_atoms = pos.len() / 3;
        frame_positions_flat.extend_from_slice(pos);
        let last = *atom_offsets.last().unwrap();
        atom_offsets.push(last + m_atoms as u32);
        max_atoms = max_atoms.max(m_atoms);
        if m_atoms != n_atoms {
            varies_atoms = true;
        }
    }
    let hetero = if varies_atoms {
        let empty_bonds: HashSet<(u32, u32)> = HashSet::new();
        let mut elements_flat: Vec<u8> = Vec::new();
        let mut bonds_flat: Vec<u32> = Vec::new();
        let mut bond_offsets: Vec<u32> = vec![0];
        for (k, elems) in extra_elements.iter().enumerate() {
            let a = atom_offsets[k] as usize * 3;
            let b = atom_offsets[k + 1] as usize * 3;
            let fpos = &frame_positions_flat[a..b];
            let fbonds = bonds::infer_bonds(fpos, elems, elems.len(), &empty_bonds);
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

    let mut warnings: Vec<String> = Vec::new();

    // File-declared connectivity from _struct_conn (disulfides, covalent
    // ligand links, metal coordination). mmCIF carries no routine polymer
    // connectivity, so distance inference still covers everything else; the
    // declared pairs are passed to it as existing bonds so they are never
    // duplicated.
    let mut file_bonds: Vec<(u32, u32)> = Vec::new();
    let mut bond_set: HashSet<(u32, u32)> = HashSet::new();
    if !conn_rows.is_empty() {
        let mut label_map: HashMap<(String, u32, String), u32> = HashMap::new();
        let mut auth_map: HashMap<(String, u32, String), u32> = HashMap::new();
        for (idx, a) in addr.iter().enumerate() {
            let name = &atom_labels[idx];
            if let Some(seq) = a.label_seq {
                label_map
                    .entry((a.label_asym.clone(), seq, name.clone()))
                    .or_insert(idx as u32);
            }
            if let Some(seq) = a.auth_seq.or(a.label_seq) {
                let chain = if a.auth_asym.is_empty() {
                    a.label_asym.clone()
                } else {
                    a.auth_asym.clone()
                };
                auth_map
                    .entry((chain, seq, name.clone()))
                    .or_insert(idx as u32);
            }
        }

        let c_type = col(&conn_tags, "_struct_conn.conn_type_id");
        let p1_asym = col(&conn_tags, "_struct_conn.ptnr1_label_asym_id");
        let p1_seq = col(&conn_tags, "_struct_conn.ptnr1_label_seq_id");
        let p1_atom = col(&conn_tags, "_struct_conn.ptnr1_label_atom_id");
        let p1_auth_asym = col(&conn_tags, "_struct_conn.ptnr1_auth_asym_id");
        let p1_auth_seq = col(&conn_tags, "_struct_conn.ptnr1_auth_seq_id");
        let p2_asym = col(&conn_tags, "_struct_conn.ptnr2_label_asym_id");
        let p2_seq = col(&conn_tags, "_struct_conn.ptnr2_label_seq_id");
        let p2_atom = col(&conn_tags, "_struct_conn.ptnr2_label_atom_id");
        let p2_auth_asym = col(&conn_tags, "_struct_conn.ptnr2_auth_asym_id");
        let p2_auth_seq = col(&conn_tags, "_struct_conn.ptnr2_auth_seq_id");

        let mut unmatched = 0usize;
        for row in &conn_rows {
            // Hydrogen bonds are not covalent connectivity — skip them.
            if field(row, c_type)
                .to_ascii_lowercase()
                .starts_with("hydrog")
            {
                continue;
            }
            let a = resolve_conn_partner(
                field(row, p1_asym),
                field(row, p1_seq),
                field(row, p1_atom),
                field(row, p1_auth_asym),
                field(row, p1_auth_seq),
                &label_map,
                &auth_map,
            );
            let b = resolve_conn_partner(
                field(row, p2_asym),
                field(row, p2_seq),
                field(row, p2_atom),
                field(row, p2_auth_asym),
                field(row, p2_auth_seq),
                &label_map,
                &auth_map,
            );
            match (a, b) {
                (Some(a), Some(b)) if a != b => {
                    let pair = (a.min(b), a.max(b));
                    if bond_set.insert(pair) {
                        file_bonds.push(pair);
                    }
                }
                _ => unmatched += 1,
            }
        }
        if unmatched > 0 {
            warnings.push(format!(
                "{unmatched} _struct_conn record(s) could not be matched to atom sites"
            ));
        }
    }

    let n_file_bonds = file_bonds.len();
    let inferred = bonds::infer_bonds(&positions, &elements, n_atoms, &bond_set);
    let mut all_bonds = file_bonds;
    all_bonds.extend(inferred);

    // Secondary structure from _struct_conf / _struct_sheet_range ranges,
    // matched by chain byte + residue number exactly like PDB HELIX/SHEET.
    let ss_ranges = extract_ss_ranges(&lines);
    let mut ca_ss_type: Vec<u8> = Vec::with_capacity(ca_indices.len());
    for k in 0..ca_indices.len() {
        let ss = ss_ranges
            .iter()
            .find(|r| {
                r.chain_id == ca_chain_ids[k]
                    && ca_res_nums[k] >= r.start
                    && ca_res_nums[k] <= r.end
            })
            .map(|r| r.ss_type)
            .unwrap_or(0);
        ca_ss_type.push(ss);
    }

    let has_chain_ids = chain_ids.iter().any(|&c| c != b' ');
    let has_bfactors = bfactors.iter().any(|&b| b != 0.0);
    let has_labels = atom_labels.iter().any(|l| !l.is_empty());

    Ok(ParsedStructure {
        n_atoms,
        positions,
        elements,
        bonds: all_bonds,
        n_file_bonds,
        bond_orders: None,
        box_matrix,
        box_origin: None,
        frame_positions_flat,
        atom_labels: if has_labels { Some(atom_labels) } else { None },
        chain_ids: if has_chain_ids { Some(chain_ids) } else { None },
        bfactors: if has_bfactors { Some(bfactors) } else { None },
        vector_channels: vec![],
        ca_indices,
        ca_chain_ids,
        ca_res_nums,
        ca_ss_type,
        symmetry_ops: crate::cif::extract_symmetry_ops(text),
        scalar_channels: Vec::new(),
        warnings,
        hetero,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL_MMCIF: &str = r#"data_1ALA
_entry.id   1ALA
_cell.length_a   40.000
_cell.length_b   40.000
_cell.length_c   40.000
_cell.angle_alpha   90.000
_cell.angle_beta    90.000
_cell.angle_gamma   90.000
#
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.type_symbol
_atom_site.label_atom_id
_atom_site.label_comp_id
_atom_site.label_asym_id
_atom_site.label_seq_id
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
_atom_site.B_iso_or_equiv
_atom_site.pdbx_PDB_model_num
ATOM 1 N N ALA A 1 1.000 2.000 3.000 10.00 1
ATOM 2 C CA ALA A 1 2.000 3.000 4.000 12.00 1
ATOM 3 C C ALA A 1 3.000 4.000 5.000 11.00 1
ATOM 4 O O ALA A 1 4.000 5.000 6.000  9.00 1
ATOM 5 C CB ALA A 1 2.500 2.500 5.000 13.00 1
#
"#;

    #[test]
    fn test_is_mmcif_positive() {
        assert!(is_mmcif(MINIMAL_MMCIF));
    }

    #[test]
    fn test_is_mmcif_negative_small_mol_cif() {
        let cif = r#"data_NaCl
_cell_length_a   5.6402
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
Na1 Na 0.0 0.0 0.0
"#;
        assert!(!is_mmcif(cif));
    }

    #[test]
    fn test_parse_minimal_mmcif() {
        let result = parse(MINIMAL_MMCIF).expect("parse failed");
        assert_eq!(result.n_atoms, 5);
        assert_eq!(result.elements[0], 7); // N
        assert_eq!(result.elements[1], 6); // C (CA)
        assert_eq!(result.elements[2], 6); // C
        assert_eq!(result.elements[3], 8); // O
        assert_eq!(result.elements[4], 6); // CB
    }

    #[test]
    fn test_parse_cell_parameters() {
        let result = parse(MINIMAL_MMCIF).expect("parse failed");
        assert!(result.box_matrix.is_some());
        let bm = result.box_matrix.unwrap();
        assert!((bm[0] - 40.0).abs() < 0.01);
    }

    #[test]
    fn test_parse_cartesian_coords() {
        let result = parse(MINIMAL_MMCIF).expect("parse failed");
        // First atom N at (1, 2, 3)
        assert!((result.positions[0] - 1.0).abs() < 1e-4);
        assert!((result.positions[1] - 2.0).abs() < 1e-4);
        assert!((result.positions[2] - 3.0).abs() < 1e-4);
    }

    #[test]
    fn test_parse_chain_ids() {
        let result = parse(MINIMAL_MMCIF).expect("parse failed");
        let chain_ids = result.chain_ids.expect("no chain IDs");
        assert!(chain_ids.iter().all(|&c| c == b'A'));
    }

    #[test]
    fn test_parse_bfactors() {
        let result = parse(MINIMAL_MMCIF).expect("parse failed");
        let bfacs = result.bfactors.expect("no B-factors");
        assert!((bfacs[0] - 10.0).abs() < 0.01); // N
        assert!((bfacs[1] - 12.0).abs() < 0.01); // CA
    }

    #[test]
    fn test_parse_ca_backbone() {
        let result = parse(MINIMAL_MMCIF).expect("parse failed");
        assert_eq!(result.ca_indices.len(), 1);
        assert_eq!(result.ca_indices[0], 1); // CA is atom index 1
        assert_eq!(result.ca_chain_ids[0], b'A');
        assert_eq!(result.ca_res_nums[0], 1);
        assert_eq!(result.ca_ss_type[0], 0); // coil
    }

    #[test]
    fn test_parse_atom_labels() {
        let result = parse(MINIMAL_MMCIF).expect("parse failed");
        let labels = result.atom_labels.expect("no atom labels");
        assert_eq!(labels[0], "N");
        assert_eq!(labels[1], "CA");
        assert_eq!(labels[4], "CB");
    }

    #[test]
    fn test_single_model_unchanged() {
        let result = parse(MINIMAL_MMCIF).expect("parse failed");
        assert_eq!(result.extra_frame_count(), 0);
        assert!(result.hetero.is_none());
        assert_eq!(result.n_file_bonds, 0);
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn test_two_models_become_extra_frames() {
        let mmcif = r#"data_multi
_entry.id   multi
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.type_symbol
_atom_site.label_atom_id
_atom_site.label_asym_id
_atom_site.label_seq_id
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
_atom_site.pdbx_PDB_model_num
ATOM 1 N N A 1 1.0 2.0 3.0 1
ATOM 2 N N A 1 4.0 5.0 6.0 2
#
"#;
        let result = parse(mmcif).expect("parse failed");
        // Model 1 is the base structure; model 2 becomes an extra frame.
        assert_eq!(result.n_atoms, 1);
        assert!((result.positions[0] - 1.0).abs() < 1e-4);
        assert_eq!(result.extra_frame_count(), 1);
        assert!(result.hetero.is_none());
        let extra = result.frame(0);
        assert!((extra[0] - 4.0).abs() < 1e-4);
        assert!((extra[1] - 5.0).abs() < 1e-4);
        assert!((extra[2] - 6.0).abs() < 1e-4);
    }

    #[test]
    fn test_jagged_models_build_hetero_side_table() {
        let mmcif = r#"data_jagged
_entry.id   jagged
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.type_symbol
_atom_site.label_atom_id
_atom_site.label_asym_id
_atom_site.label_seq_id
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
_atom_site.pdbx_PDB_model_num
ATOM 1 O O  A 1 0.0 0.0 0.0 1
ATOM 2 H H1 A 1 1.0 0.0 0.0 1
ATOM 3 O O  A 1 2.0 0.0 0.0 2
#
"#;
        let result = parse(mmcif).expect("parse failed");
        assert_eq!(result.n_atoms, 2);
        assert_eq!(result.extra_frame_count(), 1);
        assert_eq!(result.frame_atom_count(0), 1);
        assert!((result.frame(0)[0] - 2.0).abs() < 1e-4);
        let h = result.hetero.as_ref().expect("hetero side table");
        assert!(h.varies_atoms);
        assert!(h.varies_topology);
        assert_eq!(h.max_atoms, 2);
        assert_eq!(h.elements_flat, vec![8]);
    }

    #[test]
    fn test_missing_values() {
        let mmcif = r#"data_missing
_entry.id   missing
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.type_symbol
_atom_site.label_atom_id
_atom_site.label_asym_id
_atom_site.label_seq_id
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
_atom_site.B_iso_or_equiv
_atom_site.pdbx_PDB_model_num
ATOM 1 O O A 1 1.0 2.0 3.0 ? 1
ATOM 2 H H A 2 4.0 5.0 6.0 . 1
#
"#;
        let result = parse(mmcif).expect("parse failed");
        assert_eq!(result.n_atoms, 2);
        // B-factors should be 0.0 for missing values
        assert!(result.bfactors.is_none() || result.bfactors.as_ref().map(|b| b[0]) == Some(0.0));
    }

    #[test]
    fn test_empty_mmcif_error() {
        let result = parse("data_empty\n_entry.id empty\n");
        assert!(result.is_err());
    }

    #[test]
    fn test_hetatm_excluded_from_ca() {
        let mmcif = r#"data_hetatm
_entry.id   hetatm
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.type_symbol
_atom_site.label_atom_id
_atom_site.label_asym_id
_atom_site.label_seq_id
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
_atom_site.pdbx_PDB_model_num
ATOM   1 C CA A 1 1.0 2.0 3.0 1
HETATM 2 C CA A 2 4.0 5.0 6.0 1
#
"#;
        let result = parse(mmcif).expect("parse failed");
        assert_eq!(result.n_atoms, 2);
        // Only the ATOM record should contribute a Cα
        assert_eq!(result.ca_indices.len(), 1);
        assert_eq!(result.ca_indices[0], 0);
    }

    #[test]
    fn test_no_cell_is_ok() {
        let mmcif = r#"data_nocell
_entry.id   nocell
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.type_symbol
_atom_site.label_atom_id
_atom_site.label_asym_id
_atom_site.label_seq_id
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
_atom_site.pdbx_PDB_model_num
ATOM 1 N N A 1 0.0 0.0 0.0 1
#
"#;
        let result = parse(mmcif).expect("parse without cell failed");
        assert!(result.box_matrix.is_none());
        assert_eq!(result.n_atoms, 1);
    }

    #[test]
    fn test_parse_mmcif_fixture() {
        let text = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/1ala.mmcif"
        ))
        .expect("read fixture");
        let result = parse(&text).expect("parse failed");
        // Pin the fixture's visible behavior: 10 atom sites, no _struct_conn.
        assert_eq!(result.n_atoms, 10);
        assert_eq!(result.n_file_bonds, 0);
        assert_eq!(result.extra_frame_count(), 0);
        assert!(!result.ca_indices.is_empty());
        assert!(result.chain_ids.is_some());
        assert!(result.bfactors.is_some());
        assert!(result.warnings.is_empty());
    }

    /// Two CYS SG atoms `x2` Å apart with one `_struct_conn` row of the given
    /// `conn_type` between them.
    fn disulfide_mmcif(x2: f32, conn_type: &str) -> String {
        format!(
            r#"data_ss
_entry.id ss
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.type_symbol
_atom_site.label_atom_id
_atom_site.label_comp_id
_atom_site.label_asym_id
_atom_site.label_seq_id
_atom_site.auth_asym_id
_atom_site.auth_seq_id
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
_atom_site.pdbx_PDB_model_num
ATOM 1 S SG CYS A 1 A 1 0.000 0.000 0.000 1
ATOM 2 S SG CYS A 4 A 4 {x2:.3} 0.000 0.000 1
#
loop_
_struct_conn.id
_struct_conn.conn_type_id
_struct_conn.ptnr1_label_asym_id
_struct_conn.ptnr1_label_comp_id
_struct_conn.ptnr1_label_seq_id
_struct_conn.ptnr1_label_atom_id
_struct_conn.ptnr2_label_asym_id
_struct_conn.ptnr2_label_comp_id
_struct_conn.ptnr2_label_seq_id
_struct_conn.ptnr2_label_atom_id
bond1 {conn_type} A CYS 1 SG A CYS 4 SG
#
"#
        )
    }

    #[test]
    fn test_struct_conn_disulfide_file_bond() {
        // 3.5 Å is beyond the S–S inference cutoff, so the only possible bond
        // is the file-declared one.
        let result = parse(&disulfide_mmcif(3.5, "disulf")).expect("parse failed");
        assert_eq!(result.n_file_bonds, 1);
        assert_eq!(result.bonds, vec![(0, 1)]);
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn test_struct_conn_not_duplicated_by_inference() {
        // 2.0 Å is within the S–S inference cutoff; the declared bond must
        // suppress the inferred duplicate.
        let result = parse(&disulfide_mmcif(2.0, "disulf")).expect("parse failed");
        assert_eq!(result.n_file_bonds, 1);
        let count = result.bonds.iter().filter(|&&b| b == (0, 1)).count();
        assert_eq!(count, 1);
        assert_eq!(result.bonds.len(), 1);
    }

    #[test]
    fn test_struct_conn_hydrog_skipped() {
        let result = parse(&disulfide_mmcif(3.5, "hydrog")).expect("parse failed");
        assert_eq!(result.n_file_bonds, 0);
        assert!(result.bonds.is_empty());
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn test_struct_conn_unmatched_warns() {
        // ptnr2 references residue 99, which does not exist.
        let text = disulfide_mmcif(3.5, "disulf").replace("A CYS 4 SG", "A CYS 99 SG");
        let result = parse(&text).expect("parse failed");
        assert_eq!(result.n_file_bonds, 0);
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].contains("_struct_conn"));
    }

    #[test]
    fn test_struct_conn_auth_fallback() {
        // The ZN partner has label_seq_id `.` (HETATM), so it must resolve
        // through auth_asym_id + auth_seq_id.
        let mmcif = r#"data_zn
_entry.id zn
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.type_symbol
_atom_site.label_atom_id
_atom_site.label_comp_id
_atom_site.label_asym_id
_atom_site.label_seq_id
_atom_site.auth_asym_id
_atom_site.auth_seq_id
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
_atom_site.pdbx_PDB_model_num
ATOM   1 S  SG CYS A 10 A 10  0.000 0.000 0.000 1
HETATM 2 ZN ZN ZN  B .  B 101 4.000 0.000 0.000 1
#
loop_
_struct_conn.id
_struct_conn.conn_type_id
_struct_conn.ptnr1_label_asym_id
_struct_conn.ptnr1_label_seq_id
_struct_conn.ptnr1_label_atom_id
_struct_conn.ptnr1_auth_asym_id
_struct_conn.ptnr1_auth_seq_id
_struct_conn.ptnr2_label_asym_id
_struct_conn.ptnr2_label_seq_id
_struct_conn.ptnr2_label_atom_id
_struct_conn.ptnr2_auth_asym_id
_struct_conn.ptnr2_auth_seq_id
metalc1 metalc A 10 SG A 10 B . ZN B 101
#
"#;
        let result = parse(mmcif).expect("parse failed");
        assert_eq!(result.n_file_bonds, 1);
        assert_eq!(result.bonds, vec![(0, 1)]);
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn test_struct_conn_key_value_form() {
        // A single _struct_conn record written in key-value (non-loop) form.
        let mmcif = r#"data_kv
_entry.id kv
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.type_symbol
_atom_site.label_atom_id
_atom_site.label_comp_id
_atom_site.label_asym_id
_atom_site.label_seq_id
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
_atom_site.pdbx_PDB_model_num
ATOM 1 S SG CYS A 1 0.000 0.000 0.000 1
ATOM 2 S SG CYS A 4 3.500 0.000 0.000 1
#
_struct_conn.id                   disulf1
_struct_conn.conn_type_id         disulf
_struct_conn.ptnr1_label_asym_id  A
_struct_conn.ptnr1_label_seq_id   1
_struct_conn.ptnr1_label_atom_id  SG
_struct_conn.ptnr2_label_asym_id  A
_struct_conn.ptnr2_label_seq_id   4
_struct_conn.ptnr2_label_atom_id  SG
#
"#;
        let result = parse(mmcif).expect("parse failed");
        assert_eq!(result.n_file_bonds, 1);
        assert_eq!(result.bonds, vec![(0, 1)]);
    }

    #[test]
    fn test_struct_conf_helix_and_sheet_ranges() {
        let mmcif = r#"data_ssr
_entry.id ssr
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.type_symbol
_atom_site.label_atom_id
_atom_site.label_comp_id
_atom_site.label_asym_id
_atom_site.label_seq_id
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
_atom_site.pdbx_PDB_model_num
ATOM 1 C CA ALA A 1 0.000 0.000 0.000 1
ATOM 2 C CA ALA A 2 4.000 0.000 0.000 1
ATOM 3 C CA ALA A 3 8.000 0.000 0.000 1
ATOM 4 C CA ALA A 4 12.000 0.000 0.000 1
ATOM 5 C CA ALA A 5 16.000 0.000 0.000 1
#
loop_
_struct_conf.conf_type_id
_struct_conf.id
_struct_conf.beg_label_comp_id
_struct_conf.beg_label_asym_id
_struct_conf.beg_label_seq_id
_struct_conf.end_label_comp_id
_struct_conf.end_label_asym_id
_struct_conf.end_label_seq_id
HELX_P HELX_P1 ALA A 1 ALA A 2
#
loop_
_struct_sheet_range.sheet_id
_struct_sheet_range.id
_struct_sheet_range.beg_label_comp_id
_struct_sheet_range.beg_label_asym_id
_struct_sheet_range.beg_label_seq_id
_struct_sheet_range.end_label_comp_id
_struct_sheet_range.end_label_asym_id
_struct_sheet_range.end_label_seq_id
A 1 ALA A 3 ALA A 4
#
"#;
        let result = parse(mmcif).expect("parse failed");
        assert_eq!(result.ca_indices.len(), 5);
        // Residues 1-2 helix, 3-4 sheet, 5 coil.
        assert_eq!(result.ca_ss_type, vec![1, 1, 2, 2, 0]);
    }

    #[test]
    fn test_strip_quotes() {
        assert_eq!(strip_quotes("'THR'"), "THR");
        assert_eq!(strip_quotes("\"CA\""), "CA");
        assert_eq!(strip_quotes("THR"), "THR");
        assert_eq!(strip_quotes("?"), "?");
    }

    #[test]
    fn test_is_missing() {
        assert!(is_missing("?"));
        assert!(is_missing("."));
        assert!(!is_missing("A"));
        assert!(!is_missing("1.0"));
    }

    #[test]
    fn test_element_from_type_symbol() {
        assert_eq!(element_from_type_symbol("C"), 6);
        assert_eq!(element_from_type_symbol("N"), 7);
        assert_eq!(element_from_type_symbol("O"), 8);
        assert_eq!(element_from_type_symbol("S"), 16);
        assert_eq!(element_from_type_symbol("FE"), 26);
        assert_eq!(element_from_type_symbol("ZN"), 30);
    }
}
