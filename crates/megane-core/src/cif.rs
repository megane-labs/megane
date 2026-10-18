/// CIF (Crystallographic Information File) text parser.
///
/// Parses cell parameters (_cell_length_a/b/c, _cell_angle_alpha/beta/gamma)
/// and atom sites (_atom_site loop) with fractional or Cartesian coordinates.
use std::collections::HashSet;

use crate::atomic::element_from_symbol;
use crate::bonds;
use crate::cif_lex::{contains_ci, split_line, starts_with_ci, strip_quotes, Document, Item};
use crate::parser::{cell_params_to_matrix, ParsedStructure};

/// Determine column indices from the loop_ header tags.
struct AtomSiteColumns {
    type_symbol: Option<usize>,
    label: Option<usize>,
    fract_x: Option<usize>,
    fract_y: Option<usize>,
    fract_z: Option<usize>,
    cartn_x: Option<usize>,
    cartn_y: Option<usize>,
    cartn_z: Option<usize>,
}

impl AtomSiteColumns {
    fn new() -> Self {
        Self {
            type_symbol: None,
            label: None,
            fract_x: None,
            fract_y: None,
            fract_z: None,
            cartn_x: None,
            cartn_y: None,
            cartn_z: None,
        }
    }

    fn assign(&mut self, idx: usize, tag: &str) {
        let tag_lower = tag.to_ascii_lowercase();
        match tag_lower.as_str() {
            "_atom_site_type_symbol" => self.type_symbol = Some(idx),
            "_atom_site_label" => self.label = Some(idx),
            "_atom_site_fract_x" => self.fract_x = Some(idx),
            "_atom_site_fract_y" => self.fract_y = Some(idx),
            "_atom_site_fract_z" => self.fract_z = Some(idx),
            "_atom_site_cartn_x" => self.cartn_x = Some(idx),
            "_atom_site_cartn_y" => self.cartn_y = Some(idx),
            "_atom_site_cartn_z" => self.cartn_z = Some(idx),
            _ => {}
        }
    }

    fn has_fractional(&self) -> bool {
        self.fract_x.is_some() && self.fract_y.is_some() && self.fract_z.is_some()
    }

    fn has_cartesian(&self) -> bool {
        self.cartn_x.is_some() && self.cartn_y.is_some() && self.cartn_z.is_some()
    }
}

// Fractional → Cartesian with the row-major cell matrix (rows va, vb, vc);
// the shared implementation lives in `crate::cell`.
use crate::cell::frac_to_cart as fract_to_cart;

/// CIF/mmCIF loop tags whose column holds a symmetry operation string.
const SYMOP_TAGS: [&str; 2] = [
    "_symmetry_equiv_pos_as_xyz",
    "_space_group_symop_operation_xyz",
];

fn is_symop_tag(tag: &str) -> bool {
    SYMOP_TAGS.iter().any(|t| t.eq_ignore_ascii_case(tag))
}

/// Extract the symop field from a single data row of a symmetry loop.
fn extract_symop_field(line: &str, col: usize, col_count: usize) -> Option<String> {
    let line = line.trim();
    // Single-column loop: the entire (possibly quoted) line is the symop.
    if col_count == 1 {
        let v = strip_quotes(line);
        return (!v.is_empty()).then(|| v.to_string());
    }
    let fields = split_line(line);
    if fields.len() < col_count {
        // Some malformed-but-common files omit the id/flag columns and provide
        // only the operation. Preserve the existing comma-token fallback.
        return fields
            .into_iter()
            .find(|field| field.contains(','))
            .map(str::to_string);
    }
    fields.get(col).map(|f| f.to_string())
}

/// The rest of the line `value` starts on, for an unquoted symop written with
/// spaces (`_symmetry_equiv_pos_as_xyz x, y, z`), which is malformed but
/// common enough that the parser has always accepted it.
fn rest_of_line<'a>(text: &'a str, value: &'a str) -> &'a str {
    let base = text.as_ptr() as usize;
    let ptr = value.as_ptr() as usize;
    if ptr < base || ptr + value.len() > base + text.len() {
        return value;
    }
    let start = ptr - base;
    let line = &text[start..];
    line.split('\n').next().unwrap_or(line).trim()
}

