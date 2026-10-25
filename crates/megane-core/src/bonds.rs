/// Distance-based bond inference using cell-list spatial search.
///
/// `src/parsers/inferBondsJS.ts` is a deliberate JS port of this module for
/// the browser's synchronous executor path — keep the two in sync (any
/// cutoff/tolerance or algorithm change lands in both in the same commit).
use std::collections::HashSet;

use crate::atomic::covalent_radius;
// Re-export so that `megane_core::bonds::vdw_radius` continues to work.
pub use crate::atomic::vdw_radius;

const BOND_TOLERANCE: f32 = 1.3;
const MIN_BOND_DIST: f32 = 0.4;
const VDW_BOND_FACTOR: f32 = 0.6;

/// 13 half-shell neighbor offsets, so each pair of cells is visited once.
const HALF_SHELL: [(i8, i8, i8); 13] = [
    (0, 0, 1),
    (0, 1, -1),
    (0, 1, 0),
    (0, 1, 1),
    (1, -1, -1),
    (1, -1, 0),
    (1, -1, 1),
    (1, 0, -1),
    (1, 0, 0),
    (1, 0, 1),
    (1, 1, -1),
    (1, 1, 0),
    (1, 1, 1),
];

/// Largest grid kept dense: a few cells per atom (plus a floor for small
/// systems), so the per-cell table never outgrows the atoms themselves.
/// `src/parsers/inferBondsJS.ts` uses the same bound.
pub(crate) fn max_dense_cells(n_atoms: usize) -> usize {
    n_atoms.saturating_mul(8).saturating_add(4096)
}

/// Relative slack on a cutoff-sized cell, so a pair sitting exactly at the
/// cutoff cannot round into a cell one step further away.
const CELL_SLACK: f32 = 1.001;

/// At most `1 / WIDE_ATOM_SHARE` of the atoms may be "wide" (see [`ScanPlan`]).
const WIDE_ATOM_SHARE: usize = 8;

/// How a cell-list scan finds every pair within its cutoff
/// `(radius(e_i) + radius(e_j)) * factor`.
///
/// The half-shell scan only pairs atoms in the same or adjacent cells, so it
/// is exact only when every cutoff fits in one cell. Heavy atoms have cutoffs
/// wider than the base cell (covalent Na–Na 4.32 Å and K–K 5.28 Å against a
/// 2.5 Å cell; vdW S–S 2.16 Å against 2.0 Å), and such pairs were found or
/// missed depending on where the grid origin fell. Widening every cell to the
/// largest cutoff would be exact but slow — one K⁺ in a water box would make
/// every cell 5.3 Å wide — so the cell is sized for all but a small minority
/// of *wide* atoms, which instead search `reach` cells along each axis.
struct ScanPlan {
    cell_size: f32,
    /// Indices of the wide atoms, ascending.
    wide: Vec<u32>,
    /// `is_wide[i]` for every atom (empty when no atom is wide).
    is_wide: Vec<bool>,
    /// Cells a wide atom searches along each axis (≥ 2 when any atom is wide).
    reach: i64,
}

impl ScanPlan {
    /// Plan a scan of `elements` whose cutoff is `(radius_i + radius_j) * factor`,
    /// never using cells smaller than `base`.
    fn new(base: f32, elements: &[u8], radius: fn(u8) -> f32, factor: f32) -> Self {
        let cutoff = |r: f32| 2.0 * r * factor * CELL_SLACK;
        let mut counts = [0usize; 256];
        for &e in elements {
            counts[e as usize] += 1;
        }
        // Elements present, widest radius first.
        let mut present: Vec<(f32, usize)> = (0..256)
            .filter(|&z| counts[z] > 0)
            .map(|z| (radius(z as u8), counts[z]))
            .collect();
        present.sort_by(|a, b| b.0.total_cmp(&a.0));

        // Grow the cell until the atoms it does not fit are a small minority.
        let budget = elements.len() / WIDE_ATOM_SHARE;
        let mut cell_size = base;
        let mut outside = 0;
        for &(r, count) in &present {
            if cutoff(r) <= base {
                break;
            }
            outside += count;
            if outside > budget {
                cell_size = cutoff(r);
                break;
            }
        }

        let max_cutoff = present.first().map_or(0.0, |&(r, _)| cutoff(r));
        let wide_element: Vec<bool> = (0..=255u8).map(|z| cutoff(radius(z)) > cell_size).collect();
        let wide: Vec<u32> = (0..elements.len() as u32)
            .filter(|&i| wide_element[elements[i as usize] as usize])
            .collect();
        let is_wide = if wide.is_empty() {
            Vec::new()
        } else {
            elements.iter().map(|&e| wide_element[e as usize]).collect()
        };
        ScanPlan {
            cell_size,
            reach: (max_cutoff / cell_size).ceil() as i64,
            wide,
            is_wide,
        }
    }

    /// A plan with fixed cells and no wide atoms.
    #[cfg(test)]
    fn uniform(cell_size: f32) -> Self {
        ScanPlan {
            cell_size,
            wide: Vec::new(),
            is_wide: Vec::new(),
            reach: 1,
        }
    }

    /// Cell offsets within `reach` that the half-shell scan does not visit
    /// (some axis two or more cells away). Each wide atom searches all of
    /// them, not half, so a pair of two wide atoms is found from both ends and
    /// kept only from the lower index (see [`ScanPlan::keeps_far_pair`]).
    fn far_offsets(&self) -> Vec<[i64; 3]> {
        if self.wide.is_empty() {
            return Vec::new();
        }
        let r = self.reach;
        let mut offsets = Vec::new();
        for x in -r..=r {
            for y in -r..=r {
                for z in -r..=r {
                    if x.abs().max(y.abs()).max(z.abs()) >= 2 {
                        offsets.push([x, y, z]);
                    }
                }
            }
        }
        offsets
    }

    /// Whether wide atom `i` checks the far pair `(i, j)`: always, unless `j`
    /// is wide too and will check the pair itself.
    fn keeps_far_pair(&self, i: usize, j: usize) -> bool {
        !(self.is_wide[j] && j < i)
    }
}

/// `v + d` when it stays inside `0..n`.
fn step_cell(v: u64, d: i64, n: u64) -> Option<u64> {
    let w = v.checked_add_signed(d)?;
    (w < n).then_some(w)
}

/// The cell-list scan over only the occupied cells. Cells are visited in the
/// same (x, y, z) order as the dense grid, atoms within a cell by index and
/// neighbors in half-shell order, so it reports the same bonds in the same
/// order; neighbor cells are found by binary search instead of by index.
fn sparse_cell_list_scan<F>(
    positions: &[f32],
    n_atoms: usize,
    plan: &ScanPlan,
    lo: [f32; 3],
    dims: [u64; 3],
    mut check_pair: F,
) -> Vec<(u32, u32)>
where
    F: FnMut(usize, usize) -> Option<(u32, u32)>,
{
    let cell_size = plan.cell_size;
    // Float-to-int `as` saturates, so even absurd coordinates stay in range.
    let coord = |i: usize, axis: usize| -> u64 {
        (((positions[i * 3 + axis] - lo[axis]) / cell_size) as u64).min(dims[axis] - 1)
    };
    let mut keyed: Vec<([u64; 3], u32)> = (0..n_atoms)
        .map(|i| ([coord(i, 0), coord(i, 1), coord(i, 2)], i as u32))
        .collect();
    keyed.sort_unstable();

    let mut cells: Vec<[u64; 3]> = Vec::new();
    let mut starts: Vec<usize> = Vec::new();
    for (k, (key, _)) in keyed.iter().enumerate() {
        if cells.last() != Some(key) {
            cells.push(*key);
            starts.push(k);
        }
    }
    starts.push(n_atoms);
    let atoms: Vec<u32> = keyed.iter().map(|&(_, i)| i).collect();
    drop(keyed);

    let mut bonds = Vec::with_capacity(n_atoms);
    for (c, key) in cells.iter().enumerate() {
        let cell = &atoms[starts[c]..starts[c + 1]];
        // Resolve this cell's neighbors once, not once per atom.
        let mut neighbors: [Option<usize>; 13] = [None; 13];
        for (slot, &(dx, dy, dz)) in neighbors.iter_mut().zip(HALF_SHELL.iter()) {
            let nk = match (
                step_cell(key[0], dx as i64, dims[0]),
                step_cell(key[1], dy as i64, dims[1]),
                step_cell(key[2], dz as i64, dims[2]),
            ) {
                (Some(a), Some(b), Some(c)) => [a, b, c],
                _ => continue,
            };
            *slot = cells.binary_search(&nk).ok();
        }
        for ii in 0..cell.len() {
            let i = cell[ii] as usize;
            for &j in &cell[(ii + 1)..] {
                if let Some(bond) = check_pair(i, j as usize) {
                    bonds.push(bond);
                }
            }
            for &n in neighbors.iter().flatten() {
                for &j in &atoms[starts[n]..starts[n + 1]] {
                    if let Some(bond) = check_pair(i, j as usize) {
                        bonds.push(bond);
                    }
                }
            }
        }
    }

    // Wide atoms: the cells beyond the half shell, within their reach.
    let far = plan.far_offsets();
    for &i in &plan.wide {
        let i = i as usize;
        let key = [coord(i, 0), coord(i, 1), coord(i, 2)];
        for d in &far {
            let nk = match (
                step_cell(key[0], d[0], dims[0]),
                step_cell(key[1], d[1], dims[1]),
                step_cell(key[2], d[2], dims[2]),
            ) {
                (Some(a), Some(b), Some(c)) => [a, b, c],
                _ => continue,
            };
            let Ok(n) = cells.binary_search(&nk) else {
                continue;
            };
            for &j in &atoms[starts[n]..starts[n + 1]] {
                let j = j as usize;
                if plan.keeps_far_pair(i, j) {
                    if let Some(bond) = check_pair(i, j) {
                        bonds.push(bond);
                    }
                }
            }
        }
    }
    bonds
}

