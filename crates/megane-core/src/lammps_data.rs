/// LAMMPS data file parser.
///
/// Supports atom_style: atomic, charge, and full (real).
/// Auto-detects style from comment hint (`Atoms # full`) or field count.
use std::collections::{HashMap, HashSet};

use crate::atomic::mass_to_atomic_num;
use crate::bonds;
use crate::parser::ParsedStructure;
use crate::trajectory::{ScalarChannel, ScalarFrame};

// ── Atom style ────────────────────────────────────────────────────────────

/// Detected atom_style for the Atoms section.
#[derive(Debug, Clone, Copy, PartialEq)]
enum AtomStyle {
    /// atom_id type x y z
    Atomic,
    /// atom_id type charge x y z
    Charge,
    /// atom_id mol_id type charge x y z
    Full,
}

/// Try to detect atom style from the comment after `Atoms` keyword.
/// e.g. `Atoms # full` → Some(Full)
fn parse_style_hint(line: &str) -> Option<AtomStyle> {
    let hash_pos = line.find('#')?;
    let hint = line[hash_pos + 1..].trim().to_lowercase();
    match hint.as_str() {
        "atomic" => Some(AtomStyle::Atomic),
        "charge" => Some(AtomStyle::Charge),
        "full" | "real" => Some(AtomStyle::Full),
        _ => None,
    }
}

/// Detect atom style from number of whitespace-separated fields.
fn detect_style_from_fields(n_fields: usize) -> Option<AtomStyle> {
    match n_fields {
        5 => Some(AtomStyle::Atomic),
        6 => Some(AtomStyle::Charge),
        7.. => Some(AtomStyle::Full),
        _ => None,
    }
}

// ── Header ────────────────────────────────────────────────────────────────

/// Parsed data from the header and section-start scan of a LAMMPS data file.
struct HeaderData {
    n_atoms: usize,
    has_box: bool,
    xlo: f32,
    xhi: f32,
    ylo: f32,
    yhi: f32,
    zlo: f32,
    zhi: f32,
    xy: f32,
    xz: f32,
    yz: f32,
    has_tilt: bool,
    masses_start: Option<usize>,
    atoms_start: Option<usize>,
    atoms_style_hint: Option<AtomStyle>,
    bonds_start: Option<usize>,
}

/// Scan all lines once to collect header counts, box bounds, and section positions.
fn parse_header(lines: &[&str]) -> HeaderData {
    let mut hd = HeaderData {
        n_atoms: 0,
        has_box: false,
        xlo: 0.0,
        xhi: 0.0,
        ylo: 0.0,
        yhi: 0.0,
        zlo: 0.0,
        zhi: 0.0,
        xy: 0.0,
        xz: 0.0,
        yz: 0.0,
        has_tilt: false,
        masses_start: None,
        atoms_start: None,
        atoms_style_hint: None,
        bonds_start: None,
    };

    let mut tokens: Vec<&str> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        tokens.clear();
        tokens.extend(trimmed.split_whitespace());

        // "N atoms" header line
        if tokens.len() == 2 && tokens[1] == "atoms" {
            if let Ok(n) = tokens[0].parse::<usize>() {
                hd.n_atoms = n;
            }
        }

        // Box bounds: "lo hi xlo xhi"
        if tokens.len() >= 4 {
            match (tokens[2], tokens[3]) {
                ("xlo", "xhi") => {
                    hd.xlo = tokens[0].parse().unwrap_or(0.0);
                    hd.xhi = tokens[1].parse().unwrap_or(0.0);
                    hd.has_box = true;
                }
                ("ylo", "yhi") => {
                    hd.ylo = tokens[0].parse().unwrap_or(0.0);
                    hd.yhi = tokens[1].parse().unwrap_or(0.0);
                }
                ("zlo", "zhi") => {
                    hd.zlo = tokens[0].parse().unwrap_or(0.0);
                    hd.zhi = tokens[1].parse().unwrap_or(0.0);
                }
                _ => {}
            }
        }

        // Tilt factors: "<xy> <xz> <yz> xy xz yz"
        if tokens.len() >= 6 && tokens[3] == "xy" && tokens[4] == "xz" && tokens[5] == "yz" {
            hd.xy = tokens[0].parse().unwrap_or(0.0);
            hd.xz = tokens[1].parse().unwrap_or(0.0);
            hd.yz = tokens[2].parse().unwrap_or(0.0);
            hd.has_tilt = true;
        }

        // Section headers
        if trimmed == "Masses" || trimmed.starts_with("Masses ") {
            hd.masses_start = Some(i);
        }
        if trimmed == "Atoms" || trimmed.starts_with("Atoms ") {
            hd.atoms_start = Some(i);
            hd.atoms_style_hint = parse_style_hint(trimmed);
        }
        if trimmed == "Bonds" || trimmed.starts_with("Bonds ") {
            hd.bonds_start = Some(i);
        }
    }

    hd
}

