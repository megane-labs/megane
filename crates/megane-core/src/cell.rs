//! Unit-cell conversions shared by every parser and writer.
//!
//! A cell is stored as a row-major 3×3 matrix whose rows are the cell vectors
//! `a`, `b`, `c` (Å), with `a` along +x and `b` in the xy plane — the standard
//! crystallographic orientation. Parsers that read `(a, b, c, α, β, γ)` build
//! the matrix with [`cell_params_to_matrix`]; the writers go back with
//! [`matrix_to_params`].
//!
//! Angles are always in degrees here. Formats that store something else (the
//! DCD cosine convention, for instance) convert in their own parser before
//! calling in.

/// How far (in degrees) an angle may sit from 90° and still count as a right
/// angle for the exact orthorhombic path of [`cell_params_to_matrix`].
pub const RIGHT_ANGLE_TOLERANCE_DEG: f32 = 1e-3;

/// Build the diagonal matrix of an orthorhombic cell with edges `a`, `b`, `c`.
pub fn orthorhombic(a: f32, b: f32, c: f32) -> [f32; 9] {
    [a, 0.0, 0.0, 0.0, b, 0.0, 0.0, 0.0, c]
}

/// Convert crystallographic cell parameters (lengths in Å, angles in degrees)
/// to a row-major 3×3 matrix of cell vectors.
///
/// When all three angles are right angles (within
/// [`RIGHT_ANGLE_TOLERANCE_DEG`]) the result is the exact diagonal matrix:
/// `cos(90°)` evaluated in `f32` is about `-4.4e-8`, not zero, so the general
/// formula would leave off-diagonal noise of order `1e-7·a` in every
/// orthorhombic box. Any other cell goes through the general triclinic
/// conversion.
pub fn cell_params_to_matrix(
    a: f32,
    b: f32,
    c: f32,
    alpha: f32,
    beta: f32,
    gamma: f32,
) -> [f32; 9] {
    let right = |ang: f32| (ang - 90.0).abs() < RIGHT_ANGLE_TOLERANCE_DEG;
    if right(alpha) && right(beta) && right(gamma) {
        orthorhombic(a, b, c)
    } else {
        triclinic_matrix(a, b, c, alpha, beta, gamma)
    }
}

/// [`cell_params_to_matrix`] for parameters read from a file, or why they
/// describe no cell: every length must be positive and finite, every angle
/// strictly between 0° and 180°, and the three angles must close into a cell
/// of positive volume (α = β = γ = 179° cannot). The general conversion
/// divides by `sin γ`, so a zero angle would otherwise fill the matrix with
/// NaN. Parsers report the error as a warning and return no cell.
pub fn checked_cell_params_to_matrix(
    a: f32,
    b: f32,
    c: f32,
    alpha: f32,
    beta: f32,
    gamma: f32,
) -> Result<[f32; 9], String> {
    if ![a, b, c].iter().all(|v| v.is_finite() && *v > 0.0) {
        return Err(format!("cell lengths {a} {b} {c} are not all positive"));
    }
    if ![alpha, beta, gamma]
        .iter()
        .all(|v| v.is_finite() && *v > 0.0 && *v < 180.0)
    {
        return Err(format!(
            "cell angles {alpha} {beta} {gamma} must lie strictly between 0 and 180 degrees"
        ));
    }
    let m = cell_params_to_matrix(a, b, c, alpha, beta, gamma);
    // `c_z` is the cell height over the a-b plane; it collapses to 0 when the
    // angles cannot close.
    if !(m.iter().all(|v| v.is_finite()) && m[8] > 0.0) {
        return Err(format!(
            "cell angles {alpha} {beta} {gamma} do not enclose a positive volume"
        ));
    }
    Ok(m)
}

/// The general cell-parameter → matrix conversion, with no special cases.
fn triclinic_matrix(a: f32, b: f32, c: f32, alpha: f32, beta: f32, gamma: f32) -> [f32; 9] {
    let to_rad = std::f32::consts::PI / 180.0;
    let alpha_r = alpha * to_rad;
    let beta_r = beta * to_rad;
    let gamma_r = gamma * to_rad;

    let cos_a = alpha_r.cos();
    let cos_b = beta_r.cos();
    let cos_g = gamma_r.cos();
    let sin_g = gamma_r.sin();

    let cx = c * cos_b;
    let cy = c * (cos_a - cos_b * cos_g) / sin_g;
    let cz = (c * c - cx * cx - cy * cy).max(0.0).sqrt();

    [
        a,
        0.0,
        0.0, // va
        b * cos_g,
        b * sin_g,
        0.0, // vb
        cx,
        cy,
        cz, // vc
    ]
}

