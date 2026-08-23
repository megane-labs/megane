/// PSF (CHARMM/NAMD protein structure file) topology parser.
///
/// Parses the ATOM and BOND sections from standard and extended (EXT) PSF files.
/// PSF carries no coordinate data; positions are zeroed in the returned structure.
/// Use together with a DCD or XTC trajectory to supply per-frame coordinates.
///
/// Supported variants: standard PSF, extended PSF (PSF EXT), XPLOR PSF.
/// Unsupported sections (NTHETA, NPHI, NIMPHI, NDON, NACC, NNB, NGRP, NCRTERM)
/// are silently skipped.
use crate::atomic::{mass_to_atomic_num, symbol_to_atomic_num};
use crate::parser::ParsedStructure;
use std::collections::HashSet;

struct PsfAtom {
    segment: String,
    res_id: u32,
    res_name: String,
    element: u8,
}

/// Derive element from a CHARMM atom name.
/// Strips leading digits then takes the first character as a single-letter symbol.
fn element_from_atom_name(name: &str) -> u8 {
    let s = name.trim_start_matches(|c: char| c.is_ascii_digit());
    let sym: String = s
        .chars()
        .next()
        .map(|c| c.to_ascii_uppercase().to_string())
        .unwrap_or_default();
    symbol_to_atomic_num(&sym)
}

/// Parse a PSF ATOM section line (whitespace-split; handles both standard and EXT widths).
///
/// Expected fields (1-indexed): serial segid resid resname atomname atomtype charge mass …
fn parse_atom_line(line: &str) -> Option<PsfAtom> {
    let mut parts = line.split_whitespace();
    let _serial: u32 = parts.next()?.parse().ok()?;
    let segment = parts.next()?.to_string();
    let res_id: u32 = parts.next()?.parse().ok()?;
    let res_name = parts.next()?.to_string();
    let atom_name = parts.next()?.to_string();
    let _atom_type = parts.next();
    let _charge = parts.next();
    let mass: Option<f32> = parts.next().and_then(|s| s.parse().ok());
    // The mass column is the most authoritative element field a PSF carries
    // (atom names like "CL"/"FE"/"ZN" are ambiguous under first-letter
    // guessing). Fall back to the atom-name guess only when the mass is
    // missing, non-positive, or matches no known element.
    let element = mass
        .filter(|&m| m > 0.0)
        .map(mass_to_atomic_num)
        .filter(|&z| z != 0)
        .unwrap_or_else(|| element_from_atom_name(&atom_name));
    Some(PsfAtom {
        segment,
        res_id,
        res_name,
        element,
    })
}

/// Flush the accumulated bond integer buffer into bond pairs.
fn flush_bonds(values: &[u32], expected: usize, bonds: &mut Vec<(u32, u32)>) {
    for chunk in values.chunks(2) {
        if bonds.len() >= expected {
            break;
        }
        if chunk.len() == 2 {
            // PSF is 1-indexed; convert to 0-indexed.
            let a = chunk[0].saturating_sub(1);
            let b = chunk[1].saturating_sub(1);
            let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
            bonds.push((lo, hi));
        }
    }
}

