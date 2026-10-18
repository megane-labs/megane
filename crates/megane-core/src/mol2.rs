/// Tripos MOL2 parser.
///
/// Supported sections:
///   @<TRIPOS>MOLECULE   — molecule name and counts
///   @<TRIPOS>ATOM       — per-atom: id name x y z type [subst_id [subst_name [charge]]]
///   @<TRIPOS>BOND       — per-bond: id atom1 atom2 type
///   @<TRIPOS>SUBSTRUCTURE — optional, parsed for residue labels only
///   @<TRIPOS>CRYSIN     — optional unit cell: a b c alpha beta gamma [space_grp [setting]]
///
/// CRYSIN is the only cell record the Tripos spec defines, but writers differ
/// in how they fill it, so `parse_crysin` is deliberately tolerant: the space
/// group and setting may be absent or symbolic (`P1`), the six numbers may be
/// separated by whitespace, tabs or commas, use exponent notation, or be split
/// across several lines, and the section may appear anywhere in the molecule
/// (some tools emit it right after MOLECULE rather than after BOND). Section
/// headers are matched case-insensitively. A cell that cannot be read, or
/// whose parameters are degenerate (a placeholder `0 0 0 90 90 90`), leaves
/// `box_matrix` unset and records a warning instead of failing the load.
///
/// Multi-molecule streams are supported; only the first molecule is returned,
/// with a warning counting the records that were skipped.
/// Atom types use Tripos notation (e.g. "C.3", "C.ar", "N.am") — the element
/// is derived from the prefix before the first dot.
use crate::atomic::symbol_to_atomic_num;

/// Extract the element symbol from a MOL2 atom type string.
/// "C.3" → "C", "N.am" → "N", "O.co2" → "O", "Fe" → "Fe".
fn element_from_mol2_type(atom_type: &str) -> String {
    let base = atom_type.split('.').next().unwrap_or(atom_type);
    crate::atomic::capitalize(base)
}

/// Convert a MOL2 bond type token to a numeric bond order.
/// Aromatic ("ar") maps to 4, MDL's aromatic encoding (`mol.rs`), so the same
/// chemistry carries the same order across formats. Amide ("am") is a single
/// bond in MDL terms; dummy ("du"), unknown ("un") and not-connected ("nc")
/// carry no order information and fall back to 1.
fn bond_order_from_mol2_type(bond_type: &str) -> u8 {
    match bond_type {
        "ar" | "a" => 4,
        "2" => 2,
        "3" => 3,
        _ => bond_type.parse::<u8>().unwrap_or(1),
    }
}

/// Outcome of reading the CRYSIN section of one molecule.
#[derive(Debug, PartialEq)]
enum Crysin {
    /// Row-major 3x3 cell matrix.
    Cell([f32; 9]),
    /// The section was present but unusable; the string is the warning text.
    Invalid(String),
}

/// Numeric tokens of one CRYSIN data line. Writers separate the fields with
/// whitespace, tabs or commas; the trailing space group may be symbolic
/// (`P1`, `P63/mmc`), so a non-numeric token simply ends the numeric run
/// rather than being an error.
fn crysin_numbers(line: &str) -> Vec<f32> {
    line.split(|c: char| c.is_whitespace() || c == ',')
        .filter(|t| !t.is_empty())
        .map(|t| t.parse::<f32>())
        .take_while(|r| r.is_ok())
        .map(|r| r.unwrap())
        .collect()
}

/// Turn the six CRYSIN cell parameters into a cell matrix, or explain why the
/// record is unusable.
fn parse_crysin(params: &[f32]) -> Crysin {
    if params.len() < 6 {
        return Crysin::Invalid(format!(
            "CRYSIN record has {} numeric field{} (need a b c alpha beta gamma); no unit cell shown",
            params.len(),
            if params.len() == 1 { "" } else { "s" }
        ));
    }
    let (a, b, c, alpha, beta, gamma) = (
        params[0], params[1], params[2], params[3], params[4], params[5],
    );
    if !(a > 0.0 && b > 0.0 && c > 0.0) || [a, b, c].iter().any(|v| !v.is_finite()) {
        return Crysin::Invalid(format!(
            "CRYSIN cell lengths {} {} {} are not all positive; no unit cell shown",
            a, b, c
        ));
    }
    let angle_ok = |v: f32| v.is_finite() && v > 0.0 && v < 180.0;
    if !(angle_ok(alpha) && angle_ok(beta) && angle_ok(gamma)) {
        return Crysin::Invalid(format!(
            "CRYSIN cell angles {} {} {} must lie in (0, 180) degrees; no unit cell shown",
            alpha, beta, gamma
        ));
    }
    let m = crate::cell::cell_params_to_matrix(a, b, c, alpha, beta, gamma);
    // The angle combination can still be geometrically impossible (e.g.
    // alpha = beta = gamma = 179): c_z collapses to zero and the cell is flat.
    if m.iter().any(|v| !v.is_finite()) || m[8] <= 0.0 {
        return Crysin::Invalid(format!(
            "CRYSIN cell angles {} {} {} do not describe a valid cell; no unit cell shown",
            alpha, beta, gamma
        ));
    }
    Crysin::Cell(m)
}