/// Generic cell-list spatial scan that iterates over all nearby atom pairs
/// and calls `check_pair(i, j)` for each. The closure returns `Some((a, b))`
/// if the pair should be recorded as a bond.
fn cell_list_scan<F>(
    positions: &[f32],
    n_atoms: usize,
    plan: &ScanPlan,
    mut check_pair: F,
) -> Vec<(u32, u32)>
where
    F: FnMut(usize, usize) -> Option<(u32, u32)>,
{
    if n_atoms == 0 {
        return Vec::new();
    }
    let cell_size = plan.cell_size;

    // Bounding box
    let (mut min_x, mut min_y, mut min_z) = (f32::MAX, f32::MAX, f32::MAX);
    let (mut max_x, mut max_y, mut max_z) = (f32::MIN, f32::MIN, f32::MIN);

    for i in 0..n_atoms {
        let (x, y, z) = (positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        min_z = min_z.min(z);
        max_x = max_x.max(x);
        max_y = max_y.max(y);
        max_z = max_z.max(z);
    }

    let dim = |lo: f32, hi: f32| ((hi - lo) / cell_size).ceil().max(1.0) as f64;
    let (fx, fy, fz) = (dim(min_x, max_x), dim(min_y, max_y), dim(min_z, max_z));
    // A dense grid spans the bounding box, so one atom far from the rest (a
    // 9999 Å placeholder) would make it astronomically large. Past a few cells
    // per atom only the occupied cells are kept.
    if fx * fy * fz > max_dense_cells(n_atoms) as f64 {
        let lo = [min_x, min_y, min_z];
        let dims = [fx as u64, fy as u64, fz as u64];
        return sparse_cell_list_scan(positions, n_atoms, plan, lo, dims, check_pair);
    }
    let (nx, ny, nz) = (fx as usize, fy as usize, fz as usize);

    let ncells = nx * ny * nz;

    // Compute each atom's flat cell index once.
    let cell_of = |i: usize| -> usize {
        let cx = (((positions[i * 3] - min_x) / cell_size) as usize).min(nx - 1);
        let cy = (((positions[i * 3 + 1] - min_y) / cell_size) as usize).min(ny - 1);
        let cz = (((positions[i * 3 + 2] - min_z) / cell_size) as usize).min(nz - 1);
        cx * ny * nz + cy * nz + cz
    };

    // Bucket atoms into a CSR (counting-sort) layout instead of a
    // `Vec<Vec<usize>>` to avoid one heap allocation per spatial cell.
    // `starts[c]..starts[c + 1]` is the slice of `cell_atoms` for cell `c`.
    let mut atom_cell = vec![0u32; n_atoms];
    let mut starts = vec![0u32; ncells + 1];
    for (i, slot) in atom_cell.iter_mut().enumerate() {
        let c = cell_of(i);
        *slot = c as u32;
        starts[c + 1] += 1;
    }
    for c in 0..ncells {
        starts[c + 1] += starts[c];
    }
    // Fill in ascending atom index order so within-cell ordering matches the
    // previous `Vec<Vec<usize>>` (each cell pushed atoms in `i` order), which
    // keeps the emitted bond order byte-for-byte identical.
    let mut cursor: Vec<u32> = starts[..ncells].to_vec();
    let mut cell_atoms = vec![0u32; n_atoms];
    for (i, &c) in atom_cell.iter().enumerate() {
        let c = c as usize;
        cell_atoms[cursor[c] as usize] = i as u32;
        cursor[c] += 1;
    }

    // Molecular systems carry roughly one bond per atom; reserve to avoid
    // repeated reallocation of the output vector.
    let mut bonds = Vec::with_capacity(n_atoms);

    // Half-shell neighbor offsets, to avoid double-counting.
    let offsets = HALF_SHELL.map(|(x, y, z)| (x as isize, y as isize, z as isize));

    for cx in 0..nx {
        for cy in 0..ny {
            for cz in 0..nz {
                let cell_idx = cx * ny * nz + cy * nz + cz;
                let cell = &cell_atoms[starts[cell_idx] as usize..starts[cell_idx + 1] as usize];

                // Pairs within the same cell
                for ii in 0..cell.len() {
                    let i = cell[ii] as usize;

                    for &j in &cell[(ii + 1)..] {
                        if let Some(bond) = check_pair(i, j as usize) {
                            bonds.push(bond);
                        }
                    }

                    // Pairs with neighboring cells (half-shell)
                    for &(dx, dy, dz) in &offsets {
                        let ncx = cx as isize + dx;
                        let ncy = cy as isize + dy;
                        let ncz = cz as isize + dz;
                        if ncx < 0
                            || ncy < 0
                            || ncz < 0
                            || ncx >= nx as isize
                            || ncy >= ny as isize
                            || ncz >= nz as isize
                        {
                            continue;
                        }
                        let neighbor_idx =
                            ncx as usize * ny * nz + ncy as usize * nz + ncz as usize;
                        let neighbor = &cell_atoms
                            [starts[neighbor_idx] as usize..starts[neighbor_idx + 1] as usize];
                        for &j in neighbor {
                            if let Some(bond) = check_pair(i, j as usize) {
                                bonds.push(bond);
                            }
                        }
                    }
                }
            }
        }
    }

    // Wide atoms: the cells beyond the half shell, within their reach.
    let far = plan.far_offsets();
    let dims = [nx as u64, ny as u64, nz as u64];
    for &i in &plan.wide {
        let i = i as usize;
        let c = atom_cell[i] as usize;
        let key = [
            (c / (ny * nz)) as u64,
            ((c / nz) % ny) as u64,
            (c % nz) as u64,
        ];
        for d in &far {
            let (Some(x), Some(y), Some(z)) = (
                step_cell(key[0], d[0], dims[0]),
                step_cell(key[1], d[1], dims[1]),
                step_cell(key[2], d[2], dims[2]),
            ) else {
                continue;
            };
            let idx = x as usize * ny * nz + y as usize * nz + z as usize;
            for &j in &cell_atoms[starts[idx] as usize..starts[idx + 1] as usize] {
                let j = j as usize;
                if plan.keeps_far_pair(i, j) {
                    if let Some(bond) = check_pair(i, j) {
                        bonds.push(bond);
                    }
                }
            }
        }
    }

    bonds
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

/// Shift each bonded molecule by whole lattice vectors so that no covalent bond
/// spans the periodic boundary — i.e. every connected component becomes
/// spatially contiguous.
///
/// Many CIFs list every atom wrapped into the `[0,1)` fractional cell, which
/// physically splits a molecule that straddles a face: two bonded atoms then
/// sit ~one lattice vector apart in Cartesian space. Distance-based bond
/// inference (`infer_bonds`) is not periodic, so it drops those cross-boundary
/// bonds — the molecule renders broken (Issue #558). Running this first makes
/// the molecule whole, so ordinary (non-periodic) inference finds every bond
/// and the bond cylinders render at their true short length rather than across
/// the cell.
///
/// Connectivity for the unwrap is determined with the minimum-image convention
/// using the same covalent-radius criterion as `infer_bonds`, so exactly the
/// bonds that inference would otherwise find (were the molecule contiguous) are
/// used to knit each component together. A finite molecule has a consistent
/// lattice shift for every path through its bond graph. An extended periodic
/// network has at least one cycle with non-zero lattice winding; such a component
/// cannot be made whole in a single image and is deliberately left in the home
/// cell. Atoms with no bonds, periodic networks, and molecules that are already
/// whole are therefore untouched. Positions are modified in place. The unit cell
/// is unchanged, so a finite whole molecule may poke slightly outside the
/// `[0,1)` box (the standard VESTA/Mercury depiction).
pub fn unwrap_molecules(positions: &mut [f32], elements: &[u8], box_matrix: &[f32; 9]) {
    let n = elements.len();
    if n < 2 {
        return;
    }
    let minv = match invert3x3(box_matrix) {
        Some(m) => m,
        None => return,
    };

    let frac = |i: usize, p: &[f32]| -> (f32, f32, f32) {
        let (x, y, z) = (p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
        (
            x * minv[0] + y * minv[3] + z * minv[6],
            x * minv[1] + y * minv[4] + z * minv[7],
            x * minv[2] + y * minv[5] + z * minv[8],
        )
    };

    // Adjacency with the integer lattice shift that brings the neighbour's
    // minimum image next to the current atom. Asymmetric units are small, so a
    // brute-force O(n²) scan is cheap and avoids periodic cell-list bookkeeping.
    let mut adj: Vec<Vec<(usize, [i32; 3])>> = vec![Vec::new(); n];
    for i in 0..n {
        let (fi0, fi1, fi2) = frac(i, positions);
        for j in (i + 1)..n {
            let (fj0, fj1, fj2) = frac(j, positions);
            let (mut d0, mut d1, mut d2) = (fj0 - fi0, fj1 - fi1, fj2 - fi2);
            let (n0, n1, n2) = (d0.round(), d1.round(), d2.round());
            d0 -= n0;
            d1 -= n1;
            d2 -= n2;
            let cx = d0 * box_matrix[0] + d1 * box_matrix[3] + d2 * box_matrix[6];
            let cy = d0 * box_matrix[1] + d1 * box_matrix[4] + d2 * box_matrix[7];
            let cz = d0 * box_matrix[2] + d1 * box_matrix[5] + d2 * box_matrix[8];
            let dist_sq = cx * cx + cy * cy + cz * cz;
            let threshold =
                (covalent_radius(elements[i]) + covalent_radius(elements[j])) * BOND_TOLERANCE;
            if dist_sq > MIN_BOND_DIST * MIN_BOND_DIST && dist_sq <= threshold * threshold {
                // To place j's minimum image next to i, shift j by -n lattice
                // vectors; the reverse edge shifts i by +n relative to j.
                adj[i].push((j, [-(n0 as i32), -(n1 as i32), -(n2 as i32)]));
                adj[j].push((i, [n0 as i32, n1 as i32, n2 as i32]));
            }
        }
    }

    // Flood-fill each connected component, accumulating lattice shifts so a
    // finite molecule is expressed in one image. The seed atom stays put. If an
    // already visited atom is reached with a different shift, the component has
    // a non-zero periodic winding and is an extended network rather than a
    // finite molecule. Reset every shift in that component so its crystallographic
    // coordinates remain in the home cell.
    let mut shift = vec![[0i32; 3]; n];
    let mut visited = vec![false; n];
    let mut stack: Vec<usize> = Vec::new();
    for start in 0..n {
        if visited[start] {
            continue;
        }
        visited[start] = true;
        stack.push(start);
        let mut component = Vec::new();
        let mut has_periodic_winding = false;
        while let Some(i) = stack.pop() {
            component.push(i);
            for &(j, s) in &adj[i] {
                let expected = [shift[i][0] + s[0], shift[i][1] + s[1], shift[i][2] + s[2]];
                if !visited[j] {
                    visited[j] = true;
                    shift[j] = expected;
                    stack.push(j);
                } else if shift[j] != expected {
                    has_periodic_winding = true;
                }
            }
        }
        if has_periodic_winding {
            for i in component {
                shift[i] = [0, 0, 0];
            }
        }
    }

    for i in 0..n {
        let s = shift[i];
        if s == [0, 0, 0] {
            continue;
        }
        let (sf0, sf1, sf2) = (s[0] as f32, s[1] as f32, s[2] as f32);
        positions[i * 3] += sf0 * box_matrix[0] + sf1 * box_matrix[3] + sf2 * box_matrix[6];
        positions[i * 3 + 1] += sf0 * box_matrix[1] + sf1 * box_matrix[4] + sf2 * box_matrix[7];
        positions[i * 3 + 2] += sf0 * box_matrix[2] + sf1 * box_matrix[5] + sf2 * box_matrix[8];
    }
}

/// Infer bonds using a cell-list (spatial hashing) approach.
pub fn infer_bonds(
    positions: &[f32],
    elements: &[u8],
    n_atoms: usize,
    existing_bonds: &HashSet<(u32, u32)>,
) -> Vec<(u32, u32)> {
    let plan = ScanPlan::new(2.5, &elements[..n_atoms], covalent_radius, BOND_TOLERANCE);

    cell_list_scan(positions, n_atoms, &plan, |i, j| {
        let ri = covalent_radius(elements[i]);
        let rj = covalent_radius(elements[j]);
        let threshold = (ri + rj) * BOND_TOLERANCE;

        let dx = positions[j * 3] - positions[i * 3];
        let dy = positions[j * 3 + 1] - positions[i * 3 + 1];
        let dz = positions[j * 3 + 2] - positions[i * 3 + 2];

        let dist_sq = dx * dx + dy * dy + dz * dz;
        if dist_sq > MIN_BOND_DIST * MIN_BOND_DIST && dist_sq <= threshold * threshold {
            let a = i.min(j) as u32;
            let b = i.max(j) as u32;
            // Skip pairs already supplied by the file. The lookup runs only
            // after the (cheap) distance test passes — i.e. for the few real
            // hits rather than every candidate pair — which is a large win on
            // topologies carrying many explicit bonds (e.g. LAMMPS full).
            if existing_bonds.contains(&(a, b)) {
                None
            } else {
                Some((a, b))
            }
        } else {
            None
        }
    })
}

/// Infer covalent bonds with the minimum-image convention without moving atoms
/// out of their crystallographic cell. This is the appropriate path for
/// periodic structures: connectivity may cross a cell face, while structural
/// coordinates remain exactly as supplied by the file.
///
/// Candidate pairs come from a periodic cell list over fractional
/// coordinates, so the cost grows with the atom count rather than its square.
/// Every candidate then goes through the same minimum-image test the
/// all-pairs scan used, and the result is sorted, so the bonds — and their
/// order — are exactly what checking every pair would give.
pub fn infer_bonds_periodic(
    positions: &[f32],
    elements: &[u8],
    n_atoms: usize,
    existing_bonds: &HashSet<(u32, u32)>,
    box_matrix: &[f32; 9],
) -> Vec<(u32, u32)> {
    let minv = match invert3x3(box_matrix) {
        Some(matrix) => matrix,
        None => return infer_bonds(positions, elements, n_atoms, existing_bonds),
    };
    if n_atoms < 2 {
        return Vec::new();
    }

    let grid = PeriodicGrid::new(positions, &elements[..n_atoms], &minv, box_matrix);
    let mut inferred = Vec::with_capacity(n_atoms);
    let mut neighbors: Vec<usize> = Vec::with_capacity(27);
    for cell in 0..grid.n_cells() {
        let members = grid.atoms_in(cell);
        if members.is_empty() {
            continue;
        }
        grid.neighbor_cells(cell, &mut neighbors);
        for &i in members {
            let i = i as usize;
            for &other in &neighbors {
                for &j in grid.atoms_in(other) {
                    let j = j as usize;
                    // Each unordered pair is seen from both atoms (or twice
                    // from one cell); keep it once, from the lower index.
                    if j <= i {
                        continue;
                    }
                    let pair = (i as u32, j as u32);
                    if periodic_pair_bonded(positions, elements, &minv, box_matrix, i, j)
                        && !existing_bonds.contains(&pair)
                    {
                        inferred.push(pair);
                    }
                }
            }
        }
    }
    inferred.sort_unstable();
    inferred
}

/// The covalent test for atoms `i` and `j` of a periodic structure: their
/// separation, reduced to the nearest image by rounding its fractional
/// components, lies within `(r_i + r_j) * BOND_TOLERANCE` (and beyond
/// `MIN_BOND_DIST`).
fn periodic_pair_bonded(
    positions: &[f32],
    elements: &[u8],
    minv: &[f32; 9],
    box_matrix: &[f32; 9],
    i: usize,
    j: usize,
) -> bool {
    let mut dx = positions[j * 3] - positions[i * 3];
    let mut dy = positions[j * 3 + 1] - positions[i * 3 + 1];
    let mut dz = positions[j * 3 + 2] - positions[i * 3 + 2];

    let mut fa = dx * minv[0] + dy * minv[3] + dz * minv[6];
    let mut fb = dx * minv[1] + dy * minv[4] + dz * minv[7];
    let mut fc = dx * minv[2] + dy * minv[5] + dz * minv[8];
    fa -= fa.round();
    fb -= fb.round();
    fc -= fc.round();

    dx = fa * box_matrix[0] + fb * box_matrix[3] + fc * box_matrix[6];
    dy = fa * box_matrix[1] + fb * box_matrix[4] + fc * box_matrix[7];
    dz = fa * box_matrix[2] + fb * box_matrix[5] + fc * box_matrix[8];

    let dist_sq = dx * dx + dy * dy + dz * dz;
    let threshold = (covalent_radius(elements[i]) + covalent_radius(elements[j])) * BOND_TOLERANCE;
    dist_sq > MIN_BOND_DIST * MIN_BOND_DIST && dist_sq <= threshold * threshold
}

/// Atoms bucketed by their wrapped fractional coordinates into
/// `dims[0] × dims[1] × dims[2]` cells that tile the unit cell.
///
/// Each cell is at least as thick as the largest bond cutoff among the atoms,
/// measured between lattice planes (in a skewed cell that is less than the
/// vector length), so the nearest image of any bonded partner lies in one of
/// the 27 cells around an atom's own, wrapping across the cell faces.
struct PeriodicGrid {
    dims: [usize; 3],
    /// `starts[c]..starts[c + 1]` indexes the atoms of cell `c` in `atoms`.
    starts: Vec<usize>,
    atoms: Vec<u32>,
}

impl PeriodicGrid {
    fn new(positions: &[f32], elements: &[u8], minv: &[f32; 9], box_matrix: &[f32; 9]) -> Self {
        // The widest cutoff any two atoms present can have, with a little
        // slack so a pair right at the cutoff cannot round into a cell two
        // planes away. 2.5 Å stays the floor, as in `infer_bonds`.
        let max_radius = elements
            .iter()
            .map(|&e| covalent_radius(e))
            .fold(0.0, f32::max);
        let cell = (2.0 * max_radius * BOND_TOLERANCE * 1.001).max(2.5);
        let mut dims = plane_spacings(box_matrix).map(|w| ((w / cell) as usize).max(1));
        // A huge, mostly empty box: coarser cells keep the table proportional
        // to the atoms (cells only ever grow, so the search stays exact).
        let cap = max_dense_cells(elements.len()) as f64;
        while dims.iter().map(|&d| d as f64).product::<f64>() > cap {
            let k = (0..3).max_by_key(|&k| dims[k]).unwrap_or(0);
            dims[k] = (dims[k] / 2).max(1);
        }

        let n = elements.len();
        let cell_of = |i: usize| -> usize {
            let (x, y, z) = (positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
            let frac = [
                x * minv[0] + y * minv[3] + z * minv[6],
                x * minv[1] + y * minv[4] + z * minv[7],
                x * minv[2] + y * minv[5] + z * minv[8],
            ];
            let mut idx = [0usize; 3];
            for k in 0..3 {
                let wrapped = frac[k] - frac[k].floor();
                // `as` saturates (and maps NaN to 0); the `min` absorbs a
                // wrapped value that rounds up to exactly 1.0.
                idx[k] = ((wrapped * dims[k] as f32) as usize).min(dims[k] - 1);
            }
            (idx[0] * dims[1] + idx[1]) * dims[2] + idx[2]
        };

        let n_cells = dims[0] * dims[1] * dims[2];
        let atom_cell: Vec<usize> = (0..n).map(cell_of).collect();
        let mut starts = vec![0usize; n_cells + 1];
        for &c in &atom_cell {
            starts[c + 1] += 1;
        }
        for c in 0..n_cells {
            starts[c + 1] += starts[c];
        }
        let mut cursor = starts[..n_cells].to_vec();
        let mut atoms = vec![0u32; n];
        for (i, &c) in atom_cell.iter().enumerate() {
            atoms[cursor[c]] = i as u32;
            cursor[c] += 1;
        }
        PeriodicGrid {
            dims,
            starts,
            atoms,
        }
    }

    fn n_cells(&self) -> usize {
        self.starts.len() - 1
    }

    fn atoms_in(&self, cell: usize) -> &[u32] {
        &self.atoms[self.starts[cell]..self.starts[cell + 1]]
    }

    /// The distinct cells among the 27 around `cell`, wrapping across the
    /// faces. With fewer than three cells along an axis, several offsets land
    /// on the same cell; each is listed once so no pair is tested twice.
    fn neighbor_cells(&self, cell: usize, out: &mut Vec<usize>) {
        let [na, nb, nc] = self.dims;
        let (a, b, c) = (cell / (nb * nc), (cell / nc) % nb, cell % nc);
        let wrap = |v: usize, d: isize, n: usize| (v as isize + d).rem_euclid(n as isize) as usize;
        out.clear();
        for da in -1..=1 {
            for db in -1..=1 {
                for dc in -1..=1 {
                    let (x, y, z) = (wrap(a, da, na), wrap(b, db, nb), wrap(c, dc, nc));
                    out.push((x * nb + y) * nc + z);
                }
            }
        }
        out.sort_unstable();
        out.dedup();
    }
}

/// The spacing of the lattice planes spanned by each pair of cell vectors:
/// `volume / |b × c|` along a, and so on. A cell's thickness along an axis is
/// this, not the vector length, once the cell is skewed.
fn plane_spacings(m: &[f32; 9]) -> [f32; 3] {
    let (a, b, c) = ([m[0], m[1], m[2]], [m[3], m[4], m[5]], [m[6], m[7], m[8]]);
    let cross = |u: [f32; 3], v: [f32; 3]| {
        [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ]
    };
    let norm = |v: [f32; 3]| (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    let bc = cross(b, c);
    let volume = (a[0] * bc[0] + a[1] * bc[1] + a[2] * bc[2]).abs();
    [
        volume / norm(bc),
        volume / norm(cross(c, a)),
        volume / norm(cross(a, b)),
    ]
}

/// Infer bonds using VDW radii: bond if distance <= (vdw_i + vdw_j) * 0.6.
pub fn infer_bonds_vdw(positions: &[f32], elements: &[u8], n_atoms: usize) -> Vec<(u32, u32)> {
    let plan = ScanPlan::new(2.0, &elements[..n_atoms], vdw_radius, VDW_BOND_FACTOR);

    cell_list_scan(positions, n_atoms, &plan, |i, j| {
        let ri = vdw_radius(elements[i]);
        let rj = vdw_radius(elements[j]);
        let threshold = (ri + rj) * VDW_BOND_FACTOR;

        let dx = positions[j * 3] - positions[i * 3];
        let dy = positions[j * 3 + 1] - positions[i * 3 + 1];
        let dz = positions[j * 3 + 2] - positions[i * 3 + 2];

        let dist_sq = dx * dx + dy * dy + dz * dz;
        if dist_sq > MIN_BOND_DIST * MIN_BOND_DIST && dist_sq <= threshold * threshold {
            let a = i.min(j) as u32;
            let b = i.max(j) as u32;
            Some((a, b))
        } else {
            None
        }
    })
}

// ── Default bond-source policy ─────────────────────────────────────────────────

/// Structure formats that embed bond information directly in the file
/// (PDB CONECT records, MOL/SDF bond block, LAMMPS data Bonds section,
/// CML/Chem3D/Odyssey connectivity). Other supported structure formats
/// (xyz, gro, cif, traj, ...) carry no bond information, so VDW distance
/// inference is the more useful default.
///
/// This list is the single source of truth for every host's default
/// AddBond source. `src/pipeline/openFile.ts` (`FILE_BOND_EXTS`) mirrors it
/// for the synchronous TS load path and pins the mirror with a unit test —
/// change both together.
pub const FILE_BOND_EXTS: [&str; 11] = [
    ".pdb",
    ".ent",
    ".pdbx",
    ".mol",
    ".sdf",
    ".data",
    ".lammps",
    ".cml",
    ".c3xml",
    ".xodydata",
    ".odydata",
];

/// Flatten bond pairs `[(a0, b0), (a1, b1), …]` into `[a0, b0, a1, b1, …]`,
/// the layout every binding hands to its host (a `Uint32Array` in the browser,
/// an `(n, 2)` array after a reshape in Python).
pub fn flatten_pairs(pairs: &[(u32, u32)]) -> Vec<u32> {
    let mut flat = Vec::with_capacity(pairs.len() * 2);
    for &(a, b) in pairs {
        flat.push(a);
        flat.push(b);
    }
    flat
}

/// The default AddBond source for a structure file: `"structure"` for
/// formats that embed bonds, `"distance"` (VDW inference) otherwise.
/// Matching is by case-insensitive filename suffix.
pub fn default_bond_source(filename: &str) -> &'static str {
    let lower = filename.to_ascii_lowercase();
    if FILE_BOND_EXTS.iter().any(|ext| lower.ends_with(ext)) {
        "structure"
    } else {
        "distance"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A jittered cubic lattice of carbon atoms 1.5 Å apart (bonded to its
    /// axis neighbours), deterministic so dense and sparse scans can be compared.
    fn lattice(n_side: usize) -> (Vec<f32>, Vec<u8>) {
        let mut positions = Vec::new();
        let mut seed: u32 = 12345;
        let mut jitter = || {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            ((seed >> 16) % 1000) as f32 / 1000.0 * 0.2 - 0.1
        };
        for x in 0..n_side {
            for y in 0..n_side {
                for z in 0..n_side {
                    positions.push(x as f32 * 1.5 + jitter());
                    positions.push(y as f32 * 1.5 + jitter());
                    positions.push(z as f32 * 1.5 + jitter());
                }
            }
        }
        let n = n_side * n_side * n_side;
        (positions, vec![6; n])
    }

    #[test]
    fn sparse_scan_reports_the_dense_scan_bonds_in_the_same_order() {
        let (positions, elements) = lattice(9);
        let n = elements.len();
        let dense = infer_bonds(&positions, &elements, n, &HashSet::new());
        assert!(dense.len() > n, "the lattice is bonded");
        let check = |i: usize, j: usize| {
            let d2 = (0..3)
                .map(|k| positions[j * 3 + k] - positions[i * 3 + k])
                .map(|d| d * d)
                .sum::<f32>();
            let t = covalent_radius(6) * 2.0 * BOND_TOLERANCE;
            (d2 > MIN_BOND_DIST * MIN_BOND_DIST && d2 <= t * t)
                .then(|| (i.min(j) as u32, i.max(j) as u32))
        };
        let (mut lo, mut hi) = ([f32::MAX; 3], [f32::MIN; 3]);
        for i in 0..n {
            for k in 0..3 {
                lo[k] = lo[k].min(positions[i * 3 + k]);
                hi[k] = hi[k].max(positions[i * 3 + k]);
            }
        }
        let dims = [0, 1, 2].map(|k| ((hi[k] - lo[k]) / 2.5).ceil().max(1.0) as u64);
        let sparse = sparse_cell_list_scan(&positions, n, &ScanPlan::uniform(2.5), lo, dims, check);
        assert_eq!(sparse, dense);
    }

    #[test]
    fn one_far_away_atom_does_not_blow_up_the_grid() {
        // 9999 Å on every axis would be ~6e10 dense cells (240 GB of table).
        let (mut positions, mut elements) = lattice(6);
        let n0 = elements.len();
        let base = infer_bonds(&positions, &elements, n0, &HashSet::new());
        positions.extend_from_slice(&[9999.0, 9999.0, 9999.0]);
        elements.push(8);
        let with_outlier = infer_bonds(&positions, &elements, n0 + 1, &HashSet::new());
        assert_eq!(with_outlier, base);
        // The vdW variant shares the scan.
        let vdw = infer_bonds_vdw(&positions, &elements, n0 + 1);
        assert_eq!(
            vdw,
            infer_bonds_vdw(&positions[..n0 * 3], &elements[..n0], n0)
        );
        // Absurd and non-finite-looking magnitudes stay in range too.
        let far = [0.0, 0.0, 0.0, 1.0e30, -1.0e30, 1.0e30, 1.2, 0.0, 0.0];
        let bonds = infer_bonds(&far, &[6, 6, 6], 3, &HashSet::new());
        assert_eq!(bonds, vec![(0, 2)]);
    }

    #[test]
    fn max_dense_cells_scales_with_atoms() {
        assert_eq!(max_dense_cells(0), 4096);
        assert_eq!(max_dense_cells(1000), 12_096);
        assert_eq!(max_dense_cells(usize::MAX), usize::MAX);
    }

    #[test]
    fn flatten_pairs_interleaves_each_pair() {
        assert_eq!(flatten_pairs(&[]), Vec::<u32>::new());
        assert_eq!(
            flatten_pairs(&[(0, 1), (2, 5), (7, 3)]),
            vec![0, 1, 2, 5, 7, 3]
        );
    }

    #[test]
    fn default_bond_source_uses_file_bonds_for_embedding_formats() {
        for f in [
            "a.pdb",
            "b.ENT",
            "c.pdbx",
            "d.mol",
            "e.sdf",
            "f.data",
            "g.lammps",
            "h.cml",
            "i.c3xml",
            "j.xodydata",
            "k.odydata",
        ] {
            assert_eq!(super::default_bond_source(f), "structure", "{f}");
        }
    }

    #[test]
    fn default_bond_source_falls_back_to_distance_inference() {
        for f in [
            "a.xyz",
            "b.gro",
            "c.cif",
            "d.traj",
            "POSCAR",
            "e.lammpstrj",
            "f.mol2",
        ] {
            assert_eq!(super::default_bond_source(f), "distance", "{f}");
        }
    }
    use std::collections::HashSet;

    /// Build a water molecule: O at origin, H1 and H2 at ~0.96 Å.
    fn water_positions() -> (Vec<f32>, Vec<u8>) {
        let oh = 0.96f32;
        let half_angle = (104.5f32 / 2.0).to_radians();
        let positions = vec![
            0.0,
            0.0,
            0.0, // O
            oh * half_angle.sin(),
            oh * half_angle.cos(),
            0.0, // H1
            -oh * half_angle.sin(),
            oh * half_angle.cos(),
            0.0, // H2
        ];
        let elements = vec![8, 1, 1]; // O, H, H
        (positions, elements)
    }

    #[test]
    fn test_infer_bonds_empty() {
        let bonds = infer_bonds(&[], &[], 0, &HashSet::new());
        assert!(bonds.is_empty());
    }

    /// A carbonyl split across the a-face (C near fract 0.05, O near fract 0.90)
    /// loses its C–O bond under non-periodic inference; unwrapping must knit the
    /// molecule back together so the bond is recovered (Issue #558).
    #[test]
    fn test_unwrap_molecules_recovers_split_bond() {
        let a = 8.0f32;
        let box_m = [a, 0.0, 0.0, 0.0, a, 0.0, 0.0, 0.0, a];
        // C at 0.4 Å (fract 0.05), O at 7.16 Å (fract 0.895): 6.76 Å apart
        // directly, 1.24 Å across the periodic boundary.
        let mut positions = vec![0.4, 4.0, 4.0, 7.16, 4.0, 4.0];
        let elements = vec![6u8, 8u8];

        // Without unwrapping, non-periodic inference misses the bond.
        assert!(infer_bonds(&positions, &elements, 2, &HashSet::new()).is_empty());

        unwrap_molecules(&mut positions, &elements, &box_m);
        // O is shifted by one -a lattice vector to sit next to C.
        assert!((positions[3] - (7.16 - a)).abs() < 1e-3);
        let bonds = infer_bonds(&positions, &elements, 2, &HashSet::new());
        assert_eq!(bonds, vec![(0, 1)]);
    }

    #[test]
    fn test_infer_bonds_periodic_recovers_split_bond_without_moving_atoms() {
        let a = 8.0f32;
        let box_m = [a, 0.0, 0.0, 0.0, a, 0.0, 0.0, 0.0, a];
        let positions = vec![0.4, 4.0, 4.0, 7.16, 4.0, 4.0];
        let elements = vec![6u8, 8u8];
        let before = positions.clone();

        let inferred = infer_bonds_periodic(
            &positions,
            &elements,
            elements.len(),
            &HashSet::new(),
            &box_m,
        );

        assert_eq!(inferred, vec![(0, 1)]);
        assert_eq!(positions, before);
    }

    /// A molecule already whole must be left exactly as-is (all shifts zero).
    #[test]
    fn test_unwrap_molecules_noop_for_contiguous() {
        let box_m = [20.0, 0.0, 0.0, 0.0, 20.0, 0.0, 0.0, 0.0, 20.0];
        let (mut positions, elements) = water_positions();
        // Center the whole molecule inside the box.
        for i in 0..3 {
            positions[i * 3] += 10.0;
            positions[i * 3 + 1] += 10.0;
            positions[i * 3 + 2] += 10.0;
        }
        let before = positions.clone();
        unwrap_molecules(&mut positions, &elements, &box_m);
        for (a, b) in positions.iter().zip(before.iter()) {
            assert!((a - b).abs() < 1e-6);
        }
    }

    /// Two independent split molecules are each made whole without being merged.
    #[test]
    fn test_unwrap_molecules_multiple_components() {
        let a = 8.0f32;
        let box_m = [a, 0.0, 0.0, 0.0, a, 0.0, 0.0, 0.0, a];
        // Molecule A (C–O) split across the a-face; molecule B (C–O) whole and
        // far away along y.
        let mut positions = vec![
            0.4, 1.0, 1.0, // C  (fract 0.05)
            7.16, 1.0, 1.0, // O  (fract 0.895) — split partner of the C above
            3.0, 6.0, 6.0, // C  (whole molecule B)
            4.2, 6.0, 6.0, // O
        ];
        let elements = vec![6u8, 8u8, 6u8, 8u8];
        unwrap_molecules(&mut positions, &elements, &box_m);
        let bonds = infer_bonds(&positions, &elements, 4, &HashSet::new());
        let set: HashSet<(u32, u32)> = bonds.into_iter().collect();
        assert!(set.contains(&(0, 1)));
        assert!(set.contains(&(2, 3)));
        // Molecule B was already whole — untouched.
        assert!((positions[6] - 3.0).abs() < 1e-6 && (positions[9] - 4.2).abs() < 1e-6);
    }

    /// A bond graph whose cycle winds around the cell is an extended periodic
    /// network, not a finite molecule. There is no single set of atom images
    /// that makes every edge whole, so crystallographic positions must remain
    /// in the home cell.
    #[test]
    fn test_unwrap_molecules_leaves_periodic_network_in_home_cell() {
        let a = 3.0f32;
        let box_m = [a, 0.0, 0.0, 0.0, a, 0.0, 0.0, 0.0, a];
        let mut positions = vec![
            0.3, 1.5, 1.5, // C at fractional x = 0.1
            1.5, 1.5, 1.5, // C at fractional x = 0.5
            2.7, 1.5, 1.5, // C at fractional x = 0.9
        ];
        let elements = vec![6u8, 6u8, 6u8];
        let before = positions.clone();

        unwrap_molecules(&mut positions, &elements, &box_m);

        assert_eq!(positions, before);
    }

    #[test]
    fn test_unwrap_molecules_too_few_atoms_is_noop() {
        let box_m = [10.0, 0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 10.0];
        let mut positions = vec![9.9, 0.0, 0.0];
        let before = positions.clone();
        unwrap_molecules(&mut positions, &[6], &box_m);
        assert_eq!(positions, before);
    }

    #[test]
    fn test_unwrap_molecules_singular_box_is_noop() {
        let box_m = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0]; // singular
        let mut positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0];
        let before = positions.clone();
        unwrap_molecules(&mut positions, &[6, 6], &box_m);
        assert_eq!(positions, before);
    }

    #[test]
    fn test_infer_bonds_water() {
        let (positions, elements) = water_positions();
        let bonds = infer_bonds(&positions, &elements, 3, &HashSet::new());
        assert_eq!(bonds.len(), 2);
        assert!(bonds.contains(&(0, 1)));
        assert!(bonds.contains(&(0, 2)));
    }

    #[test]
    fn test_infer_bonds_skips_existing() {
        let (positions, elements) = water_positions();
        let mut existing = HashSet::new();
        existing.insert((0u32, 1u32));
        let bonds = infer_bonds(&positions, &elements, 3, &existing);
        assert_eq!(bonds.len(), 1);
        assert!(bonds.contains(&(0, 2)));
    }

    #[test]
    fn test_infer_bonds_far_apart() {
        let positions = vec![0.0, 0.0, 0.0, 10.0, 0.0, 0.0];
        let elements = vec![6, 6];
        let bonds = infer_bonds(&positions, &elements, 2, &HashSet::new());
        assert!(bonds.is_empty());
    }

    #[test]
    fn test_infer_bonds_too_close() {
        let positions = vec![0.0, 0.0, 0.0, 0.3, 0.0, 0.0];
        let elements = vec![6, 6];
        let bonds = infer_bonds(&positions, &elements, 2, &HashSet::new());
        assert!(bonds.is_empty());
    }

    #[test]
    fn test_infer_bonds_vdw_water() {
        let (positions, elements) = water_positions();
        let bonds = infer_bonds_vdw(&positions, &elements, 3);
        assert!(bonds.len() >= 2);
        assert!(bonds.contains(&(0, 1)));
        assert!(bonds.contains(&(0, 2)));
    }

    #[test]
    fn test_infer_bonds_vdw_empty() {
        let bonds = infer_bonds_vdw(&[], &[], 0);
        assert!(bonds.is_empty());
    }

    #[test]
    fn test_infer_bonds_vdw_far_apart() {
        let positions = vec![0.0, 0.0, 0.0, 10.0, 0.0, 0.0];
        let elements = vec![6, 6];
        let bonds = infer_bonds_vdw(&positions, &elements, 2);
        assert!(bonds.is_empty());
    }

    #[test]
    fn test_infer_bonds_single_atom() {
        let bonds = infer_bonds(&[1.0, 2.0, 3.0], &[6], 1, &HashSet::new());
        assert!(bonds.is_empty());
    }

    #[test]
    fn test_infer_bonds_chain_ordering() {
        // A carbon chain spaced 1.5 Å along x spans several 2.5 Å cells.
        // Each atom bonds only to its immediate neighbour, and the CSR cell
        // list must emit the pairs in ascending (i, j) order.
        let positions = vec![
            0.0, 0.0, 0.0, // 0
            1.5, 0.0, 0.0, // 1
            3.0, 0.0, 0.0, // 2
            4.5, 0.0, 0.0, // 3
        ];
        let elements = vec![6, 6, 6, 6];
        let bonds = infer_bonds(&positions, &elements, 4, &HashSet::new());
        assert_eq!(bonds, vec![(0, 1), (1, 2), (2, 3)]);
    }

    /// Brute-force O(n²) covalent reference, mirroring the scan predicate.
    fn brute_force_covalent(positions: &[f32], elements: &[u8], n: usize) -> HashSet<(u32, u32)> {
        let mut set = HashSet::new();
        for i in 0..n {
            for j in (i + 1)..n {
                let dx = positions[j * 3] - positions[i * 3];
                let dy = positions[j * 3 + 1] - positions[i * 3 + 1];
                let dz = positions[j * 3 + 2] - positions[i * 3 + 2];
                let d_sq = dx * dx + dy * dy + dz * dz;
                let thr =
                    (covalent_radius(elements[i]) + covalent_radius(elements[j])) * BOND_TOLERANCE;
                if d_sq > MIN_BOND_DIST * MIN_BOND_DIST && d_sq <= thr * thr {
                    set.insert((i as u32, j as u32));
                }
            }
        }
        set
    }

    #[test]
    fn test_infer_bonds_matches_brute_force_grid() {
        // A 3-D grid straddling many cells: the cell-list scan must find
        // exactly the same (duplicate-free) bond set as the naive all-pairs
        // reference, including when some pairs are pre-supplied as existing.
        let side = 6usize;
        let spacing = 1.4f32;
        let n = side * side * side;
        let mut positions = Vec::with_capacity(n * 3);
        for x in 0..side {
            for y in 0..side {
                for z in 0..side {
                    positions.push(x as f32 * spacing + y as f32 * 0.01);
                    positions.push(y as f32 * spacing);
                    positions.push(z as f32 * spacing);
                }
            }
        }
        let elements = vec![6u8; n];
        let bonds = infer_bonds(&positions, &elements, n, &HashSet::new());

        let set: HashSet<(u32, u32)> = bonds.iter().copied().collect();
        assert_eq!(set.len(), bonds.len(), "bond list must be duplicate-free");
        let reference = brute_force_covalent(&positions, &elements, n);
        assert_eq!(set, reference);

        // Pre-supplying an existing bond must drop exactly that pair.
        let some = *reference.iter().next().unwrap();
        let mut existing = HashSet::new();
        existing.insert(some);
        let filtered: HashSet<(u32, u32)> = infer_bonds(&positions, &elements, n, &existing)
            .into_iter()
            .collect();
        assert!(!filtered.contains(&some));
        assert_eq!(filtered.len(), reference.len() - 1);
    }

    /// The all-pairs minimum-image scan `infer_bonds_periodic` used before its
    /// cell list, kept as the reference the cell list must reproduce exactly.
    fn periodic_all_pairs(
        positions: &[f32],
        elements: &[u8],
        n_atoms: usize,
        existing_bonds: &HashSet<(u32, u32)>,
        box_matrix: &[f32; 9],
    ) -> Vec<(u32, u32)> {
        let minv = invert3x3(box_matrix).expect("test cells are invertible");
        let mut inferred = Vec::new();
        for i in 0..n_atoms {
            for j in (i + 1)..n_atoms {
                let pair = (i as u32, j as u32);
                if periodic_pair_bonded(positions, elements, &minv, box_matrix, i, j)
                    && !existing_bonds.contains(&pair)
                {
                    inferred.push(pair);
                }
            }
        }
        inferred
    }

    /// Fill one unit cell from a fixture's asymmetric unit, then tile it
    /// `k`³ times so the periodic grid has several cells per axis.
    fn fixture_supercell(name: &str, k: usize) -> (Vec<f32>, Vec<u8>, [f32; 9]) {
        let path = format!("{}/../../tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(&path).unwrap();
        let s = if name.ends_with(".cif") {
            crate::cif::parse(&text).unwrap()
        } else {
            crate::vasp::parse(&text).unwrap()
        };
        let bm = s.box_matrix.expect("fixture has a cell");
        let (positions, elements) = match crate::crystal::expand_symmetry(
            &s.positions,
            &s.elements,
            &[],
            None,
            &bm,
            &s.symmetry_ops,
        ) {
            Some((p, e, _, _)) => (p, e),
            None => (s.positions.clone(), s.elements.clone()),
        };
        let mut tiled_p = Vec::new();
        let mut tiled_e = Vec::new();
        for a in 0..k {
            for b in 0..k {
                for c in 0..k {
                    let shift = [0, 1, 2]
                        .map(|x| a as f32 * bm[x] + b as f32 * bm[3 + x] + c as f32 * bm[6 + x]);
                    for i in 0..elements.len() {
                        tiled_p.extend((0..3).map(|x| positions[i * 3 + x] + shift[x]));
                    }
                    tiled_e.extend_from_slice(&elements);
                }
            }
        }
        let kf = k as f32;
        (tiled_p, tiled_e, bm.map(|v| v * kf))
    }

    #[test]
    fn test_infer_bonds_periodic_matches_all_pairs_on_fixtures() {
        for name in [
            "alpha_al2o3_aflow.cif",
            "delta_glycine.cif",
            "glycine_csd.cif",
            "nacl.cif",
            "pbc_bond_split.cif",
            "POSCAR_si_diamond",
        ] {
            for k in [1, 3] {
                let (p, e, bm) = fixture_supercell(name, k);
                let n = e.len();
                let got = infer_bonds_periodic(&p, &e, n, &HashSet::new(), &bm);
                let want = periodic_all_pairs(&p, &e, n, &HashSet::new(), &bm);
                assert!(!want.is_empty(), "{name} x{k} has bonds");
                assert_eq!(got, want, "{name} x{k}");
            }
        }
    }

    /// Deterministic random atoms at fractional coordinates in `[-1, 2)` of
    /// `box_m` (so many sit outside the home cell), mixing H/C/N/O with K, Na,
    /// S and Fe so short and long cutoffs meet.
    fn random_periodic(n: usize, box_m: &[f32; 9], seed: u32) -> (Vec<f32>, Vec<u8>) {
        let mut state = seed;
        let mut next = || {
            state = state.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            (state >> 8) as f32 / (1u32 << 24) as f32
        };
        let palette = [1u8, 1, 6, 6, 7, 8, 8, 19, 11, 16, 26];
        let mut positions = Vec::with_capacity(n * 3);
        let mut elements = Vec::with_capacity(n);
        for i in 0..n {
            let f = [next() * 3.0 - 1.0, next() * 3.0 - 1.0, next() * 3.0 - 1.0];
            positions.extend(
                (0..3).map(|x| f[0] * box_m[x] + f[1] * box_m[3 + x] + f[2] * box_m[6 + x]),
            );
            elements.push(palette[i % palette.len()]);
        }
        (positions, elements)
    }

    #[test]
    fn test_infer_bonds_periodic_matches_all_pairs_on_random_cells() {
        let cells: [[f32; 9]; 6] = [
            // Orthorhombic, several cells per axis.
            [21.0, 0.0, 0.0, 0.0, 18.0, 0.0, 0.0, 0.0, 24.0],
            // Triclinic.
            [19.0, 0.0, 0.0, 6.0, 17.0, 0.0, -4.0, 5.0, 20.0],
            // Strongly sheared: |b| = 25 Å but the a-c planes are 12 Å apart.
            [20.0, 0.0, 0.0, 22.0, 12.0, 0.0, 3.0, -2.0, 18.0],
            // Hexagonal (gamma = 120°).
            [16.0, 0.0, 0.0, -8.0, 13.856, 0.0, 0.0, 0.0, 15.0],
            // Small: one or two cells per axis, so wrapped neighbours repeat.
            [4.0, 0.0, 0.0, 0.0, 6.0, 0.0, 0.0, 0.0, 9.0],
            // Thin slab: one cell along c.
            [22.0, 0.0, 0.0, 0.0, 22.0, 0.0, 0.0, 0.0, 3.3],
        ];
        for (k, bm) in cells.iter().enumerate() {
            for seed in [1, 2] {
                let n = if k == 4 { 60 } else { 700 };
                let (p, e) = random_periodic(n, bm, seed + k as u32 * 10);
                let got = infer_bonds_periodic(&p, &e, n, &HashSet::new(), bm);
                let want = periodic_all_pairs(&p, &e, n, &HashSet::new(), bm);
                assert!(!want.is_empty(), "cell {k} seed {seed} has bonds");
                assert_eq!(got, want, "cell {k} seed {seed}");

                // Pairs the file already supplies are left out, exactly.
                let existing: HashSet<(u32, u32)> = want.iter().step_by(3).copied().collect();
                let got = infer_bonds_periodic(&p, &e, n, &existing, bm);
                assert_eq!(got, periodic_all_pairs(&p, &e, n, &existing, bm));
            }
        }
    }

    #[test]
    fn test_infer_bonds_periodic_edge_cases() {
        let cube = [10.0, 0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 10.0];
        assert!(infer_bonds_periodic(&[], &[], 0, &HashSet::new(), &cube).is_empty());
        assert!(infer_bonds_periodic(&[1.0, 1.0, 1.0], &[6], 1, &HashSet::new(), &cube).is_empty());
        // A singular cell falls back to non-periodic inference.
        let flat = [10.0, 0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 0.0];
        let p = [0.0, 0.0, 0.0, 1.4, 0.0, 0.0];
        assert_eq!(
            infer_bonds_periodic(&p, &[6, 6], 2, &HashSet::new(), &flat),
            vec![(0, 1)]
        );
        // A huge, nearly empty box stays bounded and still bonds across a face.
        let huge = [5000.0, 0.0, 0.0, 0.0, 5000.0, 0.0, 0.0, 0.0, 5000.0];
        let p = [0.3, 1.0, 1.0, 4999.5, 1.0, 1.0, 2500.0, 2500.0, 2500.0];
        assert_eq!(
            infer_bonds_periodic(&p, &[6, 6, 8], 3, &HashSet::new(), &huge),
            vec![(0, 1)]
        );
    }

    #[test]
    fn test_plane_spacings() {
        let w = plane_spacings(&[10.0, 0.0, 0.0, 0.0, 20.0, 0.0, 0.0, 0.0, 30.0]);
        assert_eq!(w, [10.0, 20.0, 30.0]);
        // Shearing b along a leaves the a-c plane spacing at b's y component.
        let w = plane_spacings(&[10.0, 0.0, 0.0, 20.0, 15.0, 0.0, 0.0, 0.0, 30.0]);
        assert!((w[1] - 15.0).abs() < 1e-4, "{w:?}");
        assert!(
            w[0] < 10.0,
            "a's planes are closer than |a| once b is sheared"
        );
    }

    /// Brute-force O(n²) vdW reference, mirroring the scan predicate.
    fn brute_force_vdw(positions: &[f32], elements: &[u8], n: usize) -> HashSet<(u32, u32)> {
        let mut set = HashSet::new();
        for i in 0..n {
            for j in (i + 1)..n {
                let d_sq: f32 = (0..3)
                    .map(|k| positions[j * 3 + k] - positions[i * 3 + k])
                    .map(|d| d * d)
                    .sum();
                let thr = (vdw_radius(elements[i]) + vdw_radius(elements[j])) * VDW_BOND_FACTOR;
                if d_sq > MIN_BOND_DIST * MIN_BOND_DIST && d_sq <= thr * thr {
                    set.insert((i as u32, j as u32));
                }
            }
        }
        set
    }

    /// Rock-salt lattice (`side`³ sites, a = 5.64 Å) of Na (11) and Cl (17),
    /// translated by `shift`.
    fn rock_salt(side: usize, shift: f32) -> (Vec<f32>, Vec<u8>) {
        let half = 5.64f32 / 2.0;
        let mut positions = Vec::with_capacity(side * side * side * 3);
        let mut elements = Vec::with_capacity(side * side * side);
        for i in 0..side {
            for j in 0..side {
                for k in 0..side {
                    positions.extend([i, j, k].map(|v| v as f32 * half + shift));
                    elements.push(if (i + j + k) % 2 == 0 { 11 } else { 17 });
                }
            }
        }
        (positions, elements)
    }

    fn as_set(bonds: &[(u32, u32)]) -> HashSet<(u32, u32)> {
        let set: HashSet<(u32, u32)> = bonds.iter().copied().collect();
        assert_eq!(set.len(), bonds.len(), "bond list must be duplicate-free");
        set
    }

    /// The covalent cutoff of heavy atoms exceeds the 2.5 Å base cell (Na–Na
    /// 4.32 Å, K–K 5.28 Å). Whether such a pair bonds must not depend on where
    /// unrelated atoms put the grid origin.
    #[test]
    fn test_infer_bonds_long_cutoff_ignores_unrelated_atoms() {
        let na = vec![0.0, 0.0, 0.0, 4.0, 0.0, 0.0];
        assert_eq!(
            infer_bonds(&na, &[11, 11], 2, &HashSet::new()),
            vec![(0, 1)]
        );
        // Two far-off H atoms move the grid origin to x = -1.
        let mut with_h = na.clone();
        with_h.extend_from_slice(&[-1.0, 20.0, 0.0, 10.0, 20.0, 0.0]);
        let bonds = infer_bonds(&with_h, &[11, 11, 1, 1], 4, &HashSet::new());
        assert_eq!(bonds, vec![(0, 1)]);
        // K–K 5.0 Å (cutoff 5.28 Å) spans three base cells.
        let k = vec![0.3, 0.0, 0.0, 5.3, 0.0, 0.0];
        assert_eq!(infer_bonds(&k, &[19, 19], 2, &HashSet::new()), vec![(0, 1)]);
    }

    #[test]
    fn test_infer_bonds_rock_salt_matches_brute_force() {
        // 12³ NaCl: the cell list used to find 7920 of the 9108 bonds.
        for shift in [0.0, 0.3, -1.7] {
            let (positions, elements) = rock_salt(12, shift);
            let n = elements.len();
            let bonds = infer_bonds(&positions, &elements, n, &HashSet::new());
            let reference = brute_force_covalent(&positions, &elements, n);
            assert_eq!(reference.len(), 9108, "shift {shift}");
            assert_eq!(as_set(&bonds), reference, "shift {shift}");
        }
    }

    /// The vdW cutoff of S–S (2.16 Å), Na–Na (2.72 Å) and K–K (3.3 Å) exceeds
    /// the 2.0 Å base cell.
    #[test]
    fn test_infer_bonds_vdw_long_cutoff_matches_brute_force() {
        // A 2.05 Å S–S pair at two grid offsets, with a C fixing the origin.
        for x0 in [1.99f32, 1.0] {
            let p = vec![x0, 0.0, 0.0, x0 + 2.05, 0.0, 0.0, 0.0, 5.0, 0.0];
            assert_eq!(
                infer_bonds_vdw(&p, &[16, 16, 6], 3),
                vec![(0, 1)],
                "x0 {x0}"
            );
        }
        let (positions, mut elements) = rock_salt(8, 0.4);
        // Sprinkle K and S over the lattice so several long cutoffs mix.
        for (i, e) in elements.iter_mut().enumerate() {
            match i % 7 {
                0 => *e = 19,
                3 => *e = 16,
                _ => {}
            }
        }
        let n = elements.len();
        let bonds = infer_bonds_vdw(&positions, &elements, n);
        let reference = brute_force_vdw(&positions, &elements, n);
        assert!(!reference.is_empty());
        assert_eq!(as_set(&bonds), reference);
    }

    #[test]
    fn test_scan_plan_sizes_cells_for_all_but_a_wide_minority() {
        // Typical organics keep the base covalent cell, so their bond order is
        // unchanged.
        let organic = ScanPlan::new(2.5, &[1, 6, 7, 8], covalent_radius, BOND_TOLERANCE);
        assert_eq!(organic.cell_size, 2.5);
        assert!(organic.wide.is_empty() && organic.far_offsets().is_empty());
        let empty = ScanPlan::new(2.5, &[], covalent_radius, BOND_TOLERANCE);
        assert_eq!(empty.cell_size, 2.5);
        assert!(empty.wide.is_empty());
        assert_eq!(
            ScanPlan::new(2.0, &[1, 7, 8], vdw_radius, VDW_BOND_FACTOR).cell_size,
            2.0
        );
        // Carbon's own vdW cutoff (2.04 A) is wider than the 2.0 A base, and
        // carbon is no minority, so the cell grows to fit it.
        let c = ScanPlan::new(2.0, &[1, 6], vdw_radius, VDW_BOND_FACTOR);
        assert!(c.cell_size >= 2.0 * vdw_radius(6) * VDW_BOND_FACTOR && c.cell_size < 2.05);
        assert!(c.wide.is_empty());

        // A K+ among many waters keeps the 2.5 A cell and searches 3 cells out
        // (K-K 5.28 A) instead of widening every cell.
        let mut water: Vec<u8> = (0..300).map(|i| if i % 3 == 0 { 8 } else { 1 }).collect();
        water[10] = 19;
        water[200] = 19;
        let ions = ScanPlan::new(2.5, &water, covalent_radius, BOND_TOLERANCE);
        assert_eq!(ions.cell_size, 2.5);
        assert_eq!(ions.wide, vec![10, 200]);
        assert_eq!(ions.reach, 3);
        assert_eq!(ions.far_offsets().len(), 7 * 7 * 7 - 27);
        assert!(ions.keeps_far_pair(10, 5)); // water partner: checked by the ion
        assert!(ions.keeps_far_pair(10, 200)); // ion pair: checked from the lower index
        assert!(!ions.keeps_far_pair(200, 10));

        // When heavy atoms are no minority (rock salt), the cell grows instead.
        let (_, salt) = rock_salt(4, 0.0);
        let salt_plan = ScanPlan::new(2.5, &salt, covalent_radius, BOND_TOLERANCE);
        assert!(salt_plan.cell_size >= 2.0 * covalent_radius(11) * BOND_TOLERANCE);
        assert!(salt_plan.wide.is_empty());
    }

    /// Random atoms in a cube: mostly H/C/N/O with a minority of heavy atoms
    /// (K, Na, Ca, S, Cl, Fe, I), so the wide-atom search is exercised.
    fn mixed_box(n: usize, side: f32, seed: u32) -> (Vec<f32>, Vec<u8>) {
        let mut state = seed;
        let mut next = || {
            state = state.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            (state >> 8) as f32 / (1u32 << 24) as f32
        };
        let heavy = [19u8, 11, 20, 16, 17, 26, 53];
        let light = [1u8, 1, 6, 7, 8];
        let mut positions = Vec::with_capacity(n * 3);
        let mut elements = Vec::with_capacity(n);
        for i in 0..n {
            positions.extend([next() * side, next() * side, next() * side]);
            elements.push(if i % 17 == 0 {
                heavy[(i / 17) % heavy.len()]
            } else {
                light[i % light.len()]
            });
        }
        (positions, elements)
    }

    #[test]
    fn test_wide_atoms_find_every_long_bond_dense_and_sparse() {
        for seed in [1, 2, 3] {
            let (mut positions, mut elements) = mixed_box(1000, 21.0, seed);
            let n = elements.len();
            let plan = ScanPlan::new(2.5, &elements, covalent_radius, BOND_TOLERANCE);
            assert_eq!(plan.cell_size, 2.5, "heavy atoms stay a minority");
            assert!(!plan.wide.is_empty());

            let cov = infer_bonds(&positions, &elements, n, &HashSet::new());
            assert_eq!(as_set(&cov), brute_force_covalent(&positions, &elements, n));
            let vdw = infer_bonds_vdw(&positions, &elements, n);
            assert_eq!(as_set(&vdw), brute_force_vdw(&positions, &elements, n));

            // A far-off outlier switches both scans to the sparse grid.
            positions.extend_from_slice(&[9999.0, 9999.0, 9999.0]);
            elements.push(19);
            let m = n + 1;
            let cov = infer_bonds(&positions, &elements, m, &HashSet::new());
            assert_eq!(as_set(&cov), brute_force_covalent(&positions, &elements, m));
            let vdw = infer_bonds_vdw(&positions, &elements, m);
            assert_eq!(as_set(&vdw), brute_force_vdw(&positions, &elements, m));
        }
    }
}