/// Parse a PSF file and return a [`ParsedStructure`].
///
/// Positions are zeroed because PSF carries no coordinate data.
/// Bonds are returned from the ATOM 1-indexed NBOND section, converted to 0-indexed pairs.
pub fn parse_psf(text: &str) -> Result<ParsedStructure, String> {
    let mut lines = text.lines();

    let first = lines.next().ok_or("empty PSF file")?;
    if !first.trim_start().starts_with("PSF") {
        return Err(format!("not a PSF file (first line: {:?})", first.trim()));
    }

    let mut atoms: Vec<PsfAtom> = Vec::new();
    let mut bonds: Vec<(u32, u32)> = Vec::new();

    // Current section state.
    let mut section = "";
    let mut atoms_remaining: i64 = 0;
    let mut bond_values: Vec<u32> = Vec::new();
    let mut bonds_expected: usize = 0;

    for line in lines {
        let trimmed = line.trim();

        // Section header lines contain '!'.
        if let Some(bang) = trimmed.find('!') {
            // Leaving NBOND section: flush collected integers.
            if section == "bond" {
                flush_bonds(&bond_values, bonds_expected, &mut bonds);
                bond_values.clear();
            }

            let kw = trimmed[bang + 1..]
                .split_whitespace()
                .next()
                .unwrap_or("")
                .trim_end_matches(':');
            let count: i64 = trimmed[..bang].trim().parse().unwrap_or(0);

            section = match kw {
                "NTITLE" => {
                    atoms_remaining = count;
                    "title"
                }
                "NATOM" => {
                    atoms_remaining = count;
                    "atom"
                }
                "NBOND" => {
                    bonds_expected = count as usize;
                    bond_values.clear();
                    "bond"
                }
                _ => "skip",
            };
            continue;
        }

        if trimmed.is_empty() {
            continue;
        }

        match section {
            "atom" if atoms_remaining > 0 => {
                if let Some(atom) = parse_atom_line(line) {
                    atoms.push(atom);
                    atoms_remaining -= 1;
                }
            }
            "bond" => {
                for tok in trimmed.split_whitespace() {
                    if let Ok(v) = tok.parse::<u32>() {
                        bond_values.push(v);
                    }
                }
            }
            "title" if atoms_remaining > 0 => {
                atoms_remaining -= 1;
            }
            _ => {}
        }
    }

    // Flush any remaining bond values at EOF.
    if section == "bond" {
        flush_bonds(&bond_values, bonds_expected, &mut bonds);
    }

    if atoms.is_empty() {
        return Err("PSF file contains no atoms".into());
    }

    let n_atoms = atoms.len();

    // PSF carries no coordinates; use zeros so the structure can be loaded
    // and combined with a DCD/XTC trajectory.
    let positions = vec![0.0f32; n_atoms * 3];
    let elements: Vec<u8> = atoms.iter().map(|a| a.element).collect();

    // Atom labels: residue name + residue ID (e.g. "ALA1").
    let atom_labels: Vec<String> = atoms
        .iter()
        .map(|a| format!("{}{}", a.res_name, a.res_id))
        .collect();

    // Chain IDs: first byte of segment name.
    let chain_ids: Vec<u8> = atoms
        .iter()
        .map(|a| a.segment.bytes().next().unwrap_or(b' '))
        .collect();

    // Deduplicate and validate bonds.
    let mut bond_set: HashSet<(u32, u32)> = HashSet::new();
    let mut unique_bonds: Vec<(u32, u32)> = Vec::new();
    for bond in bonds {
        if (bond.0 as usize) < n_atoms && (bond.1 as usize) < n_atoms && bond_set.insert(bond) {
            unique_bonds.push(bond);
        }
    }
    let n_file_bonds = unique_bonds.len();

    let has_chain = chain_ids.iter().any(|&c| c != b' ' && c != 0);

    Ok(ParsedStructure {
        n_atoms,
        positions,
        elements,
        bonds: unique_bonds,
        n_file_bonds,
        bond_orders: None,
        box_matrix: None,
        box_origin: None,
        frame_positions_flat: Vec::new(),
        atom_labels: Some(atom_labels),
        chain_ids: if has_chain { Some(chain_ids) } else { None },
        bfactors: None,
        vector_channels: vec![],
        ca_indices: Vec::new(),
        ca_chain_ids: Vec::new(),
        ca_res_nums: Vec::new(),
        ca_ss_type: Vec::new(),
        symmetry_ops: Vec::new(),
        scalar_channels: Vec::new(),
        warnings: Vec::new(),
        hetero: None,
    })
}