pub fn parse(text: &str) -> Result<crate::structure::ParsedStructure, String> {
    parse_first_molecule(text)
}

fn parse_first_molecule(text: &str) -> Result<crate::structure::ParsedStructure, String> {
    #[derive(PartialEq)]
    enum Section {
        None,
        Molecule,
        Atom,
        Bond,
        Crysin,
        Other,
    }

    let mut section = Section::None;
    let mut mol_line = 0usize; // lines consumed within the current MOLECULE section
    let mut n_atoms_expected: Option<usize> = None;
    let mut n_bonds_expected: Option<usize> = None;

    let mut positions: Vec<f32> = Vec::new();
    let mut elements: Vec<u8> = Vec::new();
    let mut atom_labels: Vec<String> = Vec::new();
    let mut bonds: Vec<(u32, u32)> = Vec::new();
    let mut bond_orders: Vec<u8> = Vec::new();

    // MOL2 atom IDs are 1-based integers that are not guaranteed to be
    // contiguous, so map them to 0-based indices.
    let mut atom_id_to_idx: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();

    let mut molecule_count = 0u32;

    // Numeric CRYSIN fields accumulated across the lines of the first CRYSIN
    // section (writers may wrap `a b c` / `alpha beta gamma` onto two lines).
    let mut crysin_fields: Vec<f32> = Vec::new();
    let mut crysin_sections = 0u32;

    for line in text.lines() {
        let trimmed = line.trim();

        // Skip blank lines and comments
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with("//") {
            continue;
        }

        // Section header
        if let Some(name) = trimmed.strip_prefix("@<TRIPOS>") {
            let name = name.trim();
            if name.eq_ignore_ascii_case("MOLECULE") {
                molecule_count += 1;
                section = Section::Molecule;
                mol_line = 0;
            } else if name.eq_ignore_ascii_case("ATOM") {
                section = Section::Atom;
            } else if name.eq_ignore_ascii_case("BOND") {
                section = Section::Bond;
            } else if name.eq_ignore_ascii_case("CRYSIN") {
                if molecule_count <= 1 {
                    crysin_sections += 1;
                }
                // Only the first CRYSIN of the first molecule is read; a
                // repeated section is counted for the warning below.
                section = if crysin_sections == 1 {
                    Section::Crysin
                } else {
                    Section::Other
                };
            } else {
                section = Section::Other;
            }
            continue;
        }

        // Records after the first molecule are only counted for the warning
        // below, never parsed.
        if molecule_count > 1 {
            continue;
        }

        match section {
            Section::Molecule => {
                mol_line += 1;
                if mol_line == 2 {
                    // Second line: "n_atoms [n_bonds [n_subst [n_feat [n_sets]]]]"
                    let parts: Vec<&str> = trimmed.split_whitespace().collect();
                    if parts.is_empty() {
                        continue;
                    }
                    n_atoms_expected = Some(parts[0].parse::<usize>().map_err(|_| {
                        format!("MOL2: cannot parse atom count from '{}'", parts[0])
                    })?);
                    if parts.len() > 1 {
                        n_bonds_expected = Some(parts[1].parse::<usize>().map_err(|_| {
                            format!("MOL2: cannot parse bond count from '{}'", parts[1])
                        })?);
                    }
                }
            }

            Section::Atom => {
                // atom_id atom_name x y z atom_type [subst_id [subst_name [charge]]]
                let parts: Vec<&str> = trimmed.split_whitespace().collect();
                if parts.len() < 6 {
                    return Err(format!(
                        "MOL2 ATOM line has too few fields (need ≥6, got {}): '{}'",
                        parts.len(),
                        trimmed
                    ));
                }
                let atom_id: u32 = parts[0]
                    .parse()
                    .map_err(|_| format!("MOL2: cannot parse atom_id '{}'", parts[0]))?;
                let atom_name = parts[1];
                let x: f32 = parts[2]
                    .parse()
                    .map_err(|_| format!("MOL2: bad x for atom {}", atom_id))?;
                let y: f32 = parts[3]
                    .parse()
                    .map_err(|_| format!("MOL2: bad y for atom {}", atom_id))?;
                let z: f32 = parts[4]
                    .parse()
                    .map_err(|_| format!("MOL2: bad z for atom {}", atom_id))?;
                let atom_type = parts[5];

                let elem_sym = element_from_mol2_type(atom_type);
                let atomic_num = symbol_to_atomic_num(&elem_sym);

                let idx = positions.len() / 3;
                atom_id_to_idx.insert(atom_id, idx as u32);

                positions.push(x);
                positions.push(y);
                positions.push(z);
                elements.push(atomic_num);
                atom_labels.push(atom_name.to_string());
            }

            Section::Bond => {
                // bond_id origin_atom_id target_atom_id bond_type
                let parts: Vec<&str> = trimmed.split_whitespace().collect();
                if parts.len() < 4 {
                    return Err(format!(
                        "MOL2 BOND line has too few fields (need ≥4, got {}): '{}'",
                        parts.len(),
                        trimmed
                    ));
                }
                // parts[0] is bond_id — not needed
                let a_id: u32 = parts[1]
                    .parse()
                    .map_err(|_| format!("MOL2: cannot parse origin atom id '{}'", parts[1]))?;
                let b_id: u32 = parts[2]
                    .parse()
                    .map_err(|_| format!("MOL2: cannot parse target atom id '{}'", parts[2]))?;
                let bond_type = parts[3];

                let a = *atom_id_to_idx
                    .get(&a_id)
                    .ok_or_else(|| format!("MOL2: bond references unknown atom id {}", a_id))?;
                let b = *atom_id_to_idx
                    .get(&b_id)
                    .ok_or_else(|| format!("MOL2: bond references unknown atom id {}", b_id))?;

                bonds.push((a.min(b), a.max(b)));
                bond_orders.push(bond_order_from_mol2_type(bond_type));
            }

            Section::Crysin => {
                // a b c alpha beta gamma [space_grp [setting]] — possibly
                // wrapped over several lines; stop once six numbers are in.
                if crysin_fields.len() < 6 {
                    crysin_fields.extend(crysin_numbers(trimmed));
                }
            }

            Section::None | Section::Other => {}
        }
    }

    let n_atoms = positions.len() / 3;
    if n_atoms == 0 {
        return Err("MOL2 file has no atoms".into());
    }

    if let Some(expected) = n_atoms_expected {
        if n_atoms != expected {
            return Err(format!(
                "MOL2: expected {} atoms but parsed {}",
                expected, n_atoms
            ));
        }
    }

    if let Some(expected) = n_bonds_expected {
        if bonds.len() != expected {
            return Err(format!(
                "MOL2: expected {} bonds but parsed {}",
                expected,
                bonds.len()
            ));
        }
    }

    let n_file_bonds = bonds.len();

    let mut warnings = Vec::new();
    let mut box_matrix = None;
    if crysin_sections > 0 {
        match parse_crysin(&crysin_fields) {
            Crysin::Cell(m) => box_matrix = Some(m),
            Crysin::Invalid(msg) => warnings.push(msg),
        }
    }
    if crysin_sections > 1 {
        warnings.push(format!(
            "file has {} CRYSIN records; only the first is used",
            crysin_sections
        ));
    }
    if molecule_count > 1 {
        let extra = molecule_count - 1;
        warnings.push(format!(
            "file contains {} additional MOLECULE record{}; only the first is shown",
            extra,
            if extra == 1 { "" } else { "s" }
        ));
    }

    Ok(crate::structure::ParsedStructure {
        n_atoms,
        positions,
        elements,
        bonds,
        n_file_bonds,
        bond_orders: Some(bond_orders),
        box_matrix,
        atom_labels: Some(atom_labels),
        warnings,
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Minimal methanol MOL2 (6 atoms, 5 bonds)
    const METHANOL_MOL2: &str = "\
@<TRIPOS>MOLECULE
methanol
 6 5 1 0 0
SMALL
GASTEIGER

@<TRIPOS>ATOM
      1 C1          0.0000    0.0000    0.0000 C.3     1  LIG1        0.0000
      2 O1          1.4300    0.0000    0.0000 O.3     1  LIG1       -0.3940
      3 H1         -0.3600    1.0200    0.0000 H       1  LIG1        0.0000
      4 H2         -0.3600   -0.5100    0.8800 H       1  LIG1        0.0000
      5 H3         -0.3600   -0.5100   -0.8800 H       1  LIG1        0.0000
      6 H4          1.8300    0.9300    0.0000 H       1  LIG1        0.2640
@<TRIPOS>BOND
     1     1     2    1
     2     1     3    1
     3     1     4    1
     4     1     5    1
     5     2     6    1
@<TRIPOS>SUBSTRUCTURE
     1  LIG1        1 TEMP              0 ****  ****    0 ROOT
";

    // Benzene with aromatic bonds
    const BENZENE_MOL2: &str = "\
@<TRIPOS>MOLECULE
benzene
12 12 1 0 0
SMALL
GASTEIGER

@<TRIPOS>ATOM
      1 C1          1.2124    0.7000    0.0000 C.ar    1  LIG1        0.0000
      2 C2          1.2124   -0.7000    0.0000 C.ar    1  LIG1        0.0000
      3 C3          0.0000   -1.4000    0.0000 C.ar    1  LIG1        0.0000
      4 C4         -1.2124   -0.7000    0.0000 C.ar    1  LIG1        0.0000
      5 C5         -1.2124    0.7000    0.0000 C.ar    1  LIG1        0.0000
      6 C6          0.0000    1.4000    0.0000 C.ar    1  LIG1        0.0000
      7 H1          2.1560    1.2450    0.0000 H       1  LIG1        0.0000
      8 H2          2.1560   -1.2450    0.0000 H       1  LIG1        0.0000
      9 H3          0.0000   -2.4900    0.0000 H       1  LIG1        0.0000
     10 H4         -2.1560   -1.2450    0.0000 H       1  LIG1        0.0000
     11 H5         -2.1560    1.2450    0.0000 H       1  LIG1        0.0000
     12 H6          0.0000    2.4900    0.0000 H       1  LIG1        0.0000
@<TRIPOS>BOND
     1     1     2   ar
     2     2     3   ar
     3     3     4   ar
     4     4     5   ar
     5     5     6   ar
     6     6     1   ar
     7     1     7    1
     8     2     8    1
     9     3     9    1
    10     4    10    1
    11     5    11    1
    12     6    12    1
";

    #[test]
    fn parse_methanol() {
        let result = parse(METHANOL_MOL2).unwrap();
        assert_eq!(result.n_atoms, 6);
        assert_eq!(result.n_file_bonds, 5);

        // Carbon at index 0
        assert_eq!(result.elements[0], 6); // C
                                           // Oxygen at index 1
        assert_eq!(result.elements[1], 8); // O
                                           // Hydrogens
        assert_eq!(result.elements[2], 1); // H
        assert_eq!(result.elements[3], 1);
        assert_eq!(result.elements[4], 1);
        assert_eq!(result.elements[5], 1);

        // C position (0,0,0)
        assert!((result.positions[0] - 0.0).abs() < 1e-4);
        // O position x ≈ 1.43
        assert!((result.positions[3] - 1.43).abs() < 1e-4);

        // Bonds are sorted (min, max)
        assert!(result.bonds.iter().all(|(a, b)| a <= b));

        // Bond C-O: indices 0 and 1
        assert!(result.bonds.contains(&(0, 1)));

        let orders = result.bond_orders.unwrap();
        assert_eq!(orders.len(), 5);
        assert!(orders.iter().all(|&o| o == 1));

        // Atom labels
        let labels = result.atom_labels.unwrap();
        assert_eq!(labels[0], "C1");
        assert_eq!(labels[1], "O1");
    }

    #[test]
    fn parse_benzene_aromatic() {
        let result = parse(BENZENE_MOL2).unwrap();
        assert_eq!(result.n_atoms, 12);
        assert_eq!(result.n_file_bonds, 12);

        // All ring carbons should be element 6
        for i in 0..6 {
            assert_eq!(result.elements[i], 6, "atom {} should be carbon", i);
        }
        // All ring hydrogens
        for i in 6..12 {
            assert_eq!(result.elements[i], 1, "atom {} should be hydrogen", i);
        }
        // All bonds sorted
        assert!(result.bonds.iter().all(|(a, b)| a <= b));
        // Aromatic bonds carry MDL order 4
        let orders = result.bond_orders.unwrap();
        for &o in &orders[0..6] {
            assert_eq!(o, 4, "aromatic bond order should be 4");
        }
        // Ring-to-hydrogen bonds stay single
        for &o in &orders[6..12] {
            assert_eq!(o, 1, "C-H bond order should be 1");
        }
    }

    #[test]
    fn parse_double_bond() {
        let mol2 = "\
@<TRIPOS>MOLECULE
ethene
 4 3 0 0 0
SMALL

@<TRIPOS>ATOM
      1 C1         -0.6660    0.0000    0.0000 C.2     1  LIG         0.0000
      2 C2          0.6660    0.0000    0.0000 C.2     1  LIG         0.0000
      3 H1         -1.2340    0.9290    0.0000 H       1  LIG         0.0000
      4 H2          1.2340    0.9290    0.0000 H       1  LIG         0.0000
@<TRIPOS>BOND
     1     1     2    2
     2     1     3    1
     3     2     4    1
";
        let result = parse(mol2).unwrap();
        assert_eq!(result.n_atoms, 4);
        assert_eq!(result.n_file_bonds, 3);
        let orders = result.bond_orders.unwrap();
        assert_eq!(orders[0], 2); // C=C double bond
        assert_eq!(orders[1], 1);
        assert_eq!(orders[2], 1);
    }

    #[test]
    fn parse_amide_bond_is_single() {
        let mol2 = "\
@<TRIPOS>MOLECULE
formamide-fragment
 3 2 0 0 0
SMALL

@<TRIPOS>ATOM
      1 C1          0.0000    0.0000    0.0000 C.2     1  LIG         0.0000
      2 O1          0.6100    1.0600    0.0000 O.2     1  LIG         0.0000
      3 N1          0.6100   -1.1900    0.0000 N.am    1  LIG         0.0000
@<TRIPOS>BOND
     1     1     2    2
     2     1     3   am
";
        let result = parse(mol2).unwrap();
        let orders = result.bond_orders.unwrap();
        assert_eq!(orders, vec![2, 1]);
    }

    #[test]
    fn parse_multi_molecule_returns_first() {
        let mol2 = format!("{}\n{}", METHANOL_MOL2, BENZENE_MOL2);
        let result = parse(&mol2).unwrap();
        // Should return methanol (6 atoms), not benzene (12 atoms)
        assert_eq!(result.n_atoms, 6);
        assert_eq!(
            result.warnings,
            vec!["file contains 1 additional MOLECULE record; only the first is shown".to_string()]
        );
    }

    #[test]
    fn a_three_molecule_stream_counts_both_extra_records() {
        let mol2 = format!("{}\n{}\n{}", METHANOL_MOL2, BENZENE_MOL2, BENZENE_MOL2);
        let result = parse(&mol2).unwrap();
        assert_eq!(result.n_atoms, 6);
        assert_eq!(
            result.warnings,
            vec![
                "file contains 2 additional MOLECULE records; only the first is shown".to_string()
            ]
        );
    }

    #[test]
    fn a_single_molecule_file_has_no_warning() {
        let result = parse(METHANOL_MOL2).unwrap();
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn error_no_atoms() {
        let mol2 = "\
@<TRIPOS>MOLECULE
empty
 0 0 0 0 0
SMALL

@<TRIPOS>ATOM
@<TRIPOS>BOND
";
        let Err(msg) = parse(mol2) else {
            panic!("expected parse to fail for zero atoms");
        };
        assert!(msg.contains("no atoms"), "unexpected error: {}", msg);
    }

    #[test]
    fn error_too_few_atom_fields() {
        let mol2 = "\
@<TRIPOS>MOLECULE
bad
 1 0 0 0 0
SMALL

@<TRIPOS>ATOM
      1 C1         0.0 0.0
";
        let Err(msg) = parse(mol2) else {
            panic!("expected parse to fail for too-short atom line");
        };
        assert!(msg.contains("too few fields"), "unexpected error: {}", msg);
    }

    #[test]
    fn error_unknown_bond_atom_id() {
        let mol2 = "\
@<TRIPOS>MOLECULE
bad
 1 1 0 0 0
SMALL

@<TRIPOS>ATOM
      1 C1  0.0 0.0 0.0 C.3
@<TRIPOS>BOND
     1     1    99    1
";
        let Err(msg) = parse(mol2) else {
            panic!("expected parse to fail for unknown bond atom id");
        };
        assert!(msg.contains("unknown atom id"), "unexpected error: {}", msg);
    }

    #[test]
    fn atom_type_element_extraction() {
        assert_eq!(element_from_mol2_type("C.3"), "C");
        assert_eq!(element_from_mol2_type("C.ar"), "C");
        assert_eq!(element_from_mol2_type("N.am"), "N");
        assert_eq!(element_from_mol2_type("O.co2"), "O");
        assert_eq!(element_from_mol2_type("Fe"), "Fe");
        assert_eq!(element_from_mol2_type("S.o2"), "S");
    }

    #[test]
    fn bond_order_conversion() {
        assert_eq!(bond_order_from_mol2_type("1"), 1);
        assert_eq!(bond_order_from_mol2_type("2"), 2);
        assert_eq!(bond_order_from_mol2_type("3"), 3);
        assert_eq!(bond_order_from_mol2_type("ar"), 4);
        assert_eq!(bond_order_from_mol2_type("a"), 4);
        assert_eq!(bond_order_from_mol2_type("am"), 1);
        assert_eq!(bond_order_from_mol2_type("du"), 1);
        assert_eq!(bond_order_from_mol2_type("un"), 1);
        assert_eq!(bond_order_from_mol2_type("nc"), 1);
    }

    #[test]
    fn bonds_are_sorted_min_max() {
        // Bond listed as "2 1" should be stored as (0, 1)
        let mol2 = "\
@<TRIPOS>MOLECULE
test
 2 1 0 0 0
SMALL

@<TRIPOS>ATOM
      1 C1  0.0 0.0 0.0 C.3
      2 O1  1.4 0.0 0.0 O.3
@<TRIPOS>BOND
     1     2     1    1
";
        let result = parse(mol2).unwrap();
        assert_eq!(result.bonds[0], (0, 1));
    }

    #[test]
    fn comment_lines_ignored() {
        let mol2 = "\
# This is a comment
@<TRIPOS>MOLECULE
// Another comment style
test
 1 0 0 0 0
SMALL

@<TRIPOS>ATOM
      1 C1  0.0 0.0 0.0 C.3
";
        let result = parse(mol2).unwrap();
        assert_eq!(result.n_atoms, 1);
        assert_eq!(result.elements[0], 6);
    }

    // ---- CRYSIN unit cell -------------------------------------------------

    fn assert_close(actual: &[f32], expected: &[f32]) {
        assert_eq!(actual.len(), expected.len());
        for (i, (a, e)) in actual.iter().zip(expected).enumerate() {
            assert!(
                (a - e).abs() < 1e-3,
                "element {} differs: {} vs {} (actual {:?})",
                i,
                a,
                e,
                actual
            );
        }
    }

    const CUBIC_10: [f32; 9] = [10.0, 0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 10.0];

    /// One-atom molecule followed by the given CRYSIN body.
    fn with_crysin(body: &str) -> String {
        format!(
            "@<TRIPOS>MOLECULE\ncell\n 1 0 0 0 0\nSMALL\n\n@<TRIPOS>ATOM\n      1 C1  0.0 0.0 0.0 C.3\n@<TRIPOS>BOND\n@<TRIPOS>CRYSIN\n{}\n",
            body
        )
    }

    #[test]
    fn crysin_numbers_stops_at_symbolic_space_group() {
        assert_eq!(
            crysin_numbers("10 10 10 90 90 90 P1 1"),
            vec![10.0, 10.0, 10.0, 90.0, 90.0, 90.0]
        );
        assert_eq!(crysin_numbers("1,2,3"), vec![1.0, 2.0, 3.0]);
        assert_eq!(crysin_numbers("1\t2  3"), vec![1.0, 2.0, 3.0]);
        assert_eq!(crysin_numbers("P1 1"), Vec::<f32>::new());
        assert_eq!(crysin_numbers(""), Vec::<f32>::new());
    }

    #[test]
    fn parse_crysin_rejects_bad_parameters() {
        assert!(matches!(parse_crysin(&[]), Crysin::Invalid(_)));
        assert!(matches!(
            parse_crysin(&[1.0, 2.0, 3.0, 90.0, 90.0]),
            Crysin::Invalid(_)
        ));
        // Placeholder zero cell.
        match parse_crysin(&[0.0, 0.0, 0.0, 90.0, 90.0, 90.0]) {
            Crysin::Invalid(msg) => assert!(msg.contains("not all positive"), "{}", msg),
            other => panic!("expected Invalid, got {:?}", other),
        }
        assert!(matches!(
            parse_crysin(&[1.0, -2.0, 3.0, 90.0, 90.0, 90.0]),
            Crysin::Invalid(_)
        ));
        assert!(matches!(
            parse_crysin(&[f32::NAN, 2.0, 3.0, 90.0, 90.0, 90.0]),
            Crysin::Invalid(_)
        ));
        // Angles out of range.
        match parse_crysin(&[5.0, 5.0, 5.0, 0.0, 90.0, 90.0]) {
            Crysin::Invalid(msg) => assert!(msg.contains("(0, 180)"), "{}", msg),
            other => panic!("expected Invalid, got {:?}", other),
        }
        assert!(matches!(
            parse_crysin(&[5.0, 5.0, 5.0, 90.0, 180.0, 90.0]),
            Crysin::Invalid(_)
        ));
        assert!(matches!(
            parse_crysin(&[5.0, 5.0, 5.0, 90.0, 90.0, f32::INFINITY]),
            Crysin::Invalid(_)
        ));
        // Geometrically impossible angle triple: the c vector collapses.
        match parse_crysin(&[5.0, 5.0, 5.0, 179.0, 179.0, 179.0]) {
            Crysin::Invalid(msg) => assert!(msg.contains("valid cell"), "{}", msg),
            other => panic!("expected Invalid, got {:?}", other),
        }
    }

    #[test]
    fn parse_crysin_accepts_valid_cells() {
        match parse_crysin(&[10.0, 10.0, 10.0, 90.0, 90.0, 90.0]) {
            Crysin::Cell(m) => assert_close(&m, &CUBIC_10),
            other => panic!("expected Cell, got {:?}", other),
        }
        // Extra fields (space group / setting) are ignored.
        match parse_crysin(&[10.0, 10.0, 10.0, 90.0, 90.0, 90.0, 225.0, 1.0]) {
            Crysin::Cell(m) => assert_close(&m, &CUBIC_10),
            other => panic!("expected Cell, got {:?}", other),
        }
    }

    #[test]
    fn crysin_standard_eight_fields_sets_box() {
        let s = parse(&with_crysin(
            "   10.0000   10.0000   10.0000   90.0000   90.0000   90.0000 1 1",
        ))
        .unwrap();
        assert_close(&s.box_matrix.expect("box"), &CUBIC_10);
        assert!(s.box_origin.is_none());
        assert!(s.warnings.is_empty(), "{:?}", s.warnings);
    }

    #[test]
    fn crysin_six_fields_only() {
        let s = parse(&with_crysin("10 10 10 90 90 90")).unwrap();
        assert_close(&s.box_matrix.expect("box"), &CUBIC_10);
        assert!(s.warnings.is_empty());
    }

    #[test]
    fn crysin_symbolic_space_group() {
        let s = parse(&with_crysin("10 10 10 90 90 90 P1 1")).unwrap();
        assert_close(&s.box_matrix.expect("box"), &CUBIC_10);
        let s = parse(&with_crysin("10 10 10 90 90 90 P63/mmc")).unwrap();
        assert_close(&s.box_matrix.expect("box"), &CUBIC_10);
    }

    #[test]
    fn crysin_commas_tabs_and_exponent_notation() {
        let s = parse(&with_crysin("1.0E+01,\t1.0e1, 10.0,\t9.0E1, 90, 90.0")).unwrap();
        assert_close(&s.box_matrix.expect("box"), &CUBIC_10);
        assert!(s.warnings.is_empty());
    }

    #[test]
    fn crysin_wrapped_over_two_lines() {
        let s = parse(&with_crysin("10 10 10\n90 90 90\n1 1")).unwrap();
        assert_close(&s.box_matrix.expect("box"), &CUBIC_10);
        assert!(s.warnings.is_empty());
    }

    #[test]
    fn crysin_lowercase_header() {
        let text = with_crysin("10 10 10 90 90 90").replace("@<TRIPOS>CRYSIN", "@<TRIPOS>crysin");
        let s = parse(&text).unwrap();
        assert_close(&s.box_matrix.expect("box"), &CUBIC_10);
        // Case-insensitive matching must not break the other sections.
        let text = text
            .replace(
                "@<TRIPOS>MOLECULE",
                "@<tripos>molecule".replace("<tripos>", "<TRIPOS>").as_str(),
            )
            .replace("@<TRIPOS>ATOM", "@<TRIPOS>atom")
            .replace("@<TRIPOS>BOND", "@<TRIPOS>Bond");
        let s = parse(&text).unwrap();
        assert_eq!(s.n_atoms, 1);
        assert_close(&s.box_matrix.expect("box"), &CUBIC_10);
    }

    #[test]
    fn crysin_before_atom_section() {
        let text = "\
@<TRIPOS>MOLECULE
cell
 1 0 0 0 0
SMALL

@<TRIPOS>CRYSIN
10 10 10 90 90 90 1 1
@<TRIPOS>ATOM
      1 C1  0.0 0.0 0.0 C.3
@<TRIPOS>BOND
";
        let s = parse(text).unwrap();
        assert_eq!(s.n_atoms, 1);
        assert_close(&s.box_matrix.expect("box"), &CUBIC_10);
    }

    #[test]
    fn crysin_non_orthogonal_cell_matrix() {
        // Hexagonal: b lies in the xy-plane at 120 deg from a.
        let s = parse(&with_crysin("2.4612 2.4612 6.7079 90 90 120")).unwrap();
        let m = s.box_matrix.expect("box");
        assert_close(
            &m,
            &[
                2.4612, 0.0, 0.0, //
                -1.2306, 2.13146, 0.0, //
                0.0, 0.0, 6.7079,
            ],
        );
    }

    #[test]
    fn crysin_zero_cell_is_skipped_with_warning() {
        let s = parse(&with_crysin("0.0 0.0 0.0 90.0 90.0 90.0 1 1")).unwrap();
        assert!(s.box_matrix.is_none());
        assert_eq!(s.warnings.len(), 1);
        assert!(s.warnings[0].contains("CRYSIN"), "{}", s.warnings[0]);
        assert!(
            s.warnings[0].contains("no unit cell shown"),
            "{}",
            s.warnings[0]
        );
    }

    #[test]
    fn crysin_bad_angles_skipped_with_warning() {
        let s = parse(&with_crysin("10 10 10 90 90 0")).unwrap();
        assert!(s.box_matrix.is_none());
        assert_eq!(s.warnings.len(), 1);
        assert!(s.warnings[0].contains("angles"), "{}", s.warnings[0]);
    }

    #[test]
    fn crysin_too_few_fields_skipped_with_warning() {
        let s = parse(&with_crysin("10 10 10")).unwrap();
        assert!(s.box_matrix.is_none());
        assert_eq!(s.warnings.len(), 1);
        assert!(
            s.warnings[0].contains("3 numeric fields"),
            "{}",
            s.warnings[0]
        );

        // Header with no data at all.
        let s = parse(&with_crysin("")).unwrap();
        assert!(s.box_matrix.is_none());
        assert!(
            s.warnings[0].contains("0 numeric fields"),
            "{}",
            s.warnings[0]
        );
    }

    #[test]
    fn crysin_duplicate_uses_first_and_warns() {
        let s = parse(&with_crysin(
            "10 10 10 90 90 90\n@<TRIPOS>CRYSIN\n20 20 20 90 90 90",
        ))
        .unwrap();
        assert_close(&s.box_matrix.expect("box"), &CUBIC_10);
        assert_eq!(s.warnings.len(), 1);
        assert!(
            s.warnings[0].contains("2 CRYSIN records"),
            "{}",
            s.warnings[0]
        );
    }

    #[test]
    fn crysin_of_second_molecule_is_ignored() {
        // First molecule has no cell, second declares one: the cell belongs to
        // the molecule that is not shown, so no box is set.
        let text = "\
@<TRIPOS>MOLECULE
first
 1 0 0 0 0
SMALL

@<TRIPOS>ATOM
      1 C1  0.0 0.0 0.0 C.3
@<TRIPOS>BOND
@<TRIPOS>MOLECULE
second
 1 0 0 0 0
SMALL

@<TRIPOS>ATOM
      1 C1  0.0 0.0 0.0 C.3
@<TRIPOS>BOND
@<TRIPOS>CRYSIN
10 10 10 90 90 90 1 1
";
        let s = parse(text).unwrap();
        assert!(s.box_matrix.is_none());
        // Only the multi-molecule warning, nothing about CRYSIN.
        assert_eq!(s.warnings.len(), 1);
        assert!(
            s.warnings[0].contains("additional MOLECULE"),
            "{}",
            s.warnings[0]
        );

        // First molecule with a cell, second with a different one: first wins,
        // and the second's record is not counted as a duplicate.
        let text = text.replacen(
            "@<TRIPOS>BOND\n@<TRIPOS>MOLECULE",
            "@<TRIPOS>BOND\n@<TRIPOS>CRYSIN\n5 5 5 90 90 90\n@<TRIPOS>MOLECULE",
            1,
        );
        let s = parse(&text).unwrap();
        assert_close(
            &s.box_matrix.expect("box"),
            &[5.0, 0.0, 0.0, 0.0, 5.0, 0.0, 0.0, 0.0, 5.0],
        );
        assert_eq!(s.warnings.len(), 1);
        assert!(
            s.warnings[0].contains("additional MOLECULE"),
            "{}",
            s.warnings[0]
        );
    }

    #[test]
    fn no_crysin_means_no_box_and_no_warning() {
        let s = parse(METHANOL_MOL2).unwrap();
        assert!(s.box_matrix.is_none());
        assert!(s.warnings.is_empty());
    }

    #[test]
    fn fixture_nacl_crysin() {
        let s = parse(include_str!("../../../tests/fixtures/nacl_crysin.mol2")).unwrap();
        assert_eq!(s.n_atoms, 8);
        assert_eq!(s.bonds.len(), 0);
        assert_eq!(s.elements.iter().filter(|&&e| e == 11).count(), 4);
        assert_eq!(s.elements.iter().filter(|&&e| e == 17).count(), 4);
        assert_close(
            &s.box_matrix.expect("box"),
            &[5.6402, 0.0, 0.0, 0.0, 5.6402, 0.0, 0.0, 0.0, 5.6402],
        );
        assert!(s.warnings.is_empty(), "{:?}", s.warnings);
    }

    #[test]
    fn fixture_graphite_crysin() {
        let s = parse(include_str!("../../../tests/fixtures/graphite_crysin.mol2")).unwrap();
        assert_eq!(s.n_atoms, 4);
        assert_eq!(s.bonds.len(), 2);
        assert_eq!(s.bond_orders.as_ref().unwrap(), &vec![4, 4]);
        assert_close(
            &s.box_matrix.expect("box"),
            &[2.4612, 0.0, 0.0, -1.2306, 2.13146, 0.0, 0.0, 0.0, 6.7079],
        );
        assert!(s.warnings.is_empty(), "{:?}", s.warnings);
    }
}