/// Convert fractional coordinates to Cartesian: `frac_a·a + frac_b·b + frac_c·c`
/// for the row-major cell matrix `m` (rows are the cell vectors).
pub fn frac_to_cart(fa: f32, fb: f32, fc: f32, m: &[f32; 9]) -> (f32, f32, f32) {
    (
        fa * m[0] + fb * m[3] + fc * m[6],
        fa * m[1] + fb * m[4] + fc * m[7],
        fa * m[2] + fb * m[5] + fc * m[8],
    )
}

/// Convert a row-major cell matrix back to crystallographic
/// `(a, b, c, α, β, γ)` (Å, degrees) — the inverse of
/// [`cell_params_to_matrix`]. A zero-length vector reports 90° for the angles
/// it takes part in.
pub fn matrix_to_params(m: &[f32; 9]) -> (f32, f32, f32, f32, f32, f32) {
    let a = [m[0], m[1], m[2]];
    let b = [m[3], m[4], m[5]];
    let c = [m[6], m[7], m[8]];
    let norm = |v: &[f32; 3]| (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    let dot = |u: &[f32; 3], v: &[f32; 3]| u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    let la = norm(&a);
    let lb = norm(&b);
    let lc = norm(&c);
    let angle = |u: &[f32; 3], v: &[f32; 3], lu: f32, lv: f32| {
        if lu == 0.0 || lv == 0.0 {
            90.0
        } else {
            (dot(u, v) / (lu * lv)).clamp(-1.0, 1.0).acos().to_degrees()
        }
    };
    (
        la,
        lb,
        lc,
        angle(&b, &c, lb, lc),
        angle(&a, &c, la, lc),
        angle(&a, &b, la, lb),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Parameters read from a file must describe a cell: `γ = 0` used to
    /// divide by `sin γ = 0` and fill the matrix (and every fractional
    /// coordinate) with NaN.
    #[test]
    fn checked_conversion_rejects_parameters_that_describe_no_cell() {
        let ok = checked_cell_params_to_matrix(10.0, 11.0, 12.0, 80.0, 95.0, 110.0).unwrap();
        assert_eq!(
            ok,
            cell_params_to_matrix(10.0, 11.0, 12.0, 80.0, 95.0, 110.0)
        );
        for (params, why) in [
            ((10.0, 10.0, 10.0, 0.0, 0.0, 0.0), "angles"),
            ((10.0, 10.0, 10.0, 90.0, 90.0, 180.0), "angles"),
            ((10.0, 10.0, 10.0, 90.0, -90.0, 90.0), "angles"),
            ((10.0, 10.0, 10.0, 90.0, 90.0, f32::NAN), "angles"),
            ((0.0, 10.0, 10.0, 90.0, 90.0, 90.0), "lengths"),
            ((10.0, -1.0, 10.0, 90.0, 90.0, 90.0), "lengths"),
            ((10.0, 10.0, f32::INFINITY, 90.0, 90.0, 90.0), "lengths"),
            // Each angle is legal on its own, but they cannot close a cell.
            ((10.0, 10.0, 10.0, 179.0, 179.0, 179.0), "volume"),
            ((10.0, 10.0, 10.0, 10.0, 10.0, 170.0), "volume"),
        ] {
            let (a, b, c, al, be, ga) = params;
            let err = checked_cell_params_to_matrix(a, b, c, al, be, ga).unwrap_err();
            assert!(err.contains(why), "{params:?}: {err}");
        }
    }

    fn assert_rel_close(got: &[f32; 9], want: &[f32; 9], rel: f32) {
        let scale = want.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        for i in 0..9 {
            assert!(
                (got[i] - want[i]).abs() <= rel * scale,
                "m[{i}] = {} expected {} (rel {rel})",
                got[i],
                want[i]
            );
        }
    }

    #[test]
    fn orthorhombic_is_the_diagonal() {
        assert_eq!(
            orthorhombic(10.0, 20.0, 30.0),
            [10.0, 0.0, 0.0, 0.0, 20.0, 0.0, 0.0, 0.0, 30.0]
        );
    }

    #[test]
    fn right_angles_give_exact_zeros() {
        let m = cell_params_to_matrix(10.0, 20.0, 30.0, 90.0, 90.0, 90.0);
        assert_eq!(m, orthorhombic(10.0, 20.0, 30.0));
        // The raw trig path leaves f32 noise in the off-diagonals — the reason
        // the exact path exists.
        let raw = triclinic_matrix(10.0, 20.0, 30.0, 90.0, 90.0, 90.0);
        assert_ne!(raw[3], 0.0);
        assert_ne!(raw[6], 0.0);
        assert_rel_close(&raw, &m, 1e-6);
    }

    #[test]
    fn near_right_angles_within_tolerance_snap() {
        let m = cell_params_to_matrix(5.0, 6.0, 7.0, 90.0005, 89.9995, 90.0);
        assert_eq!(m, orthorhombic(5.0, 6.0, 7.0));
    }

    #[test]
    fn one_non_right_angle_takes_the_general_path() {
        // Monoclinic: only β differs from 90°.
        let m = cell_params_to_matrix(5.0, 6.0, 7.0, 90.0, 100.0, 90.0);
        assert_eq!(m, triclinic_matrix(5.0, 6.0, 7.0, 90.0, 100.0, 90.0));
        assert!((m[6] - 7.0 * 100f32.to_radians().cos()).abs() < 1e-5);
        // Just outside the tolerance is not snapped either.
        let m = cell_params_to_matrix(5.0, 6.0, 7.0, 90.0, 90.0, 90.01);
        assert_eq!(m, triclinic_matrix(5.0, 6.0, 7.0, 90.0, 90.0, 90.01));
    }

    #[test]
    fn triclinic_matches_the_analytic_vectors() {
        // Hexagonal: γ = 120°.
        let m = cell_params_to_matrix(3.0, 3.0, 5.0, 90.0, 90.0, 120.0);
        let s3 = 3f32.sqrt();
        assert_rel_close(
            &m,
            &[3.0, 0.0, 0.0, -1.5, 1.5 * s3, 0.0, 0.0, 0.0, 5.0],
            1e-6,
        );
        // Truncated octahedron: every vector keeps its length.
        let m = cell_params_to_matrix(20.0, 20.0, 20.0, 109.471_22, 109.471_22, 109.471_22);
        for row in 0..3 {
            let v = &m[row * 3..row * 3 + 3];
            let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
            assert!((len - 20.0).abs() < 1e-4, "row {row} length {len}");
        }
        assert!((m[3] + 20.0 / 3.0).abs() < 1e-3, "b·x = {}", m[3]);
    }

    #[test]
    fn round_trips_through_matrix_to_params() {
        let cases = [
            (10.0, 20.0, 30.0, 90.0, 90.0, 90.0),
            (3.0, 3.0, 5.0, 90.0, 90.0, 120.0),
            (5.0, 6.0, 7.0, 90.0, 100.0, 90.0),
            (7.1, 8.2, 9.3, 75.0, 82.0, 101.0),
            (20.0, 20.0, 20.0, 109.471_22, 109.471_22, 109.471_22),
        ];
        for (a, b, c, al, be, ga) in cases {
            let m = cell_params_to_matrix(a, b, c, al, be, ga);
            let (a2, b2, c2, al2, be2, ga2) = matrix_to_params(&m);
            for (got, want) in [(a2, a), (b2, b), (c2, c)] {
                assert!((got - want).abs() < 1e-4 * want, "length {got} vs {want}");
            }
            for (got, want) in [(al2, al), (be2, be), (ga2, ga)] {
                assert!((got - want).abs() < 1e-3, "angle {got} vs {want}");
            }
        }
    }

    #[test]
    fn matrix_to_params_of_a_60_degree_cell() {
        // 60° between a and b, everything else orthogonal.
        let m = [2.0, 0.0, 0.0, 1.0, 3f32.sqrt(), 0.0, 0.0, 0.0, 5.0];
        let (a, b, c, alpha, beta, gamma) = matrix_to_params(&m);
        assert!((a - 2.0).abs() < 1e-5);
        assert!((b - 2.0).abs() < 1e-5);
        assert!((c - 5.0).abs() < 1e-5);
        assert!((alpha - 90.0).abs() < 1e-3);
        assert!((beta - 90.0).abs() < 1e-3);
        assert!((gamma - 60.0).abs() < 1e-3);
    }

    #[test]
    fn matrix_to_params_of_a_degenerate_cell_reports_right_angles() {
        let m = [0.0, 0.0, 0.0, 0.0, 4.0, 0.0, 0.0, 0.0, 5.0];
        let (a, _, _, alpha, beta, gamma) = matrix_to_params(&m);
        assert_eq!(a, 0.0);
        assert_eq!(beta, 90.0);
        assert_eq!(gamma, 90.0);
        assert!((alpha - 90.0).abs() < 1e-3);
    }

    #[test]
    fn frac_to_cart_combines_the_cell_vectors() {
        let m = cell_params_to_matrix(10.0, 10.0, 10.0, 90.0, 90.0, 90.0);
        assert_eq!(frac_to_cart(0.5, 0.25, 1.0, &m), (5.0, 2.5, 10.0));
        let m = [2.0, 0.0, 0.0, 1.0, 3.0, 0.0, 0.5, 0.5, 4.0];
        let (x, y, z) = frac_to_cart(1.0, 1.0, 1.0, &m);
        assert_eq!((x, y, z), (3.5, 3.5, 4.0));
    }
}

/// Every parser that reads `(a, b, c, α, β, γ)` now shares the exact
/// right-angle path: orthorhombic cells come out exactly diagonal and
/// fractional coordinates pick up no cross-axis noise.
#[cfg(test)]
mod format_regressions {
    fn assert_diagonal(m: Option<[f32; 9]>, a: f32, b: f32, c: f32) {
        assert_eq!(m, Some([a, 0.0, 0.0, 0.0, b, 0.0, 0.0, 0.0, c]));
    }

    /// Each coordinate of a lattice made of half-cell fractions is exactly
    /// `0` or `a/2` once no off-diagonal noise leaks in.
    fn assert_on_half_lattice(positions: &[f32], a: f32) {
        for (i, &v) in positions.iter().enumerate() {
            assert!(v == 0.0 || v == 0.5 * a, "coordinate {i} = {v:e}");
        }
    }

    #[test]
    fn pdb_cryst1() {
        let s = crate::pdb::parse(include_str!("../../../tests/fixtures/empty_box.pdb")).unwrap();
        assert_diagonal(s.box_matrix, 10.0, 10.0, 10.0);
    }

    #[test]
    fn cif_cell_and_fractional_coordinates() {
        let s = crate::cif::parse(include_str!("../../../tests/fixtures/nacl.cif")).unwrap();
        assert_diagonal(s.box_matrix, 5.6402, 5.6402, 5.6402);
        assert_on_half_lattice(&s.positions, 5.6402);
    }

    #[test]
    fn mmcif_cell() {
        let s = crate::mmcif::parse(include_str!("../../../tests/fixtures/1ala.mmcif")).unwrap();
        assert_diagonal(s.box_matrix, 40.0, 40.0, 40.0);
    }

    #[test]
    fn mol2_crysin() {
        let s =
            crate::mol2::parse(include_str!("../../../tests/fixtures/nacl_crysin.mol2")).unwrap();
        assert_diagonal(s.box_matrix, 5.6402, 5.6402, 5.6402);
    }

    #[test]
    fn cml_crystal_and_fractional_coordinates() {
        let s = crate::cml::parse(include_str!("../../../tests/fixtures/si_diamond.cml")).unwrap();
        assert_diagonal(s.box_matrix, 5.43, 5.43, 5.43);
        // Diamond sites sit on quarter fractions: x = f·a with no other axis
        // contributing.
        for (i, &v) in s.positions.iter().enumerate() {
            let f = v / 5.43;
            assert!(
                [0.0, 0.25, 0.5, 0.75].iter().any(|q| v == q * 5.43),
                "coordinate {i} = {v:e} (fraction {f})"
            );
        }
    }

    #[test]
    fn odydata_boundary_box() {
        let text = r#"<odyssey_simulation>
  <structure><atom id="1" element="Ar" xyz="0 0 0"/></structure>
  <boundary box="20.0 21.0 22.0"/>
</odyssey_simulation>"#;
        let s = crate::odydata::parse(text).unwrap();
        assert_diagonal(s.box_matrix, 20.0, 21.0, 22.0);
    }
}
