//! VASP structure file parser (POSCAR / CONTCAR / XDATCAR, also `.vasp`).
//!
//! Layout of a POSCAR / CONTCAR:
//!
//! ```text
//! comment line
//!   1.0                      universal scaling factor
//!     a1x a1y a1z            lattice vector a
//!     a2x a2y a2z            lattice vector b
//!     a3x a3y a3z            lattice vector c
//!   Si  O                    species names (VASP 5+; absent in VASP 4)
//!    2  4                    atom counts per species
//! Selective dynamics         optional
//! Direct                     or Cartesian
//!   0.0 0.0 0.0  T T T       coordinates (+ optional selective-dynamics flags)
//!   ...
//! ```
//!
//! An XDATCAR repeats the same header and then carries one
//! `Direct configuration=  N` block per frame. Variable-cell runs (ISIF ≥ 3)
//! re-emit the whole header before every configuration, so the cell — and in
//! principle the species — may change between frames; both shapes are handled.
//!
//! Notes:
//! - `Selective dynamics` flags are not rendered, but they are kept as a
//!   static `selective_dynamics` scalar channel (see [`selective_flags`]) so
//!   the information the file carries is not discarded.
//! - A VASP 4 file has no species line. Rather than erroring, the species index
//!   (1, 2, 3, …) is used as an atomic-number *proxy* — exactly the convention
//!   the LAMMPS dump reader uses for its integer `type` ids — and every atom is
//!   labelled `Type<N> (no species line)` so the viewer surfaces the situation.
//! - A trailing velocity / predictor-corrector block is skipped, not parsed.

use crate::atomic::{capitalize, symbol_to_atomic_num};
use crate::bonds;
use crate::parser::{HeteroFrames, ParsedStructure};
use crate::trajectory::{ScalarChannel, ScalarFrame};
use std::collections::HashSet;

/// The fixed header of a POSCAR / XDATCAR block.
struct Header {
    /// Row-major 3×3 lattice, already multiplied by the universal scaling factor.
    cell: [f32; 9],
    /// Per-atom atomic numbers (species expanded by their counts).
    elements: Vec<u8>,
    /// Per-atom label, only populated for VASP 4 files with no species line.
    placeholder_labels: Option<Vec<String>>,
    /// Universal scaling factor, needed to scale `Cartesian` coordinates.
    scale: f32,
    /// Line index (into `lines`) just past the header.
    next: usize,
}

/// Row-major 3×3 determinant, i.e. the (signed) cell volume.
fn det3(m: &[f32; 9]) -> f32 {
    m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6])
        + m[2] * (m[3] * m[7] - m[4] * m[6])
}

/// Parse whitespace-separated floats from a line.
fn floats(line: &str) -> Vec<f32> {
    line.split_whitespace()
        .filter_map(|t| t.parse().ok())
        .collect()
}

/// True when every whitespace-separated token parses as a positive integer.
/// This is how the atom-count line is told apart from the species-name line.
fn is_count_line(line: &str) -> bool {
    let mut any = false;
    for tok in line.split_whitespace() {
        match tok.parse::<usize>() {
            Ok(_) => any = true,
            Err(_) => return false,
        }
    }
    any
}

