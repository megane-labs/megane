//! Structure writers — the inverse of the parsers for the formats a user is
//! most likely to hand to another tool after editing a structure in megane.
//!
//! Supported formats:
//! - `xyz` — plain XYZ, or extended XYZ (`Lattice="…"` + `Properties=`)
//!   when the structure carries a unit cell.
//! - `pdb` — `CRYST1` (when a cell is present), `ATOM` records, and
//!   `CONECT` records for every bond.
//! - `mol` — MDL Molfile V2000 (atoms + bonds with bond orders). Limited
//!   to 999 atoms / 999 bonds by the fixed-width format.
//! - `cif` — small-molecule / crystal CIF in space group P 1: cell
//!   parameters plus an `_atom_site` loop with fractional coordinates. Needs
//!   a unit cell. Bonds are not written (readers infer them).
//! - `poscar` — VASP 5 POSCAR (`Cartesian`). Needs a unit cell. Atoms are
//!   grouped by element in first-appearance order, so the atom order of the
//!   file can differ from the input; bonds are not written.
//!
//! Writers take a borrowed [`StructureView`] rather than a [`ParsedStructure`]
//! so hosts (WASM, PyO3) can hand over flat arrays without building the full
//! parser result. All coordinates are Ångström, matching the parser contract.

use crate::atomic::atomic_num_to_symbol;
use crate::cell::matrix_to_params;
use std::fmt::Write as _;

/// Borrowed view over the minimal per-atom data a writer needs.
pub struct StructureView<'a> {
    /// Flat `[x0,y0,z0, x1,y1,z1, …]` in Å; length `3 * n_atoms`.
    pub positions: &'a [f32],
    /// Atomic numbers, length `n_atoms`. `0` is written as `X` (unknown).
    pub elements: &'a [u8],
    /// Flat bond pairs `[a0,b0, a1,b1, …]` (0-based atom indices).
    pub bonds: &'a [u32],
    /// Optional per-bond orders (1..4), length `bonds.len() / 2`.
    pub bond_orders: Option<&'a [u8]>,
    /// Optional row-major 3×3 cell matrix.
    pub box_matrix: Option<[f32; 9]>,
    /// Optional world-space corner the cell vectors are anchored at (the
    /// LAMMPS `xlo ylo zlo`); `None` means `(0, 0, 0)`. Only the cell-based
    /// writers (`cif`, `poscar`) use it: their cell always starts at the
    /// origin, so atoms are written relative to this corner.
    pub box_origin: Option<[f32; 3]>,
    /// Optional per-atom residue labels in megane's `RESNAME<resid>` form
    /// (`ALA42`, `HOH`). Only the PDB writer consumes these.
    pub atom_labels: Option<&'a [String]>,
    /// Optional per-atom chain identifiers as ASCII bytes (`b'A'`).
    pub chain_ids: Option<&'a [u8]>,
}

impl<'a> StructureView<'a> {
    pub fn n_atoms(&self) -> usize {
        self.elements.len()
    }

    pub fn n_bonds(&self) -> usize {
        self.bonds.len() / 2
    }

    fn validate(&self) -> Result<(), String> {
        let n = self.n_atoms();
        if self.positions.len() != n * 3 {
            return Err(format!(
                "positions length {} does not match 3 * n_atoms ({})",
                self.positions.len(),
                n * 3
            ));
        }
        if !self.bonds.len().is_multiple_of(2) {
            return Err("bonds must be a flat list of index pairs".to_string());
        }
        if let Some(orders) = self.bond_orders {
            if orders.len() != self.n_bonds() {
                return Err(format!(
                    "bond_orders length {} does not match n_bonds ({})",
                    orders.len(),
                    self.n_bonds()
                ));
            }
        }
        for &idx in self.bonds {
            if idx as usize >= n {
                return Err(format!("bond references atom {} but n_atoms is {}", idx, n));
            }
        }
        if let Some(labels) = self.atom_labels {
            if labels.len() != n {
                return Err(format!(
                    "atom_labels length {} does not match n_atoms ({})",
                    labels.len(),
                    n
                ));
            }
        }
        if let Some(chains) = self.chain_ids {
            if chains.len() != n {
                return Err(format!(
                    "chain_ids length {} does not match n_atoms ({})",
                    chains.len(),
                    n
                ));
            }
        }
        Ok(())
    }
}

