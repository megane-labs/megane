//! CASTEP lattice-dynamics output parser (`.phonon`).
//!
//! ```text
//!  BEGIN header
//!  Number of ions         2
//!  Number of branches     6
//!  Number of wavevectors  1
//!  Unit cell vectors (A)
//!     2.716  2.716  0.000
//!     ...
//!  Fractional Co-ordinates
//!      1   0.000 0.000 0.000   Si   28.0855
//!      2   0.250 0.250 0.250   Si   28.0855
//!  END header
//!      q-pt=    1   0.0 0.0 0.0   1.0
//!         1     -0.030000
//!         ...
//!                          Phonon Eigenvectors
//!  Mode Ion X Y Z
//!     1   1   re im   re im   re im
//! ```
//!
//! Scope (issue #610): the **header** — cell, fractional coordinates, and
//! species — becomes a normal periodic structure, and the q-points,
//! frequencies, and eigenvectors are parsed into [`PhononModes`] so a
//! follow-up mode-animation node has something to consume. Displacing atoms
//! along `Re(eigenvector)·cos(ωt)` is a *feature*, not a parser concern, and
//! the issue explicitly asks for it to land separately — shared with Molden's
//! `[FREQ]` / `[FR-NORM-COORD]`.

use crate::atomic::{capitalize, symbol_to_atomic_num};
use crate::bonds;
use crate::parser::ParsedStructure;
use std::collections::HashSet;

/// Auxiliary lattice-dynamics data carried alongside the structure.
///
/// Not yet surfaced through the WASM/PyO3 `ParseResult` — the mode-animation
/// node that will consume it is a follow-up — but parsed and unit-tested here
/// so the follow-up is a UI change rather than another parser rewrite.
#[derive(Debug, Default, PartialEq)]
pub struct PhononModes {
    pub n_ions: usize,
    pub n_branches: usize,
    /// Fractional q per wavevector, 3 floats each.
    pub qpoints: Vec<[f32; 3]>,
    /// Frequencies (cm⁻¹) per q-point, `n_branches` each.
    pub frequencies: Vec<Vec<f32>>,
    /// Complex eigenvectors per q-point, laid out
    /// `[branch][ion][x_re, x_im, y_re, y_im, z_re, z_im]` flattened.
    /// Empty when the file carries no eigenvector block.
    pub eigenvectors: Vec<Vec<f32>>,
}