// ── Masses section ────────────────────────────────────────────────────────

/// Parse the Masses section and return a map from type_id → mass.
fn parse_masses_section(lines: &[&str], start: usize) -> HashMap<u32, f32> {
    let mut type_to_mass: HashMap<u32, f32> = HashMap::new();
    let mut tokens: Vec<&str> = Vec::new();

    for line in lines.iter().skip(start + 1) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        tokens.clear();
        tokens.extend(trimmed.split_whitespace());
        if tokens.is_empty() {
            continue;
        }
        let type_id: u32 = match tokens[0].parse() {
            Ok(id) => id,
            Err(_) => break, // reached next section header
        };
        if tokens.len() >= 2 {
            if let Ok(mass) = tokens[1].parse::<f32>() {
                type_to_mass.insert(type_id, mass);
            }
        }
    }

    type_to_mass
}

// ── Atom ID → index map ─────────────────────────────────────────────────────

/// Sentinel marking an empty slot in the dense atom-ID table.
const ID_SENTINEL: u32 = u32::MAX;

/// Maps LAMMPS 1-based atom IDs to 0-based atom indices.
///
/// The common case — atom IDs spanning `1..=n_atoms` — is served by a dense
/// `Vec` lookup (no hashing). IDs outside that range fall back to a `HashMap`,
/// so behaviour is identical to a plain `HashMap<u32, usize>` while avoiding
/// per-atom hashing for typical files.
struct IdToIndex {
    /// `table[id] == ID_SENTINEL` means "not present"; otherwise the index.
    table: Vec<u32>,
    overflow: HashMap<u32, usize>,
}

impl IdToIndex {
    fn with_capacity(n_atoms: usize) -> Self {
        Self {
            table: vec![ID_SENTINEL; n_atoms + 1],
            overflow: HashMap::new(),
        }
    }

    fn insert(&mut self, id: u32, index: usize) {
        if (id as usize) < self.table.len() {
            self.table[id as usize] = index as u32;
        } else {
            self.overflow.insert(id, index);
        }
    }

    fn get(&self, id: u32) -> Option<usize> {
        if (id as usize) < self.table.len() {
            let v = self.table[id as usize];
            if v != ID_SENTINEL {
                return Some(v as usize);
            }
        }
        self.overflow.get(&id).copied()
    }
}

// ── Atoms section ─────────────────────────────────────────────────────────

/// Data extracted from the Atoms section.
struct AtomsData {
    positions: Vec<f32>,
    elements: Vec<u8>,
    labels: Vec<String>,
    /// Maps LAMMPS 1-based atom IDs to 0-based indices.
    id_to_index: IdToIndex,
    count: usize,
    /// Per-atom charge, present for atom_style charge/full.
    charges: Option<Vec<f32>>,
    /// Per-atom molecule ID, present for atom_style full.
    mol_ids: Option<Vec<f32>>,
}

