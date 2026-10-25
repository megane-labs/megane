//! GAMESS (US / Firefly) log-output parser (`.gamess`).
//!
//! Not a data format but the program's printed output. Geometries live in
//! fixed banner-delimited blocks:
//!
//! ```text
//!  COORDINATES OF ALL ATOMS ARE (ANGS)
//!    ATOM   CHARGE       X              Y              Z
//!  ------------------------------------------------------------
//!  C           6.0    0.0000000000   0.0000000000   0.0000000000
//!  H           1.0    1.0900000000   0.0000000000   0.0000000000
//! ```
//!
//! Every such block becomes a frame, so a geometry optimisation can be
//! scrubbed exactly like a multi-frame XYZ; the terminal
//! `EQUILIBRIUM GEOMETRY LOCATED` block is simply the last one. The banner's
//! `(ANGS)` / `(BOHR)` argument is honoured — some run types print Bohr.
//!
//! ## Element resolution
//!
//! The `CHARGE` column is the nuclear charge, so for an all-electron atom it
//! is the atomic number (rounded, as GAMESS prints it as a float). An
//! effective core potential (ECP) removes core electrons, and GAMESS then
//! prints the *valence* charge: Pt with a 60-electron core shows `18.0`, I
//! with a 28-electron core `25.0`, which read as Z would be Ar and Mn. The
//! atom label (`PT`, `I1`) names the element instead, so the precedence is:
//!
//! 1. the label's element, when it is heavier than the charge says by exactly
//!    an ECP core (a closed-shell core of 2, 10, 18, 28, 36, 46, 54, 60, 68,
//!    78, 86, 92 or 100 electrons, or a lanthanide/actinide core holding the
//!    4f/5f shell, see [`is_ecp_core`]);
//! 2. otherwise the rounded charge, when it is an element (1..=118) — a
//!    carbon labelled `CA` keeps Z = 6, since 20 − 6 = 14 is no ECP core;
//! 3. otherwise the label's element (`0` when the label names none).
//!
//! ## Extension policy
//!
//! GAMESS output is normally named `.log` or `.out`. megane deliberately does
//! **not** claim those globally — registering `*.log` in the VS Code
//! `customEditors` selector or the JupyterLab filetypes would hijack every log
//! file in the user's workspace. Only `.gamess` is registered; a `.log`/`.out`
//! can still be opened by renaming it, or through the Load Structure dialog's
//! "All Files" option.

use crate::atomic::{capitalize, symbol_to_atomic_num};
use crate::bonds;
use crate::structure::{FrameChange, HeteroFramesBuilder, ParsedStructure};
use std::collections::HashSet;

/// 1 Bohr in Ångström (CODATA 2018).
const BOHR_TO_ANGSTROM: f32 = 0.529_177_2;

/// The coordinate banner GAMESS prints before every geometry block.
const BANNER: &str = "COORDINATES OF ALL ATOMS ARE";

/// One geometry block.
struct Frame {
    positions: Vec<f32>,
    elements: Vec<u8>,
}

/// Read one geometry block whose banner sits at `start`. Returns the frame and
/// the index just past it.
fn read_block(lines: &[&str], start: usize) -> (Option<Frame>, usize) {
    let scale = if lines[start].to_ascii_uppercase().contains("BOHR") {
        BOHR_TO_ANGSTROM
    } else {
        1.0
    };
    let mut i = start + 1;

    // Skip the column header and the dashed rule that follow the banner.
    while i < lines.len() {
        let t = lines[i].trim();
        if t.is_empty() || t.starts_with("ATOM") || t.starts_with("---") {
            i += 1;
            continue;
        }
        break;
    }

    let mut positions = Vec::new();
    let mut elements = Vec::new();
    while i < lines.len() {
        let t = lines[i].trim();
        if t.is_empty() {
            break; // a blank line closes the block
        }
        let toks: Vec<&str> = t.split_whitespace().collect();
        if toks.len() < 5 {
            break;
        }
        let (Ok(charge), Ok(x), Ok(y), Ok(z)) = (
            toks[1].parse::<f32>(),
            toks[2].parse::<f32>(),
            toks[3].parse::<f32>(),
            toks[4].parse::<f32>(),
        ) else {
            break; // not an atom line — the block has ended
        };
        elements.push(resolve_element(toks[0], charge));
        positions.push(x * scale);
        positions.push(y * scale);
        positions.push(z * scale);
        i += 1;
    }

    if elements.is_empty() {
        (None, i)
    } else {
        (
            Some(Frame {
                positions,
                elements,
            }),
            i,
        )
    }
}

