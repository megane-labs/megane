//! Molden file parser (`.molden`).
//!
//! Section-keyword text format written by Molpro, ORCA, NWChem, Psi4, CFOUR,
//! and friends:
//!
//! ```text
//! [Molden Format]
//! [Atoms] (AU)          or (Angs)
//!  C     1    6    0.000000    0.000000    0.000000
//!  H     2    1    2.059000    0.000000    0.000000
//! [GTO]
//!  …basis set…
//! [MO]
//!  …orbital coefficients…
//! [GEOMETRIES] XYZ
//!  2
//!  step 1
//!  C  0.0 0.0 0.0
//!  H  1.09 0.0 0.0
//!  …
//! ```
//!
//! Scope (issue #604): `[Atoms]` becomes the static structure with
//! distance-inferred bonds, honouring the mandatory `(AU)` / `(Angs)` unit
//! argument — getting that wrong is a 1.889× coordinate error. `[GEOMETRIES]
//! XYZ` becomes a multi-frame structure by handing the block to the existing
//! XYZ frame reader.
//!
//! `[GTO]`/`[MO]` orbital evaluation and `[FREQ]`/`[FR-NORM-COORD]` normal-mode
//! animation are deliberately out of scope; the latter should share one
//! format-agnostic "vibrational mode" node with CASTEP `.phonon`.
//!
//! Every unrecognised `[...]` section is skipped tolerantly — writers emit many
//! vendor-specific blocks and the parser must never fail on one it does not know.

use crate::atomic::{capitalize, symbol_to_atomic_num};
use crate::bonds;
use crate::parser::ParsedStructure;
use std::collections::HashSet;

/// 1 Bohr in Ångström (CODATA 2018), for `[Atoms] (AU)`.
const BOHR_TO_ANGSTROM: f32 = 0.529_177_2;

/// The section header on a line, lower-cased and without brackets, e.g.
/// `[FR-NORM-COORD]` → `fr-norm-coord`. `None` for any other line.
fn section_of(line: &str) -> Option<String> {
    let t = line.trim();
    if !t.starts_with('[') {
        return None;
    }
    let close = t.find(']')?;
    Some(t[1..close].trim().to_ascii_lowercase())
}

/// Everything after the `]` on a section line, e.g. `(AU)` or `XYZ`.
fn section_arg(line: &str) -> String {
    let t = line.trim();
    match t.find(']') {
        Some(i) => t[i + 1..].trim().to_string(),
        None => String::new(),
    }
}

/// Coordinate scale implied by an `[Atoms]` unit argument. Molden spells it
/// `(AU)` / `AU` / `(Angs)` / `Angs`; anything unrecognised is treated as
/// Ångström, which is what every writer that omits the argument means.
fn unit_scale(arg: &str) -> f32 {
    let a = arg.trim().trim_matches(['(', ')']).to_ascii_lowercase();
    if a == "au" || a.starts_with("a.u") || a == "bohr" {
        BOHR_TO_ANGSTROM
    } else {
        1.0
    }
}