/// Parse the Atoms section.
///
/// `atoms_line` is the line index of the "Atoms" header.
fn parse_atoms_section(
    lines: &[&str],
    atoms_line: usize,
    style_hint: Option<AtomStyle>,
    type_to_mass: &HashMap<u32, f32>,
    n_atoms: usize,
) -> Result<AtomsData, String> {
    // Skip blank lines after the "Atoms" header
    let mut data_start = atoms_line + 1;
    while data_start < lines.len() && lines[data_start].trim().is_empty() {
        data_start += 1;
    }

    // Resolve atom style: use hint if present, else detect from first data line
    let style = if let Some(hint) = style_hint {
        hint
    } else if data_start < lines.len() {
        let field_count = lines[data_start].split_whitespace().count();
        detect_style_from_fields(field_count)
            .ok_or("Cannot detect atom_style: unexpected number of fields")?
    } else {
        return Err("Atoms section is empty".into());
    };

    let mut positions = Vec::with_capacity(n_atoms * 3);
    let mut elements = Vec::with_capacity(n_atoms);
    let mut labels = Vec::with_capacity(n_atoms);
    let mut id_to_index = IdToIndex::with_capacity(n_atoms);
    let mut count = 0usize;
    let mut tokens: Vec<&str> = Vec::new();
    // Per-atom columns the style carries beyond position/type.
    let mut charges: Option<Vec<f32>> = match style {
        AtomStyle::Charge | AtomStyle::Full => Some(Vec::with_capacity(n_atoms)),
        AtomStyle::Atomic => None,
    };
    let mut mol_ids: Option<Vec<f32>> = match style {
        AtomStyle::Full => Some(Vec::with_capacity(n_atoms)),
        _ => None,
    };

    for line in lines.iter().skip(data_start) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        tokens.clear();
        tokens.extend(trimmed.split_whitespace());
        if tokens.is_empty() {
            continue;
        }
        // Non-numeric first token signals a new section header
        if tokens[0].parse::<u32>().is_err() {
            break;
        }

        let (atom_id, type_id, x, y, z) = match style {
            AtomStyle::Atomic => {
                // atom_id type x y z
                if tokens.len() < 5 {
                    continue;
                }
                let aid: u32 = tokens[0].parse().map_err(|_| "bad atom_id")?;
                let tid: u32 = tokens[1].parse().map_err(|_| "bad type")?;
                let x: f32 = tokens[2].parse().map_err(|_| "bad x")?;
                let y: f32 = tokens[3].parse().map_err(|_| "bad y")?;
                let z: f32 = tokens[4].parse().map_err(|_| "bad z")?;
                (aid, tid, x, y, z)
            }
            AtomStyle::Charge => {
                // atom_id type charge x y z
                if tokens.len() < 6 {
                    continue;
                }
                let aid: u32 = tokens[0].parse().map_err(|_| "bad atom_id")?;
                let tid: u32 = tokens[1].parse().map_err(|_| "bad type")?;
                let q: f32 = tokens[2].parse().map_err(|_| "bad charge")?;
                let x: f32 = tokens[3].parse().map_err(|_| "bad x")?;
                let y: f32 = tokens[4].parse().map_err(|_| "bad y")?;
                let z: f32 = tokens[5].parse().map_err(|_| "bad z")?;
                if let Some(qs) = charges.as_mut() {
                    qs.push(q);
                }
                (aid, tid, x, y, z)
            }
            AtomStyle::Full => {
                // atom_id mol_id type charge x y z
                if tokens.len() < 7 {
                    continue;
                }
                let aid: u32 = tokens[0].parse().map_err(|_| "bad atom_id")?;
                let mid: f32 = tokens[1].parse().map_err(|_| "bad mol_id")?;
                let tid: u32 = tokens[2].parse().map_err(|_| "bad type")?;
                let q: f32 = tokens[3].parse().map_err(|_| "bad charge")?;
                let x: f32 = tokens[4].parse().map_err(|_| "bad x")?;
                let y: f32 = tokens[5].parse().map_err(|_| "bad y")?;
                let z: f32 = tokens[6].parse().map_err(|_| "bad z")?;
                if let Some(ms) = mol_ids.as_mut() {
                    ms.push(mid);
                }
                if let Some(qs) = charges.as_mut() {
                    qs.push(q);
                }
                (aid, tid, x, y, z)
            }
        };

        id_to_index.insert(atom_id, count);
        count += 1;

        positions.push(x);
        positions.push(y);
        positions.push(z);

        let elem = type_to_mass
            .get(&type_id)
            .map(|&m| mass_to_atomic_num(m))
            .unwrap_or(0);
        elements.push(elem);
        labels.push(format!("{}", type_id));
    }

    Ok(AtomsData {
        positions,
        elements,
        labels,
        id_to_index,
        count,
        charges,
        mol_ids,
    })
}