/// Extract crystallographic symmetry operations from CIF/mmCIF text.
///
/// Recognizes both the loop form (`loop_ _symmetry_equiv_pos_as_xyz ...`) with
/// an optional id column, and the single key-value form
/// (`_symmetry_equiv_pos_as_xyz 'x,y,z'`). Returns the raw operation strings
/// (e.g. `"-x+1/2,y+1/2,-z"`) without applying them.
pub fn extract_symmetry_ops(text: &str) -> Vec<String> {
    // Every symop tag ends in `xyz`; skip lexing documents (most mmCIF
    // entries) that cannot hold one.
    if !contains_ci(text, "xyz") {
        return Vec::new();
    }
    symmetry_ops(text, &Document::parse(text))
}

/// [`extract_symmetry_ops`] over an already-lexed document.
///
/// Symmetry loops are read line by line on purpose: unlike atom-site rows,
/// symop rows are conventionally one per line, and real files write unquoted
/// operations containing spaces (`x, y, z`) that a strict token stream would
/// split into three values.
pub(crate) fn symmetry_ops(text: &str, doc: &Document) -> Vec<String> {
    let mut ops: Vec<String> = Vec::new();
    for item in &doc.items {
        match item {
            Item::Loop(lp) => {
                let Some(col) = lp.tags.iter().position(|t| is_symop_tag(t)) else {
                    continue;
                };
                for line in lp.body().lines() {
                    let t = line.trim();
                    if t.is_empty() || t.starts_with('#') {
                        continue;
                    }
                    if let Some(op) = extract_symop_field(t, col, lp.tags.len()) {
                        ops.push(op);
                    }
                }
            }
            Item::Pair { tag, value } => {
                if !is_symop_tag(tag) {
                    continue;
                }
                let v = if value.quoted {
                    value.text
                } else {
                    rest_of_line(text, value.text)
                };
                if !v.is_empty() {
                    ops.push(v.to_string());
                }
            }
        }
    }
    ops
}

