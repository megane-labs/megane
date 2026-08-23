//! Chemical Markup Language (`.cml`) parser.
//!
//! XML interchange format emitted by Open Babel, Avogadro, ChemDraw, and the
//! rest of the Blue Obelisk toolchain:
//!
//! ```xml
//! <molecule id="m1">
//!   <crystal>
//!     <scalar title="a">5.43</scalar>  … b, c, alpha, beta, gamma
//!   </crystal>
//!   <atomArray>
//!     <atom id="a1" elementType="C" x3="0.0" y3="0.0" z3="0.0"/>
//!   </atomArray>
//!   <bondArray>
//!     <bond atomRefs2="a1 a2" order="1"/>
//!   </bondArray>
//! </molecule>
//! ```
//!
//! Coordinate flavours, in the order they are preferred per atom:
//! 1. `x3`/`y3`/`z3` — Cartesian Å (the common 3D case).
//! 2. `xyz3="x y z"` — the same triple packed into one attribute.
//! 3. `xFract`/`yFract`/`zFract` — fractional, converted with the `<crystal>`
//!    cell.
//! 4. `x2`/`y2` — a 2D depiction, projected to `z = 0` so the file still opens
//!    (flat, but visibly flat) rather than being rejected.
//!
//! A `units` attribute (`units:bohr`, `units:pm`, `units:nm`, …) on an `<atom>`
//! rescales its Cartesian coordinates to Å; the same applies to the `<crystal>`
//! length scalars. Fractional coordinates are unitless and never rescaled. An
//! unrecognised unit keeps the raw value and produces a warning.
//!
//! A file may hold several `<molecule>` elements under `<cml>` / `<list>`; the
//! first one carrying atoms is loaded, with a warning counting the sibling
//! documents that were skipped. Treating the rest as frames is a follow-up.
//!
//! ## Untrusted input
//!
//! `quick_xml::Reader` is a pull parser that performs **no** DTD processing and
//! **no** entity expansion beyond the five XML predefined entities, so a
//! hostile `.cml` cannot mount a billion-laughs or external-entity (XXE)
//! attack through it. Nothing here resolves a `SYSTEM` identifier or reads a
//! second file.

use crate::atomic::{capitalize, symbol_to_atomic_num};
use crate::bonds;
use crate::parser::{cell_params_to_matrix, ParsedStructure};
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use std::collections::{HashMap, HashSet};

/// Cell parameters harvested from a `<crystal>` block.
#[derive(Default)]
struct Cell {
    a: Option<f32>,
    b: Option<f32>,
    c: Option<f32>,
    alpha: Option<f32>,
    beta: Option<f32>,
    gamma: Option<f32>,
}

impl Cell {
    fn matrix(&self) -> Option<[f32; 9]> {
        let (a, b, c) = (self.a?, self.b?, self.c?);
        if a <= 0.0 || b <= 0.0 || c <= 0.0 {
            return None;
        }
        Some(cell_params_to_matrix(
            a,
            b,
            c,
            self.alpha.unwrap_or(90.0),
            self.beta.unwrap_or(90.0),
            self.gamma.unwrap_or(90.0),
        ))
    }
}

/// How an atom's coordinates were expressed in the file.
enum Coord {
    Cartesian([f32; 3]),
    Fractional([f32; 3]),
}

struct Atom {
    id: String,
    element: u8,
    coord: Coord,
}

/// Strip an XML namespace prefix: `cml:atom` → `atom`.
fn local_name(raw: &[u8]) -> String {
    let s = String::from_utf8_lossy(raw);
    match s.rsplit_once(':') {
        Some((_, local)) => local.to_string(),
        None => s.to_string(),
    }
}

/// Collect an element's attributes into a map keyed by local name.
fn attrs(e: &BytesStart<'_>) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for a in e.attributes().flatten() {
        let key = local_name(a.key.as_ref());
        let val = a
            .unescape_value()
            .map(|v| v.into_owned())
            .unwrap_or_else(|_| String::from_utf8_lossy(&a.value).into_owned());
        map.insert(key, val);
    }
    map
}

fn attr_f32(map: &HashMap<String, String>, key: &str) -> Option<f32> {
    map.get(key)?.trim().parse().ok()
}

/// Bohr radius in Å (CODATA), for `units:bohr` / `units:au` conversion.
const BOHR_TO_ANGSTROM: f32 = 0.529177211;