/// The element of one atom line from its label and printed nuclear charge,
/// following the precedence in the module docs.
fn resolve_element(label: &str, charge: f32) -> u8 {
    let rounded = charge.round();
    let z_charge = if (1.0..=118.0).contains(&rounded) {
        rounded as u8
    } else {
        0
    };
    // The label's leading letters, as an exact element symbol (`PT1` → Pt);
    // a ghost `BQ` or a free-form name resolves to nothing.
    let letters: String = label
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect();
    let z_label = symbol_to_atomic_num(&capitalize(&letters));
    if z_charge == 0 || (z_label > z_charge && is_ecp_core(z_label, z_label - z_charge)) {
        z_label
    } else {
        z_charge
    }
}

/// Whether removing `core` electrons from element `z` matches an effective
/// core potential: a closed-shell core (noble-gas cores and the filled
/// 3d/4d/4f/5d shells they combine with), or a large-core lanthanide or
/// actinide ECP that also folds the 4f/5f electrons into the core.
fn is_ecp_core(z: u8, core: u8) -> bool {
    matches!(
        core,
        2 | 10 | 18 | 28 | 36 | 46 | 54 | 60 | 68 | 78 | 86 | 92 | 100
    ) || ((58..=71).contains(&z) && (47..=60).contains(&core))
        || ((90..=103).contains(&z) && (79..=92).contains(&core))
}