/// Parse the header block starting at `start`.
fn parse_header(lines: &[&str], start: usize) -> Result<Header, String> {
    // Line 1: free-form comment (in VASP 4 it often holds the species names,
    // but that is a convention we deliberately do not guess at).
    let mut i = start + 1;
    if i >= lines.len() {
        return Err("VASP file truncated after comment line".into());
    }

    // Line 2: universal scaling factor. A single value scales all three
    // vectors; three values scale each axis independently; a negative single
    // value is the *target volume* in Å³.
    let scale_vals = floats(lines[i]);
    if scale_vals.is_empty() {
        return Err(format!("VASP: missing scaling factor at line {}", i + 1));
    }
    i += 1;

    // Lines 3–5: lattice vectors.
    if i + 3 > lines.len() {
        return Err("VASP: truncated lattice block".into());
    }
    let mut cell = [0.0f32; 9];
    for row in 0..3 {
        let v = floats(lines[i + row]);
        if v.len() < 3 {
            return Err(format!("VASP: bad lattice vector at line {}", i + row + 1));
        }
        cell[row * 3] = v[0];
        cell[row * 3 + 1] = v[1];
        cell[row * 3 + 2] = v[2];
    }
    i += 3;

    // Apply the scaling factor to the cell.
    let uniform_scale = if scale_vals.len() >= 3 {
        for row in 0..3 {
            for col in 0..3 {
                cell[row * 3 + col] *= scale_vals[row];
            }
        }
        1.0
    } else {
        let s = scale_vals[0];
        let factor = if s < 0.0 {
            // Negative ⇒ target volume; derive the isotropic scale from it.
            let vol = det3(&cell).abs();
            if vol <= 0.0 {
                return Err("VASP: negative scaling factor with a degenerate cell".into());
            }
            (-s / vol).cbrt()
        } else {
            s
        };
        for c in cell.iter_mut() {
            *c *= factor;
        }
        factor
    };

    // Optional species line (VASP 5+), then the per-species counts.
    if i >= lines.len() {
        return Err("VASP: truncated before atom counts".into());
    }
    let species: Option<Vec<String>> = if is_count_line(lines[i]) {
        None
    } else {
        let names: Vec<String> = lines[i]
            .split_whitespace()
            .map(|t| capitalize(t.split(['_', '/']).next().unwrap_or(t)))
            .collect();
        i += 1;
        Some(names)
    };

    if i >= lines.len() || !is_count_line(lines[i]) {
        return Err(format!(
            "VASP: expected per-species atom counts at line {}",
            i + 1
        ));
    }
    let counts: Vec<usize> = lines[i]
        .split_whitespace()
        .filter_map(|t| t.parse().ok())
        .collect();
    i += 1;

    // Expand species × counts into per-atom atomic numbers.
    let total: usize = counts.iter().sum();
    if total == 0 {
        return Err("VASP: file declares zero atoms".into());
    }
    let mut elements = Vec::with_capacity(total);
    let mut placeholder_labels = None;
    match &species {
        Some(names) => {
            for (si, &n) in counts.iter().enumerate() {
                let z = names.get(si).map(|s| symbol_to_atomic_num(s)).unwrap_or(0);
                elements.extend(std::iter::repeat_n(z, n));
            }
        }
        None => {
            // VASP 4: no species names (they live in POTCAR). Use the 1-based
            // species index as an atomic-number proxy and say so in the labels.
            let mut labels = Vec::with_capacity(total);
            for (si, &n) in counts.iter().enumerate() {
                let proxy = (si + 1).min(u8::MAX as usize) as u8;
                elements.extend(std::iter::repeat_n(proxy, n));
                for _ in 0..n {
                    labels.push(format!("Type{} (no species line)", si + 1));
                }
            }
            placeholder_labels = Some(labels);
        }
    }

    Ok(Header {
        cell,
        elements,
        placeholder_labels,
        scale: uniform_scale,
        next: i,
    })
}

/// Strict coordinate-mode test: recognises only the spellings VASP writers
/// actually emit (`Direct`, `Direct configuration=  N`, `Cartesian`, `D`, `C`,
/// `K`). Used to spot the start of the *next* XDATCAR frame, where a loose
/// first-character rule would misfire on a header comment such as `Cu bulk`.
fn strict_mode(line: &str) -> Option<bool> {
    let lower = line.trim().to_ascii_lowercase();
    if lower.starts_with("direct") || lower == "d" {
        Some(true)
    } else if lower.starts_with("cartesian") || lower == "c" || lower == "k" {
        Some(false)
    } else {
        None
    }
}

/// VASP's own rule for the mode line: only the first non-blank character
/// matters, and anything that is not `D`/`d` means Cartesian. Applied as a
/// fallback in the one position where the line is guaranteed to be a mode line
/// (immediately after the header).
fn loose_mode(line: &str) -> Option<bool> {
    let c = line.trim_start().chars().next()?.to_ascii_lowercase();
    match c {
        'd' => Some(true),
        'c' | 'k' => Some(false),
        _ => None,
    }
}

