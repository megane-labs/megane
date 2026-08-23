//! CASTEP / Quantum ESPRESSO NMR `magres` parser (`.magres`).
//!
//! New-style (v1.0) block format:
//!
//! ```text
//! #$magres-abinitio-v1.0
//! [atoms]
//!   units lattice Angstrom
//!   lattice  ax ay az bx by bz cx cy cz
//!   units atom Angstrom
//!   atom  Si Si 1  0.0 0.0 0.0
//! [/atoms]
//! [magres]
//!   units ms ppm
//!   ms Si 1  <9 tensor components>
//! [/magres]
//! ```
//!
//! Scope (issue #605): the `[atoms]` block only — lattice plus labelled atoms
//! become a normal periodic structure. Each block declares its **own** `units`
//! line and this parser honours it rather than assuming Ångström; `bohr` /
//! `au` are converted.
//!
//! The `ms` / `efg` / `isc` tensors in `[magres]` are per-atom 3×3 quantities
//! with no home in the current renderer (they want a per-atom scalar channel
//! and/or an ellipsoid representation). They are deliberately left for a
//! follow-up, as the issue asks.
//!
//! The **old-style** (pre-2010) free-form `.magres` is a different grammar
//! entirely and is rejected with a clear message instead of being misparsed.
//!
//! Block delimiters come in two spellings in the wild: the format definition
//! writes `[atoms]` … `[/atoms]`, but CASTEP itself and CCP-NC's `format.py`
//! emit `<atoms>` … `</atoms>`. Both are accepted.

use crate::atomic::{capitalize, symbol_to_atomic_num};
use crate::bonds;
use crate::parser::ParsedStructure;
use std::collections::HashSet;

/// 1 Bohr in Ångström (CODATA 2018).
const BOHR_TO_ANGSTROM: f32 = 0.529_177_2;

/// Scale factor for a `units` declaration. magres spells lengths `Angstrom`,
/// `A`, `bohr`, or `au`.
fn length_scale(unit: &str) -> Result<f32, String> {
    match unit.trim().to_ascii_lowercase().as_str() {
        "angstrom" | "angstroms" | "a" | "ang" => Ok(1.0),
        "bohr" | "au" | "a.u." => Ok(BOHR_TO_ANGSTROM),
        other => Err(format!("magres: unsupported length unit '{other}'")),
    }
}