/// Extract bond pairs from a PSF topology file, filtered to `n_atoms`.
///
/// Returns 0-indexed bond pairs. Pairs with an atom index ≥ `n_atoms` are
/// dropped (useful when `n_atoms` comes from a separately-loaded coordinate
/// file whose atom count should agree with the PSF).
/// Pass `n_atoms = usize::MAX` to accept all pairs.
pub fn parse_psf_bonds(text: &str, n_atoms: usize) -> Vec<(u32, u32)> {
    parse_psf(text)
        .map(|data| {
            data.bonds
                .into_iter()
                .filter(|(a, b)| (*a as usize) < n_atoms && (*b as usize) < n_atoms)
                .collect()
        })
        .unwrap_or_default()
}

// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const WATER_PSF: &str = "\
PSF

       1 !NTITLE
 REMARKS water molecule for testing

       3 !NATOM
         1 WAT      1 TIP3 OH2  OT    -0.834000       15.9994           0
         2 WAT      1 TIP3 H1   HT     0.417000        1.0080           0
         3 WAT      1 TIP3 H2   HT     0.417000        1.0080           0

       2 !NBOND: bonds
         1         2         1         3

       0 !NTHETA: angles

       0 !NPHI: dihedrals

       0 !NIMPHI: impropers

       0 !NDON: donors

       0 !NACC: acceptors

       0 !NNB

         0         0         0

       1 !NGRP
         0         0         0