/// Parse a `.phonon` header + mode data. Returns the structure and the modes.
pub fn parse_with_modes(text: &str) -> Result<(ParsedStructure, PhononModes), String> {
    let lines: Vec<&str> = text.lines().collect();

    let mut in_header = false;
    let mut saw_header = false;
    let mut modes = PhononModes::default();
    let mut cell: Option<[f32; 9]> = None;
    let mut fracs: Vec<[f32; 3]> = Vec::new();
    let mut elements: Vec<u8> = Vec::new();
    let mut labels: Vec<String> = Vec::new();

    let mut i = 0usize;
    while i < lines.len() {
        let t = lines[i].trim();
        let lower = t.to_ascii_lowercase();

        if lower.starts_with("begin header") {
            in_header = true;
            saw_header = true;
            i += 1;
            continue;
        }
        if lower.starts_with("end header") {
            in_header = false;
            i += 1;
            continue;
        }

        if in_header {
            if lower.starts_with("number of ions") {
                modes.n_ions = t
                    .split_whitespace()
                    .last()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
            } else if lower.starts_with("number of branches") {
                modes.n_branches = t
                    .split_whitespace()
                    .last()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
            } else if lower.starts_with("unit cell vectors") {
                let mut m = [0.0f32; 9];
                for row in 0..3 {
                    i += 1;
                    let v: Vec<f32> = lines
                        .get(i)
                        .unwrap_or(&"")
                        .split_whitespace()
                        .filter_map(|s| s.parse().ok())
                        .collect();
                    if v.len() < 3 {
                        return Err("phonon: malformed unit cell vector".into());
                    }
                    m[row * 3] = v[0];
                    m[row * 3 + 1] = v[1];
                    m[row * 3 + 2] = v[2];
                }
                cell = Some(m);
            } else if lower.starts_with("fractional co-ordinates") {
                // `idx  u v w  species  mass`, one per ion.
                while i + 1 < lines.len() {
                    let next = lines[i + 1].trim();
                    if next.to_ascii_lowercase().starts_with("end header") {
                        break;
                    }
                    let toks: Vec<&str> = next.split_whitespace().collect();
                    if toks.len() < 5 {
                        break;
                    }
                    let (Ok(u), Ok(v), Ok(w)) = (
                        toks[1].parse::<f32>(),
                        toks[2].parse::<f32>(),
                        toks[3].parse::<f32>(),
                    ) else {
                        break;
                    };
                    fracs.push([u, v, w]);
                    elements.push(symbol_to_atomic_num(&capitalize(toks[4])));
                    labels.push(format!("{}{}", toks[4], toks[0]));
                    i += 1;
                }
            }
            i += 1;
            continue;
        }

        // Mode data, after END header.
        if lower.starts_with("q-pt=") {
            let nums: Vec<f32> = t
                .split_whitespace()
                .skip(1)
                .filter_map(|s| s.parse().ok())
                .collect();
            // `q-pt=  <index>  qx qy qz  <weight>` — index first, then q.
            if nums.len() >= 4 {
                modes.qpoints.push([nums[1], nums[2], nums[3]]);
            } else {
                modes.qpoints.push([0.0, 0.0, 0.0]);
            }
            // Frequencies: `n_branches` lines of `<branch> <freq> [...]`.
            let mut freqs = Vec::with_capacity(modes.n_branches);
            let mut k = i + 1;
            while k < lines.len() && freqs.len() < modes.n_branches {
                let ft: Vec<&str> = lines[k].split_whitespace().collect();
                if ft.len() < 2 {
                    break;
                }
                let (Ok(_), Ok(f)) = (ft[0].parse::<usize>(), ft[1].parse::<f32>()) else {
                    break;
                };
                freqs.push(f);
                k += 1;
            }
            modes.frequencies.push(freqs);
            i = k;

            // Optional eigenvector block.
            while i < lines.len() {
                let l = lines[i].trim().to_ascii_lowercase();
                if l.starts_with("q-pt=") {
                    break;
                }
                if l.contains("phonon eigenvectors") || l.starts_with("mode ion") {
                    i += 1;
                    continue;
                }
                let ev: Vec<f32> = lines[i]
                    .split_whitespace()
                    .filter_map(|s| s.parse().ok())
                    .collect();
                // `mode ion  x_re x_im  y_re y_im  z_re z_im` = 8 numbers.
                if ev.len() >= 8 {
                    let slot = modes.eigenvectors.len();
                    if slot < modes.qpoints.len() {
                        modes.eigenvectors.resize(modes.qpoints.len(), Vec::new());
                    }
                    let idx = modes.qpoints.len() - 1;
                    modes.eigenvectors[idx].extend_from_slice(&ev[2..8]);
                    i += 1;
                    continue;
                }
                i += 1;
            }
            continue;
        }
        i += 1;
    }

    if !saw_header {
        return Err("not a CASTEP .phonon file: no 'BEGIN header' line found".into());
    }
    if fracs.is_empty() {
        return Err("phonon: header carries no 'Fractional Co-ordinates' ions".into());
    }
    let Some(m) = cell else {
        return Err("phonon: header carries no 'Unit cell vectors' block".into());
    };

    let n_atoms = fracs.len();
    let mut positions = Vec::with_capacity(n_atoms * 3);
    for f in &fracs {
        positions.push(f[0] * m[0] + f[1] * m[3] + f[2] * m[6]);
        positions.push(f[0] * m[1] + f[1] * m[4] + f[2] * m[7]);
        positions.push(f[0] * m[2] + f[1] * m[5] + f[2] * m[8]);
    }

    let empty = HashSet::new();
    let bonds = bonds::infer_bonds(&positions, &elements, n_atoms, &empty);

    let structure = ParsedStructure {
        n_atoms,
        positions,
        elements,
        bonds,
        n_file_bonds: 0,
        bond_orders: None,
        box_matrix: Some(m),
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
    };
    Ok((structure, modes))
}

