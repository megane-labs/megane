//! XCrySDen structure file parser (`.xsf` / `.axsf`).
//!
//! Keyword-block text format written by XCrySDen, Quantum ESPRESSO, and ASE:
//!
//! ```text
//! # a comment
//! CRYSTAL                     dimensionality: CRYSTAL | SLAB | POLYMER | MOLECULE | ATOMS
//! PRIMVEC                     3×3 primitive lattice vectors (Å)
//!   ax ay az
//!   bx by bz
//!   cx cy cz
//! CONVVEC                     conventional lattice vectors (parsed, not used)
//!   ...
//! PRIMCOORD
//!   2 1                       atom count + (ignored) group count
//!   14  0.0 0.0 0.0           Z (or symbol) x y z [fx fy fz]
//!   14  1.3 1.3 1.3
//! ```
//!
//! An animated file (`.axsf`) opens with `ANIMSTEPS n` and then repeats
//! `PRIMVEC n` / `PRIMCOORD n` (or `ATOMS n`) blocks — one per step. The cell
//! may vary between steps (variable-cell animation), which maps onto megane's
//! per-frame cell support.
//!
//! Handled but not rendered:
//! - Ghost/dummy atoms (negative Z) — kept in place as element 0 (unknown),
//!   with an aggregated warning, since the file asserts they are not atoms.
//! - `CONVVEC` — read and discarded; `PRIMVEC` is the cell megane draws.
//! - `BEGIN_BLOCK_DATAGRID_*` … `END_BLOCK_DATAGRID_*` volumetric grids are
//!   skipped wholesale. Mapping them onto the isosurface pipeline is a
//!   follow-up (see the `.dx` work).
//!
//! The optional per-atom force triple is exposed as a `force` vector channel,
//! the same mechanism GRO velocities use, so the Vector Overlay node can draw
//! it without any format-specific plumbing.

use crate::atomic::{capitalize, symbol_to_atomic_num};
use crate::bonds;
use crate::parser::{HeteroFrames, ParsedStructure};
use crate::trajectory::{VectorChannel, VectorFrame};
use std::collections::HashSet;

/// One parsed animation step.
struct Step {
    positions: Vec<f32>,
    elements: Vec<u8>,
    /// Per-atom force triple, empty when the step carries no forces.
    forces: Vec<f32>,
    cell: Option<[f32; 9]>,
}

/// Strip an inline `#` comment and surrounding whitespace.
fn clean(line: &str) -> &str {
    let no_comment = match line.find('#') {
        Some(i) => &line[..i],
        None => line,
    };
    no_comment.trim()
}

/// The leading keyword of a line, upper-cased, or `""` for a blank/comment line.
fn keyword(line: &str) -> String {
    clean(line)
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_uppercase()
}

/// Decoded atom line: element, ghost flag, position, optional force vector.
type AtomLine = (u8, bool, [f32; 3], Option<[f32; 3]>);

/// Parse an atom line: `Z x y z [fx fy fz]`, where the first column is either
/// an atomic number or an element symbol. The boolean flags a ghost atom.
fn parse_atom_line(line: &str) -> Option<AtomLine> {
    let toks: Vec<&str> = clean(line).split_whitespace().collect();
    if toks.len() < 4 {
        return None;
    }
    let (z, ghost) = match toks[0].parse::<i32>() {
        // XCrySDen marks ghost/dummy atoms with a negative Z: the file asserts
        // they are NOT real atoms, so they become element 0 (unknown) rather
        // than the magnitude's element.
        Ok(n) if n < 0 => (0u8, true),
        Ok(n) => ((n as u32).min(u8::MAX as u32) as u8, false),
        Err(_) => (symbol_to_atomic_num(&capitalize(toks[0])), false),
    };
    let x = toks[1].parse().ok()?;
    let y = toks[2].parse().ok()?;
    let zc = toks[3].parse().ok()?;
    let force = if toks.len() >= 7 {
        match (
            toks[4].parse::<f32>(),
            toks[5].parse::<f32>(),
            toks[6].parse::<f32>(),
        ) {
            (Ok(fx), Ok(fy), Ok(fz)) => Some([fx, fy, fz]),
            _ => None,
        }
    } else {
        None
    };
    Some((z, ghost, [x, y, zc], force))
}