/// Element symbol for a writer: `X` for unknown / virtual atoms so the output
/// stays parseable instead of emitting an empty column.
fn symbol(z: u8) -> &'static str {
    let s = atomic_num_to_symbol(z);
    if s.is_empty() {
        "X"
    } else {
        s
    }
}

/// Dispatch by format name (`"xyz"`, `"pdb"`, `"mol"`, `"cif"`, `"poscar"`;
/// case-insensitive).
pub fn write(format: &str, view: &StructureView<'_>) -> Result<String, String> {
    match format.to_ascii_lowercase().as_str() {
        "xyz" | "extxyz" => write_xyz(view),
        "pdb" => write_pdb(view),
        "mol" | "sdf" => write_mol(view),
        "cif" => write_cif(view),
        "poscar" | "vasp" | "contcar" => write_poscar(view),
        other => Err(format!("unsupported output format: {other}")),
    }
}

/// Serialize as (extended) XYZ. With a cell the comment line carries
/// `Lattice="…" Properties=species:S:1:pos:R:3` so ASE/OVITO read the box back.
pub fn write_xyz(view: &StructureView<'_>) -> Result<String, String> {
    view.validate()?;
    let n = view.n_atoms();
    let mut out = String::with_capacity(n * 48 + 64);
    let _ = writeln!(out, "{n}");
    match view.box_matrix {
        Some(m) => {
            let lattice: Vec<String> = m.iter().map(|v| format!("{v:.6}")).collect();
            let _ = writeln!(
                out,
                "Lattice=\"{}\" Properties=species:S:1:pos:R:3",
                lattice.join(" ")
            );
        }
        None => {
            let _ = writeln!(out, "generated by megane");
        }
    }
    for i in 0..n {
        let p = &view.positions[i * 3..i * 3 + 3];
        let _ = writeln!(
            out,
            "{:<2} {:>12.6} {:>12.6} {:>12.6}",
            symbol(view.elements[i]),
            p[0],
            p[1],
            p[2]
        );
    }
    Ok(out)
}

/// Split a megane residue label (`ALA42`) into `(resname, resid)`.
fn split_label(label: &str) -> (&str, Option<u32>) {
    let name_end = label
        .char_indices()
        .find(|(_, c)| !c.is_ascii_alphabetic())
        .map(|(i, _)| i)
        .unwrap_or(label.len());
    let name = &label[..name_end];
    let digits: String = label
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    let resid = if digits.is_empty() {
        None
    } else {
        digits.chars().rev().collect::<String>().parse().ok()
    };
    (name, resid)
}

/// Serialize as PDB: optional `CRYST1`, one `ATOM` per atom, `CONECT` for
/// every bond, `END`. Atom names are the element symbol; residue name / number
/// come from `atom_labels` when present (`UNK 1` otherwise).
pub fn write_pdb(view: &StructureView<'_>) -> Result<String, String> {
    view.validate()?;
    let n = view.n_atoms();
    if n > 99_999 {
        return Err(format!(
            "PDB serial numbers cannot exceed 99999 (got {n} atoms)"
        ));
    }
    let mut out = String::with_capacity(n * 90 + 128);
    if let Some(m) = &view.box_matrix {
        let (a, b, c, alpha, beta, gamma) = matrix_to_params(m);
        let _ = writeln!(
            out,
            "CRYST1{:9.3}{:9.3}{:9.3}{:7.2}{:7.2}{:7.2} P 1           1",
            a, b, c, alpha, beta, gamma
        );
    }
    for i in 0..n {
        let p = &view.positions[i * 3..i * 3 + 3];
        let sym = symbol(view.elements[i]);
        let (resname, resid) = match view.atom_labels {
            Some(labels) => {
                let (name, id) = split_label(&labels[i]);
                (if name.is_empty() { "UNK" } else { name }, id.unwrap_or(1))
            }
            None => ("UNK", 1),
        };
        let chain = view
            .chain_ids
            .map(|c| c[i])
            .filter(|&c| c != 0)
            .map(|c| c as char)
            .unwrap_or(' ');
        // Atom name: element symbols of one letter are right-aligned in
        // columns 13-16 per the PDB convention (" C  "), two-letter ones
        // start in column 13 ("FE  ").
        let upper = sym.to_ascii_uppercase();
        let atom_name = if upper.len() == 1 {
            format!(" {upper}  ")
        } else {
            format!("{upper:<4}")
        };
        let _ = writeln!(
            out,
            "ATOM  {:5} {} {:>3} {}{:4}    {:8.3}{:8.3}{:8.3}  1.00  0.00          {:>2}",
            i + 1,
            atom_name,
            &resname[..resname.len().min(3)],
            chain,
            resid % 10_000,
            p[0],
            p[1],
            p[2],
            upper
        );
    }
    // CONECT: group partners per atom, emitting both directions like most
    // writers do so readers that only scan one direction still see the bond.
    let mut partners: Vec<Vec<u32>> = vec![Vec::new(); n];
    for pair in view.bonds.chunks(2) {
        let (a, b) = (pair[0], pair[1]);
        partners[a as usize].push(b);
        partners[b as usize].push(a);
    }
    for (i, list) in partners.iter().enumerate() {
        if list.is_empty() {
            continue;
        }
        // At most four partners per CONECT line.
        for chunk in list.chunks(4) {
            let _ = write!(out, "CONECT{:5}", i + 1);
            for &j in chunk {
                let _ = write!(out, "{:5}", j + 1);
            }
            out.push('\n');
        }
    }
    out.push_str("END\n");
    Ok(out)
}