/// Parse a GAMESS output file into a (possibly multi-frame) structure.
pub fn parse(text: &str) -> Result<ParsedStructure, String> {
    let lines: Vec<&str> = text.lines().collect();
    let mut frames: Vec<Frame> = Vec::new();

    let mut i = 0usize;
    while i < lines.len() {
        if lines[i].to_ascii_uppercase().contains(BANNER) {
            let (frame, next) = read_block(&lines, i);
            if let Some(f) = frame {
                frames.push(f);
            }
            i = next.max(i + 1);
        } else {
            i += 1;
        }
    }

    if frames.is_empty() {
        return Err(format!(
            "not a GAMESS output file: no '{BANNER}' block found"
        ));
    }

    let first = frames.remove(0);
    let n_atoms = first.elements.len();

    let mut hframes = HeteroFramesBuilder::with_capacity(n_atoms, frames.len());
    for f in &frames {
        hframes.push_frame(
            &f.positions,
            || f.elements.clone(),
            None,
            FrameChange {
                topology: f.elements != first.elements,
                cell: false,
            },
        );
    }

    let empty = HashSet::new();
    let bonds = bonds::infer_bonds(&first.positions, &first.elements, n_atoms, &empty);

    // An optimisation keeps a fixed atom set, so the fast fixed-stride path is
    // the norm; the side table only appears if a log really does change atoms.
    // A molecular log carries no cell, so it never varies.
    let (frame_positions_flat, hetero) = hframes.finish(&first.elements, None);

    Ok(ParsedStructure {
        n_atoms,
        positions: first.positions,
        elements: first.elements,
        bonds,
        n_file_bonds: 0,
        frame_positions_flat,
        hetero,
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPT: &str = "\
          ******************************************************
          *         GAMESS VERSION = 30 JUN 2024 (R2)          *
          ******************************************************

 COORDINATES OF ALL ATOMS ARE (ANGS)
   ATOM   CHARGE       X              Y              Z
 ------------------------------------------------------------
 O           8.0    0.0000000000   0.0000000000   0.2000000000
 H           1.0    0.0000000000   0.8000000000  -0.5200000000
 H           1.0    0.0000000000  -0.8000000000  -0.5200000000

          NSERCH=  1     ENERGY=     -76.0100000

 COORDINATES OF ALL ATOMS ARE (ANGS)
   ATOM   CHARGE       X              Y              Z
 ------------------------------------------------------------
 O           8.0    0.0000000000   0.0000000000   0.1300000000
 H           1.0    0.0000000000   0.7700000000  -0.4800000000
 H           1.0    0.0000000000  -0.7700000000  -0.4800000000

          ***** EQUILIBRIUM GEOMETRY LOCATED *****
 COORDINATES OF ALL ATOMS ARE (ANGS)
   ATOM   CHARGE       X              Y              Z
 ------------------------------------------------------------
 O           8.0    0.0000000000   0.0000000000   0.1173000000
 H           1.0    0.0000000000   0.7572000000  -0.4692000000
 H           1.0    0.0000000000  -0.7572000000  -0.4692000000
";

    #[test]
    fn every_coordinate_block_becomes_a_frame() {
        let s = parse(OPT).unwrap();
        assert_eq!(s.n_atoms, 3);
        assert_eq!(s.elements, vec![8, 1, 1]);
        assert_eq!(s.extra_frame_count(), 2);
        // Frame 0 is the first block; the last extra frame is the equilibrium one.
        assert!((s.positions[2] - 0.2).abs() < 1e-5);
        assert!((s.frame(1)[2] - 0.1173).abs() < 1e-5);
        assert!(s.hetero.is_none()); // constant topology ⇒ fast path
        assert_eq!(s.bonds.len(), 2);
    }

    #[test]
    fn honours_the_bohr_banner() {
        let text = "\
 COORDINATES OF ALL ATOMS ARE (BOHR)
   ATOM   CHARGE       X              Y              Z
 ------------------------------------------------------------
 H           1.0    0.0000000000   0.0000000000   0.0000000000
 H           1.0    1.4000000000   0.0000000000   0.0000000000
";
        let s = parse(text).unwrap();
        assert!(
            (s.positions[3] - 0.740848).abs() < 1e-4,
            "{}",
            s.positions[3]
        );
    }

    #[test]
    fn a_single_point_run_is_a_one_frame_structure() {
        let text = "\
 COORDINATES OF ALL ATOMS ARE (ANGS)
   ATOM   CHARGE       X              Y              Z
 ------------------------------------------------------------
 C           6.0    0.0000000000   0.0000000000   0.0000000000
 O           8.0    1.1280000000   0.0000000000   0.0000000000
";
        let s = parse(text).unwrap();
        assert_eq!(s.n_atoms, 2);
        assert_eq!(s.extra_frame_count(), 0);
    }

    #[test]
    fn an_ecp_fractional_charge_falls_back_to_the_atom_label() {
        // Pt with an ECP prints its valence charge, not Z = 78.
        let text = "\
 COORDINATES OF ALL ATOMS ARE (ANGS)
   ATOM   CHARGE       X              Y              Z
 ------------------------------------------------------------
 PT        200.0    0.0000000000   0.0000000000   0.0000000000
";
        let s = parse(text).unwrap();
        assert_eq!(s.elements, vec![78]);
    }

    #[test]
    fn a_rounded_charge_still_resolves_the_element() {
        let text = "\
 COORDINATES OF ALL ATOMS ARE (ANGS)
   ATOM   CHARGE       X              Y              Z
 ------------------------------------------------------------
 FE         25.9    0.0000000000   0.0000000000   0.0000000000
";
        let s = parse(text).unwrap();
        assert_eq!(s.elements, vec![26]);
    }

    #[test]
    fn stops_the_block_at_trailing_prose() {
        let text = "\
 COORDINATES OF ALL ATOMS ARE (ANGS)
   ATOM   CHARGE       X              Y              Z
 ------------------------------------------------------------
 H           1.0    0.0000000000   0.0000000000   0.0000000000
          INTERNUCLEAR DISTANCES (ANGS.)
 ------------------------------------------------------------
";
        let s = parse(text).unwrap();
        assert_eq!(s.n_atoms, 1);
    }

    #[test]
    fn varying_atom_counts_build_a_hetero_side_table() {
        let text = "\
 COORDINATES OF ALL ATOMS ARE (ANGS)
   ATOM   CHARGE       X              Y              Z
 ------------------------------------------------------------
 H           1.0    0.0000000000   0.0000000000   0.0000000000

 COORDINATES OF ALL ATOMS ARE (ANGS)
   ATOM   CHARGE       X              Y              Z
 ------------------------------------------------------------
 H           1.0    0.0000000000   0.0000000000   0.0000000000
 H           1.0    0.7400000000   0.0000000000   0.0000000000
";
        let s = parse(text).unwrap();
        let h = s.hetero.as_ref().expect("varying atoms ⇒ hetero table");
        assert!(h.varies_atoms);
        assert_eq!(h.max_atoms, 2);
        assert_eq!(s.frame_atom_count(0), 2);
    }

    #[test]
    fn rejects_a_file_with_no_coordinate_banner() {
        let err = match parse("some other program's output\n") {
            Ok(_) => panic!("expected an error"),
            Err(e) => e,
        };
        assert!(err.contains("not a GAMESS output"), "unexpected: {err}");
    }

    #[test]
    fn ignores_a_banner_with_an_empty_block() {
        let err = match parse(" COORDINATES OF ALL ATOMS ARE (ANGS)\n") {
            Ok(_) => panic!("expected an error"),
            Err(e) => e,
        };
        assert!(err.contains("not a GAMESS output"), "unexpected: {err}");
    }

    /// One geometry block of `(label, charge)` atoms laid out along x.
    fn block(atoms: &[(&str, &str)]) -> String {
        let mut text = String::from(
            " COORDINATES OF ALL ATOMS ARE (ANGS)\n   ATOM   CHARGE       X              Y              Z\n \
             ------------------------------------------------------------\n",
        );
        for (k, (label, charge)) in atoms.iter().enumerate() {
            text.push_str(&format!(
                " {label:<8} {charge:>6}    {:.10}   0.0000000000   0.0000000000\n",
                k as f32 * 3.0
            ));
        }
        text
    }

    #[test]
    fn an_ecp_valence_charge_resolves_to_the_labelled_element() {
        // ECP runs print the charge left after the core electrons are removed:
        // Pt with a 60-electron core shows 18.0 (not Ar), I with 28 shows 25.0
        // (not Mn) or with 46 shows 7.0 (not N), and so on.
        let s = parse(&block(&[
            ("PT", "18.0"),
            ("I", "25.0"),
            ("I1", "7.0"),
            ("AU", "19.0"),
            ("FE", "16.0"),
            ("CU", "11.0"),
            ("SI", "4.0"),
            ("C", "4.0"),
            ("GD", "11.0"), // large-core lanthanide: 4f in the 53-electron core
            ("U", "14.0"),
        ]))
        .unwrap();
        assert_eq!(s.elements, vec![78, 53, 53, 79, 26, 29, 14, 6, 64, 92]);
    }

    #[test]
    fn an_all_electron_charge_wins_over_a_label_that_merely_looks_like_an_element() {
        // A carbon named "CA", "CO1" or "CL", a nitrogen named "NA", a hydrogen
        // named "HG": the charge is the nuclear charge, and the difference to
        // the label's element is no ECP core, so the label must not win.
        let s = parse(&block(&[
            ("CA", "6.0"),
            ("CO1", "6.0"),
            ("CL", "6.0"),
            ("NA", "7.0"),
            ("HG", "1.0"),
            ("C1", "6.0"),
            ("O", "8.0"),
        ]))
        .unwrap();
        assert_eq!(s.elements, vec![6, 6, 6, 7, 1, 6, 8]);
    }

    #[test]
    fn a_labelled_atom_with_digits_resolves_when_the_charge_is_no_element() {
        let s = parse(&block(&[("PT1", "200.0"), ("BQ", "0.0")])).unwrap();
        assert_eq!(s.elements, vec![78, 0]);
    }

    #[test]
    fn ecp_core_sizes() {
        assert!(is_ecp_core(78, 60));
        assert!(is_ecp_core(6, 2));
        assert!(!is_ecp_core(20, 14));
        assert!(is_ecp_core(64, 53)); // Gd, 4f7 in the core
        assert!(!is_ecp_core(26, 53)); // only lanthanides put 4f in the core
        assert!(is_ecp_core(94, 84)); // Pu, 5f in the core
        assert!(!is_ecp_core(40, 84));
    }
}
