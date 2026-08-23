//! Crystallographic symmetry expansion for CIF structures.
//!
//! A CIF lists only the asymmetric unit plus the space-group operations
//! (`_symmetry_equiv_pos_as_xyz`). To show the structure the way VESTA does we
//! apply those operations to fill one unit cell with its symmetry-equivalent
//! molecules. Each operation is a rigid isometry, so every generated image is a
//! whole, rigidly-copied asymmetric unit — its internal bond graph is identical
//! to the original, and bonds are replicated by index offset rather than
//! re-inferred (which keeps molecules whole and avoids spurious bonds across
//! cell boundaries).
//!
//! This is symmetry expansion only (asymmetric unit → full cell). Translational
//! `na × nb × nc` replication (a true supercell) is a separate, downstream
//! operation handled by the Supercell pipeline node.
//!
//! NOTE: the browser-side `symmetry` pipeline node executor
//! (`src/pipeline/executors/symmetry.ts`) is a TypeScript port of this
//! algorithm — parsing, identity detection, centroid wrapping, image
//! deduplication (`image_key`), and bond replication must stay in sync between
//! the two implementations.

use std::collections::HashSet;

/// A parsed symmetry operation: fractional 3×3 rotation + translation.
pub struct Symop {
    /// Row-major 3×3 rotation/permutation acting on fractional coordinates.
    pub rot: [f32; 9],
    /// Fractional translation.
    pub trans: [f32; 3],
}

/// Parse a numeric token that may be a fraction ("1/2") or a decimal.
fn parse_num(s: &str) -> Option<f32> {
    let t = s.trim();
    match t.split_once('/') {
        Some((n, d)) => Some(n.trim().parse::<f32>().ok()? / d.trim().parse::<f32>().ok()?),
        None => t.parse().ok(),
    }
}

/// Parse one component of a symop (e.g. "-x+1/2", "1/2-y", "z") into the
/// coefficients of (x, y, z) and the constant translation.
fn parse_component(comp: &str) -> ([f32; 3], f32) {
    let mut coef = [0.0f32; 3];
    let mut trans = 0.0f32;
    let cleaned: String = comp.chars().filter(|c| !c.is_whitespace()).collect();
    // Split into signed terms, keeping the sign with each term.
    let mut term = String::new();
    let mut terms: Vec<String> = Vec::new();
    for ch in cleaned.chars() {
        if (ch == '+' || ch == '-') && !term.is_empty() {
            terms.push(std::mem::take(&mut term));
        }
        term.push(ch);
    }
    if !term.is_empty() {
        terms.push(term);
    }
    for t in terms {
        let mut sign = 1.0f32;
        let mut body = t.as_str();
        if let Some(stripped) = body.strip_prefix('+') {
            body = stripped;
        } else if let Some(stripped) = body.strip_prefix('-') {
            sign = -1.0;
            body = stripped;
        }
        if let Some(axis) = body.find(['x', 'y', 'z', 'X', 'Y', 'Z']) {
            let ch = body.as_bytes()[axis].to_ascii_lowercase();
            let num_part: String = body
                .chars()
                .enumerate()
                .filter(|(idx, _)| *idx != axis)
                .map(|(_, c)| c)
                .collect();
            let mag = if num_part.is_empty() || num_part == "*" {
                1.0
            } else {
                parse_num(num_part.trim_end_matches('*')).unwrap_or(1.0)
            };
            let idx = match ch {
                b'x' => 0,
                b'y' => 1,
                _ => 2,
            };
            coef[idx] += sign * mag;
        } else if let Some(v) = parse_num(body) {
            trans += sign * v;
        }
    }
    (coef, trans)
}

/// Parse a CIF symmetry operation string (e.g. "-x+1/2,y+1/2,-z").
pub fn parse_symop(op: &str) -> Option<Symop> {
    let comps: Vec<&str> = op.split(',').collect();
    if comps.len() != 3 {
        return None;
    }
    let mut rot = [0.0f32; 9];
    let mut trans = [0.0f32; 3];
    for (r, comp) in comps.iter().enumerate() {
        let (coef, t) = parse_component(comp);
        rot[r * 3] = coef[0];
        rot[r * 3 + 1] = coef[1];
        rot[r * 3 + 2] = coef[2];
        trans[r] = t;
    }
    Some(Symop { rot, trans })
}

fn is_identity(op: &Symop) -> bool {
    op.rot == [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0] && op.trans == [0.0, 0.0, 0.0]
}