// ── Bonds section ─────────────────────────────────────────────────────────

/// Unique file bonds (0-based index pairs) paired with their deduplication set.
type FileBonds = (Vec<(u32, u32)>, HashSet<(u32, u32)>);

/// Parse the Bonds section and return unique (a, b) index pairs (0-based)
/// together with the deduplication set, so callers can reuse it for bond
/// inference without rebuilding it.
fn parse_bonds_section(lines: &[&str], start: usize, id_to_index: &IdToIndex) -> FileBonds {
    let mut file_bonds: Vec<(u32, u32)> = Vec::new();
    let mut bond_set: HashSet<(u32, u32)> = HashSet::new();
    let mut tokens: Vec<&str> = Vec::new();

    let mut bond_data_start = start + 1;
    while bond_data_start < lines.len() && lines[bond_data_start].trim().is_empty() {
        bond_data_start += 1;
    }

    for line in lines.iter().skip(bond_data_start) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        tokens.clear();
        tokens.extend(trimmed.split_whitespace());
        if tokens.is_empty() {
            continue;
        }
        if tokens[0].parse::<u32>().is_err() {
            break; // reached next section header
        }
        // bond_id bond_type atom_i atom_j
        if tokens.len() < 4 {
            continue;
        }
        let ai: u32 = match tokens[2].parse() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let aj: u32 = match tokens[3].parse() {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Convert from LAMMPS 1-based IDs to 0-based indices
        let idx_i = match id_to_index.get(ai) {
            Some(idx) => idx as u32,
            None => continue,
        };
        let idx_j = match id_to_index.get(aj) {
            Some(idx) => idx as u32,
            None => continue,
        };
        let a = idx_i.min(idx_j);
        let b = idx_i.max(idx_j);
        if bond_set.insert((a, b)) {
            file_bonds.push((a, b));
        }
    }

    (file_bonds, bond_set)
}

// ── Public API ────────────────────────────────────────────────────────────