/// Serialize as an MDL Molfile (V2000). Bond orders default to single; the
/// aromatic order (4) is written as-is, which is the V2000 convention.
pub fn write_mol(view: &StructureView<'_>) -> Result<String, String> {
    view.validate()?;
    let n = view.n_atoms();
    let nb = view.n_bonds();
    if n > 999 || nb > 999 {
        return Err(format!(
            "MOL V2000 supports at most 999 atoms and 999 bonds (got {n} atoms, {nb} bonds)"
        ));
    }
    let mut out = String::with_capacity(n * 70 + nb * 24 + 96);
    out.push_str("megane\n  megane\n\n");
    let _ = writeln!(out, "{n:3}{nb:3}  0  0  0  0  0  0  0  0999 V2000");
    for i in 0..n {
        let p = &view.positions[i * 3..i * 3 + 3];
        let _ = writeln!(
            out,
            "{:10.4}{:10.4}{:10.4} {:<3} 0  0  0  0  0  0  0  0  0  0  0  0",
            p[0],
            p[1],
            p[2],
            symbol(view.elements[i])
        );
    }
    for (k, pair) in view.bonds.chunks(2).enumerate() {
        let order = view
            .bond_orders
            .map(|o| o[k])
            .filter(|&o| (1..=4).contains(&o))
            .unwrap_or(1);
        let _ = writeln!(out, "{:3}{:3}{:3}  0", pair[0] + 1, pair[1] + 1, order);
    }
    out.push_str("M  END\n");
    Ok(out)
}

/// The cell a cell-based writer (`cif`, `poscar`) needs, with its inverse.
/// `format` names the writer in the error message. A missing or all-zero cell
/// is "no cell"; a cell whose vectors are coplanar cannot be inverted.
/// Returns `(cell, inverse, |det| = volume)` in `f64`.
fn require_cell(
    view: &StructureView<'_>,
    format: &str,
) -> Result<([f64; 9], [f64; 9], f64), String> {
    let m = match view.box_matrix {
        Some(m) if m.iter().any(|v| *v != 0.0) => m,
        _ => {
            return Err(format!(
                "{format} needs a unit cell; this structure has none"
            ))
        }
    };
    let m: [f64; 9] = m.map(widen);
    let det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6])
        + m[2] * (m[3] * m[7] - m[4] * m[6]);
    let scale = (0..3)
        .map(|r| (m[r * 3].powi(2) + m[r * 3 + 1].powi(2) + m[r * 3 + 2].powi(2)).sqrt())
        .product::<f64>();
    if !det.is_finite() || det.abs() <= 1e-9 * scale.max(f64::MIN_POSITIVE) {
        return Err(format!(
            "{format} needs a unit cell with three independent vectors; this cell is flat"
        ));
    }
    let inv_det = 1.0 / det;
    let inv = [
        (m[4] * m[8] - m[5] * m[7]) * inv_det,
        (m[2] * m[7] - m[1] * m[8]) * inv_det,
        (m[1] * m[5] - m[2] * m[4]) * inv_det,
        (m[5] * m[6] - m[3] * m[8]) * inv_det,
        (m[0] * m[8] - m[2] * m[6]) * inv_det,
        (m[2] * m[3] - m[0] * m[5]) * inv_det,
        (m[3] * m[7] - m[4] * m[6]) * inv_det,
        (m[1] * m[6] - m[0] * m[7]) * inv_det,
        (m[0] * m[4] - m[1] * m[3]) * inv_det,
    ];
    Ok((m, inv, det.abs()))
}