pub fn parse(text: &str) -> Result<ParsedStructure, String> {
    let doc = Document::parse(text);

    // --- Cell parameters (last occurrence wins) ---
    let cell = |tag: &str| doc.value(tag).and_then(|v| v.as_f32());
    let cell_a = cell("_cell_length_a");
    let cell_b = cell("_cell_length_b");
    let cell_c = cell("_cell_length_c");
    let cell_alpha = cell("_cell_angle_alpha");
    let cell_beta = cell("_cell_angle_beta");
    let cell_gamma = cell("_cell_angle_gamma");

    let box_matrix = match (cell_a, cell_b, cell_c, cell_alpha, cell_beta, cell_gamma) {
        (Some(a), Some(b), Some(c), Some(alpha), Some(beta), Some(gamma))
            if a > 0.0 && b > 0.0 && c > 0.0 =>
        {
            Some(cell_params_to_matrix(a, b, c, alpha, beta, gamma))
        }
        _ => None,
    };

    // --- Parse atom_site loop ---
    let mut positions: Vec<f32> = Vec::new();
    let mut elements: Vec<u8> = Vec::new();
    let mut atom_labels: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    // Loop rows are a CIF token stream (see `cif_lex`): a row may wrap lines,
    // quoted values may contain spaces, and blank/comment lines inside the
    // loop body are ignored (Issue #458).
    for lp in doc.loops() {
        if !lp.has_tag_prefix("_atom_site") {
            continue;
        }
        let mut cols = AtomSiteColumns::new();
        for (idx, tag) in lp.tags.iter().enumerate() {
            if starts_with_ci(tag, "_atom_site") {
                cols.assign(idx, tag);
            }
        }

        let use_fractional = cols.has_fractional() && box_matrix.is_some();
        let use_cartesian = cols.has_cartesian();
        if !use_fractional && !use_cartesian {
            continue;
        }

        let mut rows = lp.cursor();
        while let Some(row) = rows.next_row() {
            let num = |c: usize| row[c].as_f32().unwrap_or(0.0);
            // Extract coordinates first to avoid desyncing
            // elements/atom_labels from positions on missing coords
            let coords = if let (true, Some(fx_col), Some(fy_col), Some(fz_col), Some(bm)) = (
                use_fractional,
                cols.fract_x,
                cols.fract_y,
                cols.fract_z,
                box_matrix.as_ref(),
            ) {
                Some(fract_to_cart(num(fx_col), num(fy_col), num(fz_col), bm))
            } else if let (Some(cx), Some(cy), Some(cz)) =
                (cols.cartn_x, cols.cartn_y, cols.cartn_z)
            {
                Some((num(cx), num(cy), num(cz)))
            } else {
                None
            };

            let Some((x, y, z)) = coords else {
                continue;
            };

            // Element: type_symbol, falling back to the label when the type
            // symbol column is absent or holds a `?`/`.` null.
            let label = cols.label.and_then(|c| row[c].get());
            let elem = cols
                .type_symbol
                .and_then(|c| row[c].get())
                .or(label)
                .map(element_from_symbol)
                .unwrap_or(0);
            elements.push(elem);
            atom_labels.push(label.unwrap_or_default().to_string());

            positions.push(x);
            positions.push(y);
            positions.push(z);
        }

        if lp.partial_row_len() > 0 {
            warnings.push(format!(
                "_atom_site loop ends with an incomplete row ({} of {} values); it was skipped",
                lp.partial_row_len(),
                lp.tags.len()
            ));
        }

        // Only parse the first atom_site loop
        if !elements.is_empty() {
            break;
        }
    }

    let n_atoms = elements.len();
    if n_atoms == 0 {
        // Macromolecular CIFs use dotted `_atom_site.` tags (mmCIF grammar)
        // rather than the small-molecule `_atom_site_` ones, yet ship under
        // the same `.cif` extension (e.g. wwPDB downloads). Delegate instead
        // of erroring so hosts don't need to sniff the dialect themselves.
        if doc.has_tag_prefix("_atom_site.") {
            return crate::mmcif::parse_document(text, &doc);
        }
        return Err("CIF file contains no atom sites".to_string());
    }

    // Infer periodic connectivity without changing the crystallographic atom
    // sites. Moving atoms to make a finite molecule whole is invalid for an
    // extended inorganic network and corrupts which atoms belong to the home
    // cell. Downstream bond rendering resolves cross-boundary bond images.
    let empty_bonds = HashSet::new();
    let bonds = match box_matrix.as_ref() {
        Some(bm) => bonds::infer_bonds_periodic(&positions, &elements, n_atoms, &empty_bonds, bm),
        None => bonds::infer_bonds(&positions, &elements, n_atoms, &empty_bonds),
    };

    let labels = if atom_labels.iter().any(|l| !l.is_empty()) {
        Some(atom_labels)
    } else {
        None
    };

    // A CIF lists only the asymmetric unit. The space-group operations are
    // captured verbatim and returned in `symmetry_ops`; filling the unit cell
    // (VESTA-style packing) is the `symmetry` pipeline node's job, so the user
    // can see and toggle the expansion instead of it being baked in at parse
    // time.
    let symmetry_ops = symmetry_ops(text, &doc);

    Ok(ParsedStructure {
        n_atoms,
        positions,
        elements,
        bonds,
        n_file_bonds: 0,
        box_matrix,
        atom_labels: labels,
        symmetry_ops,
        warnings,
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A macromolecular (mmCIF-grammar) file under the `.cif` extension —
    /// exactly what wwPDB serves as `1cbs.cif` — must be delegated to the
    /// mmCIF parser instead of failing with "no atom sites".
    #[test]
    fn delegates_a_dotted_tag_mmcif_document_to_the_mmcif_parser() {
        let s = parse(include_str!("../../../tests/fixtures/1ala.mmcif")).unwrap();
        assert!(s.n_atoms > 0);
    }

    /// A document with neither `_atom_site_*` nor `_atom_site.` tags still
    /// gets the plain-CIF error, not an mmCIF one.
    #[test]
    fn a_cif_without_any_atom_sites_still_errors() {
        let err = match parse("data_x\n_cell_length_a 5.0\n") {
            Ok(_) => panic!("expected an error"),
            Err(e) => e,
        };
        assert!(err.contains("no atom sites"), "unexpected: {err}");
    }

    /// Regression test for Issue #558. `pbc_bond_split.cif` lists a single
    /// molecule wrapped into the cell so the carbonyl oxygen sits on the far
    /// side of the a-face from the carbon. Periodic inference must recover the
    /// C–O bond without changing either atom's crystallographic coordinates.
    #[test]
    fn test_parse_recovers_bond_across_periodic_boundary() {
        let text = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/pbc_bond_split.cif"
        ))
        .expect("read fixture");
        let s = parse(&text).unwrap();
        assert_eq!(s.n_atoms, 4);
        let matrix = s.box_matrix.expect("fixture cell");
        let expected_oxygen = fract_to_cart(0.895, 0.5, 0.5, &matrix);
        assert!((s.positions[3] - expected_oxygen.0).abs() < 1e-4);
        assert!((s.positions[4] - expected_oxygen.1).abs() < 1e-4);
        assert!((s.positions[5] - expected_oxygen.2).abs() < 1e-4);
        // C–O (the boundary-crossing bond) plus the two C–H bonds.
        assert_eq!(s.bonds.len(), 3);
        let has = |a: u32, b: u32| s.bonds.contains(&(a, b)) || s.bonds.contains(&(b, a));
        assert!(
            has(0, 1),
            "C–O bond across the periodic boundary must exist"
        );
        assert!(has(0, 2));
        assert!(has(0, 3));
    }

    /// Parsing the expanded AFLOW alpha-Al2O3 conventional cell must preserve
    /// its 30 asserted atom sites instead of moving the periodic network while
    /// attempting to make it into one finite molecule.
    #[test]
    fn test_parse_aflow_alpha_al2o3_preserves_asserted_sites() {
        let text = include_str!("../../../tests/fixtures/alpha_al2o3_aflow.cif");
        let s = parse(text).expect("parse AFLOW alpha-Al2O3 fixture");
        assert_eq!(s.n_atoms, 30);
        assert_eq!(s.symmetry_ops, vec!["x, y, z"]);

        let matrix = s.box_matrix.expect("fixture cell");
        let expected_fractional = [
            (0, 0.0, 0.0, 0.352_16),
            (4, 2.0 / 3.0, 1.0 / 3.0, 0.685_493_35),
            (12, 0.693_9, 0.0, 0.25),
            (29, 0.027_233_332, 0.360_566_68, 0.416_666_66),
        ];
        for (index, fx, fy, fz) in expected_fractional {
            let (x, y, z) = fract_to_cart(fx, fy, fz, &matrix);
            let actual = &s.positions[index * 3..index * 3 + 3];
            assert!((actual[0] - x).abs() < 1e-4, "atom {index} x shifted");
            assert!((actual[1] - y).abs() < 1e-4, "atom {index} y shifted");
            assert!((actual[2] - z).abs() < 1e-4, "atom {index} z shifted");
        }
        // The parser stores unique atom pairs. Multiple periodic images of the
        // same pair are derived later by the bond/coordination pipeline nodes.
        assert_eq!(s.bonds.len(), 36);
    }

    #[test]
    fn test_extract_symmetry_ops_single_column_loop() {
        let cif = r#"data_x
loop_
_symmetry_equiv_pos_as_xyz
x,y,z
-x,-y,-z
-x+1/2,y+1/2,-z
x+1/2,-y+1/2,z

loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
Na1 Na 0.0 0.0 0.0
"#;
        let ops = extract_symmetry_ops(cif);
        assert_eq!(
            ops,
            vec!["x,y,z", "-x,-y,-z", "-x+1/2,y+1/2,-z", "x+1/2,-y+1/2,z"]
        );
    }

    #[test]
    fn test_extract_symmetry_ops_id_column_and_space_group_tag() {
        let cif = r#"data_x
loop_
_space_group_symop_id
_space_group_symop_operation_xyz
1 x,y,z
2 -x,-y,-z
"#;
        let ops = extract_symmetry_ops(cif);
        assert_eq!(ops, vec!["x,y,z", "-x,-y,-z"]);
    }

    #[test]
    fn test_extract_symmetry_ops_quoted_field_with_spaces() {
        let cif = r#"data_x
loop_
_symmetry_equiv_pos_site_id
_symmetry_equiv_pos_as_xyz
1 'x, y, z'
2 '-x, -y, -z'
"#;
        let ops = extract_symmetry_ops(cif);
        assert_eq!(ops, vec!["x, y, z", "-x, -y, -z"]);
    }

    #[test]
    fn test_extract_symmetry_ops_quoted_keyvalue() {
        let cif = "data_x\n_symmetry_equiv_pos_as_xyz 'x,y,z'\n";
        let ops = extract_symmetry_ops(cif);
        assert_eq!(ops, vec!["x,y,z"]);
    }

    #[test]
    fn test_extract_symmetry_ops_double_quoted() {
        // Single-column loop with a double-quoted operation.
        let cif = "data_x\nloop_\n_symmetry_equiv_pos_as_xyz\n\"x,y,z\"\n\"-x,-y,-z\"\n";
        let ops = extract_symmetry_ops(cif);
        assert_eq!(ops, vec!["x,y,z", "-x,-y,-z"]);
    }

    #[test]
    fn test_extract_symmetry_ops_fewer_fields_than_columns() {
        // A multi-column symmetry loop whose data row collapses to a single
        // quoted token (fewer whitespace fields than header tags) exercises the
        // comma-token fallback in extract_symop_field.
        let cif = r#"data_x
loop_
_symmetry_equiv_pos_site_id
_symmetry_equiv_pos_as_xyz
_symmetry_extra_flag
'x,y,z'
'-x,-y,-z'
"#;
        let ops = extract_symmetry_ops(cif);
        assert_eq!(ops, vec!["x,y,z", "-x,-y,-z"]);
    }

    #[test]
    fn test_extract_symmetry_ops_absent() {
        let cif = "data_x\n_cell_length_a 5.0\n";
        assert!(extract_symmetry_ops(cif).is_empty());
    }

    /// The Issue #460 CIF carries the P2_1/a equivalent positions.
    #[test]
    fn test_parse_cif_captures_symmetry_ops() {
        let cif = r#"data_degly19
_cell_length_a 11.156
_cell_length_b 5.8644
_cell_length_c 5.3417
_cell_angle_alpha 90
_cell_angle_beta 125.83
_cell_angle_gamma 90
loop_
_symmetry_equiv_pos_as_xyz
x,y,z
-x,-y,-z
-x+1/2,y+1/2,-z
x+1/2,-y+1/2,z
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
O1 O 0.7229 0.8423 0.8321
"#;
        let result = parse(cif).expect("parse failed");
        // The parser returns the asymmetric unit as-is; the 4 P2_1/a
        // operations are surfaced for the `symmetry` pipeline node to apply.
        assert_eq!(result.n_atoms, 1);
        assert_eq!(result.symmetry_ops.len(), 4);
        assert_eq!(result.symmetry_ops[0], "x,y,z");
        assert_eq!(result.symmetry_ops[2], "-x+1/2,y+1/2,-z");
    }

    /// A quoted atom label containing a space used to shift every later
    /// column, so the type symbol and coordinates were read from the wrong
    /// fields.
    #[test]
    fn quoted_label_with_space_keeps_columns_aligned() {
        let cif = "data_q
_cell_length_a 10
_cell_length_b 10
_cell_length_c 10
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
'C1 A' C 0.1 0.2 0.3
\"O5'\" O 0.4 0.5 0.6
";
        let s = parse(cif).expect("parse");
        assert_eq!(s.n_atoms, 2);
        assert_eq!(s.elements, vec![6, 8]);
        assert_eq!(
            s.atom_labels.as_ref().unwrap(),
            &vec!["C1 A".to_string(), "O5'".to_string()]
        );
        assert!((s.positions[0] - 1.0).abs() < 1e-4);
        assert!((s.positions[5] - 6.0).abs() < 1e-4);
    }

    /// Loop rows are a token stream: a row may wrap onto several lines and a
    /// column may hold a `;` text field.
    #[test]
    fn wrapped_rows_and_text_fields_in_atom_loop() {
        let cif = "data_w
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_Cartn_x
_atom_site_Cartn_y
_atom_site_Cartn_z
_atom_site_note
O1 O
  1.0 2.0
  3.0 plain
H1 H 4.0 5.0 6.0
;multi-line
note
;
";
        let s = parse(cif).expect("parse");
        assert_eq!(s.n_atoms, 2);
        assert_eq!(s.elements, vec![8, 1]);
        assert_eq!(&s.positions, &[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
    }

    /// Standard uncertainties are stripped from coordinates, a value may sit
    /// on the line after its tag, and `?`/`.` nulls are handled: a missing
    /// type symbol falls back to the label, a missing label is no label.
    #[test]
    fn uncertainties_and_missing_values() {
        let cif = "data_su
_cell_length_a
  10.0(2)
_cell_length_b 10.0(2)
_cell_length_c 10.0(2)
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
Na1 ? 0.25(3) 0.5(12) 0.75(1)
? Cl 0.0 0.0 0.0
";
        let s = parse(cif).expect("parse");
        assert!(s.box_matrix.is_some());
        assert_eq!(s.elements, vec![11, 17]);
        assert!((s.positions[0] - 2.5).abs() < 1e-4);
        assert!((s.positions[1] - 5.0).abs() < 1e-4);
        assert!((s.positions[2] - 7.5).abs() < 1e-4);
        assert_eq!(
            s.atom_labels.as_ref().unwrap(),
            &vec!["Na1".to_string(), String::new()]
        );
    }

    /// A dangling partial row at the end of the atom loop is reported, not
    /// dropped silently.
    #[test]
    fn incomplete_last_row_warns() {
        let cif = "data_p
loop_
_atom_site_label
_atom_site_Cartn_x
_atom_site_Cartn_y
_atom_site_Cartn_z
Na1 1 2 3
Cl1 4
";
        let s = parse(cif).expect("parse");
        assert_eq!(s.n_atoms, 1);
        assert_eq!(
            s.warnings,
            vec!["_atom_site loop ends with an incomplete row (2 of 4 values); it was skipped"]
        );
    }

    #[test]
    fn atom_site_loop_without_coordinates_is_skipped() {
        let cif = "data_aniso
loop_
_atom_site_aniso_label
_atom_site_aniso_U_11
Na1 0.01
loop_
_atom_site_label
_atom_site_Cartn_x
_atom_site_Cartn_y
_atom_site_Cartn_z
Na1 1 2 3
";
        let s = parse(cif).expect("parse");
        assert_eq!(s.n_atoms, 1);
        assert_eq!(s.elements, vec![11]);
    }

    #[test]
    fn test_extract_symmetry_ops_unquoted_keyvalue_with_spaces() {
        let cif = "data_x\n_symmetry_equiv_pos_as_xyz x, y, z\n_cell_length_a 5\n";
        assert_eq!(extract_symmetry_ops(cif), vec!["x, y, z"]);
        // Uppercase tags are matched case-insensitively.
        let upper = "data_x\nloop_\n_SYMMETRY_EQUIV_POS_AS_XYZ\nx,y,z\n";
        assert_eq!(extract_symmetry_ops(upper), vec!["x,y,z"]);
    }

    #[test]
    fn test_rest_of_line_ignores_foreign_slices() {
        let text = "_tag x, y, z\nnext";
        assert_eq!(rest_of_line(text, &text[5..7]), "x, y, z");
        let other = String::from("abc");
        assert_eq!(rest_of_line(text, &other), "abc");
    }

    /// Compact golden digest of every CIF/mmCIF fixture, dispatched the way
    /// the hosts do. Recorded from the pre-lexer line-based parsers so the
    /// shared token-stream lexer is pinned to the exact same output.
    #[test]
    fn fixture_outputs_are_pinned() {
        let cases: [(&str, usize, usize, usize, u32, f64); 6] = [
            ("1ala.mmcif", 10, 11, 0, 68, 152.5),
            ("alpha_al2o3_aflow.cif", 30, 36, 1, 300, 272.9593),
            ("delta_glycine.cif", 10, 9, 4, 40, 158.4565),
            ("glycine_csd.cif", 10, 9, 4, 40, 17.7596),
            ("nacl.cif", 8, 18, 0, 112, 33.8412),
            ("pbc_bond_split.cif", 4, 3, 1, 16, 41.56),
        ];
        for (name, n_atoms, n_bonds, n_ops, elem_sum, pos_sum) in cases {
            let path = format!("{}/../../tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
            let text = std::fs::read_to_string(&path).expect("read fixture");
            let s = if crate::mmcif::is_mmcif(&text) {
                crate::mmcif::parse(&text)
            } else {
                parse(&text)
            }
            .expect("parse fixture");
            assert_eq!(s.n_atoms, n_atoms, "{name} n_atoms");
            assert_eq!(s.bonds.len(), n_bonds, "{name} bonds");
            assert_eq!(s.symmetry_ops.len(), n_ops, "{name} symops");
            let es: u32 = s.elements.iter().map(|&e| e as u32).sum();
            assert_eq!(es, elem_sum, "{name} elements");
            let ps: f64 = s.positions.iter().map(|&p| p as f64).sum();
            assert!((ps - pos_sum).abs() < 1e-3, "{name} positions {ps}");
            assert!(s.warnings.is_empty(), "{name} warnings");
        }
    }

    #[test]
    fn test_element_from_symbol() {
        assert_eq!(element_from_symbol("Na"), 11);
        assert_eq!(element_from_symbol("Cl"), 17);
        assert_eq!(element_from_symbol("Fe2+"), 26);
        assert_eq!(element_from_symbol("O2-"), 8);
        assert_eq!(element_from_symbol("Si"), 14);
        assert_eq!(element_from_symbol("Na1"), 11);
    }

    #[test]
    fn test_fract_to_cart_cubic() {
        // Simple cubic cell: a=b=c=10, alpha=beta=gamma=90
        let matrix = cell_params_to_matrix(10.0, 10.0, 10.0, 90.0, 90.0, 90.0);
        let (x, y, z) = fract_to_cart(0.5, 0.5, 0.5, &matrix);
        assert!((x - 5.0).abs() < 1e-3);
        assert!((y - 5.0).abs() < 1e-3);
        assert!((z - 5.0).abs() < 1e-3);
    }

    #[test]
    fn test_parse_nacl_cif() {
        let cif = r#"data_NaCl
_cell_length_a   5.6402
_cell_length_b   5.6402
_cell_length_c   5.6402
_cell_angle_alpha   90.000
_cell_angle_beta    90.000
_cell_angle_gamma   90.000

loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
Na1 Na 0.0 0.0 0.0
Cl1 Cl 0.5 0.5 0.5
"#;
        let result = parse(cif).expect("parse failed");
        assert_eq!(result.n_atoms, 2);
        assert_eq!(result.elements[0], 11); // Na
        assert_eq!(result.elements[1], 17); // Cl
        assert!(result.box_matrix.is_some());
        let bm = result.box_matrix.unwrap();
        assert!((bm[0] - 5.6402).abs() < 0.01);
        // Na at origin
        assert!(result.positions[0].abs() < 0.01);
        assert!(result.positions[1].abs() < 0.01);
        assert!(result.positions[2].abs() < 0.01);
        // Cl at (0.5, 0.5, 0.5) → ~(2.82, 2.82, 2.82)
        assert!((result.positions[3] - 2.82).abs() < 0.1);
    }

    #[test]
    fn test_parse_cif_with_su() {
        let cif = r#"data_test
_cell_length_a   5.6402(1)
_cell_length_b   5.6402(1)
_cell_length_c   5.6402(1)
_cell_angle_alpha   90.000(0)
_cell_angle_beta    90.000(0)
_cell_angle_gamma   90.000(0)

loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
Na1 Na 0.0 0.0 0.0
"#;
        let result = parse(cif).expect("parse failed");
        assert_eq!(result.n_atoms, 1);
        let bm = result.box_matrix.unwrap();
        assert!((bm[0] - 5.6402).abs() < 0.01);
    }

    #[test]
    fn test_parse_cif_cartesian() {
        let cif = r#"data_test
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_Cartn_x
_atom_site_Cartn_y
_atom_site_Cartn_z
O1 O 1.0 2.0 3.0
H1 H 1.5 2.5 3.5
"#;
        let result = parse(cif).expect("parse failed");
        assert_eq!(result.n_atoms, 2);
        assert_eq!(result.elements[0], 8); // O
        assert_eq!(result.elements[1], 1); // H
        assert!((result.positions[0] - 1.0).abs() < 1e-5);
        assert!((result.positions[1] - 2.0).abs() < 1e-5);
        assert!((result.positions[2] - 3.0).abs() < 1e-5);
        assert!(result.box_matrix.is_none());
    }

    #[test]
    fn test_parse_empty_cif_errors() {
        let result = parse("data_empty\n");
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_cif_fixture() {
        let text = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/nacl.cif"
        ))
        .expect("read fixture");
        let result = parse(&text).expect("parse failed");
        assert_eq!(result.n_atoms, 8);
        assert!(result.elements.contains(&11)); // Na
        assert!(result.elements.contains(&17)); // Cl
        assert!(result.box_matrix.is_some());
    }

    /// Regression test for Issue #458: CCDC-style CIFs put a blank line
    /// between the `_atom_site_*` loop header and the first data row.
    /// The parser used to break on that blank line and report no atoms.
    #[test]
    fn test_parse_cif_blank_line_before_data() {
        let cif = r#"data_blanks
_cell_length_a   5.6402
_cell_length_b   5.6402
_cell_length_c   5.6402
_cell_angle_alpha   90.000
_cell_angle_beta    90.000
_cell_angle_gamma   90.000

loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z

Na1 Na 0.0 0.0 0.0
Cl1 Cl 0.5 0.5 0.5
"#;
        let result = parse(cif).expect("parse failed");
        assert_eq!(result.n_atoms, 2);
        assert_eq!(result.elements[0], 11);
        assert_eq!(result.elements[1], 17);
    }

    /// Blank lines and comment lines should be tolerated *between* data rows too.
    #[test]
    fn test_parse_cif_blank_and_comment_lines_inside_loop() {
        let cif = r#"data_blanks_mid
_cell_length_a   5.6402
_cell_length_b   5.6402
_cell_length_c   5.6402
_cell_angle_alpha   90.000
_cell_angle_beta    90.000
_cell_angle_gamma   90.000

loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
Na1 Na 0.0 0.0 0.0

# spacer comment between data rows
Cl1 Cl 0.5 0.5 0.5
"#;
        let result = parse(cif).expect("parse failed");
        assert_eq!(result.n_atoms, 2);
        assert_eq!(result.elements[0], 11);
        assert_eq!(result.elements[1], 17);
    }

    /// Regression test for Issue #458 against the exact CCDC glycine fixture.
    #[test]
    fn test_parse_glycine_csd_fixture() {
        let text = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/glycine_csd.cif"
        ))
        .expect("read fixture");
        let result = parse(&text).expect("parse failed");
        // The parser returns the 10-atom asymmetric unit untouched; the 4
        // space-group operations that fill the unit cell (4 glycine molecules,
        // 40 atoms) are surfaced for the `symmetry` pipeline node to apply.
        assert_eq!(result.n_atoms, 10);
        assert_eq!(result.symmetry_ops.len(), 4);
        assert!(result.elements.contains(&1)); // H
        assert!(result.elements.contains(&6)); // C
        assert!(result.elements.contains(&7)); // N
        assert!(result.elements.contains(&8)); // O
        let bm = result.box_matrix.expect("box matrix");
        assert!((bm[0] - 5.0999).abs() < 0.01);
        let n_o = result.elements.iter().filter(|&&e| e == 8).count();
        let n_c = result.elements.iter().filter(|&&e| e == 6).count();
        let n_n = result.elements.iter().filter(|&&e| e == 7).count();
        let n_h = result.elements.iter().filter(|&&e| e == 1).count();
        assert_eq!(n_o, 2);
        assert_eq!(n_c, 2);
        assert_eq!(n_n, 1);
        assert_eq!(n_h, 5);
        // First atom O1 fract=(0.30478, 0.09443, 0.23515) → Cartesian non-zero
        assert!(result.positions[0].abs() > 0.1);
        // The asymmetric-unit labels come back exactly as the file lists them.
        let labels = result.atom_labels.as_ref().expect("labels");
        assert_eq!(labels[0], "O1");
        assert_eq!(labels[9], "H10");
    }
}