/// Parse a `.phonon` file into a structure, discarding the mode data.
pub fn parse(text: &str) -> Result<ParsedStructure, String> {
    parse_with_modes(text).map(|(s, _)| s)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SI: &str = "\
 BEGIN header
 Number of ions         2
 Number of branches     6
 Number of wavevectors  1
 Frequencies in         cm-1
 Unit cell vectors (A)
    2.715000    2.715000    0.000000
    0.000000    2.715000    2.715000
    2.715000    0.000000    2.715000
 Fractional Co-ordinates
     1    0.000000    0.000000    0.000000   Si        28.08550000
     2    0.250000    0.250000    0.250000   Si        28.08550000
 END header
     q-pt=    1    0.000000  0.000000  0.000000      1.0000000000
        1      -0.026685
        2      -0.026685
        3      -0.026685
        4     517.339000
        5     517.339000
        6     517.339000
                        Phonon Eigenvectors
 Mode Ion                 X                                   Y                                   Z
    1   1 0.4082482905 0.0000000000 0.4082482905 0.0000000000 0.4082482905 0.0000000000
    1   2 0.4082482905 0.0000000000 0.4082482905 0.0000000000 0.4082482905 0.0000000000
";

    #[test]
    fn header_becomes_a_periodic_structure() {
        let s = parse(SI).unwrap();
        assert_eq!(s.n_atoms, 2);
        assert_eq!(s.elements, vec![14, 14]);
        let cell = s.box_matrix.expect("unit cell");
        assert!((cell[0] - 2.715).abs() < 1e-5);
        // Fractional (0.25,0.25,0.25) → Cartesian 1.3575 along each axis.
        assert!((s.positions[3] - 1.3575).abs() < 1e-4);
        assert!((s.positions[4] - 1.3575).abs() < 1e-4);
        let labels = s.atom_labels.expect("labels");
        assert_eq!(labels[0], "Si1");
    }

    #[test]
    fn frequencies_and_qpoints_are_captured() {
        let (_, modes) = parse_with_modes(SI).unwrap();
        assert_eq!(modes.n_ions, 2);
        assert_eq!(modes.n_branches, 6);
        assert_eq!(modes.qpoints.len(), 1);
        assert_eq!(modes.qpoints[0], [0.0, 0.0, 0.0]);
        assert_eq!(modes.frequencies[0].len(), 6);
        assert!((modes.frequencies[0][3] - 517.339).abs() < 1e-3);
    }

    #[test]
    fn eigenvectors_are_captured_as_complex_triples() {
        let (_, modes) = parse_with_modes(SI).unwrap();
        assert_eq!(modes.eigenvectors.len(), 1);
        // Two ion rows × 6 floats (re/im per axis).
        assert_eq!(modes.eigenvectors[0].len(), 12);
        assert!((modes.eigenvectors[0][0] - 0.408_248_3).abs() < 1e-6);
        assert_eq!(modes.eigenvectors[0][1], 0.0); // imaginary part at Γ
    }

    #[test]
    fn multiple_qpoints_each_get_their_own_frequency_list() {
        let text = SI.replace(" Number of wavevectors  1", " Number of wavevectors  2")
            + "     q-pt=    2    0.500000  0.000000  0.000000      1.0000000000\n\
        1      12.000000\n        2      13.000000\n        3      14.000000\n\
        4     500.000000\n        5     501.000000\n        6     502.000000\n";
        let (_, modes) = parse_with_modes(&text).unwrap();
        assert_eq!(modes.qpoints.len(), 2);
        assert!((modes.qpoints[1][0] - 0.5).abs() < 1e-6);
        assert_eq!(modes.frequencies[1].len(), 6);
        assert!((modes.frequencies[1][5] - 502.0).abs() < 1e-3);
    }

    #[test]
    fn a_file_without_eigenvectors_still_parses() {
        let cut = SI
            .split("                        Phonon Eigenvectors")
            .next()
            .unwrap();
        let (s, modes) = parse_with_modes(cut).unwrap();
        assert_eq!(s.n_atoms, 2);
        assert!(modes.eigenvectors.is_empty() || modes.eigenvectors[0].is_empty());
    }

    #[test]
    fn rejects_a_file_with_no_header() {
        let err = match parse("not a phonon file\n") {
            Ok(_) => panic!("expected an error"),
            Err(e) => e,
        };
        assert!(err.contains("not a CASTEP"), "unexpected error: {err}");
    }

    #[test]
    fn rejects_a_header_without_ions() {
        let text = " BEGIN header\n Number of ions 0\n Unit cell vectors (A)\n 1 0 0\n 0 1 0\n 0 0 1\n END header\n";
        let err = match parse(text) {
            Ok(_) => panic!("expected an error"),
            Err(e) => e,
        };
        assert!(err.contains("Fractional Co-ordinates"), "unexpected: {err}");
    }

    #[test]
    fn rejects_a_header_without_a_cell() {
        let text =
            " BEGIN header\n Fractional Co-ordinates\n  1 0.0 0.0 0.0 Si 28.0\n END header\n";
        let err = match parse(text) {
            Ok(_) => panic!("expected an error"),
            Err(e) => e,
        };
        assert!(err.contains("Unit cell vectors"), "unexpected: {err}");
    }

    #[test]
    fn rejects_a_malformed_cell_vector() {
        let text = " BEGIN header\n Unit cell vectors (A)\n a b c\n 0 1 0\n 0 0 1\n END header\n";
        assert!(parse(text).is_err());
    }
}