/// Atom `i` relative to the cell corner (`box_origin`, or the world origin).
fn relative_position(view: &StructureView<'_>, i: usize) -> [f64; 3] {
    let o = view.box_origin.unwrap_or([0.0; 3]);
    let p = &view.positions[i * 3..i * 3 + 3];
    [
        widen(p[0]) - widen(o[0]),
        widen(p[1]) - widen(o[1]),
        widen(p[2]) - widen(o[2]),
    ]
}

/// An `f32` as the `f64` of its shortest decimal form, so `5.6f32` is written
/// as `5.6000000000` rather than `5.5999999046` when printed past `f32`
/// precision.
fn widen(v: f32) -> f64 {
    v.to_string().parse().unwrap_or(f64::from(v))
}

/// Values that round to zero are written as `0`, never `-0.000000`.
fn tidy(v: f64) -> f64 {
    if v.abs() < 5e-9 {
        0.0
    } else {
        v
    }
}

/// Serialize as a CIF in space group P 1: the cell parameters, the identity
/// symmetry operation, and one `_atom_site` row per atom (label = element +
/// per-element running index, fractional coordinates relative to the cell
/// corner). The coordinates are not wrapped into `[0, 1)`: every atom is
/// written where it is. A CIF stores the cell as `(a, b, c, α, β, γ)`, so a
/// reader rebuilds it in the standard orientation (`a` along +x, `b` in the xy
/// plane); a cell given in another orientation comes back rigidly rotated,
/// with the same fractional coordinates. Bonds are not written.
pub fn write_cif(view: &StructureView<'_>) -> Result<String, String> {
    view.validate()?;
    let (m, inv, volume) = require_cell(view, "CIF")?;
    let n = view.n_atoms();
    let m32: [f32; 9] = m.map(|v| v as f32);
    let (a, b, c, alpha, beta, gamma) = matrix_to_params(&m32);
    let mut out = String::with_capacity(n * 64 + 640);
    out.push_str("# generated by megane\n");
    out.push_str("data_megane\n");
    out.push_str("_symmetry_space_group_name_H-M   'P 1'\n");
    out.push_str("_symmetry_Int_Tables_number      1\n");
    let _ = writeln!(out, "_cell_length_a    {a:.6}");
    let _ = writeln!(out, "_cell_length_b    {b:.6}");
    let _ = writeln!(out, "_cell_length_c    {c:.6}");
    let _ = writeln!(out, "_cell_angle_alpha {alpha:.6}");
    let _ = writeln!(out, "_cell_angle_beta  {beta:.6}");
    let _ = writeln!(out, "_cell_angle_gamma {gamma:.6}");
    let _ = writeln!(out, "_cell_volume      {volume:.6}");
    out.push_str("\nloop_\n_space_group_symop_operation_xyz\n'x, y, z'\n");
    out.push_str(
        "\nloop_\n_atom_site_label\n_atom_site_type_symbol\n_atom_site_fract_x\n\
         _atom_site_fract_y\n_atom_site_fract_z\n_atom_site_occupancy\n",
    );
    let mut counters = [0usize; 256];
    for i in 0..n {
        let z = view.elements[i];
        counters[z as usize] += 1;
        let sym = symbol(z);
        let d = relative_position(view, i);
        let f = [0, 1, 2].map(|j| tidy(d[0] * inv[j] + d[1] * inv[3 + j] + d[2] * inv[6 + j]));
        let _ = writeln!(
            out,
            "{:<6} {:<2} {:>10.6} {:>10.6} {:>10.6} 1.0",
            format!("{sym}{}", counters[z as usize]),
            sym,
            f[0],
            f[1],
            f[2]
        );
    }
    Ok(out)
}

