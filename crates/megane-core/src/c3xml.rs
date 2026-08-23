//! Chem3D XML (`.c3xml`) parser.
//!
//! PerkinElmer ChemDraw / Chem3D's XML serialisation, a member of the CDXML
//! family:
//!
//! ```xml
//! <CDXML>
//!   <fragment>
//!     <n id="1" Element="6" Position="0.0 0.0 0.0"/>
//!     <n id="2" Element="1" Position="1.09 0.0 0.0"/>
//!     <b B="1" E="2" Order="1"/>
//!   </fragment>
//! </CDXML>
//! ```
//!
//! `<n>` (node) elements carry `id`, `Element` (an atomic **number**), and 3D
//! coordinates in `Position="x y z"`. `<b>` (bond) elements carry `B`/`E`
//! endpoint ids and an `Order` attribute, so connectivity is explicit and no
//! distance inference is needed.
//!
//! The schema is only loosely documented, so this reader is deliberately
//! permissive: it accepts the long spellings (`node`/`bond`/`Begin`/`End`) that
//! some exports use, and `Element` may be an atomic number or a symbol.
//!
//! Chem3D's **native** `.c3xml` export (root `<C3XML version="…">`) is a
//! different dialect from the CDXML-style one above: atoms are `<atom>`
//! elements carrying `symbol="C"` and `cartCoords="x y z"`, and bonds are
//! `<bond bondAtom1="…" bondAtom2="…" bondOrder="…"/>`. Both dialects are
//! read by this one parser.
//!
//! **2D-only drawings** carry `p="x y"` instead of `Position` and have no third
//! dimension at all. Rather than rejecting them, they are projected onto
//! `z = 0` — the same decision the CML reader makes for `x2`/`y2`, so the two
//! XML formats behave alike. The result is visibly flat, which is the honest
//! rendering of a flat input.
//!
//! The binary `.cdx` and the general `.cdxml` variants are out of scope.
//!
//! Untrusted input: `quick_xml::Reader` does no DTD processing and no custom
//! entity expansion, so a hostile document cannot mount an XXE or
//! billion-laughs attack through it.

use crate::atomic::{capitalize, symbol_to_atomic_num};
use crate::bonds;
use crate::parser::ParsedStructure;
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use std::collections::{HashMap, HashSet};

/// Strip an XML namespace prefix and lower-case: `cdx:Position` → `position`.
fn norm_key(raw: &[u8]) -> String {
    let s = String::from_utf8_lossy(raw);
    let local = match s.rsplit_once(':') {
        Some((_, l)) => l,
        None => &s,
    };
    local.to_ascii_lowercase()
}

/// Attributes keyed by lower-cased local name (the schema mixes casings).
fn attrs(e: &BytesStart<'_>) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for a in e.attributes().flatten() {
        let val = a
            .unescape_value()
            .map(|v| v.into_owned())
            .unwrap_or_else(|_| String::from_utf8_lossy(&a.value).into_owned());
        map.insert(norm_key(a.key.as_ref()), val);
    }
    map
}

/// Parse a whitespace- or comma-separated coordinate list.
fn coords(raw: &str) -> Vec<f32> {
    raw.split([' ', ',', '\t', '\n'])
        .filter(|t| !t.is_empty())
        .filter_map(|t| t.parse().ok())
        .collect()
}

