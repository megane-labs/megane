//! AMBER prmtop topology and inpcrd/rst7 coordinate parsers.
//!
//! prmtop uses %FLAG/%FORMAT block structure.
//! inpcrd uses fixed-width F12.7 coordinates (6 per line).

use std::collections::HashMap;

use crate::atomic::{element_from_atom_name_in_residue, mass_to_atomic_num};
use crate::cell::cell_params_to_matrix;
use crate::structure::ParsedStructure;

/// Parse an AMBER prmtop topology file.
///
/// Returns atom names, elements, and bond connectivity with positions at the
/// origin. Pass the result to `load()` with an inpcrd to obtain real coords.
pub fn parse_prmtop(text: &str) -> Result<ParsedStructure, String> {
    let sections = read_flag_sections(text);

    let pointers = parse_ints(sections.get("POINTERS").map(String::as_str).unwrap_or(""))?;
    let n_atoms = pointers.first().copied().ok_or("POINTERS missing NATOM")? as usize;
    if n_atoms == 0 {
        return Err("NATOM is 0 in prmtop".into());
    }

    let atom_names = parse_char4(
        sections.get("ATOM_NAME").map(String::as_str).unwrap_or(""),
        n_atoms,
    );

    let res_labels = parse_char4(
        sections
            .get("RESIDUE_LABEL")
            .map(String::as_str)
            .unwrap_or(""),
        0,
    );
    let res_ptrs = parse_ints(
        sections
            .get("RESIDUE_POINTER")
            .map(String::as_str)
            .unwrap_or(""),
    )?;

    let elements: Vec<u8> = if let Some(sec) = sections.get("ATOMIC_NUMBER") {
        let nums = parse_ints(sec)?;
        nums.into_iter().map(|n| n.clamp(0, 255) as u8).collect()
    } else {
        // Older prmtops carry no ATOMIC_NUMBER section. Next most
        // authoritative is the (mandatory) MASS section; only atoms whose mass
        // is missing or matches no element fall back to the residue-aware
        // atom-name guess (a protein "CA" is carbon, an ion residue "CA" is
        // calcium).
        let masses: Vec<f32> = sections
            .get("MASS")
            .map(|sec| {
                sec.split_whitespace()
                    .map(|t| t.parse().unwrap_or(0.0))
                    .collect()
            })
            .unwrap_or_default();
        (0..n_atoms)
            .map(|i| {
                masses
                    .get(i)
                    .copied()
                    .filter(|&m| m > 0.0)
                    .map(mass_to_atomic_num)
                    .filter(|&z| z != 0)
                    .unwrap_or_else(|| {
                        let name = atom_names.get(i).map(String::as_str).unwrap_or("");
                        element_from_atom_name_in_residue(
                            name,
                            residue_name(i, &res_labels, &res_ptrs),
                        )
                    })
            })
            .collect()
    };

    let atom_labels = build_atom_labels(&atom_names, &res_labels, &res_ptrs, n_atoms);

    let bonds = parse_bond_sections(
        sections
            .get("BONDS_INC_HYDROGEN")
            .map(String::as_str)
            .unwrap_or(""),
        sections
            .get("BONDS_WITHOUT_HYDROGEN")
            .map(String::as_str)
            .unwrap_or(""),
        n_atoms,
    )?;
    let n_file_bonds = bonds.len();

    // Optional BOX_DIMENSIONS section: [OLDBETA, A, B, C]. OLDBETA is the box
    // angle applied to alpha, beta, and gamma alike (90° rectangular or
    // 109.47° truncated octahedron). An inpcrd box, when present, overrides
    // this in `parse()`.
    let box_matrix = sections.get("BOX_DIMENSIONS").and_then(|sec| {
        let vals: Vec<f32> = sec
            .split_whitespace()
            .filter_map(|t| t.parse().ok())
            .collect();
        match vals[..] {
            [beta, a, b, c] if a > 0.0 && b > 0.0 && c > 0.0 => {
                Some(cell_params_to_matrix(a, b, c, beta, beta, beta))
            }
            _ => None,
        }
    });

    Ok(ParsedStructure {
        n_atoms,
        positions: vec![0.0f32; n_atoms * 3],
        elements,
        bonds,
        n_file_bonds,
        box_matrix,
        atom_labels: Some(atom_labels),
        ..Default::default()
    })
}