/// Å-per-unit factor for a CML `units` attribute value (`units:bohr`,
/// `cml:angstrom`, plain `pm`, …). `None` means the unit is not a recognised
/// length unit and the value must be kept as-is.
fn length_unit_factor(unit: &str) -> Option<f32> {
    // The namespace prefix (`units:`, `cmlUnits:`, …) carries no meaning here.
    let local = match unit.trim().rsplit_once(':') {
        Some((_, l)) => l,
        None => unit.trim(),
    };
    match local.to_ascii_lowercase().as_str() {
        "angstrom" | "ang" | "a" => Some(1.0),
        "bohr" | "au" => Some(BOHR_TO_ANGSTROM),
        "pm" => Some(0.01),
        "nm" => Some(10.0),
        _ => None,
    }
}

/// CML writes bond orders as `1`/`2`/`3` or the letters `S`/`D`/`T`/`A`.
/// Aromatic collapses to 1, matching the MOL2 reader.
fn bond_order(raw: Option<&String>) -> u8 {
    match raw.map(|s| s.trim().to_ascii_uppercase()) {
        Some(s) => match s.as_str() {
            "2" | "D" => 2,
            "3" | "T" => 3,
            _ => s.parse::<u8>().unwrap_or(1),
        },
        None => 1,
    }
}

/// Read the coordinates off an `<atom>` element, preferring 3D over fractional
/// over a 2D depiction.
fn atom_coord(map: &HashMap<String, String>) -> Option<Coord> {
    if let (Some(x), Some(y), Some(z)) = (
        attr_f32(map, "x3"),
        attr_f32(map, "y3"),
        attr_f32(map, "z3"),
    ) {
        return Some(Coord::Cartesian([x, y, z]));
    }
    if let Some(packed) = map.get("xyz3") {
        let v: Vec<f32> = packed
            .split_whitespace()
            .filter_map(|t| t.parse().ok())
            .collect();
        if v.len() >= 3 {
            return Some(Coord::Cartesian([v[0], v[1], v[2]]));
        }
    }
    if let (Some(x), Some(y), Some(z)) = (
        attr_f32(map, "xFract"),
        attr_f32(map, "yFract"),
        attr_f32(map, "zFract"),
    ) {
        return Some(Coord::Fractional([x, y, z]));
    }
    // 2D depiction: project onto z = 0 so the file still opens.
    if let (Some(x), Some(y)) = (attr_f32(map, "x2"), attr_f32(map, "y2")) {
        return Some(Coord::Cartesian([x, y, 0.0]));
    }
    None
}