/// Parse a Chem3D XML document into a structure.
pub fn parse(text: &str) -> Result<ParsedStructure, String> {
    let mut reader = Reader::from_str(text);
    reader.config_mut().trim_text(true);

    let mut ids: Vec<String> = Vec::new();
    let mut positions: Vec<f32> = Vec::new();
    let mut elements: Vec<u8> = Vec::new();
    let mut raw_bonds: Vec<(String, String, u8)> = Vec::new();
    let mut any_3d = false;
    let mut saw_root = false;
    let mut warnings: Vec<String> = Vec::new();
    let mut nodes_without_coords = 0usize;

    loop {
        let ev = reader.read_event().map_err(|e| {
            format!(
                "c3xml: malformed XML at byte {}: {e}",
                reader.buffer_position()
            )
        })?;
        match ev {
            Event::Eof => break,
            Event::Start(ref e) | Event::Empty(ref e) => {
                let name = norm_key(e.name().as_ref());
                match name.as_str() {
                    "cdxml" | "fragment" | "chemdraw" | "c3xml" => saw_root = true,
                    "n" | "node" | "atom" => {
                        let map = attrs(e);
                        let (pos, is_3d) = if let Some(p) =
                            map.get("position").or_else(|| map.get("cartcoords"))
                        {
                            let v = coords(p);
                            if v.len() >= 3 {
                                ([v[0], v[1], v[2]], true)
                            } else if v.len() == 2 {
                                ([v[0], v[1], 0.0], false)
                            } else {
                                nodes_without_coords += 1;
                                continue;
                            }
                        } else if let Some(p) = map.get("p") {
                            // 2D drawing coordinates.
                            let v = coords(p);
                            if v.len() >= 2 {
                                ([v[0], v[1], 0.0], false)
                            } else {
                                nodes_without_coords += 1;
                                continue;
                            }
                        } else {
                            // No coordinates — not a renderable node.
                            nodes_without_coords += 1;
                            continue;
                        };
                        any_3d |= is_3d;

                        // `Element` is an atomic number in CDXML-style exports,
                        // but some writers put the symbol there instead; the
                        // native dialect spells it `symbol="C"`.
                        let z = match map.get("element").or_else(|| map.get("symbol")) {
                            Some(v) => match v.trim().parse::<i32>() {
                                Ok(n) if (1..=118).contains(&n) => n as u8,
                                _ => symbol_to_atomic_num(&capitalize(v.trim())),
                            },
                            // A CDXML node with no Element is carbon by convention.
                            None => 6,
                        };

                        ids.push(map.get("id").cloned().unwrap_or_default());
                        elements.push(z);
                        positions.extend_from_slice(&pos);
                    }
                    "b" | "bond" => {
                        let map = attrs(e);
                        let begin = map
                            .get("b")
                            .or_else(|| map.get("begin"))
                            .or_else(|| map.get("bondatom1"))
                            .cloned();
                        let end = map
                            .get("e")
                            .or_else(|| map.get("end"))
                            .or_else(|| map.get("bondatom2"))
                            .cloned();
                        if let (Some(b), Some(e2)) = (begin, end) {
                            let order = map
                                .get("order")
                                .or_else(|| map.get("bondorder"))
                                .and_then(|o| o.trim().parse::<u8>().ok())
                                .filter(|o| (1..=4).contains(o))
                                .unwrap_or(1);
                            raw_bonds.push((b, e2, order));
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    if !saw_root {
        return Err("not a Chem3D XML file: no <CDXML> or <fragment> element found".into());
    }
    if elements.is_empty() {
        return Err(
            "c3xml: document contains no <n> nodes or <atom> elements with coordinates".into(),
        );
    }

    if nodes_without_coords > 0 {
        warnings.push(format!(
            "{nodes_without_coords} atoms without coordinates were dropped"
        ));
    }

    let n_atoms = elements.len();
    let mut id_to_index: HashMap<&str, u32> = HashMap::with_capacity(n_atoms);
    for (i, id) in ids.iter().enumerate() {
        if !id.is_empty() {
            id_to_index.insert(id.as_str(), i as u32);
        }
    }

    let mut bond_pairs: Vec<(u32, u32)> = Vec::new();
    let mut bond_orders: Vec<u8> = Vec::new();
    let mut seen: HashSet<(u32, u32)> = HashSet::new();
    let mut dangling = 0usize;
    for (b, e, order) in &raw_bonds {
        let (Some(&a), Some(&z)) = (id_to_index.get(b.as_str()), id_to_index.get(e.as_str()))
        else {
            dangling += 1; // dangling endpoint — drop the bond, keep the molecule
            continue;
        };
        if a == z {
            continue;
        }
        let pair = (a.min(z), a.max(z));
        if seen.insert(pair) {
            bond_pairs.push(pair);
            bond_orders.push(*order);
        }
    }
    if dangling > 0 {
        warnings.push(format!(
            "{dangling} bonds referencing unknown atoms were dropped"
        ));
    }

    let n_file_bonds = bond_pairs.len();
    let (bonds, bond_orders) = if bond_pairs.is_empty() {
        // A 2D drawing projected to z = 0 has meaningless distances, so bond
        // inference would invent nonsense; only infer for genuine 3D input.
        if any_3d {
            let empty = HashSet::new();
            (
                bonds::infer_bonds(&positions, &elements, n_atoms, &empty),
                None,
            )
        } else {
            (Vec::new(), None)
        }
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
        warnings,
        hetero: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const METHANOL: &str = r#"<?xml version="1.0"?>
<CDXML>
  <fragment>
    <n id="1" Element="6" Position="0.0000 0.0000 0.0000"/>
    <n id="2" Element="8" Position="1.4300 0.0000 0.0000"/>
    <n id="3" Element="1" Position="1.7600 0.9000 0.0000"/>
    <n id="4" Element="1" Position="-0.3600 1.0300 0.0000"/>
    <b B="1" E="2" Order="1"/>
    <b B="2" E="3" Order="1"/>
    <b B="1" E="4" Order="1"/>
  </fragment>
</CDXML>
"#;

    #[test]
    fn parses_nodes_and_explicit_bonds() {
        let s = parse(METHANOL).unwrap();
        assert_eq!(s.n_atoms, 4);
        assert_eq!(s.elements, vec![6, 8, 1, 1]);
        assert_eq!(s.n_file_bonds, 3);
        assert_eq!(s.bond_orders.unwrap(), vec![1, 1, 1]);
        assert!((s.positions[3] - 1.43).abs() < 1e-4);
    }

    #[test]
    fn reads_higher_bond_orders() {
        let text = r#"<CDXML><fragment>
  <n id="1" Element="6" Position="0 0 0"/>
  <n id="2" Element="8" Position="1.2 0 0"/>
  <b B="1" E="2" Order="2"/>
</fragment></CDXML>"#;
        let s = parse(text).unwrap();
        assert_eq!(s.bond_orders.unwrap(), vec![2]);
    }

    #[test]
    fn accepts_the_long_element_names() {
        let text = r#"<CDXML><fragment>
  <node id="a" Element="7" Position="0 0 0"/>
  <node id="b" Element="7" Position="1.1 0 0"/>
  <bond Begin="a" End="b" Order="3"/>
</fragment></CDXML>"#;
        let s = parse(text).unwrap();
        assert_eq!(s.elements, vec![7, 7]);
        assert_eq!(s.bond_orders.unwrap(), vec![3]);
    }

    #[test]
    fn accepts_an_element_symbol_in_place_of_a_number() {
        let text = r#"<CDXML><fragment>
  <n id="1" Element="Fe" Position="0 0 0"/>
</fragment></CDXML>"#;
        let s = parse(text).unwrap();
        assert_eq!(s.elements, vec![26]);
    }

    #[test]
    fn a_node_without_an_element_defaults_to_carbon() {
        let text = r#"<CDXML><fragment><n id="1" Position="0 0 0"/></fragment></CDXML>"#;
        let s = parse(text).unwrap();
        assert_eq!(s.elements, vec![6]);
    }

    #[test]
    fn projects_a_2d_drawing_onto_z_zero_without_inferring_bonds() {
        let text = r#"<CDXML><fragment>
  <n id="1" p="0 0"/>
  <n id="2" p="30 0"/>
</fragment></CDXML>"#;
        let s = parse(text).unwrap();
        assert_eq!(s.n_atoms, 2);
        assert_eq!(s.positions[2], 0.0);
        assert_eq!(s.positions[5], 0.0);
        // No <b> elements and no real 3D geometry ⇒ no invented bonds.
        assert!(s.bonds.is_empty());
    }

    #[test]
    fn infers_bonds_for_3d_input_that_omits_the_bond_elements() {
        let text = r#"<CDXML><fragment>
  <n id="1" Element="8" Position="0.0 0.0 0.117"/>
  <n id="2" Element="1" Position="0.0 0.757 -0.469"/>
  <n id="3" Element="1" Position="0.0 -0.757 -0.469"/>
</fragment></CDXML>"#;
        let s = parse(text).unwrap();
        assert_eq!(s.n_file_bonds, 0);
        assert_eq!(s.bonds.len(), 2);
    }

    #[test]
    fn comma_separated_positions_parse() {
        let text = r#"<CDXML><fragment>
  <n id="1" Element="6" Position="1.0,2.0,3.0"/>
</fragment></CDXML>"#;
        let s = parse(text).unwrap();
        assert!((s.positions[1] - 2.0).abs() < 1e-6);
    }

    #[test]
    fn drops_a_bond_with_a_dangling_endpoint() {
        let text = r#"<CDXML><fragment>
  <n id="1" Element="6" Position="0 0 0"/>
  <n id="2" Element="6" Position="1.5 0 0"/>
  <b B="1" E="2" Order="1"/>
  <b B="1" E="99" Order="1"/>
</fragment></CDXML>"#;
        let s = parse(text).unwrap();
        assert_eq!(s.n_file_bonds, 1);
        assert_eq!(
            s.warnings,
            vec!["1 bonds referencing unknown atoms were dropped".to_string()]
        );
    }

    #[test]
    fn warns_about_a_node_dropped_for_missing_coordinates() {
        let text = r#"<CDXML><fragment>
  <n id="1" Element="6" Position="0 0 0"/>
  <n id="2" Element="6"/>
  <b B="1" E="2" Order="1"/>
</fragment></CDXML>"#;
        let s = parse(text).unwrap();
        assert_eq!(s.n_atoms, 1);
        // The bond references the dropped node, so it is dropped and warned too.
        assert_eq!(s.n_file_bonds, 0);
        assert_eq!(
            s.warnings,
            vec![
                "1 atoms without coordinates were dropped".to_string(),
                "1 bonds referencing unknown atoms were dropped".to_string()
            ]
        );
    }

    /// Chem3D's native dialect: `<C3XML>` root, `<atom symbol cartCoords>`
    /// atoms, `<bond bondAtom1 bondAtom2 bondOrder>` bonds.
    #[test]
    fn parses_the_native_chem3d_dialect() {
        let text = r#"<?xml version="1.0" encoding="UTF-8" ?>
<C3XML version="10.0"><model id="1"
><atom id="3" symbol="O" pdbSymbol=" O  " userNum="1" cartCoords="0 0 0.117"
/><atom id="4" symbol="H" userNum="2" cartCoords="0 0.757 -0.469"
/><atom id="5" symbol="H" userNum="3" cartCoords="0 -0.757 -0.469"
/><bond id="6" bondAtom1="3" bondAtom2="4" bondOrderType="0" bondOrder="1"
/><bond id="7" bondAtom1="3" bondAtom2="5" bondOrderType="0" bondOrder="1"
/></model></C3XML>"#;
        let s = parse(text).unwrap();
        assert_eq!(s.n_atoms, 3);
        assert_eq!(s.elements, vec![8, 1, 1]);
        assert_eq!(s.n_file_bonds, 2);
        assert_eq!(s.bond_orders.unwrap(), vec![1, 1]);
        assert!((s.positions[2] - 0.117).abs() < 1e-5);
    }

    /// Jmol's benzene demo trimmed to its model block — a real Chem3D 10.0
    /// export (the layout that used to be rejected).
    #[test]
    fn parses_a_real_chem3d_export_fixture() {
        let s = parse(include_str!("../../../tests/fixtures/benzene_chem3d.c3xml")).unwrap();
        assert_eq!(s.n_atoms, 12);
        assert_eq!(s.elements.iter().filter(|&&z| z == 6).count(), 6);
        assert_eq!(s.elements.iter().filter(|&&z| z == 1).count(), 6);
        assert_eq!(s.n_file_bonds, 12);
    }

    #[test]
    fn rejects_a_document_with_no_cdxml_root() {
        let err = match parse("<html><body/></html>") {
            Ok(_) => panic!("expected an error"),
            Err(e) => e,
        };
        assert!(err.contains("not a Chem3D XML"), "unexpected: {err}");
    }

    #[test]
    fn rejects_a_document_with_no_nodes() {
        let err = match parse("<CDXML><fragment/></CDXML>") {
            Ok(_) => panic!("expected an error"),
            Err(e) => e,
        };
        assert!(err.contains("no <n> nodes or <atom>"), "unexpected: {err}");
    }

    #[test]
    fn rejects_malformed_xml() {
        assert!(parse("<CDXML><fragment>").is_err());
    }
}