/// Parse prmtop topology and inpcrd/rst7 coordinates together.
pub fn parse(prmtop: &str, inpcrd: &str) -> Result<ParsedStructure, String> {
    let mut structure = parse_prmtop(prmtop)?;
    let (coords, box_mat) = parse_inpcrd(inpcrd, structure.n_atoms)?;
    structure.positions = coords;
    // The inpcrd box takes precedence; a prmtop BOX_DIMENSIONS box (if any)
    // stands when the inpcrd carries none.
    if box_mat.is_some() {
        structure.box_matrix = box_mat;
    }
    Ok(structure)
}

/// Parse an AMBER inpcrd/rst7 coordinate file.
///
/// Returns `(positions_angstrom, optional_box_matrix)`.
pub fn parse_inpcrd(text: &str, n_atoms: usize) -> Result<(Vec<f32>, Option<[f32; 9]>), String> {
    let mut lines = text.lines();

    // Title line (required)
    let _title = lines.next().ok_or("inpcrd: missing title line")?;

    // NATOM line (optionally followed by TIME on same line)
    let natom_line = lines.next().ok_or("inpcrd: missing NATOM line")?;
    let natom: usize = natom_line
        .split_whitespace()
        .next()
        .ok_or("inpcrd: empty NATOM line")?
        .parse()
        .map_err(|_| "inpcrd: cannot parse NATOM")?;

    if natom != n_atoms {
        return Err(format!(
            "inpcrd NATOM={} but topology has {}",
            natom, n_atoms
        ));
    }

    // Coordinates in F12.7 format, 6 per line. Collect all remaining lines and
    // tokenise by whitespace (works for both space-separated and adjacent fields).
    let remaining: String = lines.collect::<Vec<&str>>().join("\n");
    let mut all_vals: Vec<f32> = Vec::with_capacity(n_atoms * 3 + 6);
    for token in remaining.split_whitespace() {
        if let Ok(v) = token.parse::<f32>() {
            all_vals.push(v);
        }
    }

    // Optional box: last 6 values are (a, b, c, alpha, beta, gamma) in Å / degrees
    let box_mat = if all_vals.len() == n_atoms * 3 + 6 {
        let box_vals: Vec<f32> = all_vals.drain(n_atoms * 3..).collect();
        Some(cell_params_to_matrix(
            box_vals[0],
            box_vals[1],
            box_vals[2],
            box_vals[3],
            box_vals[4],
            box_vals[5],
        ))
    } else {
        None
    };

    if all_vals.len() < n_atoms * 3 {
        return Err(format!(
            "inpcrd: expected {} coordinate values but got {}",
            n_atoms * 3,
            all_vals.len()
        ));
    }
    all_vals.truncate(n_atoms * 3);

    Ok((all_vals, box_mat))
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Split a prmtop into a map of FLAG name → data text.
///
/// Each section starts with `%FLAG <NAME>`, followed by one `%FORMAT(…)` line,
/// then data lines until the next `%FLAG` or EOF.
fn read_flag_sections(text: &str) -> HashMap<String, String> {
    let mut map: HashMap<String, String> = HashMap::new();
    let mut current_flag: Option<String> = None;
    let mut buf = String::new();
    let mut expect_format = false;

    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("%FLAG") {
            if let Some(flag) = current_flag.take() {
                map.insert(flag, std::mem::take(&mut buf));
            }
            current_flag = Some(rest.trim().to_string());
            expect_format = true;
        } else if expect_format && line.starts_with("%FORMAT") {
            expect_format = false;
        } else if !expect_format && current_flag.is_some() {
            buf.push_str(line);
            buf.push('\n');
        }
    }

    if let Some(flag) = current_flag {
        map.insert(flag, buf);
    }

    map
}