/// Consume the optional `Selective dynamics` flag line plus the mandatory
/// `Direct` / `Cartesian` mode line, starting at `i`.
/// Returns `(direct, index of the first coordinate line, selective dynamics)`.
fn read_mode(lines: &[&str], mut i: usize) -> Option<(bool, usize, bool)> {
    let skip_blank = |lines: &[&str], mut k: usize| {
        while k < lines.len() && lines[k].trim().is_empty() {
            k += 1;
        }
        k
    };
    i = skip_blank(lines, i);
    if i >= lines.len() {
        return None;
    }
    if let Some(d) = strict_mode(lines[i]).or_else(|| loose_mode(lines[i])) {
        return Some((d, i + 1, false));
    }
    // Not a mode line — in this position that can only be the optional
    // `Selective dynamics` flag, so skip it and require a mode line next.
    i = skip_blank(lines, i + 1);
    if i >= lines.len() {
        return None;
    }
    let d = strict_mode(lines[i]).or_else(|| loose_mode(lines[i]))?;
    Some((d, i + 1, true))
}

/// Decode the selective-dynamics `T`/`F` flags on one coordinate line into a
/// bitmask stored as a float: x = 1, y = 2, z = 4, with a set bit meaning `T`
/// (the atom may move along that axis). `7.0` is fully movable, `0.0` fully
/// frozen. A missing flag defaults to movable, matching VASP.
fn selective_flags(line: &str) -> f32 {
    let toks: Vec<&str> = line.split_whitespace().collect();
    let mut mask = 0u8;
    for (k, bit) in [(3usize, 1u8), (4, 2), (5, 4)] {
        let movable = toks
            .get(k)
            .map(|t| t.starts_with('T') || t.starts_with('t'))
            .unwrap_or(true);
        if movable {
            mask |= bit;
        }
    }
    mask as f32
}

/// Read `n` coordinate lines starting at `start`, converting to Cartesian Å.
fn read_positions(
    lines: &[&str],
    start: usize,
    n: usize,
    direct: bool,
    cell: &[f32; 9],
    scale: f32,
) -> Result<Vec<f32>, String> {
    if start + n > lines.len() {
        return Err("VASP: truncated coordinate block".into());
    }
    let mut positions = Vec::with_capacity(n * 3);
    for k in 0..n {
        let v = floats(lines[start + k]);
        if v.len() < 3 {
            return Err(format!("VASP: bad coordinate line {}", start + k + 1));
        }
        let (a, b, c) = (v[0], v[1], v[2]);
        if direct {
            positions.push(a * cell[0] + b * cell[3] + c * cell[6]);
            positions.push(a * cell[1] + b * cell[4] + c * cell[7]);
            positions.push(a * cell[2] + b * cell[5] + c * cell[8]);
        } else {
            positions.push(a * scale);
            positions.push(b * scale);
            positions.push(c * scale);
        }
    }
    Ok(positions)
}