/// Invert a row-major 3×3 matrix. Returns None if singular.
fn invert3x3(m: &[f32; 9]) -> Option<[f32; 9]> {
    let (a, b, c, d, e, f, g, h, i) = (m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
    let det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if det.abs() < 1e-12 {
        return None;
    }
    let inv = 1.0 / det;
    Some([
        (e * i - f * h) * inv,
        (c * h - b * i) * inv,
        (b * f - c * e) * inv,
        (f * g - d * i) * inv,
        (a * i - c * g) * inv,
        (c * d - a * f) * inv,
        (d * h - e * g) * inv,
        (b * g - a * h) * inv,
        (a * e - b * d) * inv,
    ])
}

/// Cartesian = frac · M, where M rows are the cell vectors (row-major).
fn frac_to_cart(fa: f32, fb: f32, fc: f32, m: &[f32; 9]) -> (f32, f32, f32) {
    (
        fa * m[0] + fb * m[3] + fc * m[6],
        fa * m[1] + fb * m[4] + fc * m[7],
        fa * m[2] + fb * m[5] + fc * m[8],
    )
}

/// Fractional = cart · M⁻¹.
fn cart_to_frac(x: f32, y: f32, z: f32, minv: &[f32; 9]) -> (f32, f32, f32) {
    (
        x * minv[0] + y * minv[3] + z * minv[6],
        x * minv[1] + y * minv[4] + z * minv[7],
        x * minv[2] + y * minv[5] + z * minv[8],
    )
}

/// Expanded structure: positions, elements, bonds, and (optional) atom labels.
pub type Expanded = (Vec<f32>, Vec<u8>, Vec<(u32, u32)>, Option<Vec<String>>);

/// Apply the space-group operations to the asymmetric unit, filling one unit
/// cell. Returns `None` when there is nothing to do (no usable operations, only
/// the identity, or a singular cell) so the caller can keep the original data.
pub fn expand_symmetry(
    positions: &[f32],
    elements: &[u8],
    bonds: &[(u32, u32)],
    labels: Option<&[String]>,
    box_matrix: &[f32; 9],
    symops: &[String],
) -> Option<Expanded> {
    let ops: Vec<Symop> = symops.iter().filter_map(|s| parse_symop(s)).collect();
    if ops.is_empty() || (ops.len() == 1 && is_identity(&ops[0])) {
        return None;
    }
    let minv = invert3x3(box_matrix)?;
    let n_base = elements.len();
    if n_base == 0 {
        return None;
    }

    // Fractional coordinates of the asymmetric unit.
    let mut base_frac = vec![0.0f32; n_base * 3];
    for i in 0..n_base {
        let (fa, fb, fc) = cart_to_frac(
            positions[i * 3],
            positions[i * 3 + 1],
            positions[i * 3 + 2],
            &minv,
        );
        base_frac[i * 3] = fa;
        base_frac[i * 3 + 1] = fb;
        base_frac[i * 3 + 2] = fc;
    }

    // Each operation produces one rigid image, wrapped (by centroid) into the
    // home cell so molecules stay whole. Images coinciding within tolerance are
    // dropped (atoms on special positions).
    let mut seen: HashSet<String> = HashSet::new();
    let mut image_fracs: Vec<Vec<f32>> = Vec::new();
    for op in &ops {
        let mut frac = vec![0.0f32; n_base * 3];
        let (mut cx, mut cy, mut cz) = (0.0f32, 0.0f32, 0.0f32);
        for i in 0..n_base {
            let (fa, fb, fc) = (base_frac[i * 3], base_frac[i * 3 + 1], base_frac[i * 3 + 2]);
            let na = op.rot[0] * fa + op.rot[1] * fb + op.rot[2] * fc + op.trans[0];
            let nb = op.rot[3] * fa + op.rot[4] * fb + op.rot[5] * fc + op.trans[1];
            let nc = op.rot[6] * fa + op.rot[7] * fb + op.rot[8] * fc + op.trans[2];
            frac[i * 3] = na;
            frac[i * 3 + 1] = nb;
            frac[i * 3 + 2] = nc;
            cx += na;
            cy += nb;
            cz += nc;
        }
        let sx = -(cx / n_base as f32).floor();
        let sy = -(cy / n_base as f32).floor();
        let sz = -(cz / n_base as f32).floor();
        for i in 0..n_base {
            frac[i * 3] += sx;
            frac[i * 3 + 1] += sy;
            frac[i * 3 + 2] += sz;
        }
        let key = image_key(&frac, n_base);
        if seen.insert(key) {
            image_fracs.push(frac);
        }
    }

    let n_images = image_fracs.len();
    let mut out_pos = vec![0.0f32; n_base * n_images * 3];
    let mut out_elem = vec![0u8; n_base * n_images];
    for (im, frac) in image_fracs.iter().enumerate() {
        let base = im * n_base;
        for a in 0..n_base {
            let (x, y, z) = frac_to_cart(frac[a * 3], frac[a * 3 + 1], frac[a * 3 + 2], box_matrix);
            let o = (base + a) * 3;
            out_pos[o] = x;
            out_pos[o + 1] = y;
            out_pos[o + 2] = z;
            out_elem[base + a] = elements[a];
        }
    }

    // Replicate bonds with a per-image atom-index offset.
    let mut out_bonds: Vec<(u32, u32)> = Vec::with_capacity(bonds.len() * n_images);
    for im in 0..n_images {
        let off = (im * n_base) as u32;
        for &(a, b) in bonds {
            out_bonds.push((a + off, b + off));
        }
    }

    // Tile labels when present.
    let out_labels = labels.map(|l| {
        let mut v: Vec<String> = Vec::with_capacity(l.len() * n_images);
        for _ in 0..n_images {
            v.extend_from_slice(l);
        }
        v
    });

    Some((out_pos, out_elem, out_bonds, out_labels))
}

/// Round centroid + first atom to a stable key for image deduplication.
fn image_key(frac: &[f32], n: usize) -> String {
    let (mut cx, mut cy, mut cz) = (0.0f32, 0.0f32, 0.0f32);
    for a in 0..n {
        cx += frac[a * 3];
        cy += frac[a * 3 + 1];
        cz += frac[a * 3 + 2];
    }
    let r = |v: f32| (v * 1000.0).round() / 1000.0;
    format!(
        "{},{},{}|{},{},{}",
        r(cx / n as f32),
        r(cy / n as f32),
        r(cz / n as f32),
        r(frac[0]),
        r(frac[1]),
        r(frac[2])
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_symop_identity() {
        let op = parse_symop("x,y,z").unwrap();
        assert_eq!(op.rot, [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
        assert_eq!(op.trans, [0.0, 0.0, 0.0]);
        assert!(is_identity(&op));
    }

    #[test]
    fn test_parse_symop_with_translation() {
        let op = parse_symop("-x+1/2,y+1/2,-z").unwrap();
        assert_eq!(op.rot, [-1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, -1.0]);
        assert!((op.trans[0] - 0.5).abs() < 1e-6);
        assert!((op.trans[1] - 0.5).abs() < 1e-6);
        assert!((op.trans[2]).abs() < 1e-6);
    }

    #[test]
    fn test_parse_symop_constant_first() {
        let op = parse_symop("1/2-y,x,z").unwrap();
        assert_eq!(&op.rot[0..3], &[0.0, -1.0, 0.0]);
        assert!((op.trans[0] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn test_parse_symop_malformed() {
        assert!(parse_symop("x,y").is_none());
    }

    #[test]
    fn test_invert3x3_singular() {
        assert!(invert3x3(&[1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0]).is_none());
    }

    #[test]
    fn test_expand_symmetry_inversion_doubles_atoms() {
        // Cubic 10 Å cell, two atoms at a general position; inversion produces a
        // second, distinct image (4 atoms total).
        let box_m = [10.0, 0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 10.0];
        let positions = vec![3.0, 3.0, 3.0, 4.0, 4.0, 4.0];
        let elements = vec![6u8, 8u8];
        let bonds = vec![(0u32, 1u32)];
        let symops = vec!["x,y,z".to_string(), "-x,-y,-z".to_string()];
        let (pos, elem, bnd, _) =
            expand_symmetry(&positions, &elements, &bonds, None, &box_m, &symops).unwrap();
        assert_eq!(elem.len(), 4);
        assert_eq!(pos.len(), 12);
        assert_eq!(bnd.len(), 2); // bond replicated per image
        assert_eq!(bnd[1], (2, 3)); // second image offset by n_base=2
    }

    #[test]
    fn test_expand_symmetry_identity_only_returns_none() {
        let box_m = [10.0, 0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 10.0];
        let positions = vec![1.0, 1.0, 1.0];
        let elements = vec![6u8];
        let symops = vec!["x,y,z".to_string()];
        assert!(expand_symmetry(&positions, &elements, &[], None, &box_m, &symops).is_none());
    }

    #[test]
    fn test_expand_symmetry_tiles_labels() {
        let box_m = [10.0, 0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 10.0];
        let positions = vec![3.0, 3.0, 3.0];
        let elements = vec![6u8];
        let labels = vec!["C1".to_string()];
        let symops = vec!["x,y,z".to_string(), "-x,-y,-z".to_string()];
        let (_, _, _, out_labels) =
            expand_symmetry(&positions, &elements, &[], Some(&labels), &box_m, &symops).unwrap();
        assert_eq!(out_labels.unwrap(), vec!["C1", "C1"]);
    }
}