/// Parse integer tokens from a prmtop section (handles both I8 and whitespace).
fn parse_ints(text: &str) -> Result<Vec<i64>, String> {
    let mut vals = Vec::new();
    for tok in text.split_whitespace() {
        vals.push(
            tok.parse::<i64>()
                .map_err(|_| format!("amber: cannot parse integer {:?}", tok))?,
        );
    }
    Ok(vals)
}

/// Parse fixed-width 4-char fields from a prmtop section (20a4 format).
fn parse_char4(text: &str, max_items: usize) -> Vec<String> {
    let mut result = Vec::new();
    for line in text.lines() {
        let bytes = line.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            let end = (i + 4).min(bytes.len());
            let field = std::str::from_utf8(&bytes[i..end])
                .unwrap_or("")
                .trim()
                .to_string();
            if !field.is_empty() {
                result.push(field);
            }
            i += 4;
            if max_items > 0 && result.len() >= max_items {
                return result;
            }
        }
    }
    result
}

/// Parse bond triples from BONDS_INC_HYDROGEN and BONDS_WITHOUT_HYDROGEN.
///
/// Each triple is `(atom_i - 1) * 3`, `(atom_j - 1) * 3`, force-constant-idx.
fn parse_bond_sections(
    h_sec: &str,
    no_h_sec: &str,
    n_atoms: usize,
) -> Result<Vec<(u32, u32)>, String> {
    let mut bonds = Vec::new();
    for text in &[h_sec, no_h_sec] {
        let vals = parse_ints(text)?;
        for chunk in vals.chunks(3) {
            if chunk.len() == 3 && chunk[0] >= 0 && chunk[1] >= 0 {
                let a = (chunk[0] / 3) as u32;
                let b = (chunk[1] / 3) as u32;
                if (a as usize) < n_atoms && (b as usize) < n_atoms {
                    bonds.push((a, b));
                }
            }
        }
    }
    Ok(bonds)
}

/// Residue label of atom `i` (0-indexed), or `""` when the prmtop has none.
fn residue_name<'a>(i: usize, res_labels: &'a [String], res_ptrs: &[i64]) -> &'a str {
    // res_ptrs is 1-indexed; find the last pointer ≤ (i+1)
    let res_idx = res_ptrs
        .partition_point(|&p| p <= (i as i64 + 1))
        .saturating_sub(1);
    res_labels.get(res_idx).map(String::as_str).unwrap_or("")
}