pub fn parse(text: &str) -> Result<ParsedStructure, String> {
    let lines: Vec<&str> = text.lines().collect();

    let hd = parse_header(&lines);

    if hd.n_atoms == 0 {
        return Err("LAMMPS data file contains no atoms".into());
    }
    let atoms_line = hd
        .atoms_start
        .ok_or("No Atoms section found in LAMMPS data file")?;

    let type_to_mass = hd
        .masses_start
        .map(|s| parse_masses_section(&lines, s))
        .unwrap_or_default();

    let atoms = parse_atoms_section(
        &lines,
        atoms_line,
        hd.atoms_style_hint,
        &type_to_mass,
        hd.n_atoms,
    )?;

    if atoms.count == 0 {
        return Err("No atoms parsed from Atoms section".into());
    }

    let (mut file_bonds, bond_set) = hd
        .bonds_start
        .map(|s| parse_bonds_section(&lines, s, &atoms.id_to_index))
        .unwrap_or_default();

    let n_file_bonds = file_bonds.len();
    let inferred = bonds::infer_bonds(&atoms.positions, &atoms.elements, atoms.count, &bond_set);
    if n_file_bonds > 0 {
        // The file declares its own topology, so distance inference may only
        // connect atoms the file left unbonded (e.g. free ions in a solvated
        // system) — never add guessed bonds onto file-bonded atoms.
        let mut has_file_bond = vec![false; atoms.count];
        for &(a, b) in &file_bonds {
            has_file_bond[a as usize] = true;
            has_file_bond[b as usize] = true;
        }
        file_bonds.extend(
            inferred
                .into_iter()
                .filter(|&(a, b)| !has_file_bond[a as usize] && !has_file_bond[b as usize]),
        );
    } else {
        file_bonds.extend(inferred);
    }

    let box_matrix = if hd.has_box {
        let lx = hd.xhi - hd.xlo;
        let ly = hd.yhi - hd.ylo;
        let lz = hd.zhi - hd.zlo;
        if hd.has_tilt {
            Some([lx, 0.0, 0.0, hd.xy, ly, 0.0, hd.xz, hd.yz, lz])
        } else {
            Some([lx, 0.0, 0.0, 0.0, ly, 0.0, 0.0, 0.0, lz])
        }
    } else {
        None
    };

    // Preserve the box origin (lower corner) so the cell is drawn at its true
    // world-space location. LAMMPS atom coords are absolute, so without this the
    // wireframe cell (anchored at 0,0,0) would sit far from an offset structure.
    let box_origin = if hd.has_box {
        Some([hd.xlo, hd.ylo, hd.zlo])
    } else {
        None
    };

    let atom_labels = if atoms.labels.iter().any(|l| !l.is_empty()) {
        Some(atoms.labels)
    } else {
        None
    };

    // Per-atom columns the style carries beyond geometry are kept as static
    // scalar channels so the data is not silently discarded.
    let mut scalar_channels = Vec::new();
    if let Some(values) = atoms.charges {
        scalar_channels.push(ScalarChannel {
            name: "charge".into(),
            frames: vec![ScalarFrame { frame: 0, values }],
        });
    }
    if let Some(values) = atoms.mol_ids {
        scalar_channels.push(ScalarChannel {
            name: "mol_id".into(),
            frames: vec![ScalarFrame { frame: 0, values }],
        });
    }

    Ok(ParsedStructure {
        n_atoms: atoms.count,
        positions: atoms.positions,
        elements: atoms.elements,
        bonds: file_bonds,
        n_file_bonds,
        bond_orders: None,
        box_matrix,
        box_origin,
        frame_positions_flat: Vec::new(),
        atom_labels,
        chain_ids: None,
        bfactors: None,
        vector_channels: vec![],
        ca_indices: vec![],
        ca_chain_ids: vec![],
        ca_res_nums: vec![],
        ca_ss_type: vec![],
        symmetry_ops: Vec::new(),
        scalar_channels,
        warnings: Vec::new(),
        hetero: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_style_hint() {
        assert_eq!(parse_style_hint("Atoms # atomic"), Some(AtomStyle::Atomic));
        assert_eq!(parse_style_hint("Atoms # charge"), Some(AtomStyle::Charge));
        assert_eq!(parse_style_hint("Atoms # full"), Some(AtomStyle::Full));
        assert_eq!(parse_style_hint("Atoms # real"), Some(AtomStyle::Full));
        assert_eq!(parse_style_hint("Atoms"), None);
    }

    #[test]
    fn test_detect_style_from_fields() {
        assert_eq!(detect_style_from_fields(5), Some(AtomStyle::Atomic));
        assert_eq!(detect_style_from_fields(6), Some(AtomStyle::Charge));
        assert_eq!(detect_style_from_fields(7), Some(AtomStyle::Full));
        assert_eq!(detect_style_from_fields(10), Some(AtomStyle::Full));
        assert_eq!(detect_style_from_fields(3), None);
    }

    #[test]
    fn test_parse_atomic_style() {
        let data = "\
LAMMPS data file

3 atoms
1 atom types

0.0 10.0 xlo xhi
0.0 10.0 ylo yhi
0.0 10.0 zlo zhi

Masses

1 12.011

Atoms # atomic

1 1 1.0 2.0 3.0
2 1 4.0 5.0 6.0
3 1 7.0 8.0 9.0
";
        let result = parse(data).expect("parse failed");
        assert_eq!(result.n_atoms, 3);
        assert_eq!(result.elements[0], 6); // C
        assert!((result.positions[0] - 1.0).abs() < 1e-5);
        assert!((result.positions[1] - 2.0).abs() < 1e-5);
        assert!((result.positions[2] - 3.0).abs() < 1e-5);
        let bm = result.box_matrix.unwrap();
        assert!((bm[0] - 10.0).abs() < 1e-5);
        assert!((bm[4] - 10.0).abs() < 1e-5);
        assert!((bm[8] - 10.0).abs() < 1e-5);
        // Origin at the world origin for a 0-based box.
        assert_eq!(result.box_origin, Some([0.0, 0.0, 0.0]));
    }

    #[test]
    fn test_parse_offset_box_origin() {
        // A box offset far from the origin (as in a confined/slab simulation):
        // the origin (lo corner) must be preserved so the cell is drawn around
        // the atoms, while box_matrix keeps only the edge lengths.
        let data = "\
LAMMPS data file

2 atoms
1 atom types

160.0 240.0 xlo xhi
0.0 150.0 ylo yhi
600.0 900.0 zlo zhi

Masses

1 12.011

Atoms # atomic

1 1 165.0 10.0 605.0
2 1 200.0 75.0 750.0
";
        let result = parse(data).expect("parse failed");
        // Origin is the lower corner (xlo, ylo, zlo).
        assert_eq!(result.box_origin, Some([160.0, 0.0, 600.0]));
        // box_matrix carries edge lengths only (xhi-xlo, yhi-ylo, zhi-zlo).
        let bm = result.box_matrix.unwrap();
        assert!((bm[0] - 80.0).abs() < 1e-5);
        assert!((bm[4] - 150.0).abs() < 1e-5);
        assert!((bm[8] - 300.0).abs() < 1e-5);
        // Atom coordinates stay absolute (unshifted).
        assert!((result.positions[0] - 165.0).abs() < 1e-5);
        assert!((result.positions[5] - 750.0).abs() < 1e-5);
    }

    #[test]
    fn test_no_box_has_no_origin() {
        let data = "\
LAMMPS data file

1 atoms
1 atom types

Masses

1 12.011

Atoms # atomic

1 1 1.0 2.0 3.0
";
        let result = parse(data).expect("parse failed");
        assert_eq!(result.box_matrix, None);
        assert_eq!(result.box_origin, None);
    }

    #[test]
    fn test_parse_charge_style() {
        let data = "\
LAMMPS data file

2 atoms
2 atom types

0.0 5.0 xlo xhi
0.0 5.0 ylo yhi
0.0 5.0 zlo zhi

Masses

1 15.999
2 1.008

Atoms # charge

1 1 -0.8476 2.5 2.5 2.5
2 2 0.4238 3.0 2.5 2.5
";
        let result = parse(data).expect("parse failed");
        assert_eq!(result.n_atoms, 2);
        assert_eq!(result.elements[0], 8); // O
        assert_eq!(result.elements[1], 1); // H
        assert!((result.positions[0] - 2.5).abs() < 1e-5);
    }

    #[test]
    fn test_parse_full_style() {
        let data = "\
LAMMPS data file

2 atoms
2 atom types
1 bonds
1 bond types

0.0 20.0 xlo xhi
0.0 20.0 ylo yhi
0.0 20.0 zlo zhi

Masses

1 15.999
2 1.008

Atoms # full

1 1 1 -0.8476 10.0 10.0 10.0
2 1 2 0.4238 10.757 10.587 10.0

Bonds

1 1 1 2
";
        let result = parse(data).expect("parse failed");
        assert_eq!(result.n_atoms, 2);
        assert_eq!(result.elements[0], 8); // O
        assert_eq!(result.elements[1], 1); // H
        assert_eq!(result.n_file_bonds, 1);
        assert!(result.bonds.contains(&(0, 1)));
    }

    #[test]
    fn test_parse_auto_detect_atomic() {
        let data = "\
LAMMPS data file

2 atoms
1 atom types

0.0 10.0 xlo xhi
0.0 10.0 ylo yhi
0.0 10.0 zlo zhi

Masses

1 26.982

Atoms

1 1 0.0 0.0 0.0
2 1 2.5 2.5 2.5
";
        let result = parse(data).expect("parse failed");
        assert_eq!(result.n_atoms, 2);
        assert_eq!(result.elements[0], 13); // Al
    }

    #[test]
    fn test_parse_triclinic() {
        let data = "\
LAMMPS data file

1 atoms
1 atom types

0.0 10.0 xlo xhi
0.0 10.0 ylo yhi
0.0 10.0 zlo zhi
1.0 0.5 0.0 xy xz yz

Masses

1 12.011

Atoms # atomic

1 1 5.0 5.0 5.0
";
        let result = parse(data).expect("parse failed");
        let bm = result.box_matrix.unwrap();
        assert!((bm[0] - 10.0).abs() < 1e-5); // lx
        assert!((bm[3] - 1.0).abs() < 1e-5); // xy
        assert!((bm[4] - 10.0).abs() < 1e-5); // ly
        assert!((bm[6] - 0.5).abs() < 1e-5); // xz
        assert!((bm[7] - 0.0).abs() < 1e-5); // yz
        assert!((bm[8] - 10.0).abs() < 1e-5); // lz
    }

    #[test]
    fn test_parse_no_atoms_error() {
        let data = "LAMMPS data file\n\n0 atoms\n";
        assert!(parse(data).is_err());
    }

    #[test]
    fn test_parse_no_atoms_section_error() {
        let data = "\
LAMMPS data file

2 atoms
1 atom types

0.0 10.0 xlo xhi
0.0 10.0 ylo yhi
0.0 10.0 zlo zhi
";
        assert!(parse(data).is_err());
    }

    #[test]
    fn test_parse_fixture() {
        let text = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/water.lammps"
        ));
        // Skip test if fixture doesn't exist
        if text.is_err() {
            return;
        }
        let result = parse(&text.unwrap()).expect("parse failed");
        assert!(result.n_atoms > 0);
    }

    #[test]
    fn test_inference_restricted_to_unbonded_atoms() {
        // A water molecule with file bonds O-H1/O-H2 whose hydrogens sit at
        // bonding distance from each other, plus a free Na/Cl ion pair at
        // bonding distance. Inference must connect the ions (the file leaves
        // them unbonded) but must NOT add the H-H bond on top of the file
        // topology.
        let data = "\
LAMMPS data file

5 atoms
4 atom types
2 bonds
1 bond types

0.0 20.0 xlo xhi
0.0 20.0 ylo yhi
0.0 20.0 zlo zhi

Masses

1 15.999
2 1.008
3 22.990
4 35.453

Atoms # full

1 1 1 -0.8476 5.0 5.0 5.0
2 1 2 0.4238 5.6 5.35 5.0
3 1 2 0.4238 5.6 4.65 5.0
4 2 3 1.0 12.0 12.0 12.0
5 2 4 -1.0 12.0 12.0 14.4

Bonds

1 1 1 2
2 1 1 3
";
        let result = parse(data).expect("parse failed");
        assert_eq!(result.n_file_bonds, 2);
        // Na-Cl inferred among atoms with zero file bonds.
        assert!(result.bonds.contains(&(3, 4)));
        // H-H (0.7 Å apart, within threshold) must not be inferred on top of
        // the file-declared topology.
        assert!(!result.bonds.contains(&(1, 2)));
        assert_eq!(result.bonds.len(), 3);
    }

    #[test]
    fn test_inference_unrestricted_without_bonds_section() {
        // Without a Bonds section, distance inference covers all atoms.
        let data = "\
LAMMPS data file

2 atoms
2 atom types

0.0 5.0 xlo xhi
0.0 5.0 ylo yhi
0.0 5.0 zlo zhi

Masses

1 15.999
2 1.008

Atoms # charge

1 1 -0.8476 2.5 2.5 2.5
2 2 0.4238 3.0 2.5 2.5
";
        let result = parse(data).expect("parse failed");
        assert_eq!(result.n_file_bonds, 0);
        assert_eq!(result.bonds, vec![(0, 1)]);
    }

    #[test]
    fn test_charge_style_scalar_channel() {
        let data = "\
LAMMPS data file

2 atoms
2 atom types

0.0 5.0 xlo xhi
0.0 5.0 ylo yhi
0.0 5.0 zlo zhi

Masses

1 15.999
2 1.008

Atoms # charge

1 1 -0.8476 2.5 2.5 2.5
2 2 0.4238 3.0 2.5 2.5
";
        let result = parse(data).expect("parse failed");
        assert_eq!(result.scalar_channels.len(), 1);
        let charge = &result.scalar_channels[0];
        assert_eq!(charge.name, "charge");
        assert_eq!(charge.frames.len(), 1);
        assert_eq!(charge.frames[0].frame, 0);
        assert!((charge.frames[0].values[0] - (-0.8476)).abs() < 1e-5);
        assert!((charge.frames[0].values[1] - 0.4238).abs() < 1e-5);
    }

    #[test]
    fn test_full_style_scalar_channels() {
        let data = "\
LAMMPS data file

2 atoms
2 atom types

0.0 20.0 xlo xhi
0.0 20.0 ylo yhi
0.0 20.0 zlo zhi

Masses

1 15.999
2 1.008

Atoms # full

1 3 1 -0.8476 10.0 10.0 10.0
2 7 2 0.4238 10.757 10.587 10.0
";
        let result = parse(data).expect("parse failed");
        assert_eq!(result.scalar_channels.len(), 2);
        let charge = &result.scalar_channels[0];
        assert_eq!(charge.name, "charge");
        assert!((charge.frames[0].values[0] - (-0.8476)).abs() < 1e-5);
        let mol_id = &result.scalar_channels[1];
        assert_eq!(mol_id.name, "mol_id");
        assert_eq!(mol_id.frames[0].values, vec![3.0, 7.0]);
    }

    #[test]
    fn test_atomic_style_has_no_scalar_channels() {
        let data = "\
LAMMPS data file

1 atoms
1 atom types

Masses

1 12.011

Atoms # atomic

1 1 1.0 2.0 3.0
";
        let result = parse(data).expect("parse failed");
        assert!(result.scalar_channels.is_empty());
    }

    #[test]
    fn test_fixture_bond_counts() {
        // water.lammps: 2 file bonds, no extra inferred bonds (its H atoms sit
        // 1.514 Å apart, beyond the H-H threshold). confined_offset.data: no
        // Bonds section and grid spacing far beyond any C-C threshold.
        let water = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/water.lammps"
        ));
        if let Ok(text) = water {
            let result = parse(&text).expect("parse failed");
            assert_eq!(result.n_file_bonds, 2);
            assert_eq!(result.bonds.len(), 2);
            // atom_style full carries charge and mol_id.
            assert_eq!(result.scalar_channels.len(), 2);
        }
        let confined = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/confined_offset.data"
        ));
        if let Ok(text) = confined {
            let result = parse(&text).expect("parse failed");
            assert_eq!(result.n_atoms, 64);
            assert_eq!(result.n_file_bonds, 0);
            assert_eq!(result.bonds.len(), 0);
        }
    }

    #[test]
    fn test_id_to_index_dense_and_overflow() {
        let mut map = IdToIndex::with_capacity(3);
        // Dense path: ids within 1..=n_atoms.
        map.insert(1, 0);
        map.insert(3, 2);
        // Overflow path: id outside the dense table range.
        map.insert(100, 5);

        assert_eq!(map.get(1), Some(0));
        assert_eq!(map.get(3), Some(2));
        assert_eq!(map.get(100), Some(5));
        // Unset dense slot and unknown id both return None.
        assert_eq!(map.get(2), None);
        assert_eq!(map.get(7), None);
    }

    #[test]
    fn test_parse_sparse_atom_ids() {
        // Non-contiguous atom IDs (10, 25) exercise the overflow HashMap path
        // while still producing identical 0-based bond indices.
        let data = "\
LAMMPS data file

2 atoms
2 atom types
1 bonds
1 bond types

0.0 20.0 xlo xhi
0.0 20.0 ylo yhi
0.0 20.0 zlo zhi

Masses

1 15.999
2 1.008

Atoms # full

10 1 1 -0.8476 10.0 10.0 10.0
25 1 2 0.4238 10.757 10.587 10.0

Bonds

1 1 10 25
";
        let result = parse(data).expect("parse failed");
        assert_eq!(result.n_atoms, 2);
        assert_eq!(result.n_file_bonds, 1);
        assert!(result.bonds.contains(&(0, 1)));
    }
}