/// Parse a `.magres` document into a structure.
pub fn parse(text: &str) -> Result<ParsedStructure, String> {
    let lines: Vec<&str> = text.lines().collect();

    // The version banner is the only reliable way to tell the two grammars
    // apart, and the issue scopes this parser to v1.0.
    let banner = lines
        .iter()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())
        .unwrap_or("");
    if !banner.to_ascii_lowercase().starts_with("#$magres") {
        return Err(
            "not a new-style magres file: expected a '#$magres-abinitio-v1.0' banner on the \
             first line. Old-style (pre-2010) magres output uses a different, free-form grammar \
             that megane does not read."
                .into(),
        );
    }

    let mut in_atoms = false;
    let mut lattice_scale = 1.0f32;
    let mut atom_scale = 1.0f32;
    let mut cell: Option<[f32; 9]> = None;
    let mut positions: Vec<f32> = Vec::new();
    let mut elements: Vec<u8> = Vec::new();
    let mut labels: Vec<String> = Vec::new();

    for raw in &lines {
        let line = match raw.find('#') {
            // A '#' inside the body is a comment; the banner was already read.
            Some(0) => continue,
            Some(i) => &raw[..i],
            None => raw,
        };
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if t.eq_ignore_ascii_case("[atoms]") || t.eq_ignore_ascii_case("<atoms>") {
            in_atoms = true;
            continue;
        }
        if t.eq_ignore_ascii_case("[/atoms]") || t.eq_ignore_ascii_case("</atoms>") {
            in_atoms = false;
            continue;
        }
        if !in_atoms {
            continue;
        }

        let toks: Vec<&str> = t.split_whitespace().collect();
        match toks[0].to_ascii_lowercase().as_str() {
            // `units <quantity> <unit>` — scoped to this block.
            "units" if toks.len() >= 3 => match toks[1].to_ascii_lowercase().as_str() {
                "lattice" => lattice_scale = length_scale(toks[2])?,
                "atom" => atom_scale = length_scale(toks[2])?,
                _ => {}
            },
            // `lattice ax ay az bx by bz cx cy cz`
            "lattice" if toks.len() >= 10 => {
                let mut m = [0.0f32; 9];
                for (k, slot) in m.iter_mut().enumerate() {
                    *slot = toks[k + 1]
                        .parse::<f32>()
                        .map_err(|_| "magres: malformed lattice line".to_string())?
                        * lattice_scale;
                }
                cell = Some(m);
            }
            // `atom <species> <label> <index> x y z`
            "atom" if toks.len() >= 7 => {
                let species = capitalize(toks[1]);
                elements.push(symbol_to_atomic_num(&species));
                labels.push(format!("{}{}", toks[2], toks[3]));
                for tok in &toks[4..7] {
                    positions.push(
                        tok.parse::<f32>()
                            .map_err(|_| format!("magres: malformed atom coordinate '{tok}'"))?
                            * atom_scale,
                    );
                }
            }
            _ => {}
        }
    }

    if elements.is_empty() {
        return Err("magres: [atoms] block contains no atom lines".into());
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
        box_matrix: cell,
        box_origin: None,
        frame_positions_flat: Vec::new(),
        atom_labels: Some(labels),
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

    const SI: &str = "\
#$magres-abinitio-v1.0
[calculation]
  calc_code CASTEP
[/calculation]
[atoms]
  units lattice Angstrom
  lattice  5.43 0.0 0.0  0.0 5.43 0.0  0.0 0.0 5.43
  units atom Angstrom
  atom Si Si 1  0.0000 0.0000 0.0000
  atom Si Si 2  1.3575 1.3575 1.3575
[/atoms]
[magres]
  units ms ppm
  ms Si 1  100.0 0.0 0.0  0.0 100.0 0.0  0.0 0.0 100.0
[/magres]
";

    #[test]
    fn parses_the_atoms_block_with_its_lattice() {
        let s = parse(SI).unwrap();
        assert_eq!(s.n_atoms, 2);
        assert_eq!(s.elements, vec![14, 14]);
        let cell = s.box_matrix.expect("lattice");
        assert!((cell[0] - 5.43).abs() < 1e-5);
        assert!((cell[4] - 5.43).abs() < 1e-5);
        assert!((s.positions[3] - 1.3575).abs() < 1e-5);
        let labels = s.atom_labels.expect("per-atom labels");
        assert_eq!(labels[0], "Si1");
        assert_eq!(labels[1], "Si2");
    }

    #[test]
    fn does_not_read_tensors_from_the_magres_block() {
        // `ms` lines must not be mistaken for atoms.
        let s = parse(SI).unwrap();
        assert_eq!(s.n_atoms, 2);
    }

    #[test]
    fn honours_per_block_bohr_units() {
        let text = "\
#$magres-abinitio-v1.0
[atoms]
  units lattice bohr
  lattice  10.0 0.0 0.0  0.0 10.0 0.0  0.0 0.0 10.0
  units atom bohr
  atom H H 1  0.0 0.0 0.0
  atom H H 2  1.4 0.0 0.0
[/atoms]
";
        let s = parse(text).unwrap();
        let cell = s.box_matrix.unwrap();
        assert!((cell[0] - 5.29177).abs() < 1e-3);
        assert!((s.positions[3] - 0.740848).abs() < 1e-4);
    }

    #[test]
    fn lattice_and_atom_units_are_independent() {
        let text = "\
#$magres-abinitio-v1.0
[atoms]
  units lattice Angstrom
  lattice  10.0 0.0 0.0  0.0 10.0 0.0  0.0 0.0 10.0
  units atom bohr
  atom H H 1  1.0 0.0 0.0
[/atoms]
";
        let s = parse(text).unwrap();
        assert!((s.box_matrix.unwrap()[0] - 10.0).abs() < 1e-5);
        assert!((s.positions[0] - 0.529177).abs() < 1e-5);
    }

    #[test]
    fn a_molecule_without_a_lattice_has_no_cell() {
        let text = "\
#$magres-abinitio-v1.0
[atoms]
  units atom Angstrom
  atom O O 1  0.0 0.0 0.117
  atom H H 2  0.0 0.757 -0.469
  atom H H 3  0.0 -0.757 -0.469
[/atoms]
";
        let s = parse(text).unwrap();
        assert!(s.box_matrix.is_none());
        assert_eq!(s.bonds.len(), 2);
    }

    /// CASTEP and CCP-NC's `format.py` write the block delimiters as XML-style
    /// `<atoms>` … `</atoms>` rather than the documented `[atoms]` form.
    #[test]
    fn accepts_angle_bracket_block_delimiters() {
        let text = "\
#$magres-abinitio-v1.0
<calculation>
calc_code CASTEP
</calculation>
<atoms>
  units lattice Angstrom
  lattice  5.43 0.0 0.0  0.0 5.43 0.0  0.0 0.0 5.43
  units atom Angstrom
  atom Si Si 1  0.0 0.0 0.0
  atom Si Si 2  1.3575 1.3575 1.3575
</atoms>
<magres>
  units ms ppm
</magres>
";
        let s = parse(text).unwrap();
        assert_eq!(s.n_atoms, 2);
        assert_eq!(s.elements, vec![14, 14]);
        assert!((s.box_matrix.expect("lattice")[0] - 5.43).abs() < 1e-5);
    }

    /// Jmol's croconic-acid demo file — a real CCP-NC `format.py` export with
    /// angle-bracket delimiters (the layout that used to be rejected).
    #[test]
    fn parses_a_real_ccpnc_fixture() {
        let s = parse(include_str!("../../../tests/fixtures/croconic_acid.magres")).unwrap();
        assert_eq!(s.n_atoms, 48); // 8 H + 20 C + 20 O
        assert_eq!(s.elements.iter().filter(|&&z| z == 1).count(), 8);
        assert_eq!(s.elements.iter().filter(|&&z| z == 6).count(), 20);
        assert_eq!(s.elements.iter().filter(|&&z| z == 8).count(), 20);
        let cell = s.box_matrix.expect("lattice");
        assert!((cell[0] - 8.86546).abs() < 1e-4);
        assert_eq!(s.atom_labels.as_ref().unwrap()[0], "H1");
    }

    #[test]
    fn rejects_the_old_style_grammar() {
        let text = "= chemical shielding tensor =\nSi 1\n  100.0 0.0 0.0\n";
        let err = match parse(text) {
            Ok(_) => panic!("expected an error"),
            Err(e) => e,
        };
        assert!(err.contains("Old-style"), "unexpected error: {err}");
    }

    #[test]
    fn rejects_an_unsupported_length_unit() {
        let text =
            "#$magres-abinitio-v1.0\n[atoms]\n units atom furlong\n atom H H 1 0 0 0\n[/atoms]\n";
        let err = match parse(text) {
            Ok(_) => panic!("expected an error"),
            Err(e) => e,
        };
        assert!(err.contains("unsupported length unit"), "unexpected: {err}");
    }

    #[test]
    fn rejects_an_empty_atoms_block() {
        let err = match parse("#$magres-abinitio-v1.0\n[atoms]\n[/atoms]\n") {
            Ok(_) => panic!("expected an error"),
            Err(e) => e,
        };
        assert!(err.contains("no atom lines"), "unexpected error: {err}");
    }

    #[test]
    fn rejects_a_malformed_lattice_line() {
        let text = "#$magres-abinitio-v1.0\n[atoms]\n lattice a b c d e f g h i\n atom H H 1 0 0 0\n[/atoms]\n";
        assert!(parse(text).is_err());
    }

    #[test]
    fn ignores_comment_lines_inside_the_block() {
        let text = "\
#$magres-abinitio-v1.0
[atoms]
# a comment that must not be read as an atom
  units atom Angstrom
  atom H H 1  0.0 0.0 0.0
[/atoms]
";
        let s = parse(text).unwrap();
        assert_eq!(s.n_atoms, 1);
    }
}