/// Serialize as a VASP 5 POSCAR with `Cartesian` coordinates and a scaling
/// factor of 1. POSCAR lists atoms species by species, so the atoms are
/// grouped by element in order of first appearance (`O H H O` is written as
/// `O O H H`); within one element the input order is kept. Coordinates are
/// relative to the cell corner (`box_origin`). Bonds are not written.
pub fn write_poscar(view: &StructureView<'_>) -> Result<String, String> {
    view.validate()?;
    let (m, _, _) = require_cell(view, "POSCAR")?;
    let n = view.n_atoms();
    // Species in first-appearance order, each with its atom indices.
    let mut species: Vec<(u8, Vec<usize>)> = Vec::new();
    for (i, &z) in view.elements.iter().enumerate() {
        match species.iter_mut().find(|(s, _)| *s == z) {
            Some((_, list)) => list.push(i),
            None => species.push((z, vec![i])),
        }
    }
    let mut out = String::with_capacity(n * 48 + 256);
    out.push_str("generated by megane\n1.0\n");
    for r in 0..3 {
        let _ = writeln!(
            out,
            "  {:>16.10} {:>16.10} {:>16.10}",
            tidy(m[r * 3]),
            tidy(m[r * 3 + 1]),
            tidy(m[r * 3 + 2])
        );
    }
    let names: Vec<String> = species
        .iter()
        .map(|(z, _)| format!("{:>4}", symbol(*z)))
        .collect();
    let counts: Vec<String> = species
        .iter()
        .map(|(_, l)| format!("{:>4}", l.len()))
        .collect();
    let _ = writeln!(out, "{}", names.join(" "));
    let _ = writeln!(out, "{}", counts.join(" "));
    out.push_str("Cartesian\n");
    for (_, list) in &species {
        for &i in list {
            let d = relative_position(view, i);
            let _ = writeln!(
                out,
                "  {:>16.10} {:>16.10} {:>16.10}",
                tidy(d[0]),
                tidy(d[1]),
                tidy(d[2])
            );
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn water<'a>(
        labels: Option<&'a [String]>,
        chains: Option<&'a [u8]>,
        cell: Option<[f32; 9]>,
    ) -> StructureView<'a> {
        static POS: [f32; 9] = [0.0, 0.0, 0.0, 0.757, 0.586, 0.0, -0.757, 0.586, 0.0];
        static ELEM: [u8; 3] = [8, 1, 1];
        static BONDS: [u32; 4] = [0, 1, 0, 2];
        StructureView {
            positions: &POS,
            elements: &ELEM,
            bonds: &BONDS,
            bond_orders: None,
            box_matrix: cell,
            atom_labels: labels,
            chain_ids: chains,
            box_origin: None,
        }
    }

    #[test]
    fn xyz_round_trips_through_parser() {
        let text = write_xyz(&water(None, None, None)).unwrap();
        assert!(text.starts_with("3\ngenerated by megane\n"));
        let parsed = crate::xyz::parse(&text).unwrap();
        assert_eq!(parsed.n_atoms, 3);
        assert_eq!(parsed.elements, vec![8, 1, 1]);
        assert!((parsed.positions[3] - 0.757).abs() < 1e-5);
        assert!(parsed.box_matrix.is_none());
    }

    #[test]
    fn extxyz_carries_lattice() {
        let cell = [10.0, 0.0, 0.0, 0.0, 12.0, 0.0, 0.0, 0.0, 14.0];
        let text = write_xyz(&water(None, None, Some(cell))).unwrap();
        assert!(text.contains("Lattice=\"10.000000 0.000000 0.000000"));
        let parsed = crate::xyz::parse(&text).unwrap();
        let m = parsed.box_matrix.expect("lattice parsed back");
        assert!((m[4] - 12.0).abs() < 1e-5);
    }

    #[test]
    fn pdb_round_trips_atoms_bonds_cell_and_labels() {
        let labels = vec!["HOH1".to_string(), "HOH1".to_string(), "HOH1".to_string()];
        let chains = *b"AAA";
        let cell = [10.0, 0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 10.0];
        let text = write_pdb(&water(Some(&labels), Some(&chains), Some(cell))).unwrap();
        assert!(text.starts_with("CRYST1   10.000   10.000   10.000  90.00  90.00  90.00"));
        assert!(text.contains("ATOM      1  O   HOH A   1       0.000   0.000   0.000"));
        assert!(text.contains("CONECT    1    2    3\n"));
        assert!(text.ends_with("END\n"));
        let parsed = crate::pdb::parse(&text).unwrap();
        assert_eq!(parsed.n_atoms, 3);
        assert_eq!(parsed.elements, vec![8, 1, 1]);
        assert_eq!(parsed.n_file_bonds, 2);
        assert_eq!(parsed.chain_ids.unwrap(), vec![b'A'; 3]);
        assert_eq!(parsed.atom_labels.unwrap()[0], "HOH1");
        let m = parsed.box_matrix.unwrap();
        assert!((m[0] - 10.0).abs() < 1e-3);
    }

    #[test]
    fn pdb_without_labels_uses_unk_and_two_letter_names() {
        static POS: [f32; 3] = [1.0, 2.0, 3.0];
        static ELEM: [u8; 1] = [26];
        let view = StructureView {
            positions: &POS,
            elements: &ELEM,
            bonds: &[],
            bond_orders: None,
            box_matrix: None,
            atom_labels: None,
            chain_ids: None,
            box_origin: None,
        };
        let text = write_pdb(&view).unwrap();
        assert!(text.contains("ATOM      1 FE   UNK     1       1.000   2.000   3.000"));
        assert!(text.trim_end().ends_with("FE\nEND"));
        assert!(!text.contains("CRYST1"));
        assert!(!text.contains("CONECT"));
    }

    #[test]
    fn mol_round_trips_bond_orders() {
        static POS: [f32; 6] = [0.0, 0.0, 0.0, 1.2, 0.0, 0.0];
        static ELEM: [u8; 2] = [6, 8];
        static BONDS: [u32; 2] = [0, 1];
        static ORDERS: [u8; 1] = [2];
        let view = StructureView {
            positions: &POS,
            elements: &ELEM,
            bonds: &BONDS,
            bond_orders: Some(&ORDERS),
            box_matrix: None,
            atom_labels: None,
            chain_ids: None,
            box_origin: None,
        };
        let text = write_mol(&view).unwrap();
        assert!(text.contains("  2  1  0  0  0  0  0  0  0  0999 V2000"));
        assert!(text.contains("  1  2  2  0\n"));
        let parsed = crate::mol::parse(&text).unwrap();
        assert_eq!(parsed.n_atoms, 2);
        assert_eq!(parsed.bonds, vec![(0, 1)]);
        assert_eq!(parsed.bond_orders.unwrap(), vec![2]);
    }

    #[test]
    fn dispatch_and_validation_errors() {
        assert!(write("xyz", &water(None, None, None)).is_ok());
        assert!(write("PDB", &water(None, None, None)).is_ok());
        assert!(write("sdf", &water(None, None, None)).is_ok());
        assert!(write("gro", &water(None, None, None))
            .unwrap_err()
            .contains("unsupported"));

        static POS: [f32; 2] = [0.0, 0.0];
        static ELEM: [u8; 1] = [6];
        let bad = StructureView {
            positions: &POS,
            elements: &ELEM,
            bonds: &[],
            bond_orders: None,
            box_matrix: None,
            atom_labels: None,
            chain_ids: None,
            box_origin: None,
        };
        assert!(write_xyz(&bad).unwrap_err().contains("positions length"));

        static POS3: [f32; 3] = [0.0, 0.0, 0.0];
        static BONDS_OOB: [u32; 2] = [0, 5];
        let oob = StructureView {
            positions: &POS3,
            elements: &ELEM,
            bonds: &BONDS_OOB,
            bond_orders: None,
            box_matrix: None,
            atom_labels: None,
            chain_ids: None,
            box_origin: None,
        };
        assert!(write_pdb(&oob).unwrap_err().contains("references atom 5"));
        static ORDERS_BAD: [u8; 2] = [1, 1];
        static BONDS_ONE: [u32; 2] = [0, 0];
        let bad_orders = StructureView {
            positions: &POS3,
            elements: &ELEM,
            bonds: &BONDS_ONE,
            bond_orders: Some(&ORDERS_BAD),
            box_matrix: None,
            atom_labels: None,
            chain_ids: None,
            box_origin: None,
        };
        assert!(write_mol(&bad_orders)
            .unwrap_err()
            .contains("bond_orders length"));
    }

    #[test]
    fn unknown_element_is_written_as_x() {
        static POS: [f32; 3] = [0.0, 0.0, 0.0];
        static ELEM: [u8; 1] = [0];
        let view = StructureView {
            positions: &POS,
            elements: &ELEM,
            bonds: &[],
            bond_orders: None,
            box_matrix: None,
            atom_labels: None,
            chain_ids: None,
            box_origin: None,
        };
        assert!(write_xyz(&view).unwrap().contains("X "));
    }

    #[test]
    fn split_label_variants() {
        assert_eq!(split_label("ALA42"), ("ALA", Some(42)));
        assert_eq!(split_label("HOH"), ("HOH", None));
        assert_eq!(split_label(""), ("", None));
        assert_eq!(split_label("7"), ("", Some(7)));
    }

    /// A small cell view: atoms `pos` / `elem` in `cell`, optional origin.
    fn crystal<'a>(
        pos: &'a [f32],
        elem: &'a [u8],
        cell: Option<[f32; 9]>,
        origin: Option<[f32; 3]>,
    ) -> StructureView<'a> {
        StructureView {
            positions: pos,
            elements: elem,
            bonds: &[],
            bond_orders: None,
            box_matrix: cell,
            box_origin: origin,
            atom_labels: None,
            chain_ids: None,
        }
    }

    fn assert_close(got: &[f32], want: &[f32], tol: f32) {
        assert_eq!(got.len(), want.len());
        for (k, (g, w)) in got.iter().zip(want).enumerate() {
            assert!((g - w).abs() < tol, "index {k}: got {g}, want {w}");
        }
    }

    // Rock-salt-like 4-atom cell, deliberately interleaving the species.
    const SALT_POS: [f32; 12] = [0.0, 0.0, 0.0, 2.8, 0.0, 0.0, 2.8, 2.8, 0.0, 0.0, 2.8, 0.0];
    const SALT_ELEM: [u8; 4] = [11, 17, 11, 17];
    const SALT_CELL: [f32; 9] = [5.6, 0.0, 0.0, 0.0, 5.6, 0.0, 0.0, 0.0, 5.6];

    #[test]
    fn cif_round_trips_cell_elements_and_positions() {
        let text = write_cif(&crystal(&SALT_POS, &SALT_ELEM, Some(SALT_CELL), None)).unwrap();
        assert!(text.contains("data_megane\n"));
        assert!(text.contains("_symmetry_space_group_name_H-M   'P 1'"));
        assert!(text.contains("'x, y, z'"));
        assert!(text.contains("_cell_length_a    5.600000"));
        assert!(text.contains("_cell_angle_gamma 90.000000"));
        assert!(text.contains("_cell_volume      175.616"));
        assert!(text.contains("Na1    Na   0.000000   0.000000   0.000000 1.0"));
        assert!(text.contains("Cl1    Cl   0.500000   0.000000   0.000000 1.0"));
        assert!(text.contains("Na2    Na   0.500000   0.500000   0.000000 1.0"));
        assert!(!text.contains("-0.000000"));
        let parsed = crate::cif::parse(&text).unwrap();
        assert_eq!(parsed.elements, SALT_ELEM.to_vec());
        assert_close(&parsed.positions, &SALT_POS, 1e-4);
        assert_close(&parsed.box_matrix.unwrap(), &SALT_CELL, 1e-4);
    }

    #[test]
    fn cif_triclinic_round_trip_and_origin() {
        let cell = crate::cell::cell_params_to_matrix(5.0, 6.0, 7.0, 80.0, 95.0, 110.0);
        let frac = [[0.1f32, 0.2, 0.3], [0.75, -0.25, 1.5]];
        let origin = [1.0f32, -2.0, 0.5];
        let mut pos = Vec::new();
        let mut rel = Vec::new();
        for f in frac {
            let (x, y, z) = crate::cell::frac_to_cart(f[0], f[1], f[2], &cell);
            rel.extend([x, y, z]);
            pos.extend([x + origin[0], y + origin[1], z + origin[2]]);
        }
        let elem = [14u8, 8];
        let text = write_cif(&crystal(&pos, &elem, Some(cell), Some(origin))).unwrap();
        // Fractional coordinates are relative to the cell corner and unwrapped.
        assert!(text.contains("Si1    Si   0.100000   0.200000   0.300000"));
        assert!(text.contains("O1     O    0.750000  -0.250000   1.500000"));
        assert!(text.contains("_cell_angle_alpha 80.0000"));
        let parsed = crate::cif::parse(&text).unwrap();
        assert_close(&parsed.box_matrix.unwrap(), &cell, 1e-3);
        assert_close(&parsed.positions, &rel, 1e-3);
    }

    #[test]
    fn cif_rotated_cell_keeps_fractional_coordinates() {
        // The cell rotated 90° about z: a along +y. The CIF reader rebuilds it
        // with a along +x, so Cartesian positions rotate with it while
        // fractional coordinates and cell parameters are preserved.
        let cell = [0.0, 4.0, 0.0, -5.0, 0.0, 0.0, 0.0, 0.0, 6.0];
        let pos = [0.0, 2.0, 3.0]; // fractional (0.5, 0, 0.5)
        let text = write_cif(&crystal(&pos, &[6], Some(cell), None)).unwrap();
        assert!(text.contains("C1     C    0.500000   0.000000   0.500000"));
        let parsed = crate::cif::parse(&text).unwrap();
        assert_close(
            &parsed.box_matrix.unwrap(),
            &[4.0, 0.0, 0.0, 0.0, 5.0, 0.0, 0.0, 0.0, 6.0],
            1e-4,
        );
        assert_close(&parsed.positions, &[2.0, 0.0, 3.0], 1e-4);
    }

    #[test]
    fn cell_writers_need_a_unit_cell() {
        let pos = [0.0f32; 3];
        for fmt in ["cif", "poscar"] {
            let label = fmt.to_ascii_uppercase();
            let none = write(fmt, &crystal(&pos, &[6], None, None)).unwrap_err();
            assert_eq!(
                none,
                format!("{label} needs a unit cell; this structure has none")
            );
            let zero = write(fmt, &crystal(&pos, &[6], Some([0.0; 9]), None)).unwrap_err();
            assert_eq!(zero, none);
            let flat = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0];
            let err = write(fmt, &crystal(&pos, &[6], Some(flat), None)).unwrap_err();
            assert!(err.contains("three independent vectors"), "{err}");
        }
        // Shape validation still runs first.
        assert!(write_cif(&crystal(&[0.0; 2], &[6], Some(SALT_CELL), None))
            .unwrap_err()
            .contains("positions length"));
        assert!(
            write_poscar(&crystal(&[0.0; 2], &[6], Some(SALT_CELL), None))
                .unwrap_err()
                .contains("positions length")
        );
    }

    #[test]
    fn poscar_groups_species_and_round_trips() {
        let text = write_poscar(&crystal(&SALT_POS, &SALT_ELEM, Some(SALT_CELL), None)).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[0], "generated by megane");
        assert_eq!(lines[1], "1.0");
        assert_eq!(
            lines[2].split_whitespace().collect::<Vec<_>>(),
            ["5.6000000000", "0.0000000000", "0.0000000000"]
        );
        assert_eq!(
            lines[5].split_whitespace().collect::<Vec<_>>(),
            ["Na", "Cl"]
        );
        assert_eq!(lines[6].split_whitespace().collect::<Vec<_>>(), ["2", "2"]);
        assert_eq!(lines[7], "Cartesian");
        assert_eq!(lines.len(), 12);
        assert!(!text.contains("-0.0000"));
        let parsed = crate::vasp::parse(&text).unwrap();
        // Grouped by first appearance: Na (atoms 0, 2), then Cl (atoms 1, 3).
        assert_eq!(parsed.elements, vec![11, 11, 17, 17]);
        let want = [0.0, 0.0, 0.0, 2.8, 2.8, 0.0, 2.8, 0.0, 0.0, 0.0, 2.8, 0.0];
        assert_close(&parsed.positions, &want, 1e-5);
        assert_close(&parsed.box_matrix.unwrap(), &SALT_CELL, 1e-5);
    }

    #[test]
    fn poscar_writes_positions_relative_to_the_cell_origin() {
        let cell = [3.0, 0.0, 0.0, 1.0, 3.0, 0.0, 0.5, 0.5, 4.0];
        let origin = [-1.0f32, 2.0, 10.0];
        let pos = [0.0f32, 3.0, 11.0, 0.0, 0.0, 0.0];
        let text = write_poscar(&crystal(&pos, &[0, 1], Some(cell), Some(origin))).unwrap();
        // An unknown element is written as `X`.
        assert!(text.lines().nth(5).unwrap().contains("X"));
        let parsed = crate::vasp::parse(&text).unwrap();
        assert_close(&parsed.positions, &[1.0, 1.0, 1.0, 1.0, -2.0, -10.0], 1e-5);
        assert_close(&parsed.box_matrix.unwrap(), &cell, 1e-5);
    }

    #[test]
    fn dispatch_accepts_cell_formats() {
        let v = crystal(&SALT_POS, &SALT_ELEM, Some(SALT_CELL), None);
        assert_eq!(write("CIF", &v).unwrap(), write_cif(&v).unwrap());
        let poscar = write_poscar(&v).unwrap();
        for name in ["poscar", "POSCAR", "vasp", "contcar"] {
            assert_eq!(write(name, &v).unwrap(), poscar);
        }
    }

    #[test]
    fn tidy_drops_negative_zero() {
        assert_eq!(tidy(-1e-12).to_string(), "0");
        assert_eq!(tidy(-0.5), -0.5);
    }
}