/// Parse a Molden file into a (possibly multi-frame) structure.
pub fn parse(text: &str) -> Result<ParsedStructure, String> {
    let lines: Vec<&str> = text.lines().collect();

    let mut positions: Vec<f32> = Vec::new();
    let mut elements: Vec<u8> = Vec::new();
    // `[GEOMETRIES] XYZ` payload, handed to the XYZ reader verbatim.
    let mut geometries: Vec<&str> = Vec::new();
    let mut saw_section = false;

    let mut i = 0usize;
    while i < lines.len() {
        let Some(section) = section_of(lines[i]) else {
            i += 1;
            continue;
        };
        saw_section = true;
        let arg = section_arg(lines[i]);
        i += 1;

        match section.as_str() {
            "atoms" => {
                let scale = unit_scale(&arg);
                while i < lines.len() && section_of(lines[i]).is_none() {
                    let toks: Vec<&str> = lines[i].split_whitespace().collect();
                    i += 1;
                    // `symbol index atomic_number x y z`
                    if toks.len() < 6 {
                        continue;
                    }
                    // Prefer the explicit atomic number; fall back to the symbol.
                    let z = match toks[2].parse::<i32>() {
                        Ok(n) if (1..=118).contains(&n) => n as u8,
                        _ => symbol_to_atomic_num(&capitalize(toks[0])),
                    };
                    let (Ok(x), Ok(y), Ok(zc)) = (
                        toks[3].parse::<f32>(),
                        toks[4].parse::<f32>(),
                        toks[5].parse::<f32>(),
                    ) else {
                        continue;
                    };
                    elements.push(z);
                    positions.push(x * scale);
                    positions.push(y * scale);
                    positions.push(zc * scale);
                }
            }
            "geometries" => {
                if !arg.trim().eq_ignore_ascii_case("xyz") {
                    // `[GEOMETRIES] ZMAT` and friends are not supported; skip
                    // the block rather than misreading it as XYZ.
                    while i < lines.len() && section_of(lines[i]).is_none() {
                        i += 1;
                    }
                    continue;
                }
                while i < lines.len() && section_of(lines[i]).is_none() {
                    geometries.push(lines[i]);
                    i += 1;
                }
            }
            _ => {
                // Unknown / out-of-scope section ([GTO], [MO], [FREQ], vendor
                // blocks): skip to the next header without inspecting content.
                while i < lines.len() && section_of(lines[i]).is_none() {
                    i += 1;
                }
            }
        }
    }

    if !saw_section {
        return Err("not a Molden file: no [Section] header found".into());
    }

    // A `[GEOMETRIES] XYZ` block is a concatenated multi-frame XYZ, so reuse the
    // XYZ reader wholesale rather than re-implementing frame handling.
    if !geometries.is_empty() {
        let joined = geometries.join("\n");
        if let Ok(parsed) = crate::xyz::parse(&joined) {
            return Ok(parsed);
        }
    }

    if elements.is_empty() {
        return Err("Molden file contains no [Atoms] block with readable atoms".into());
    }

    let n_atoms = elements.len();
    let empty = HashSet::new();
    let bonds = bonds::infer_bonds(&positions, &elements, n_atoms, &empty);

    Ok(ParsedStructure {
        n_atoms,
        positions,
        elements,
        bonds,
        n_file_bonds: 0,
        bond_orders: None,
        box_matrix: None,
        box_origin: None,
        frame_positions_flat: Vec::new(),
        atom_labels: None,
        chain_ids: None,
        bfactors: None,
        vector_channels: vec![],
        ca_indices: vec![],
        ca_chain_ids: vec![],
        ca_res_nums: vec![],
        ca_ss_type: vec![],
        symmetry_ops: Vec::new(),
        scalar_channels: Vec::new(),
        warnings: Vec::new(),
        hetero: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_atoms_in_angstrom() {
        let text = "\
[Molden Format]
[Atoms] (Angs)
 O     1    8    0.000000    0.000000    0.117300
 H     2    1    0.000000    0.757200   -0.469200
 H     3    1    0.000000   -0.757200   -0.469200
";
        let s = parse(text).unwrap();
        assert_eq!(s.n_atoms, 3);
        assert_eq!(s.elements, vec![8, 1, 1]);
        assert!((s.positions[2] - 0.1173).abs() < 1e-5);
        assert_eq!(s.bonds.len(), 2);
    }

    #[test]
    fn converts_atomic_units_to_angstrom() {
        let text = "\
[Molden Format]
[Atoms] (AU)
 H     1    1    0.000000    0.000000    0.000000
 H     2    1    1.400000    0.000000    0.000000
";
        let s = parse(text).unwrap();
        // 1.4 Bohr = 0.7408 Å — the 1.889x error this guards against.
        assert!(
            (s.positions[3] - 0.740848).abs() < 1e-4,
            "{}",
            s.positions[3]
        );
    }

    #[test]
    fn treats_a_missing_unit_argument_as_angstrom() {
        let text = "[Atoms]\n H  1  1  1.000000  0.000000  0.000000\n";
        let s = parse(text).unwrap();
        assert!((s.positions[0] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn skips_unknown_sections_tolerantly() {
        let text = "\
[Molden Format]
[Atoms] (Angs)
 C     1    6    0.000000    0.000000    0.000000
 O     2    8    1.200000    0.000000    0.000000
[GTO]
  1 0
 s    3 1.00
    3172.0000000  0.0018347
[MO]
 Sym= A1
 Ene= -20.0
 Occup= 2.0
   1   0.9941
[SOME-VENDOR-BLOCK]
 whatever it likes
";
        let s = parse(text).unwrap();
        assert_eq!(s.n_atoms, 2);
        assert_eq!(s.elements, vec![6, 8]);
    }

    #[test]
    fn geometries_xyz_becomes_a_multi_frame_structure() {
        let text = "\
[Molden Format]
[Atoms] (Angs)
 H     1    1    0.000000    0.000000    0.000000
 H     2    1    1.000000    0.000000    0.000000
[GEOMETRIES] XYZ
 2
 step 1
 H  0.000000 0.000000 0.000000
 H  1.000000 0.000000 0.000000
 2
 step 2
 H  0.000000 0.000000 0.000000
 H  0.850000 0.000000 0.000000
 2
 step 3
 H  0.000000 0.000000 0.000000
 H  0.741000 0.000000 0.000000
";
        let s = parse(text).unwrap();
        assert_eq!(s.n_atoms, 2);
        assert_eq!(s.extra_frame_count(), 2);
        assert!((s.frame(1)[3] - 0.741).abs() < 1e-5);
    }

    #[test]
    fn falls_back_to_the_symbol_when_the_atomic_number_is_bogus() {
        let text = "[Atoms] Angs\n Fe   1   0   0.0  0.0  0.0\n";
        let s = parse(text).unwrap();
        assert_eq!(s.elements, vec![26]);
    }

    #[test]
    fn ignores_a_non_xyz_geometries_block() {
        let text = "\
[Atoms] (Angs)
 H  1  1  0.0 0.0 0.0
[GEOMETRIES] ZMAT
 H
 H 1 0.74
";
        let s = parse(text).unwrap();
        assert_eq!(s.n_atoms, 1);
        assert_eq!(s.extra_frame_count(), 0);
    }

    #[test]
    fn skips_short_atom_lines() {
        let text = "[Atoms] (Angs)\n O 1 8 0.0 0.0 0.0\n garbage\n H 2 1 0.0 0.0 1.0\n";
        let s = parse(text).unwrap();
        assert_eq!(s.n_atoms, 2);
    }

    #[test]
    fn rejects_a_file_with_no_sections() {
        let err = match parse("just text\nno brackets\n") {
            Ok(_) => panic!("expected an error"),
            Err(e) => e,
        };
        assert!(err.contains("not a Molden file"), "unexpected error: {err}");
    }

    #[test]
    fn rejects_a_molden_file_with_an_empty_atoms_block() {
        let err = match parse("[Molden Format]\n[Atoms] (Angs)\n[GTO]\n") {
            Ok(_) => panic!("expected an error"),
            Err(e) => e,
        };
        assert!(err.contains("no [Atoms] block"), "unexpected error: {err}");
    }
}