/// Parse a CML document into a structure. The first `<molecule>` that carries
/// atoms wins.
pub fn parse(text: &str) -> Result<ParsedStructure, String> {
    let mut reader = Reader::from_str(text);
    reader.config_mut().trim_text(true);

    let mut atoms: Vec<Atom> = Vec::new();
    let mut file_bonds: Vec<(String, String, u8)> = Vec::new();
    let mut cell = Cell::default();
    // `<scalar title="a" units="…">5.43</scalar>` — title and units arrive on
    // the start tag and the number as the following text node, so both are held
    // across events.
    let mut scalar_title: Option<(String, Option<String>)> = None;
    // Unit strings that are not recognised length units, for one aggregated
    // warning; values carrying them stay unscaled.
    let mut unknown_units: HashSet<String> = HashSet::new();
    // Depth of `<molecule>` nesting, so a nested molecule's atoms do not leak
    // into the one we are reading.
    let mut molecule_depth = 0usize;
    // Set once the first molecule with atoms has closed: everything after is a
    // sibling molecule we deliberately ignore.
    let mut done = false;
    let mut saw_molecule = false;
    // Top-level <molecule> siblings skipped after the loaded one, for the
    // aggregated warning.
    let mut extra_molecules = 0usize;

    loop {
        let ev = reader.read_event().map_err(|e| {
            format!(
                "CML: malformed XML at byte {}: {e}",
                reader.buffer_position()
            )
        })?;
        match ev {
            Event::Eof => break,
            Event::Start(ref e) | Event::Empty(ref e) => {
                let empty = matches!(ev, Event::Empty(_));
                let name = local_name(e.name().as_ref());
                match name.as_str() {
                    "molecule" => {
                        saw_molecule = true;
                        if done && molecule_depth == 0 {
                            extra_molecules += 1;
                        }
                        if !empty {
                            molecule_depth += 1;
                        }
                    }
                    "atom" if !done => {
                        let map = attrs(e);
                        let Some(mut coord) = atom_coord(&map) else {
                            // No usable coordinates on this atom — skip it
                            // rather than failing the whole document.
                            continue;
                        };
                        // A `units` attribute rescales Cartesian coordinates to
                        // Å; fractional coordinates are unitless.
                        if let (Coord::Cartesian(p), Some(unit)) = (&mut coord, map.get("units")) {
                            match length_unit_factor(unit) {
                                Some(f) => p.iter_mut().for_each(|v| *v *= f),
                                None => {
                                    unknown_units.insert(unit.trim().to_string());
                                }
                            }
                        }
                        let symbol = map
                            .get("elementType")
                            .map(|s| capitalize(s.trim()))
                            .unwrap_or_default();
                        atoms.push(Atom {
                            id: map.get("id").cloned().unwrap_or_default(),
                            element: symbol_to_atomic_num(&symbol),
                            coord,
                        });
                    }
                    "bond" if !done => {
                        let map = attrs(e);
                        let refs = map
                            .get("atomRefs2")
                            .or_else(|| map.get("atomRefs"))
                            .cloned()
                            .unwrap_or_default();
                        let parts: Vec<&str> = refs.split_whitespace().collect();
                        if parts.len() >= 2 {
                            file_bonds.push((
                                parts[0].to_string(),
                                parts[1].to_string(),
                                bond_order(map.get("order")),
                            ));
                        }
                    }
                    "scalar" if !done => {
                        let map = attrs(e);
                        scalar_title = map
                            .get("title")
                            .map(|t| (t.trim().to_lowercase(), map.get("units").cloned()));
                    }
                    _ => {}
                }
            }
            Event::Text(ref t) if scalar_title.is_some() => {
                // `decode()` is enough here: the values are plain numbers, and
                // quick-xml 0.38 moved unescaping out of `BytesText`.
                let raw = t.decode().unwrap_or_default();
                if let Ok(v) = raw.trim().parse::<f32>() {
                    let (title, units) = scalar_title.as_ref().unwrap();
                    // Cell edges are lengths, so the units attribute applies;
                    // the angles stay in degrees.
                    let scaled = match (title.as_str(), units.as_deref()) {
                        ("a" | "b" | "c", Some(u)) => match length_unit_factor(u) {
                            Some(f) => v * f,
                            None => {
                                unknown_units.insert(u.trim().to_string());
                                v
                            }
                        },
                        _ => v,
                    };
                    match title.as_str() {
                        "a" => cell.a = Some(scaled),
                        "b" => cell.b = Some(scaled),
                        "c" => cell.c = Some(scaled),
                        "alpha" => cell.alpha = Some(scaled),
                        "beta" => cell.beta = Some(scaled),
                        "gamma" => cell.gamma = Some(scaled),
                        _ => {}
                    }
                }
                scalar_title = None;
            }
            Event::End(ref e) => {
                let name = local_name(e.name().as_ref());
                if name == "scalar" {
                    scalar_title = None;
                } else if name == "molecule" {
                    molecule_depth = molecule_depth.saturating_sub(1);
                    // Closing the outermost molecule that yielded atoms ends the
                    // read; later sibling molecules are a follow-up.
                    if molecule_depth == 0 && !atoms.is_empty() {
                        done = true;
                    }
                }
            }
            _ => {}
        }
    }

    if !saw_molecule {
        return Err("not a CML file: no <molecule> element found".into());
    }
    if atoms.is_empty() {
        return Err("CML: <molecule> contains no atoms with usable coordinates".into());
    }

    let box_matrix = cell.matrix();
    let needs_cell = atoms
        .iter()
        .any(|a| matches!(a.coord, Coord::Fractional(_)));
    if needs_cell && box_matrix.is_none() {
        return Err(
            "CML: fractional coordinates (xFract/yFract/zFract) need a <crystal> cell".into(),
        );
    }

    let n_atoms = atoms.len();
    let mut positions = Vec::with_capacity(n_atoms * 3);
    let mut elements = Vec::with_capacity(n_atoms);
    let mut id_to_index: HashMap<&str, u32> = HashMap::with_capacity(n_atoms);
    for (i, atom) in atoms.iter().enumerate() {
        match atom.coord {
            Coord::Cartesian([x, y, z]) => {
                positions.push(x);
                positions.push(y);
                positions.push(z);
            }
            Coord::Fractional([fa, fb, fc]) => {
                // SAFETY: `needs_cell` guarantees box_matrix is Some here.
                let m = box_matrix.unwrap();
                positions.push(fa * m[0] + fb * m[3] + fc * m[6]);
                positions.push(fa * m[1] + fb * m[4] + fc * m[7]);
                positions.push(fa * m[2] + fb * m[5] + fc * m[8]);
            }
        }
        elements.push(atom.element);
        if !atom.id.is_empty() {
            id_to_index.insert(atom.id.as_str(), i as u32);
        }
    }

    // Explicit connectivity when <bondArray> is present, distance inference
    // otherwise (CML from 2D drawing tools sometimes omits it).
    let mut bond_pairs: Vec<(u32, u32)> = Vec::new();
    let mut bond_orders: Vec<u8> = Vec::new();
    let mut seen: HashSet<(u32, u32)> = HashSet::new();
    let mut dangling_bonds = 0usize;
    for (from, to, order) in &file_bonds {
        let (Some(&a), Some(&b)) = (id_to_index.get(from.as_str()), id_to_index.get(to.as_str()))
        else {
            // Dangling atomRefs2 — drop the bond, keep the molecule.
            dangling_bonds += 1;
            continue;
        };
        if a == b {
            continue;
        }
        let pair = (a.min(b), a.max(b));
        if seen.insert(pair) {
            bond_pairs.push(pair);
            bond_orders.push(*order);
        }
    }

    let mut warnings = Vec::new();
    if !unknown_units.is_empty() {
        let mut list: Vec<String> = unknown_units.into_iter().collect();
        list.sort();
        warnings.push(format!(
            "unrecognized units attribute {} — values kept unscaled",
            list.join(", ")
        ));
    }
    if dangling_bonds > 0 {
        warnings.push(format!(
            "{dangling_bonds} bonds referencing unknown atom ids were dropped"
        ));
    }
    if extra_molecules > 0 {
        warnings.push(format!(
            "file contains {} additional <molecule> document{}; only the first is shown",
            extra_molecules,
            if extra_molecules == 1 { "" } else { "s" }
        ));
    }

    let n_file_bonds = bond_pairs.len();
    let (bonds, bond_orders) = if bond_pairs.is_empty() {
        let empty = HashSet::new();
        (
            bonds::infer_bonds(&positions, &elements, n_atoms, &empty),
            None,
        )
    } else {
        (bond_pairs, Some(bond_orders))
    };

    Ok(ParsedStructure {
        n_atoms,
        positions,
        elements,
        bonds,
        n_file_bonds,
        bond_orders,
        box_matrix,
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
        warnings,
        hetero: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const METHANE: &str = r#"<?xml version="1.0"?>
<molecule id="methane" xmlns="http://www.xml-cml.org/schema">
  <atomArray>
    <atom id="a1" elementType="C" x3="0.0000" y3="0.0000" z3="0.0000"/>
    <atom id="a2" elementType="H" x3="0.6291" y3="0.6291" z3="0.6291"/>
    <atom id="a3" elementType="H" x3="-0.6291" y3="-0.6291" z3="0.6291"/>
    <atom id="a4" elementType="H" x3="-0.6291" y3="0.6291" z3="-0.6291"/>
    <atom id="a5" elementType="H" x3="0.6291" y3="-0.6291" z3="-0.6291"/>
  </atomArray>
  <bondArray>
    <bond atomRefs2="a1 a2" order="1"/>
    <bond atomRefs2="a1 a3" order="1"/>
    <bond atomRefs2="a1 a4" order="1"/>
    <bond atomRefs2="a1 a5" order="1"/>
  </bondArray>
</molecule>
"#;

    #[test]
    fn parses_a_3d_molecule_with_explicit_bonds() {
        let s = parse(METHANE).unwrap();
        assert_eq!(s.n_atoms, 5);
        assert_eq!(s.elements, vec![6, 1, 1, 1, 1]);
        assert_eq!(s.n_file_bonds, 4);
        assert_eq!(s.bonds.len(), 4);
        assert_eq!(s.bond_orders.unwrap(), vec![1, 1, 1, 1]);
        assert!((s.positions[3] - 0.6291).abs() < 1e-4);
        assert!(s.box_matrix.is_none());
        assert!(s.warnings.is_empty());
    }

    #[test]
    fn converts_bohr_coordinates_to_angstrom() {
        let text = r#"<molecule>
  <atomArray>
    <atom id="a1" elementType="C" x3="0" y3="0" z3="0" units="units:bohr"/>
    <atom id="a2" elementType="C" x3="2.0" y3="0" z3="0" units="units:bohr"/>
  </atomArray>
</molecule>"#;
        let s = parse(text).unwrap();
        assert!((s.positions[3] - 1.058354422).abs() < 1e-5);
        assert!(s.warnings.is_empty());
    }

    #[test]
    fn converts_picometer_coordinates_to_angstrom() {
        let text = r#"<molecule>
  <atomArray>
    <atom id="a1" elementType="O" x3="100" y3="0" z3="0" units="units:pm"/>
  </atomArray>
</molecule>"#;
        let s = parse(text).unwrap();
        assert!((s.positions[0] - 1.0).abs() < 1e-5);
    }

    #[test]
    fn converts_nanometer_coordinates_to_angstrom() {
        let text = r#"<molecule>
  <atomArray>
    <atom id="a1" elementType="O" x3="0.15" y3="0" z3="0" units="units:nm"/>
  </atomArray>
</molecule>"#;
        let s = parse(text).unwrap();
        assert!((s.positions[0] - 1.5).abs() < 1e-5);
    }

    #[test]
    fn an_unknown_unit_keeps_values_unscaled_and_warns_once() {
        let text = r#"<molecule>
  <atomArray>
    <atom id="a1" elementType="C" x3="1.5" y3="0" z3="0" units="units:parsec"/>
    <atom id="a2" elementType="C" x3="3.0" y3="0" z3="0" units="units:parsec"/>
  </atomArray>
</molecule>"#;
        let s = parse(text).unwrap();
        assert!((s.positions[0] - 1.5).abs() < 1e-6);
        assert!((s.positions[3] - 3.0).abs() < 1e-6);
        assert_eq!(s.warnings.len(), 1);
        assert!(
            s.warnings[0].contains("units:parsec"),
            "unexpected warning: {}",
            s.warnings[0]
        );
    }

    #[test]
    fn converts_bohr_cell_lengths_but_not_fractional_coordinates() {
        let text = r#"<molecule>
  <crystal>
    <scalar title="a" units="units:bohr">10.0</scalar>
    <scalar title="b" units="units:bohr">10.0</scalar>
    <scalar title="c" units="units:bohr">10.0</scalar>
    <scalar title="alpha" units="units:degree">90</scalar>
    <scalar title="beta" units="units:degree">90</scalar>
    <scalar title="gamma" units="units:degree">90</scalar>
  </crystal>
  <atomArray>
    <atom id="a1" elementType="Si" xFract="0.0" yFract="0.0" zFract="0.0"/>
    <atom id="a2" elementType="Si" xFract="0.5" yFract="0.5" zFract="0.5"/>
  </atomArray>
</molecule>"#;
        let s = parse(text).unwrap();
        let cell = s.box_matrix.expect("crystal cell");
        assert!((cell[0] - 5.29177211).abs() < 1e-4);
        // Fractions are unitless: 0.5 of the Å cell edge, not 0.5 bohr.
        assert!((s.positions[3] - 2.645886055).abs() < 1e-4);
        assert!(s.warnings.is_empty());
    }

    #[test]
    fn reads_double_and_triple_bond_orders() {
        let text = r#"<molecule>
  <atomArray>
    <atom id="a1" elementType="C" x3="0" y3="0" z3="0"/>
    <atom id="a2" elementType="C" x3="1.2" y3="0" z3="0"/>
    <atom id="a3" elementType="O" x3="2.4" y3="0" z3="0"/>
  </atomArray>
  <bondArray>
    <bond atomRefs2="a1 a2" order="3"/>
    <bond atomRefs2="a2 a3" order="D"/>
  </bondArray>
</molecule>"#;
        let s = parse(text).unwrap();
        assert_eq!(s.bond_orders.unwrap(), vec![3, 2]);
    }

    #[test]
    fn aromatic_bond_order_collapses_to_one() {
        let text = r#"<molecule>
  <atomArray>
    <atom id="a1" elementType="C" x3="0" y3="0" z3="0"/>
    <atom id="a2" elementType="C" x3="1.4" y3="0" z3="0"/>
  </atomArray>
  <bondArray><bond atomRefs2="a1 a2" order="A"/></bondArray>
</molecule>"#;
        let s = parse(text).unwrap();
        assert_eq!(s.bond_orders.unwrap(), vec![1]);
    }

    #[test]
    fn parses_a_crystal_with_fractional_coordinates() {
        let text = r#"<molecule>
  <crystal>
    <scalar title="a" units="units:angstrom">5.43</scalar>
    <scalar title="b" units="units:angstrom">5.43</scalar>
    <scalar title="c" units="units:angstrom">5.43</scalar>
    <scalar title="alpha" units="units:degree">90</scalar>
    <scalar title="beta" units="units:degree">90</scalar>
    <scalar title="gamma" units="units:degree">90</scalar>
  </crystal>
  <atomArray>
    <atom id="a1" elementType="Si" xFract="0.0" yFract="0.0" zFract="0.0"/>
    <atom id="a2" elementType="Si" xFract="0.25" yFract="0.25" zFract="0.25"/>
  </atomArray>
</molecule>"#;
        let s = parse(text).unwrap();
        assert_eq!(s.n_atoms, 2);
        let cell = s.box_matrix.expect("crystal cell");
        assert!((cell[0] - 5.43).abs() < 1e-4);
        assert!((s.positions[3] - 1.3575).abs() < 1e-3);
        assert!((s.positions[5] - 1.3575).abs() < 1e-3);
    }

    #[test]
    fn packs_the_xyz3_attribute_form() {
        let text = r#"<molecule>
  <atomArray>
    <atom id="a1" elementType="O" xyz3="0.0 0.0 0.117"/>
    <atom id="a2" elementType="H" xyz3="0.0 0.757 -0.469"/>
  </atomArray>
</molecule>"#;
        let s = parse(text).unwrap();
        assert_eq!(s.elements, vec![8, 1]);
        assert!((s.positions[2] - 0.117).abs() < 1e-4);
    }

    #[test]
    fn projects_a_2d_depiction_onto_z_zero() {
        let text = r#"<molecule>
  <atomArray>
    <atom id="a1" elementType="C" x2="0.0" y2="0.0"/>
    <atom id="a2" elementType="O" x2="1.4" y2="0.0"/>
  </atomArray>
  <bondArray><bond atomRefs2="a1 a2" order="2"/></bondArray>
</molecule>"#;
        let s = parse(text).unwrap();
        assert_eq!(s.n_atoms, 2);
        assert_eq!(s.positions[2], 0.0);
        assert_eq!(s.positions[5], 0.0);
    }

    #[test]
    fn infers_bonds_when_bondarray_is_absent() {
        let text = r#"<molecule>
  <atomArray>
    <atom id="a1" elementType="O" x3="0.0" y3="0.0" z3="0.117"/>
    <atom id="a2" elementType="H" x3="0.0" y3="0.757" z3="-0.469"/>
    <atom id="a3" elementType="H" x3="0.0" y3="-0.757" z3="-0.469"/>
  </atomArray>
</molecule>"#;
        let s = parse(text).unwrap();
        assert_eq!(s.n_file_bonds, 0);
        assert_eq!(s.bonds.len(), 2); // inferred O–H pair
        assert!(s.bond_orders.is_none());
    }

    #[test]
    fn honours_namespace_prefixes() {
        let text = r#"<cml:molecule xmlns:cml="http://www.xml-cml.org/schema">
  <cml:atomArray>
    <cml:atom cml:id="a1" cml:elementType="N" cml:x3="0" cml:y3="0" cml:z3="0"/>
  </cml:atomArray>
</cml:molecule>"#;
        let s = parse(text).unwrap();
        assert_eq!(s.elements, vec![7]);
    }

    #[test]
    fn loads_the_first_molecule_of_a_multi_molecule_file() {
        let text = r#"<cml>
  <molecule id="first">
    <atomArray><atom id="a1" elementType="He" x3="0" y3="0" z3="0"/></atomArray>
  </molecule>
  <molecule id="second">
    <atomArray>
      <atom id="b1" elementType="Ne" x3="0" y3="0" z3="0"/>
      <atom id="b2" elementType="Ne" x3="3" y3="0" z3="0"/>
    </atomArray>
  </molecule>
</cml>"#;
        let s = parse(text).unwrap();
        assert_eq!(s.n_atoms, 1);
        assert_eq!(s.elements, vec![2]); // He, not Ne
        assert_eq!(
            s.warnings,
            vec![
                "file contains 1 additional <molecule> document; only the first is shown"
                    .to_string()
            ]
        );
    }

    #[test]
    fn counts_every_skipped_sibling_molecule() {
        let text = r#"<cml>
  <molecule id="first">
    <atomArray><atom id="a1" elementType="He" x3="0" y3="0" z3="0"/></atomArray>
  </molecule>
  <molecule id="second">
    <atomArray><atom id="b1" elementType="Ne" x3="0" y3="0" z3="0"/></atomArray>
  </molecule>
  <molecule id="third">
    <atomArray><atom id="c1" elementType="Ar" x3="0" y3="0" z3="0"/></atomArray>
  </molecule>
</cml>"#;
        let s = parse(text).unwrap();
        assert_eq!(s.elements, vec![2]);
        assert_eq!(
            s.warnings,
            vec![
                "file contains 2 additional <molecule> documents; only the first is shown"
                    .to_string()
            ]
        );
    }

    #[test]
    fn drops_a_bond_with_a_dangling_atom_reference() {
        let text = r#"<molecule>
  <atomArray>
    <atom id="a1" elementType="C" x3="0" y3="0" z3="0"/>
    <atom id="a2" elementType="C" x3="1.5" y3="0" z3="0"/>
  </atomArray>
  <bondArray>
    <bond atomRefs2="a1 a2" order="1"/>
    <bond atomRefs2="a1 nope" order="1"/>
    <bond atomRefs2="nope a2" order="1"/>
  </bondArray>
</molecule>"#;
        let s = parse(text).unwrap();
        assert_eq!(s.n_file_bonds, 1);
        assert_eq!(s.warnings.len(), 1);
        assert!(
            s.warnings[0].contains("2 bonds"),
            "unexpected warning: {}",
            s.warnings[0]
        );
    }

    #[test]
    fn skips_an_atom_with_no_usable_coordinates() {
        let text = r#"<molecule>
  <atomArray>
    <atom id="a1" elementType="C" x3="0" y3="0" z3="0"/>
    <atom id="a2" elementType="C"/>
  </atomArray>
</molecule>"#;
        let s = parse(text).unwrap();
        assert_eq!(s.n_atoms, 1);
    }

    #[test]
    fn unknown_element_symbol_maps_to_zero() {
        let text = r#"<molecule><atomArray>
  <atom id="a1" elementType="Xx" x3="0" y3="0" z3="0"/>
</atomArray></molecule>"#;
        let s = parse(text).unwrap();
        assert_eq!(s.elements, vec![0]);
    }

    #[test]
    fn rejects_a_document_with_no_molecule() {
        let err = match parse("<foo><bar/></foo>") {
            Ok(_) => panic!("expected an error"),
            Err(e) => e,
        };
        assert!(err.contains("not a CML file"), "unexpected error: {err}");
    }

    #[test]
    fn rejects_a_molecule_with_no_atoms() {
        let err = match parse("<molecule><atomArray/></molecule>") {
            Ok(_) => panic!("expected an error"),
            Err(e) => e,
        };
        assert!(err.contains("no atoms"), "unexpected error: {err}");
    }

    #[test]
    fn rejects_fractional_coordinates_without_a_cell() {
        let text = r#"<molecule><atomArray>
  <atom id="a1" elementType="Si" xFract="0.0" yFract="0.0" zFract="0.0"/>
</atomArray></molecule>"#;
        let err = match parse(text) {
            Ok(_) => panic!("expected an error"),
            Err(e) => e,
        };
        assert!(err.contains("<crystal> cell"), "unexpected error: {err}");
    }

    #[test]
    fn rejects_malformed_xml() {
        assert!(parse("<molecule><atomArray>").is_err());
    }

    #[test]
    fn does_not_expand_a_doctype_entity() {
        // Billion-laughs shape: quick-xml never expands custom entities, so the
        // document parses to "no molecule" rather than exploding.
        let text = concat!(
            "<?xml version=\"1.0\"?>\n",
            "<!DOCTYPE lolz [<!ENTITY lol \"lol\">",
            "<!ENTITY lol2 \"&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;\">]>\n",
            "<lolz>&lol2;</lolz>\n"
        );
        let err = match parse(text) {
            Ok(_) => panic!("expected an error"),
            Err(e) => e,
        };
        assert!(err.contains("not a CML file"), "unexpected error: {err}");
    }
}