/// Parse a VASP POSCAR / CONTCAR / XDATCAR text into a (possibly multi-frame)
/// structure.
pub fn parse(text: &str) -> Result<ParsedStructure, String> {
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() < 7 {
        return Err("VASP file too short".into());
    }

    let header = parse_header(&lines, 0)?;
    let n_atoms = header.elements.len();
    let mut cell = header.cell;
    let mut scale = header.scale;
    let mut elements = header.elements;
    let placeholder_labels = header.placeholder_labels;
    let i = header.next;

    let mut first_positions: Option<Vec<f32>> = None;
    let mut frame_positions_flat: Vec<f32> = Vec::new();
    let mut per_frame_cells: Vec<[f32; 9]> = Vec::new();
    let mut varies_cell = false;
    let base_cell = cell;

    let (mut direct, mut ci, selective) =
        read_mode(&lines, i).ok_or("VASP: missing Direct/Cartesian coordinate-mode line")?;

    // Selective-dynamics flags from the first coordinate block, kept as a
    // static bitmask channel (see `selective_flags` for the encoding).
    let mut sd_flags: Option<Vec<f32>> = None;

    loop {
        let positions = read_positions(&lines, ci, n_atoms, direct, &cell, scale)?;

        if first_positions.is_none() && selective {
            sd_flags = Some(
                (0..n_atoms)
                    .map(|k| selective_flags(lines[ci + k]))
                    .collect(),
            );
        }
        ci += n_atoms;

        if first_positions.is_none() {
            first_positions = Some(positions);
        } else {
            frame_positions_flat.extend_from_slice(&positions);
            if cell != base_cell {
                varies_cell = true;
            }
            per_frame_cells.push(cell);
        }

        // Look for another frame. Three things can follow a coordinate block:
        // another XDATCAR mode line, a re-emitted header (variable-cell run),
        // or a trailing velocity / predictor-corrector block that is *not* a
        // frame and must not be read as one.
        let mut peek = ci;
        while peek < lines.len() && lines[peek].trim().is_empty() {
            peek += 1;
        }
        if peek >= lines.len() {
            break;
        }
        if strict_mode(lines[peek]).is_some() {
            let Some((d, next, _)) = read_mode(&lines, peek) else {
                break;
            };
            direct = d;
            ci = next;
            continue;
        }
        if is_coordinate_like(lines[peek]) {
            break; // velocity block
        }
        // A variable-cell XDATCAR re-emits the whole header before each frame.
        let Ok(h) = parse_header(&lines, peek) else {
            break; // trailing content we do not recognise — stop cleanly
        };
        if h.elements.len() != n_atoms {
            return Err(
                "VASP: XDATCAR frame changes the atom count, which VASP does not emit".into(),
            );
        }
        cell = h.cell;
        scale = h.scale;
        elements = h.elements;
        let Some((d, next, _)) = read_mode(&lines, h.next) else {
            break;
        };
        direct = d;
        ci = next;
    }

    let positions = first_positions.ok_or("VASP file contains no coordinate block")?;

    let empty_bonds = HashSet::new();
    let bonds = bonds::infer_bonds(&positions, &elements, n_atoms, &empty_bonds);

    let hetero = if varies_cell {
        let mut cells_flat = Vec::with_capacity(per_frame_cells.len() * 9);
        for c in &per_frame_cells {
            cells_flat.extend_from_slice(c);
        }
        let mut atom_offsets = Vec::with_capacity(per_frame_cells.len() + 1);
        for k in 0..=per_frame_cells.len() {
            atom_offsets.push((k * n_atoms) as u32);
        }
        Some(HeteroFrames {
            atom_offsets,
            elements_flat: Vec::new(),
            cells_flat,
            bond_offsets: Vec::new(),
            bonds_flat: Vec::new(),
            varies_atoms: false,
            varies_cell: true,
            varies_topology: false,
            max_atoms: n_atoms as u32,
        })
    } else {
        None
    };

    let scalar_channels = match sd_flags {
        Some(values) => vec![ScalarChannel {
            name: "selective_dynamics".into(),
            frames: vec![ScalarFrame { frame: 0, values }],
        }],
        None => Vec::new(),
    };

    Ok(ParsedStructure {
        n_atoms,
        positions,
        elements,
        bonds,
        n_file_bonds: 0,
        bond_orders: None,
        box_matrix: Some(base_cell),
        box_origin: None,
        frame_positions_flat,
        atom_labels: placeholder_labels,
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
        hetero,
    })
}