";

    #[test]
    fn test_parse_water_psf_atom_count() {
        let data = parse_psf(WATER_PSF).expect("parse failed");
        assert_eq!(data.n_atoms, 3);
    }

    #[test]
    fn test_parse_water_psf_bonds() {
        let data = parse_psf(WATER_PSF).expect("parse failed");
        assert_eq!(data.n_file_bonds, 2);
        assert!(data.bonds.contains(&(0, 1)));
        assert!(data.bonds.contains(&(0, 2)));
    }

    #[test]
    fn test_parse_water_psf_elements() {
        let data = parse_psf(WATER_PSF).expect("parse failed");
        // OH2 → O (8), H1 → H (1), H2 → H (1)
        assert_eq!(data.elements[0], 8); // O
        assert_eq!(data.elements[1], 1); // H
        assert_eq!(data.elements[2], 1); // H
    }

    #[test]
    fn test_parse_water_psf_positions_zeroed() {
        let data = parse_psf(WATER_PSF).expect("parse failed");
        assert_eq!(data.positions.len(), 9);
        assert!(data.positions.iter().all(|&v| v == 0.0));
    }

    #[test]
    fn test_parse_water_psf_labels() {
        let data = parse_psf(WATER_PSF).expect("parse failed");
        let labels = data.atom_labels.expect("labels should be Some");
        assert_eq!(labels[0], "TIP31");
        assert_eq!(labels[1], "TIP31");
        assert_eq!(labels[2], "TIP31");
    }

    #[test]
    fn test_parse_water_psf_chain_ids() {
        let data = parse_psf(WATER_PSF).expect("parse failed");
        let cids = data.chain_ids.expect("chain_ids should be Some");
        assert!(cids.iter().all(|&c| c == b'W')); // first byte of "WAT"
    }

    #[test]
    fn test_parse_empty_file_errors() {
        assert!(parse_psf("").is_err());
    }

    #[test]
    fn test_parse_bad_magic_errors() {
        let text = "NOTPSF\n       1 !NATOM\n         1 WAT 1 TIP3 O OT -0.8 16.0 0\n";
        assert!(parse_psf(text).is_err());
    }

    #[test]
    fn test_parse_no_atoms_errors() {
        let text = "PSF\n\n       0 !NATOM\n\n       0 !NBOND: bonds\n";
        let err = parse_psf(text).err().expect("should error");
        assert!(err.contains("no atoms"), "got: {err}");
    }

    #[test]
    fn test_parse_psf_zero_bonds() {
        let text = "\
PSF

       1 !NTITLE
 REMARKS no bonds

       2 !NATOM
         1 LIG      1 LIG  C1   CT1   0.000000       12.0110           0
         2 LIG      1 LIG  C2   CT1   0.000000       12.0110           0

       0 !NBOND: bonds

       0 !NTHETA: angles
";
        let data = parse_psf(text).expect("parse failed");
        assert_eq!(data.n_atoms, 2);
        assert_eq!(data.n_file_bonds, 0);
        assert!(data.bonds.is_empty());
    }

    #[test]
    fn test_parse_psf_ext_format() {
        // Extended PSF uses wider column widths but whitespace-split parsing handles both.
        let text = "\
PSF EXT

       1 !NTITLE
 REMARKS extended PSF format

       3 !NATOM
         1 WAT           1 TIP3     OH2       OT        -0.834000       15.9994           0
         2 WAT           1 TIP3     H1        HT         0.417000        1.0080           0
         3 WAT           1 TIP3     H2        HT         0.417000        1.0080           0

       2 !NBOND: bonds
         1         2         1         3

       0 !NTHETA: angles
";
        let data = parse_psf(text).expect("parse EXT PSF failed");
        assert_eq!(data.n_atoms, 3);
        assert_eq!(data.n_file_bonds, 2);
        assert!(data.bonds.contains(&(0, 1)));
        assert!(data.bonds.contains(&(0, 2)));
    }

    #[test]
    fn test_parse_psf_multi_segment() {
        // Two segments → two distinct first-byte chain IDs.
        let text = "\
PSF

       1 !NTITLE
 REMARKS multi-segment

       4 !NATOM
         1 PROA     1 ALA  N    NH1   -0.470000       14.0070           0
         2 PROA     1 ALA  CA   CT1   -0.020000       12.0110           0
         3 PROB     1 GLY  N    NH1   -0.470000       14.0070           0
         4 PROB     1 GLY  CA   CT1   -0.020000       12.0110           0

       2 !NBOND: bonds
         1         2         3         4

       0 !NTHETA: angles
";
        let data = parse_psf(text).expect("parse failed");
        assert_eq!(data.n_atoms, 4);
        let cids = data.chain_ids.expect("chain_ids should be Some");
        assert_eq!(cids[0], b'P'); // first byte of "PROA"
        assert_eq!(cids[2], b'P'); // first byte of "PROB"
        assert_eq!(data.n_file_bonds, 2);
    }

    #[test]
    fn test_parse_psf_bond_deduplication() {
        // Same bond pair listed twice should be stored only once.
        let text = "\
PSF

       1 !NTITLE
 REMARKS dedup test

       2 !NATOM
         1 WAT      1 TIP3 OH2  OT    -0.834000       15.9994           0
         2 WAT      1 TIP3 H1   HT     0.417000        1.0080           0

       2 !NBOND: bonds
         1         2         1         2

       0 !NTHETA: angles
";
        let data = parse_psf(text).expect("parse failed");
        assert_eq!(data.n_file_bonds, 1);
    }

    #[test]
    fn test_parse_psf_bonds_function() {
        let bonds = parse_psf_bonds(WATER_PSF, 3);
        assert_eq!(bonds.len(), 2);
        assert!(bonds.contains(&(0, 1)));
        assert!(bonds.contains(&(0, 2)));
    }

    #[test]
    fn test_parse_psf_bonds_function_filters_by_natoms() {
        // n_atoms = 2 should drop bond involving atom 2 (0-indexed).
        let bonds = parse_psf_bonds(WATER_PSF, 2);
        assert_eq!(bonds.len(), 1); // only (0,1) survives; (0,2) is out of range
        assert!(bonds.contains(&(0, 1)));
    }

    #[test]
    fn test_parse_psf_bonds_function_bad_file() {
        // Bad PSF should return empty vec (not panic).
        let bonds = parse_psf_bonds("not a psf file", 100);
        assert!(bonds.is_empty());
    }

    #[test]
    fn test_parse_water_psf_fixture() {
        let data = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/water.psf"
        ))
        .expect("read water.psf");

        let result = parse_psf(&data).expect("parse fixture");
        assert_eq!(result.n_atoms, 3);
        assert_eq!(result.n_file_bonds, 2);
        assert_eq!(result.elements[0], 8); // O
        assert_eq!(result.elements[1], 1); // H
        assert_eq!(result.elements[2], 1); // H
    }

    #[test]
    fn test_element_from_atom_name_leading_digit() {
        // "1HB" → strip "1" → "H" → element 1
        assert_eq!(element_from_atom_name("1HB"), 1);
        // "2HD" → strip "2" → "H" → element 1
        assert_eq!(element_from_atom_name("2HD"), 1);
    }

    #[test]
    fn test_element_from_atom_name_standard() {
        assert_eq!(element_from_atom_name("N"), 7);
        assert_eq!(element_from_atom_name("CA"), 6);
        assert_eq!(element_from_atom_name("OH2"), 8);
        assert_eq!(element_from_atom_name("S"), 16);
        assert_eq!(element_from_atom_name("P"), 15);
    }

    #[test]
    fn test_element_from_mass_overrides_name_guess() {
        // CL/FE/ZN atom names would be mis-guessed as C/F/N by the first-letter
        // rule; the mass column the file carries must win (Cl=17, Fe=26, Zn=30).
        let text = "\
PSF

       1 !NTITLE
 REMARKS ions

       3 !NATOM
         1 ION      1 CLA  CL   CLA   -1.000000       35.4530           0
         2 ION      2 FE2  FE   FE2    2.000000       55.8450           0
         3 ION      3 ZN2  ZN   ZN2    2.000000       65.3800           0

       0 !NBOND: bonds
";
        let data = parse_psf(text).expect("parse failed");
        assert_eq!(data.elements[0], 17); // Cl, not C
        assert_eq!(data.elements[1], 26); // Fe, not F
        assert_eq!(data.elements[2], 30); // Zn, not N
    }

    #[test]
    fn test_element_falls_back_to_name_when_mass_missing() {
        // No charge/mass columns at all: resolve from the atom name.
        let text = "\
PSF

       1 !NTITLE
 REMARKS truncated atom lines

       2 !NATOM
         1 WAT      1 TIP3 OH2  OT
         2 WAT      1 TIP3 H1   HT

       0 !NBOND: bonds
";
        let data = parse_psf(text).expect("parse failed");
        assert_eq!(data.elements[0], 8); // O from "OH2"
        assert_eq!(data.elements[1], 1); // H from "H1"
    }

    #[test]
    fn test_element_falls_back_to_name_when_mass_zero_or_unknown() {
        // Zero mass (e.g. a massless site) and a mass matching no element
        // must both fall back to the atom-name guess.
        let text = "\
PSF

       1 !NTITLE
 REMARKS zero and bogus masses

       2 !NATOM
         1 WAT      1 TIP3 OH2  OT    -0.834000        0.0000           0
         2 WAT      1 TIP3 H1   HT     0.417000      999.0000           0

       0 !NBOND: bonds
";
        let data = parse_psf(text).expect("parse failed");
        assert_eq!(data.elements[0], 8); // O from "OH2" (mass 0.0 rejected)
        assert_eq!(data.elements[1], 1); // H from "H1" (mass 999.0 unmatched)
    }

    #[test]
    fn test_parse_psf_many_bonds_across_lines() {
        // 6 bonds written as one pair per line (not 4 per line).
        let text = "\
PSF

       1 !NTITLE
 REMARKS many bonds

       7 !NATOM
         1 MOL      1 MOL  C1   CT1   0.0  12.01  0
         2 MOL      1 MOL  C2   CT1   0.0  12.01  0
         3 MOL      1 MOL  C3   CT1   0.0  12.01  0
         4 MOL      1 MOL  C4   CT1   0.0  12.01  0
         5 MOL      1 MOL  C5   CT1   0.0  12.01  0
         6 MOL      1 MOL  C6   CT1   0.0  12.01  0
         7 MOL      1 MOL  C7   CT1   0.0  12.01  0

       6 !NBOND: bonds
         1         2
         2         3
         3         4
         4         5
         5         6
         6         7

       0 !NTHETA: angles
";
        let data = parse_psf(text).expect("parse failed");
        assert_eq!(data.n_file_bonds, 6);
        assert!(data.bonds.contains(&(0, 1)));
        assert!(data.bonds.contains(&(5, 6)));
    }
}