/// Build per-atom labels as `"RESNAME/ATOMNAME"` strings.
fn build_atom_labels(
    atom_names: &[String],
    res_labels: &[String],
    res_ptrs: &[i64],
    n_atoms: usize,
) -> Vec<String> {
    (0..n_atoms)
        .map(|i| {
            let res_name = residue_name(i, res_labels, res_ptrs);
            let atom_name = atom_names.get(i).map(String::as_str).unwrap_or("");
            if res_name.is_empty() {
                atom_name.to_string()
            } else {
                format!("{}/{}", res_name, atom_name)
            }
        })
        .collect()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // Minimal prmtop for a water molecule (O, H1, H2)
    const WATER_PRMTOP: &str = "\
%VERSION  VERSION_STAMP = V0001.000  DATE = 05/01/26  12:00:00
%FLAG TITLE
%FORMAT(20a4)
water
%FLAG POINTERS
%FORMAT(10I8)
       3       1       2       0       0       0       0       0       0       0
       0       0       0       0       0       0       0       0       0       0
       0       0       0       0       0       0       0       0       0       0
       0       0
%FLAG ATOM_NAME
%FORMAT(20a4)
OW  HW1 HW2
%FLAG ATOMIC_NUMBER
%FORMAT(10I8)
       8       1       1
%FLAG RESIDUE_LABEL
%FORMAT(20a4)
WAT
%FLAG RESIDUE_POINTER
%FORMAT(10I8)
       1
%FLAG BONDS_INC_HYDROGEN
%FORMAT(10I8)
       0       3       1       0       6       2
%FLAG BONDS_WITHOUT_HYDROGEN
%FORMAT(10I8)
";

    // Matching inpcrd (O at origin, H1 along x, H2 at angle)
    const WATER_INPCRD: &str = "\
water
       3
   0.0000000   0.0000000   0.0000000   0.9572000   0.0000000   0.0000000
  -0.2399500   0.9266900   0.0000000
";

    // Inpcrd with periodic box
    const WATER_INPCRD_BOX: &str = "\
water box
       3
   0.0000000   0.0000000   0.0000000   0.9572000   0.0000000   0.0000000
  -0.2399500   0.9266900   0.0000000
  20.0000000  20.0000000  20.0000000  90.0000000  90.0000000  90.0000000
";

    #[test]
    fn test_parse_prmtop_atoms() {
        let result = parse_prmtop(WATER_PRMTOP).expect("parse_prmtop failed");
        assert_eq!(result.n_atoms, 3);
        assert_eq!(result.elements[0], 8); // O
        assert_eq!(result.elements[1], 1); // H
        assert_eq!(result.elements[2], 1); // H
    }

    #[test]
    fn test_parse_prmtop_bonds() {
        let result = parse_prmtop(WATER_PRMTOP).expect("parse_prmtop failed");
        assert_eq!(result.bonds.len(), 2);
        assert_eq!(result.n_file_bonds, 2);
        // Bonds should be O-H1 and O-H2
        assert!(result.bonds.contains(&(0, 1)));
        assert!(result.bonds.contains(&(0, 2)));
    }

    #[test]
    fn test_parse_prmtop_zero_positions() {
        let result = parse_prmtop(WATER_PRMTOP).expect("parse_prmtop failed");
        assert!(result.positions.iter().all(|&v| v == 0.0));
    }

    #[test]
    fn test_parse_prmtop_labels() {
        let result = parse_prmtop(WATER_PRMTOP).expect("parse_prmtop failed");
        let labels = result.atom_labels.expect("no labels");
        assert_eq!(labels[0], "WAT/OW");
        assert_eq!(labels[1], "WAT/HW1");
        assert_eq!(labels[2], "WAT/HW2");
    }

    #[test]
    fn test_parse_combined_positions() {
        let result = parse(WATER_PRMTOP, WATER_INPCRD).expect("combined parse failed");
        assert_eq!(result.n_atoms, 3);
        // O at origin
        assert!((result.positions[0]).abs() < 1e-5);
        assert!((result.positions[1]).abs() < 1e-5);
        assert!((result.positions[2]).abs() < 1e-5);
        // H1 along x at ~0.9572 Å
        assert!((result.positions[3] - 0.9572).abs() < 1e-3);
        assert!((result.positions[4]).abs() < 1e-5);
    }

    #[test]
    fn test_parse_combined_no_box() {
        let result = parse(WATER_PRMTOP, WATER_INPCRD).expect("combined parse failed");
        assert!(result.box_matrix.is_none());
    }

    #[test]
    fn test_parse_combined_with_box() {
        let result = parse(WATER_PRMTOP, WATER_INPCRD_BOX).expect("box parse failed");
        let bm = result.box_matrix.expect("box should be present");
        assert!((bm[0] - 20.0).abs() < 1e-3); // a
        assert!((bm[4] - 20.0).abs() < 1e-3); // b
        assert!((bm[8] - 20.0).abs() < 1e-3); // c
    }

    #[test]
    fn test_parse_inpcrd_natom_mismatch() {
        let inpcrd = "test\n       5\n";
        let result = parse_inpcrd(inpcrd, 3);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("NATOM"));
    }

    #[test]
    fn test_parse_inpcrd_too_few_coords() {
        let inpcrd = "test\n       3\n   1.0   2.0\n";
        let result = parse_inpcrd(inpcrd, 3);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_prmtop_natom_zero() {
        let prmtop = "%FLAG POINTERS\n%FORMAT(10I8)\n       0\n";
        let result = parse_prmtop(prmtop);
        assert!(result.is_err());
    }

    #[test]
    fn test_read_flag_sections() {
        let text = "%FLAG TITLE\n%FORMAT(20a4)\nhello\n%FLAG POINTERS\n%FORMAT(10I8)\n   3\n   2\n";
        let sections = read_flag_sections(text);
        assert!(sections.contains_key("TITLE"));
        assert!(sections.contains_key("POINTERS"));
        let ptrs = parse_ints(sections.get("POINTERS").unwrap()).unwrap();
        assert_eq!(ptrs, vec![3, 2]);
    }

    #[test]
    fn test_parse_char4_basic() {
        let text = "OW  HW1 HW2 \n";
        let result = parse_char4(text, 0);
        assert_eq!(result[0], "OW");
        assert_eq!(result[1], "HW1");
        assert_eq!(result[2], "HW2");
    }

    #[test]
    fn test_parse_char4_max_items() {
        let text = "OW  HW1 HW2 \n";
        let result = parse_char4(text, 2);
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn test_parse_ints_valid() {
        let result = parse_ints("  3   1   2\n  0   0").unwrap();
        assert_eq!(result, vec![3, 1, 2, 0, 0]);
    }

    #[test]
    fn test_parse_ints_invalid() {
        let result = parse_ints("abc");
        assert!(result.is_err());
    }

    // Inpcrd with a truncated-octahedron (triclinic) box
    const WATER_INPCRD_TRICLINIC: &str = "\
water trunc oct
       3
   0.0000000   0.0000000   0.0000000   0.9572000   0.0000000   0.0000000
  -0.2399500   0.9266900   0.0000000
  20.0000000  20.0000000  20.0000000 109.4712190 109.4712190 109.4712190
";

    #[test]
    fn test_right_angle_boxes_are_exactly_diagonal() {
        // 90° angles take the exact orthorhombic path: no f32 trig noise in
        // the off-diagonals, from either the inpcrd box or BOX_DIMENSIONS.
        let result = parse(WATER_PRMTOP, WATER_INPCRD_BOX).expect("box parse failed");
        assert_eq!(
            result.box_matrix,
            Some([20.0, 0.0, 0.0, 0.0, 20.0, 0.0, 0.0, 0.0, 20.0])
        );
        let prmtop = format!(
            "{WATER_PRMTOP}%FLAG BOX_DIMENSIONS
%FORMAT(5E16.8)
  9.00000000E+01  2.00000000E+01  2.10000000E+01  2.20000000E+01
"
        );
        let result = parse_prmtop(&prmtop).expect("parse_prmtop failed");
        assert_eq!(
            result.box_matrix,
            Some([20.0, 0.0, 0.0, 0.0, 21.0, 0.0, 0.0, 0.0, 22.0])
        );
    }

    #[test]
    fn test_parse_inpcrd_triclinic_box() {
        let result = parse(WATER_PRMTOP, WATER_INPCRD_TRICLINIC).expect("triclinic parse failed");
        let bm = result.box_matrix.expect("box should be present");
        let expect = crate::cell::cell_params_to_matrix(
            20.0, 20.0, 20.0, 109.471_22, 109.471_22, 109.471_22,
        );
        for i in 0..9 {
            assert!(
                (bm[i] - expect[i]).abs() < 1e-3,
                "m[{i}] = {} expected {}",
                bm[i],
                expect[i]
            );
        }
        // The b vector must tilt: b·x = 20·cos(109.47°) ≈ -20/3.
        assert!((bm[3] + 20.0 / 3.0).abs() < 1e-2, "b·x = {}", bm[3]);
    }

    #[test]
    fn test_prmtop_box_dimensions() {
        // prmtop with the deprecated BOX_DIMENSIONS section [OLDBETA, A, B, C].
        let prmtop = format!(
            "{WATER_PRMTOP}%FLAG BOX_DIMENSIONS
%FORMAT(5E16.8)
  1.09471219E+02  2.00000000E+01  2.10000000E+01  2.20000000E+01
"
        );
        let result = parse_prmtop(&prmtop).expect("parse_prmtop failed");
        let bm = result.box_matrix.expect("box should be present");
        let expect = crate::cell::cell_params_to_matrix(
            20.0, 21.0, 22.0, 109.471_22, 109.471_22, 109.471_22,
        );
        for i in 0..9 {
            assert!(
                (bm[i] - expect[i]).abs() < 1e-3,
                "m[{i}] = {} expected {}",
                bm[i],
                expect[i]
            );
        }

        // Without an inpcrd box, the prmtop box stands...
        let combined = parse(&prmtop, WATER_INPCRD).expect("combined parse failed");
        assert_eq!(combined.box_matrix, Some(bm));

        // ...but an inpcrd box takes precedence.
        let combined = parse(&prmtop, WATER_INPCRD_BOX).expect("combined parse failed");
        let bm = combined.box_matrix.expect("box should be present");
        assert_eq!(bm, [20.0, 0.0, 0.0, 0.0, 20.0, 0.0, 0.0, 0.0, 20.0]);
    }

    #[test]
    fn test_prmtop_fallback_element_from_name() {
        // prmtop without ATOMIC_NUMBER section: elements inferred from atom names
        let prmtop = "\
%FLAG POINTERS
%FORMAT(10I8)
       2       0       0       0       0       0       0       0       0       0
       0       0       0       0       0       0       0       0       0       0
       0       0       0       0       0       0       0       0       0       0
       0       0
%FLAG ATOM_NAME
%FORMAT(20a4)
C1  N2
%FLAG RESIDUE_LABEL
%FORMAT(20a4)
MOL
%FLAG RESIDUE_POINTER
%FORMAT(10I8)
       1
%FLAG BONDS_INC_HYDROGEN
%FORMAT(10I8)
%FLAG BONDS_WITHOUT_HYDROGEN
%FORMAT(10I8)
       0       3       1
";
        let result = parse_prmtop(prmtop).expect("parse_prmtop failed");
        assert_eq!(result.n_atoms, 2);
        assert_eq!(result.elements[0], 6); // C
        assert_eq!(result.elements[1], 7); // N
        assert_eq!(result.bonds.len(), 1);
        assert!(result.bonds.contains(&(0, 1)));
    }

    /// Header shared by the ATOMIC_NUMBER-less prmtops below: 4 atoms in two
    /// residues, an alanine (N, CA, HG-style name) and a calcium ion "CA".
    const NO_Z_PRMTOP_HEAD: &str = "\
%FLAG POINTERS
%FORMAT(10I8)
       4       0       0       0       0       0       0       0       0       0
       0       2       0       0       0       0       0       0       0       0
       0       0       0       0       0       0       0       0       0       0
       0       0
%FLAG ATOM_NAME
%FORMAT(20a4)
N   CA  HG  CA
%FLAG RESIDUE_LABEL
%FORMAT(20a4)
ALA CA
%FLAG RESIDUE_POINTER
%FORMAT(10I8)
       1       4
";

    #[test]
    fn test_prmtop_fallback_name_is_residue_aware() {
        // No ATOMIC_NUMBER and no MASS: the protein Cα must not become calcium,
        // while the ion residue "CA" must.
        let result = parse_prmtop(NO_Z_PRMTOP_HEAD).expect("parse_prmtop failed");
        assert_eq!(result.elements, vec![7, 6, 1, 20]);
    }

    #[test]
    fn test_prmtop_fallback_prefers_mass_over_name() {
        // MASS outranks the name guess (CRITICAL RULE #11 b): an "HG" atom
        // with a mercury mass is mercury even inside a standard residue. A
        // zero / unparsable mass falls back to the residue-aware name guess.
        let prmtop = format!(
            "{NO_Z_PRMTOP_HEAD}%FLAG MASS\n%FORMAT(5E16.8)\n  1.40100000E+01  0.00000000E+00  2.00590000E+02  bogus\n"
        );
        let result = parse_prmtop(&prmtop).expect("parse_prmtop failed");
        assert_eq!(result.elements, vec![7, 6, 80, 20]);
    }
}