/// True when a line looks like a bare coordinate triple — used to tell a
/// trailing velocity block (which is coordinate-like) from the start of the
/// next XDATCAR header (which is a free-form comment).
fn is_coordinate_like(line: &str) -> bool {
    let toks: Vec<&str> = line.split_whitespace().collect();
    toks.len() >= 3 && toks[..3].iter().all(|t| t.parse::<f32>().is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    const POSCAR_DIRECT: &str = "\
Si2 primitive
   1.0
     2.7150000000    2.7150000000    0.0000000000
     0.0000000000    2.7150000000    2.7150000000
     2.7150000000    0.0000000000    2.7150000000
   Si
   2
Direct
  0.0000000000  0.0000000000  0.0000000000
  0.2500000000  0.2500000000  0.2500000000
";

    #[test]
    fn parses_direct_poscar() {
        let s = parse(POSCAR_DIRECT).unwrap();
        assert_eq!(s.n_atoms, 2);
        assert_eq!(s.elements, vec![14, 14]);
        assert_eq!(s.extra_frame_count(), 0);
        let cell = s.box_matrix.unwrap();
        assert!((cell[0] - 2.715).abs() < 1e-4);
        // Second atom: 0.25 along all three vectors.
        assert!((s.positions[3] - 1.3575).abs() < 1e-3);
        assert!((s.positions[4] - 1.3575).abs() < 1e-3);
        assert!((s.positions[5] - 1.3575).abs() < 1e-3);
        assert!(s.atom_labels.is_none());
        // No Selective dynamics section ⇒ no channel.
        assert!(s.scalar_channels.is_empty());
    }

    #[test]
    fn applies_universal_scaling_factor() {
        let text = POSCAR_DIRECT.replace("   1.0\n", "   2.0\n");
        let s = parse(&text).unwrap();
        let cell = s.box_matrix.unwrap();
        assert!((cell[0] - 5.43).abs() < 1e-3);
        assert!((s.positions[3] - 2.715).abs() < 1e-3);
    }

    #[test]
    fn negative_scale_is_a_target_volume() {
        // Cubic 1 Å cell, target volume 8 Å³ ⇒ isotropic scale 2.
        let text = "\
cube
  -8.0
    1.0 0.0 0.0
    0.0 1.0 0.0
    0.0 0.0 1.0
  H
  1
Direct
  0.5 0.5 0.5
";
        let s = parse(text).unwrap();
        let cell = s.box_matrix.unwrap();
        assert!((cell[0] - 2.0).abs() < 1e-4);
        assert!((s.positions[0] - 1.0).abs() < 1e-4);
    }

    #[test]
    fn per_axis_scaling_factors() {
        let text = "\
anisotropic
  2.0 3.0 4.0
    1.0 0.0 0.0
    0.0 1.0 0.0
    0.0 0.0 1.0
  H
  1
Direct
  1.0 1.0 1.0
";
        let s = parse(text).unwrap();
        let cell = s.box_matrix.unwrap();
        assert!((cell[0] - 2.0).abs() < 1e-4);
        assert!((cell[4] - 3.0).abs() < 1e-4);
        assert!((cell[8] - 4.0).abs() < 1e-4);
    }

    #[test]
    fn parses_cartesian_poscar_with_selective_dynamics() {
        let text = "\
NaCl slab
   1.0
     5.6400000000    0.0000000000    0.0000000000
     0.0000000000    5.6400000000    0.0000000000
     0.0000000000    0.0000000000    5.6400000000
   Na Cl
    1 1
Selective dynamics
Cartesian
  0.0000000000  0.0000000000  0.0000000000  T T T
  2.8200000000  0.0000000000  0.0000000000  F F F
";
        let s = parse(text).unwrap();
        assert_eq!(s.n_atoms, 2);
        assert_eq!(s.elements, vec![11, 17]);
        assert!((s.positions[3] - 2.82).abs() < 1e-4);
        assert!((s.positions[4]).abs() < 1e-6);
        // Flags kept as a static bitmask channel: T T T = 7, F F F = 0.
        assert_eq!(s.scalar_channels.len(), 1);
        let ch = &s.scalar_channels[0];
        assert_eq!(ch.name, "selective_dynamics");
        assert_eq!(ch.frames.len(), 1);
        assert_eq!(ch.frames[0].frame, 0);
        assert_eq!(ch.frames[0].values, vec![7.0, 0.0]);
    }

    #[test]
    fn selective_dynamics_mixed_flags_bitmask() {
        let text = "\
slab
   1.0
     4.0 0.0 0.0
     0.0 4.0 0.0
     0.0 0.0 4.0
   Si
   3
Selective dynamics
Direct
  0.0 0.0 0.0  T F T
  0.5 0.0 0.0  F T F
  0.0 0.5 0.0  F F T
";
        let s = parse(text).unwrap();
        let ch = &s.scalar_channels[0];
        assert_eq!(ch.name, "selective_dynamics");
        // x=1, y=2, z=4; T sets the bit.
        assert_eq!(ch.frames[0].values, vec![5.0, 2.0, 4.0]);
    }

    #[test]
    fn vasp4_without_species_line_uses_type_proxies() {
        let text = "\
legacy vasp4 cell
   1.0
     4.0 0.0 0.0
     0.0 4.0 0.0
     0.0 0.0 4.0
   1 2
Direct
  0.0 0.0 0.0
  0.5 0.0 0.0
  0.0 0.5 0.0
";
        let s = parse(text).unwrap();
        assert_eq!(s.n_atoms, 3);
        // Species index used as an atomic-number proxy.
        assert_eq!(s.elements, vec![1, 2, 2]);
        let labels = s.atom_labels.expect("placeholder labels");
        assert_eq!(labels.len(), 3);
        assert!(labels[0].contains("Type1"));
        assert!(labels[2].contains("Type2"));
    }

    #[test]
    fn parses_multi_frame_xdatcar() {
        let text = "\
Si2 MD
   1.0
     5.4300000000    0.0000000000    0.0000000000
     0.0000000000    5.4300000000    0.0000000000
     0.0000000000    0.0000000000    5.4300000000
   Si
   2
Direct configuration=     1
  0.0000000000  0.0000000000  0.0000000000
  0.2500000000  0.2500000000  0.2500000000
Direct configuration=     2
  0.0100000000  0.0000000000  0.0000000000
  0.2600000000  0.2500000000  0.2500000000
Direct configuration=     3
  0.0200000000  0.0000000000  0.0000000000
  0.2700000000  0.2500000000  0.2500000000
";
        let s = parse(text).unwrap();
        assert_eq!(s.n_atoms, 2);
        assert_eq!(s.extra_frame_count(), 2);
        let f1 = s.frame(0);
        assert!((f1[0] - 0.0543).abs() < 1e-3);
        let f2 = s.frame(1);
        assert!((f2[0] - 0.1086).abs() < 1e-3);
        assert!(s.hetero.is_none()); // constant cell ⇒ fast fixed-stride path
    }

    #[test]
    fn variable_cell_xdatcar_records_per_frame_cells() {
        let text = "\
Si2 NPT
   1.0
     5.4300000000    0.0000000000    0.0000000000
     0.0000000000    5.4300000000    0.0000000000
     0.0000000000    0.0000000000    5.4300000000
   Si
   2
Direct configuration=     1
  0.0000000000  0.0000000000  0.0000000000
  0.2500000000  0.2500000000  0.2500000000
Si2 NPT
   1.0
     5.5000000000    0.0000000000    0.0000000000
     0.0000000000    5.5000000000    0.0000000000
     0.0000000000    0.0000000000    5.5000000000
   Si
   2
Direct configuration=     2
  0.0000000000  0.0000000000  0.0000000000
  0.2500000000  0.2500000000  0.2500000000
";
        let s = parse(text).unwrap();
        assert_eq!(s.extra_frame_count(), 1);
        let h = s.hetero.as_ref().expect("variable cell ⇒ hetero table");
        assert!(h.varies_cell);
        assert!((h.cells_flat[0] - 5.5).abs() < 1e-4);
    }

    #[test]
    fn ignores_trailing_velocity_block() {
        let text = format!(
            "{}\n  0.0100000000  0.0000000000  0.0000000000\n  0.0000000000  0.0100000000  0.0000000000\n",
            POSCAR_DIRECT
        );
        let s = parse(&text).unwrap();
        assert_eq!(s.n_atoms, 2);
        assert_eq!(s.extra_frame_count(), 0);
    }

    #[test]
    fn rejects_truncated_file() {
        assert!(parse("only\none\nline\n").is_err());
    }

    #[test]
    fn rejects_missing_count_line() {
        let text = "\
broken
   1.0
     4.0 0.0 0.0
     0.0 4.0 0.0
     0.0 0.0 4.0
   Si O
Direct
  0.0 0.0 0.0
";
        let err = match parse(text) {
            Ok(_) => panic!("expected a parse error"),
            Err(e) => e,
        };
        assert!(err.contains("atom counts"), "unexpected error: {err}");
    }

    #[test]
    fn rejects_truncated_coordinate_block() {
        let text = "\
short coords
   1.0
     4.0 0.0 0.0
     0.0 4.0 0.0
     0.0 0.0 4.0
   Si
   3
Direct
  0.0 0.0 0.0
";
        assert!(parse(text).is_err());
    }

    #[test]
    fn unknown_species_symbol_maps_to_zero() {
        let text = "\
unknown species
   1.0
     4.0 0.0 0.0
     0.0 4.0 0.0
     0.0 0.0 4.0
   Xx
   1
Direct
  0.0 0.0 0.0
";
        let s = parse(text).unwrap();
        assert_eq!(s.elements, vec![0]);
    }

    #[test]
    fn strips_potcar_suffixes_from_species_names() {
        let text = "\
potcar-flavoured species
   1.0
     4.0 0.0 0.0
     0.0 4.0 0.0
     0.0 0.0 4.0
   Fe_pv O_s
   1 1
Direct
  0.0 0.0 0.0
  0.5 0.5 0.5
";
        let s = parse(text).unwrap();
        assert_eq!(s.elements, vec![26, 8]);
    }
}
