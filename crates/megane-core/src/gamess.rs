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
//! The nuclear-charge column gives the element directly. With ECPs the charge
//! is fractional (e.g. `28.0` printed as the valence charge), so it is rounded;
//! when it does not resolve to a real element the atom label is used instead.
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
use crate::parser::{HeteroFrames, ParsedStructure};
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
        // Nuclear charge → element; ECP runs print a fractional valence charge,
        // so fall back to the atom label when the rounded charge is not an element.
        let rounded = charge.round();
        let mut z_num = if (1.0..=118.0).contains(&rounded) {
            rounded as u8
        } else {
            0
        };
        if z_num == 0 {
            z_num = symbol_to_atomic_num(&capitalize(toks[0]));
        }
        elements.push(z_num);
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

    let mut frame_positions_flat: Vec<f32> = Vec::new();
    let mut atom_offsets: Vec<u32> = vec![0];
    let mut per_frame_elements: Vec<Vec<u8>> = Vec::new();
    let mut varies_atoms = false;
    let mut varies_topology = false;
    let mut max_atoms = n_atoms;
    for f in &frames {
        frame_positions_flat.extend_from_slice(&f.positions);
        let last = *atom_offsets.last().unwrap();
        atom_offsets.push(last + f.elements.len() as u32);
        max_atoms = max_atoms.max(f.elements.len());
        if f.elements.len() != n_atoms {
            varies_atoms = true;
        }
        if f.elements != first.elements {
            varies_topology = true;
        }
        per_frame_elements.push(f.elements.clone());
    }

    let empty = HashSet::new();
    let bonds = bonds::infer_bonds(&first.positions, &first.elements, n_atoms, &empty);

    // An optimisation keeps a fixed atom set, so the fast fixed-stride path is
    // the norm; the side table only appears if a log really does change atoms.
    let hetero = if varies_atoms || varies_topology {
        let mut elements_flat: Vec<u8> = Vec::new();
        let mut bonds_flat: Vec<u32> = Vec::new();
        let mut bond_offsets: Vec<u32> = vec![0];
        for (k, elems) in per_frame_elements.iter().enumerate() {
            let a = atom_offsets[k] as usize * 3;
            let b = atom_offsets[k + 1] as usize * 3;
            let fb = bonds::infer_bonds(&frame_positions_flat[a..b], elems, elems.len(), &empty);
            for (u, v) in &fb {
                bonds_flat.push(*u);
                bonds_flat.push(*v);
            }
            let last = *bond_offsets.last().unwrap();
            bond_offsets.push(last + fb.len() as u32);
            elements_flat.extend_from_slice(elems);
        }
        Some(HeteroFrames {
            atom_offsets,
            elements_flat,
            cells_flat: Vec::new(),
            bond_offsets,
            bonds_flat,
            varies_atoms,
            varies_cell: false,
            varies_topology,
            max_atoms: max_atoms as u32,
        })
    } else {
        None
    };

    Ok(ParsedStructure {
        n_atoms,
        positions: first.positions,
        elements: first.elements,
        bonds,
        n_file_bonds: 0,
        bond_orders: None,
        box_matrix: None,
        box_origin: None,
        frame_positions_flat,
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
        hetero,
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
}