/// Read three lattice-vector lines starting at `i`, returning the row-major cell.
fn read_cell(lines: &[&str], i: &mut usize) -> Result<[f32; 9], String> {
    let mut cell = [0.0f32; 9];
    let mut row = 0;
    while row < 3 {
        if *i >= lines.len() {
            return Err("XSF: truncated lattice-vector block".into());
        }
        let t = clean(lines[*i]);
        *i += 1;
        if t.is_empty() {
            continue;
        }
        let v: Vec<f32> = t
            .split_whitespace()
            .filter_map(|s| s.parse().ok())
            .collect();
        if v.len() < 3 {
            return Err(format!("XSF: bad lattice vector: {t}"));
        }
        cell[row * 3] = v[0];
        cell[row * 3 + 1] = v[1];
        cell[row * 3 + 2] = v[2];
        row += 1;
    }
    Ok(cell)
}

/// Parse an XCrySDen `.xsf` / `.axsf` text into a (possibly animated) structure.
pub fn parse(text: &str) -> Result<ParsedStructure, String> {
    let lines: Vec<&str> = text.lines().collect();
    let mut steps: Vec<Step> = Vec::new();
    // The most recently seen PRIMVEC. A fixed-cell animation declares it once
    // before the first PRIMCOORD, so later steps inherit it.
    let mut current_cell: Option<[f32; 9]> = None;
    let mut saw_keyword = false;
    // Ghost/dummy atoms (negative Z) across every block, for one aggregated warning.
    let mut ghost_count = 0usize;

    let mut i = 0usize;
    while i < lines.len() {
        let kw = keyword(lines[i]);
        match kw.as_str() {
            "" => {
                i += 1;
            }
            "ANIMSTEPS" | "CRYSTAL" | "SLAB" | "POLYMER" | "MOLECULE" => {
                saw_keyword = true;
                i += 1;
            }
            "PRIMVEC" => {
                saw_keyword = true;
                i += 1;
                current_cell = Some(read_cell(&lines, &mut i)?);
            }
            "CONVVEC" => {
                // Conventional cell: consumed so its three rows are not mistaken
                // for atom lines, then discarded (PRIMVEC is what we draw).
                saw_keyword = true;
                i += 1;
                read_cell(&lines, &mut i)?;
            }
            "PRIMCOORD" | "ATOMS" => {
                saw_keyword = true;
                let counted = kw == "PRIMCOORD";
                i += 1;
                let mut positions = Vec::new();
                let mut elements = Vec::new();
                let mut forces = Vec::new();
                let mut all_have_forces = true;

                let declared = if counted {
                    // Count line: `natoms [ngroups]`.
                    while i < lines.len() && clean(lines[i]).is_empty() {
                        i += 1;
                    }
                    if i >= lines.len() {
                        return Err("XSF: PRIMCOORD without an atom-count line".into());
                    }
                    let n: usize = clean(lines[i])
                        .split_whitespace()
                        .next()
                        .and_then(|t| t.parse().ok())
                        .ok_or("XSF: PRIMCOORD atom count is not an integer")?;
                    i += 1;
                    Some(n)
                } else {
                    None
                };

                loop {
                    if let Some(n) = declared {
                        if elements.len() == n {
                            break;
                        }
                    }
                    if i >= lines.len() {
                        break;
                    }
                    let t = clean(lines[i]);
                    if t.is_empty() {
                        i += 1;
                        continue;
                    }
                    // An unnumbered `ATOMS` block ends at the next keyword.
                    if declared.is_none() && parse_atom_line(lines[i]).is_none() {
                        break;
                    }
                    let (z, ghost, pos, force) = parse_atom_line(lines[i])
                        .ok_or_else(|| format!("XSF: bad atom line: {t}"))?;
                    i += 1;
                    if ghost {
                        ghost_count += 1;
                    }
                    elements.push(z);
                    positions.extend_from_slice(&pos);
                    match force {
                        Some(f) => forces.extend_from_slice(&f),
                        None => all_have_forces = false,
                    }
                }

                if let Some(n) = declared {
                    if elements.len() != n {
                        return Err(format!(
                            "XSF: PRIMCOORD declares {n} atoms but only {} were readable",
                            elements.len()
                        ));
                    }
                }
                if elements.is_empty() {
                    return Err("XSF: coordinate block contains no atoms".into());
                }

                steps.push(Step {
                    positions,
                    elements,
                    forces: if all_have_forces { forces } else { Vec::new() },
                    cell: current_cell,
                });
            }
            "BEGIN_BLOCK_DATAGRID_3D"
            | "BEGIN_BLOCK_DATAGRID_2D"
            | "BEGIN_BLOCK_DATAGRID3D"
            | "BEGIN_BLOCK_DATAGRID2D" => {
                // Volumetric payload: skip to the matching END_BLOCK line.
                // Mapping grids onto the isosurface pipeline is a follow-up.
                i += 1;
                while i < lines.len() && !keyword(lines[i]).starts_with("END_BLOCK_DATAGRID") {
                    i += 1;
                }
                i += 1; // consume the END_BLOCK line itself
            }
            _ => {
                i += 1;
            }
        }
    }

    if steps.is_empty() {
        return Err(if saw_keyword {
            "XSF file contains no PRIMCOORD or ATOMS block".into()
        } else {
            "not an XCrySDen (XSF) file: no recognised keyword found".to_string()
        });
    }

    // Frame 0 defines the topology; the remaining steps become extra frames.
    let first = steps.remove(0);
    let n_atoms = first.elements.len();
    let base_cell = first.cell;

    let mut frame_positions_flat: Vec<f32> = Vec::new();
    let mut atom_offsets: Vec<u32> = vec![0];
    let mut per_frame_cells: Vec<[f32; 9]> = Vec::new();
    let mut per_frame_elements: Vec<Vec<u8>> = Vec::new();
    let mut varies_atoms = false;
    let mut varies_cell = false;
    let mut varies_topology = false;
    let mut max_atoms = n_atoms;
    let mut force_frames: Vec<VectorFrame> = Vec::new();
    if !first.forces.is_empty() {
        force_frames.push(VectorFrame {
            frame: 0,
            vectors: first.forces.clone(),
        });
    }

    for (k, step) in steps.iter().enumerate() {
        frame_positions_flat.extend_from_slice(&step.positions);
        let last = *atom_offsets.last().unwrap();
        atom_offsets.push(last + step.elements.len() as u32);
        max_atoms = max_atoms.max(step.elements.len());
        if step.elements.len() != n_atoms {
            varies_atoms = true;
        }
        if step.elements != first.elements {
            varies_topology = true;
        }
        if step.cell != base_cell {
            varies_cell = true;
        }
        per_frame_cells.push(step.cell.or(base_cell).unwrap_or([0.0; 9]));
        per_frame_elements.push(step.elements.clone());
        if !step.forces.is_empty() {
            force_frames.push(VectorFrame {
                frame: k + 1,
                vectors: step.forces.clone(),
            });
        }
    }

    let empty_bonds = HashSet::new();
    let bonds = bonds::infer_bonds(&first.positions, &first.elements, n_atoms, &empty_bonds);

    let hetero = if varies_atoms || varies_cell || varies_topology {
        let (elements_flat, bonds_flat, bond_offsets) = if varies_atoms || varies_topology {
            let mut elements_flat: Vec<u8> = Vec::new();
            let mut bonds_flat: Vec<u32> = Vec::new();
            let mut bond_offsets: Vec<u32> = vec![0];
            for (k, elems) in per_frame_elements.iter().enumerate() {
                let a = atom_offsets[k] as usize * 3;
                let b = atom_offsets[k + 1] as usize * 3;
                let fbonds = bonds::infer_bonds(
                    &frame_positions_flat[a..b],
                    elems,
                    elems.len(),
                    &empty_bonds,
                );
                for (u, v) in &fbonds {
                    bonds_flat.push(*u);
                    bonds_flat.push(*v);
                }
                let last = *bond_offsets.last().unwrap();
                bond_offsets.push(last + fbonds.len() as u32);
                elements_flat.extend_from_slice(elems);
            }
            (elements_flat, bonds_flat, bond_offsets)
        } else {
            (Vec::new(), Vec::new(), Vec::new())
        };
        let cells_flat = if varies_cell {
            let mut cf = Vec::with_capacity(per_frame_cells.len() * 9);
            for c in &per_frame_cells {
                cf.extend_from_slice(c);
            }
            cf
        } else {
            Vec::new()
        };
        Some(HeteroFrames {
            atom_offsets,
            elements_flat,
            cells_flat,
            bond_offsets,
            bonds_flat,
            varies_atoms,
            varies_cell,
            varies_topology,
            max_atoms: max_atoms as u32,
        })
    } else {
        None
    };

    let mut warnings = Vec::new();
    if ghost_count > 0 {
        warnings.push(format!(
            "{ghost_count} ghost/dummy atoms (negative atomic numbers) kept as element 0"
        ));
    }

    let vector_channels = if force_frames.is_empty() {
        vec![]
    } else {
        vec![VectorChannel {
            name: "force".to_string(),
            frames: force_frames,
        }]
    };

    Ok(ParsedStructure {
        n_atoms,
        positions: first.positions,
        elements: first.elements,
        bonds,
        n_file_bonds: 0,
        bond_orders: None,
        box_matrix: base_cell,
        box_origin: None,
        frame_positions_flat,
        atom_labels: None,
        chain_ids: None,
        bfactors: None,
        vector_channels,
        ca_indices: vec![],
        ca_chain_ids: vec![],
        ca_res_nums: vec![],
        ca_ss_type: vec![],
        symmetry_ops: Vec::new(),
        scalar_channels: Vec::new(),
        warnings,
        hetero,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CRYSTAL_XSF: &str = "\
# Si primitive cell written by Quantum ESPRESSO
CRYSTAL
PRIMVEC
    2.7150000000    2.7150000000    0.0000000000
    0.0000000000    2.7150000000    2.7150000000
    2.7150000000    0.0000000000    2.7150000000
CONVVEC
    5.4300000000    0.0000000000    0.0000000000
    0.0000000000    5.4300000000    0.0000000000
    0.0000000000    0.0000000000    5.4300000000
PRIMCOORD
    2 1
   14    0.0000000000    0.0000000000    0.0000000000
   14    1.3575000000    1.3575000000    1.3575000000
";

    #[test]
    fn parses_crystal_with_primvec_and_primcoord() {
        let s = parse(CRYSTAL_XSF).unwrap();
        assert_eq!(s.n_atoms, 2);
        assert_eq!(s.elements, vec![14, 14]);
        assert_eq!(s.extra_frame_count(), 0);
        // PRIMVEC is the cell we draw; CONVVEC is consumed and discarded.
        let cell = s.box_matrix.unwrap();
        assert!((cell[0] - 2.715).abs() < 1e-4);
        assert!((cell[1] - 2.715).abs() < 1e-4);
        assert!((s.positions[3] - 1.3575).abs() < 1e-4);
        assert!(s.vector_channels.is_empty());
    }

    #[test]
    fn parses_molecule_atoms_block_without_a_count() {
        let text = "\
MOLECULE
ATOMS
 8   0.000000   0.000000   0.117300
 1   0.000000   0.757200  -0.469200
 1   0.000000  -0.757200  -0.469200
";
        let s = parse(text).unwrap();
        assert_eq!(s.n_atoms, 3);
        assert_eq!(s.elements, vec![8, 1, 1]);
        assert!(s.box_matrix.is_none());
        // O–H bonds inferred by distance.
        assert_eq!(s.bonds.len(), 2);
    }

    #[test]
    fn accepts_element_symbols_in_place_of_atomic_numbers() {
        let text = "\
ATOMS
 O   0.000000   0.000000   0.117300
 H   0.000000   0.757200  -0.469200
 H   0.000000  -0.757200  -0.469200
";
        let s = parse(text).unwrap();
        assert_eq!(s.elements, vec![8, 1, 1]);
    }

    #[test]
    fn exposes_the_optional_force_triple_as_a_vector_channel() {
        let text = "\
ATOMS
 8   0.0   0.0   0.0    0.10  0.20  0.30
 1   0.0   0.0   1.0   -0.10 -0.20 -0.30
";
        let s = parse(text).unwrap();
        assert_eq!(s.vector_channels.len(), 1);
        let ch = &s.vector_channels[0];
        assert_eq!(ch.name, "force");
        assert_eq!(ch.frames.len(), 1);
        assert_eq!(ch.frames[0].vectors.len(), 6);
        assert!((ch.frames[0].vectors[0] - 0.10).abs() < 1e-6);
        assert!((ch.frames[0].vectors[5] + 0.30).abs() < 1e-6);
    }

    #[test]
    fn a_partial_force_column_disables_the_channel() {
        let text = "\
ATOMS
 8   0.0   0.0   0.0    0.10  0.20  0.30
 1   0.0   0.0   1.0
";
        let s = parse(text).unwrap();
        assert!(s.vector_channels.is_empty());
    }

    #[test]
    fn parses_animated_axsf_with_a_fixed_cell() {
        let text = "\
ANIMSTEPS 3
CRYSTAL
PRIMVEC
    5.0 0.0 0.0
    0.0 5.0 0.0
    0.0 0.0 5.0
PRIMCOORD 1
 1 1
 14  0.0 0.0 0.0
PRIMCOORD 2
 1 1
 14  0.1 0.0 0.0
PRIMCOORD 3
 1 1
 14  0.2 0.0 0.0
";
        let s = parse(text).unwrap();
        assert_eq!(s.n_atoms, 1);
        assert_eq!(s.extra_frame_count(), 2);
        assert!((s.frame(0)[0] - 0.1).abs() < 1e-6);
        assert!((s.frame(1)[0] - 0.2).abs() < 1e-6);
        // Constant cell ⇒ fast fixed-stride path, no side table.
        assert!(s.hetero.is_none());
    }

    #[test]
    fn variable_cell_animation_records_per_frame_cells() {
        let text = "\
ANIMSTEPS 2
CRYSTAL
PRIMVEC 1
    5.0 0.0 0.0
    0.0 5.0 0.0
    0.0 0.0 5.0
PRIMCOORD 1
 1 1
 14  0.0 0.0 0.0
PRIMVEC 2
    5.5 0.0 0.0
    0.0 5.5 0.0
    0.0 0.0 5.5
PRIMCOORD 2
 1 1
 14  0.1 0.0 0.0
";
        let s = parse(text).unwrap();
        assert_eq!(s.extra_frame_count(), 1);
        let h = s
            .hetero
            .as_ref()
            .expect("variable cell ⇒ hetero side table");
        assert!(h.varies_cell);
        assert!((h.cells_flat[0] - 5.5).abs() < 1e-6);
    }

    #[test]
    fn animated_forces_are_frame_synced() {
        let text = "\
ANIMSTEPS 2
ATOMS 1
 14  0.0 0.0 0.0   1.0 0.0 0.0
ATOMS 2
 14  0.1 0.0 0.0   2.0 0.0 0.0
";
        let s = parse(text).unwrap();
        assert_eq!(s.extra_frame_count(), 1);
        let ch = &s.vector_channels[0];
        assert_eq!(ch.frames.len(), 2);
        assert_eq!(ch.frames[0].frame, 0);
        assert_eq!(ch.frames[1].frame, 1);
        assert!((ch.frames[1].vectors[0] - 2.0).abs() < 1e-6);
    }

    #[test]
    fn skips_datagrid_blocks() {
        let text = "\
CRYSTAL
PRIMVEC
    5.0 0.0 0.0
    0.0 5.0 0.0
    0.0 0.0 5.0
PRIMCOORD
 1 1
 14  0.0 0.0 0.0
BEGIN_BLOCK_DATAGRID_3D
  my_datagrid
  BEGIN_DATAGRID_3D_density
    2 2 2
    0.0 0.0 0.0
    5.0 0.0 0.0
    0.0 5.0 0.0
    0.0 0.0 5.0
    0.1 0.2 0.3 0.4
    0.5 0.6 0.7 0.8
  END_DATAGRID_3D
END_BLOCK_DATAGRID_3D
";
        let s = parse(text).unwrap();
        assert_eq!(s.n_atoms, 1);
        assert_eq!(s.extra_frame_count(), 0);
    }

    #[test]
    fn strips_comments_and_blank_lines() {
        let text = "\
# leading comment

ATOMS
 14  0.0 0.0 0.0   # trailing comment

 14  1.0 0.0 0.0
";
        let s = parse(text).unwrap();
        assert_eq!(s.n_atoms, 2);
    }

    #[test]
    fn ghost_atom_becomes_element_zero_with_a_warning() {
        // XCrySDen writes ghost atoms with a negative Z: not silicon, not
        // carbon — a placeholder, kept as the "unknown" element.
        let s = parse("ATOMS\n -6  1.0 2.0 3.0\n  8  0.0 0.0 0.0\n").unwrap();
        assert_eq!(s.elements, vec![0, 8]);
        assert_eq!(s.n_atoms, 2);
        assert!((s.positions[0] - 1.0).abs() < 1e-6);
        assert!((s.positions[2] - 3.0).abs() < 1e-6);
        assert_eq!(s.warnings.len(), 1);
        assert!(
            s.warnings[0].contains("1 ghost/dummy atoms"),
            "unexpected warning: {}",
            s.warnings[0]
        );
    }

    #[test]
    fn all_positive_atomic_numbers_produce_no_warnings() {
        let s = parse(CRYSTAL_XSF).unwrap();
        assert_eq!(s.elements, vec![14, 14]);
        assert!(s.warnings.is_empty());
    }

    #[test]
    fn ghost_atoms_across_animation_frames_share_one_aggregated_warning() {
        let text = "\
ANIMSTEPS 2
ATOMS 1
 -14  0.0 0.0 0.0
  14  1.0 0.0 0.0
ATOMS 2
 -14  0.1 0.0 0.0
  14  1.1 0.0 0.0
";
        let s = parse(text).unwrap();
        assert_eq!(s.elements, vec![0, 14]);
        assert_eq!(s.warnings.len(), 1);
        assert!(
            s.warnings[0].contains("2 ghost/dummy atoms"),
            "unexpected warning: {}",
            s.warnings[0]
        );
    }

    #[test]
    fn rejects_a_file_with_no_keywords() {
        let err = match parse("just some text\nand more\n") {
            Ok(_) => panic!("expected an error"),
            Err(e) => e,
        };
        assert!(err.contains("not an XCrySDen"), "unexpected error: {err}");
    }

    #[test]
    fn rejects_a_primcoord_count_mismatch() {
        let text = "\
CRYSTAL
PRIMCOORD
 3 1
 14  0.0 0.0 0.0
";
        let err = match parse(text) {
            Ok(_) => panic!("expected an error"),
            Err(e) => e,
        };
        assert!(err.contains("declares 3 atoms"), "unexpected error: {err}");
    }

    #[test]
    fn rejects_a_truncated_primvec() {
        let text = "CRYSTAL\nPRIMVEC\n 5.0 0.0 0.0\n";
        assert!(parse(text).is_err());
    }

    #[test]
    fn rejects_a_keyword_only_file() {
        let err = match parse("CRYSTAL\n") {
            Ok(_) => panic!("expected an error"),
            Err(e) => e,
        };
        assert!(err.contains("no PRIMCOORD"), "unexpected error: {err}");
    }
}
