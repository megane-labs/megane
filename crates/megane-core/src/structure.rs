//! Format-neutral result types shared by every structure parser.
//!
//! [`ParsedStructure`] is what each `megane-core` structure parser returns;
//! [`HeteroFrames`] is its per-frame side table for heterogeneous
//! trajectories, assembled by [`HeteroFramesBuilder`] from the parser's
//! [`FrameChange`] verdicts. [`SsRange`] / [`ss_type_at`] annotate Cα atoms
//! with the secondary structure a file declares (PDB HELIX/SHEET, mmCIF
//! `_struct_conf` / `_struct_sheet_range`).
//!
//! These types used to live in `parser.rs` next to the PDB parser; that path
//! is kept as a compatibility re-export (see [`crate::parser`]).
use std::collections::HashSet;

/// Per-frame topology for *heterogeneous* trajectories — those whose frames
/// differ in atom count, unit cell, or elements/bonds. `None` on
/// [`ParsedStructure`] means the trajectory is *uniform* (the common case) and
/// the fast fixed-stride path is used everywhere; nothing here is allocated.
///
/// Every channel is independently optional: a constant-atom NPT run with a
/// changing cell fills only `cells_flat`, keeps the fixed-stride positions
/// path, and reuses frame-0 elements/bonds (`elements_flat`/`bonds_flat` empty).
///
/// All indices below address the EXTRA frames (frame 0 lives in
/// [`ParsedStructure::positions`]/`elements`/`bonds`/`box_matrix`), matching the
/// `frame_positions_flat` convention.
pub struct HeteroFrames {
    /// Prefix-sum of atom counts over EXTRA frames, in atoms. Length
    /// `extra_count + 1`; extra frame `i` occupies
    /// `frame_positions_flat[atom_offsets[i]*3 .. atom_offsets[i+1]*3)`.
    /// Always populated (this is what makes jagged positions sliceable).
    pub atom_offsets: Vec<u32>,
    /// Concatenated per-extra-frame atomic numbers, sliced by `atom_offsets`.
    /// Empty when topology is constant (host reuses frame-0 `elements`).
    pub elements_flat: Vec<u8>,
    /// Per-extra-frame row-major 3×3 cell, 9 floats each; length
    /// `extra_count * 9`. Empty when the cell is constant (host reuses
    /// frame-0 `box_matrix`).
    pub cells_flat: Vec<f32>,
    /// Prefix-sum of bond counts over EXTRA frames, in *pairs*. Length
    /// `extra_count + 1` when populated, else empty (topology constant).
    pub bond_offsets: Vec<u32>,
    /// Concatenated per-extra-frame inferred bonds `[a0,b0,a1,b1,…]`, sliced by
    /// `bond_offsets` (×2). Empty when topology is constant.
    pub bonds_flat: Vec<u32>,
    /// Atom count changes between frames.
    pub varies_atoms: bool,
    /// Unit cell changes between frames.
    pub varies_cell: bool,
    /// Elements (and hence inferred bonds) change between frames.
    pub varies_topology: bool,
    /// Maximum atom count across ALL frames (incl. frame 0). Drives one-time
    /// GPU buffer sizing on the host so per-frame updates never reallocate.
    pub max_atoms: u32,
}

/// The parser's verdict on how one extra frame differs from frame 0.
///
/// Each format detects variation its own way (a byte compare of an ASE cell, a
/// `Lattice=` that may be absent, a PDB that never tracks element changes), so
/// [`HeteroFramesBuilder`] never second-guesses it: the parser decides, the
/// builder only records. Both verdicts are sticky — once any frame reports a
/// change, the channel is recorded for every later frame. A change in atom
/// count is detected by the builder itself (it is the same for every format).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FrameChange {
    /// This frame's atomic numbers differ from frame 0's.
    pub topology: bool,
    /// This frame's unit cell differs from frame 0's.
    pub cell: bool,
}

/// Accumulates the EXTRA frames of a multi-frame structure file and assembles
/// the [`HeteroFrames`] side table, shared by every structure parser that can
/// emit per-frame topology or cells (XYZ, XSF, PDB/mmCIF multi-model, ASE
/// `.traj`, GAMESS, LAMMPS dump, GRO, XDATCAR).
///
/// Per-frame elements and cells are recorded *lazily*: nothing is stored until
/// a channel is first seen to vary, and the earlier extra frames are backfilled
/// with frame-0 values at [`finish`](Self::finish). A uniform trajectory
/// therefore allocates no side table at all and keeps the fixed-stride path.
/// A parser that already holds every frame's elements and wants them recorded
/// verbatim (rather than backfilled) opts in with
/// [`eager_elements`](Self::eager_elements).
///
/// What counts as heterogeneous is the union of the three variation flags:
/// atom count (detected here), topology and cell (the parser's
/// [`FrameChange`] verdicts). A parser that never reports a topology change
/// (PDB, mmCIF) only goes heterogeneous on an atom-count change; one that never
/// reports either (GRO, XDATCAR) only on a cell change.
pub struct HeteroFramesBuilder {
    frame0_atoms: usize,
    eager_elements: bool,
    frame_positions_flat: Vec<f32>,
    atom_offsets: Vec<u32>,
    max_atoms: usize,
    varies_atoms: bool,
    varies_topology: bool,
    varies_cell: bool,
    /// Extra-frame index at which element recording began (frames before it
    /// are backfilled with frame-0 elements), and the frames recorded since.
    topo_start: Option<usize>,
    per_frame_elements: Vec<Vec<u8>>,
    /// Same lazy scheme for cells.
    cell_start: Option<usize>,
    per_frame_cells: Vec<[f32; 9]>,
}

impl HeteroFramesBuilder {
    /// Builder for a file whose frame 0 has `frame0_atoms` atoms.
    pub fn new(frame0_atoms: usize) -> Self {
        Self::with_capacity(frame0_atoms, 0)
    }

    /// Like [`new`](Self::new), reserving room for `extra_frames` frames of
    /// `frame0_atoms` atoms each (the uniform case). The reservation is made
    /// up front, so a caller whose frame count comes from a header bounds it
    /// by what its input can actually hold (see `traj::parse_traj`).
    pub fn with_capacity(frame0_atoms: usize, extra_frames: usize) -> Self {
        let mut atom_offsets = Vec::with_capacity(extra_frames + 1);
        atom_offsets.push(0);
        Self {
            frame0_atoms,
            eager_elements: false,
            frame_positions_flat: Vec::with_capacity(extra_frames * frame0_atoms * 3),
            atom_offsets,
            max_atoms: frame0_atoms,
            varies_atoms: false,
            varies_topology: false,
            varies_cell: false,
            topo_start: None,
            per_frame_elements: Vec::new(),
            cell_start: None,
            per_frame_cells: Vec::new(),
        }
    }

    /// Record every extra frame's elements from the first frame on, instead of
    /// backfilling the frames before the first variation with frame 0's. This
    /// only differs when a parser's topology verdict ignores some element
    /// changes (mmCIF only goes heterogeneous on an atom-count change, yet its
    /// side table carries each model's own elements). Element snapshots are
    /// still discarded when the file turns out uniform.
    pub fn eager_elements(mut self) -> Self {
        self.eager_elements = true;
        self
    }

    /// Number of extra frames pushed so far.
    pub fn extra_frames(&self) -> usize {
        self.atom_offsets.len() - 1
    }

    /// Whether any extra frame so far changed the atom count.
    pub fn varies_atoms(&self) -> bool {
        self.varies_atoms
    }

    /// Whether any extra frame so far was reported as a topology change.
    pub fn varies_topology(&self) -> bool {
        self.varies_topology
    }

    /// Whether any extra frame so far was reported as a cell change.
    pub fn varies_cell(&self) -> bool {
        self.varies_cell
    }

    /// Append one extra frame.
    ///
    /// `positions` are its flat `[x,y,z,…]` coordinates (the atom count is
    /// `len / 3`). `elements` yields its atomic numbers and is only called once
    /// element recording has begun, so a uniform file never builds one; the
    /// snapshot is padded with 0 / truncated to the frame's atom count so the
    /// element table always stays sliceable by `atom_offsets`. `cell` is the
    /// cell to record for this frame once cell recording has begun (`None` is
    /// stored as zeros), already resolved by the parser's own carry-forward rule.
    pub fn push_frame<E>(
        &mut self,
        positions: &[f32],
        elements: E,
        cell: Option<[f32; 9]>,
        change: FrameChange,
    ) where
        E: FnOnce() -> Vec<u8>,
    {
        let start = self.frame_positions_flat.len();
        self.frame_positions_flat.extend_from_slice(positions);
        self.push_frame_tail(start, elements, cell, change);
    }

    /// [`push_frame`](Self::push_frame) for parsers that hold coordinates in
    /// another layout (e.g. per-atom records): the coordinates are streamed
    /// straight into the flat buffer without an intermediate `Vec`.
    pub fn push_frame_iter<P, E>(
        &mut self,
        positions: P,
        elements: E,
        cell: Option<[f32; 9]>,
        change: FrameChange,
    ) where
        P: IntoIterator<Item = f32>,
        E: FnOnce() -> Vec<u8>,
    {
        let start = self.frame_positions_flat.len();
        self.frame_positions_flat.extend(positions);
        self.push_frame_tail(start, elements, cell, change);
    }

    fn push_frame_tail<E>(
        &mut self,
        start: usize,
        elements: E,
        cell: Option<[f32; 9]>,
        change: FrameChange,
    ) where
        E: FnOnce() -> Vec<u8>,
    {
        let ei = self.extra_frames();
        let n = (self.frame_positions_flat.len() - start) / 3;
        let last = self.atom_offsets[ei];
        self.atom_offsets.push(last + n as u32);
        self.max_atoms = self.max_atoms.max(n);
        self.varies_atoms |= n != self.frame0_atoms;
        self.varies_topology |= change.topology;
        self.varies_cell |= change.cell;

        if self.eager_elements || self.varies_atoms || self.varies_topology {
            self.topo_start.get_or_insert(ei);
            let mut snap = elements();
            snap.resize(n, 0);
            self.per_frame_elements.push(snap);
        }
        if self.varies_cell {
            self.cell_start.get_or_insert(ei);
            self.per_frame_cells.push(cell.unwrap_or([0.0; 9]));
        }
    }

    /// Assemble the result: the extra frames' flat positions plus the side
    /// table, or `None` when no channel varied (uniform file).
    ///
    /// `frame0_elements` / `frame0_cell` backfill the extra frames recorded
    /// before their channel first varied (those frames matched frame 0).
    ///
    /// Bonds for each extra frame are inferred by distance. None of these
    /// formats declares per-frame connectivity for its extra frames, so
    /// inference is the only source (CRITICAL RULE #11c). An atom-count change
    /// always implies a topology change (the element list differs in length).
    pub fn finish(
        self,
        frame0_elements: &[u8],
        frame0_cell: Option<[f32; 9]>,
    ) -> (Vec<f32>, Option<HeteroFrames>) {
        let varies_topology = self.varies_topology || self.varies_atoms;
        if !(varies_topology || self.varies_cell) {
            return (self.frame_positions_flat, None);
        }

        let (elements_flat, bond_offsets, bonds_flat) = if varies_topology {
            let backfill = self.topo_start.unwrap_or(0);
            let empty_bonds: HashSet<(u32, u32)> = HashSet::new();
            let mut elements_flat: Vec<u8> = Vec::new();
            let mut bonds_flat: Vec<u32> = Vec::new();
            let mut bond_offsets: Vec<u32> = Vec::with_capacity(self.atom_offsets.len());
            bond_offsets.push(0);
            let frames = std::iter::repeat_n(frame0_elements, backfill)
                .chain(self.per_frame_elements.iter().map(Vec::as_slice));
            for (k, elems) in frames.enumerate() {
                let a = self.atom_offsets[k] as usize * 3;
                let b = self.atom_offsets[k + 1] as usize * 3;
                let fpos = &self.frame_positions_flat[a..b];
                let fbonds = crate::bonds::infer_bonds(fpos, elems, elems.len(), &empty_bonds);
                for (u, v) in &fbonds {
                    bonds_flat.push(*u);
                    bonds_flat.push(*v);
                }
                bond_offsets.push(bond_offsets[k] + fbonds.len() as u32);
                elements_flat.extend_from_slice(elems);
            }
            (elements_flat, bond_offsets, bonds_flat)
        } else {
            (Vec::new(), Vec::new(), Vec::new())
        };

        let cells_flat: Vec<f32> = if self.varies_cell {
            let base = frame0_cell.unwrap_or([0.0; 9]);
            let backfill = self.cell_start.unwrap_or(0);
            std::iter::repeat_n(&base, backfill)
                .chain(self.per_frame_cells.iter())
                .flatten()
                .copied()
                .collect()
        } else {
            Vec::new()
        };

        let hetero = HeteroFrames {
            atom_offsets: self.atom_offsets,
            elements_flat,
            cells_flat,
            bond_offsets,
            bonds_flat,
            varies_atoms: self.varies_atoms,
            varies_cell: self.varies_cell,
            varies_topology,
            max_atoms: self.max_atoms as u32,
        };
        (self.frame_positions_flat, Some(hetero))
    }
}

/// Common result type for all structure format parsers.
///
/// Derives [`Default`] so parsers spell out only the channels they fill and
/// end the literal with `..Default::default()` (empty vecs, `None` options).
#[derive(Default)]
pub struct ParsedStructure {
    pub n_atoms: usize,
    pub positions: Vec<f32>,
    pub elements: Vec<u8>,
    pub bonds: Vec<(u32, u32)>,
    pub n_file_bonds: usize,
    pub bond_orders: Option<Vec<u8>>,
    pub box_matrix: Option<[f32; 9]>,
    /// World-space lower corner (xlo, ylo, zlo) of the simulation box, i.e. the
    /// origin at which `box_matrix`'s edge vectors are anchored. `None` ⇒ the
    /// box sits at world origin `(0,0,0)`. Atom coordinates in `positions` are
    /// always absolute; this only tells the renderer where to draw the cell.
    /// Only formats that store an explicit box origin (LAMMPS data/dump) set it.
    pub box_origin: Option<[f32; 3]>,
    /// EXTRA frames only (frame 0 lives in `positions`), frame-major flat:
    /// `[extra0: x0,y0,z0,…][extra1: …]…`. Length == `extra_frame_count() * n_atoms * 3`.
    /// A single contiguous allocation so the WASM/PyO3 boundary avoids a flatten copy.
    pub frame_positions_flat: Vec<f32>,
    pub atom_labels: Option<Vec<String>>,
    /// Per-atom chain IDs encoded as raw ASCII bytes (e.g. b'A'=65, b'B'=66).
    /// None when the format does not carry chain information.
    pub chain_ids: Option<Vec<u8>>,
    /// Per-atom B-factors (temperature factors) in Å².
    /// None when the format does not carry B-factor information.
    pub bfactors: Option<Vec<f32>>,
    /// Embedded vector channels (e.g. GRO velocities).
    /// Empty for formats that carry no per-atom vector quantities.
    pub vector_channels: Vec<crate::trajectory::VectorChannel>,
    /// Indices of Cα (alpha-carbon) atoms in the positions array.
    /// Empty for non-protein or formats that do not carry atom names.
    pub ca_indices: Vec<u32>,
    /// Per-Cα chain identifier (ASCII byte, e.g. b'A').
    pub ca_chain_ids: Vec<u8>,
    /// Per-Cα residue sequence number. Signed: PDB/mmCIF author numbering
    /// puts expression tags below 1 (`-2`, `-1`, `0`).
    pub ca_res_nums: Vec<i32>,
    /// Per-Cα secondary-structure type: 0 = coil, 1 = helix, 2 = sheet.
    pub ca_ss_type: Vec<u8>,
    /// Crystallographic symmetry operations as raw `x,y,z`-style strings,
    /// captured from a CIF `_symmetry_equiv_pos_as_xyz` /
    /// `_space_group_symop_operation_xyz` loop. Empty for formats that carry
    /// no space-group information. The parser does NOT apply these — it always
    /// returns the asymmetric unit; symmetry expansion is a downstream feature.
    pub symmetry_ops: Vec<String>,
    /// Per-frame topology for heterogeneous trajectories. `None` (the common
    /// case) means uniform: fixed atom count/topology/cell across all frames,
    /// and every consumer takes the fast fixed-stride path.
    pub hetero: Option<HeteroFrames>,
    /// Embedded per-atom scalar channels (charges, selective-dynamics flags,
    /// LAMMPS dump computes, ...) the file carries but megane does not render
    /// yet. Parsed rather than silently discarded (CRITICAL RULE #11).
    pub scalar_channels: Vec<crate::trajectory::ScalarChannel>,
    /// Non-fatal parse warnings (e.g. atoms the file declares but the parser
    /// could not represent). Surfaced to the host so nothing is dropped
    /// silently; empty for a clean parse.
    pub warnings: Vec<String>,
}

impl ParsedStructure {
    /// Number of EXTRA frames stored in `frame_positions_flat` (frame 0 is in `positions`).
    pub fn extra_frame_count(&self) -> usize {
        match &self.hetero {
            // Heterogeneous: frame count is the number of atom-offset segments,
            // independent of any single atom count (positions may be jagged).
            Some(h) => h.atom_offsets.len().saturating_sub(1),
            None if self.n_atoms == 0 => 0,
            None => self.frame_positions_flat.len() / (self.n_atoms * 3),
        }
    }

    /// Flat `[x0,y0,z0,…]` slice for EXTRA frame `i` (overall frame `i + 1`).
    /// Panics if `i >= extra_frame_count()`.
    pub fn frame(&self, i: usize) -> &[f32] {
        match &self.hetero {
            Some(h) => {
                let a = h.atom_offsets[i] as usize * 3;
                let b = h.atom_offsets[i + 1] as usize * 3;
                &self.frame_positions_flat[a..b]
            }
            None => {
                let stride = self.n_atoms * 3;
                &self.frame_positions_flat[i * stride..(i + 1) * stride]
            }
        }
    }

    /// Atom count of EXTRA frame `i`. For uniform trajectories this is always
    /// `n_atoms`; for heterogeneous ones it is derived from `atom_offsets`.
    pub fn frame_atom_count(&self, i: usize) -> usize {
        match &self.hetero {
            Some(h) => (h.atom_offsets[i + 1] - h.atom_offsets[i]) as usize,
            None => self.n_atoms,
        }
    }

    /// Atomic numbers for EXTRA frame `i`, or `None` when topology is constant
    /// (the caller should reuse frame-0 `elements`).
    pub fn frame_elements(&self, i: usize) -> Option<&[u8]> {
        let h = self.hetero.as_ref()?;
        if h.elements_flat.is_empty() {
            return None;
        }
        let a = h.atom_offsets[i] as usize;
        let b = h.atom_offsets[i + 1] as usize;
        Some(&h.elements_flat[a..b])
    }

    /// Row-major 3×3 cell for EXTRA frame `i`, or `None` when the cell is
    /// constant (reuse frame-0 `box_matrix`).
    pub fn frame_cell(&self, i: usize) -> Option<&[f32]> {
        let h = self.hetero.as_ref()?;
        if h.cells_flat.is_empty() {
            return None;
        }
        Some(&h.cells_flat[i * 9..i * 9 + 9])
    }

    /// Inferred bonds `[a,b,…]` for EXTRA frame `i`, or `None` when topology is
    /// constant (reuse frame-0 `bonds`).
    pub fn frame_bonds(&self, i: usize) -> Option<&[u32]> {
        let h = self.hetero.as_ref()?;
        if h.bonds_flat.is_empty() || h.bond_offsets.is_empty() {
            return None;
        }
        let a = h.bond_offsets[i] as usize * 2;
        let b = h.bond_offsets[i + 1] as usize * 2;
        Some(&h.bonds_flat[a..b])
    }
}

/// Secondary-structure range declared by a file: a PDB HELIX/SHEET record or
/// an mmCIF `_struct_conf` / `_struct_sheet_range` row. Inclusive residue
/// range `start..=end` on chain `chain_id`.
pub(crate) struct SsRange {
    pub(crate) chain_id: u8,
    pub(crate) start: i32,
    pub(crate) end: i32,
    pub(crate) ss_type: u8, // 1 = helix, 2 = sheet
}

/// Secondary-structure type of the Cα at (`chain_id`, `res_num`): the
/// `ss_type` of the first range in file order that covers it, or 0 (coil)
/// when none does.
pub(crate) fn ss_type_at(ranges: &[SsRange], chain_id: u8, res_num: i32) -> u8 {
    ranges
        .iter()
        .find(|r| r.chain_id == chain_id && res_num >= r.start && res_num <= r.end)
        .map(|r| r.ss_type)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- HeteroFramesBuilder ----

    /// Flat coordinates for `n` atoms 0.7 Å apart along x (H-H bonded neighbours).
    fn chain(n: usize, z: f32) -> Vec<f32> {
        (0..n).flat_map(|k| [k as f32 * 0.7, 0.0, z]).collect()
    }

    #[test]
    fn builder_uniform_frames_yield_no_side_table() {
        let mut b = HeteroFramesBuilder::with_capacity(2, 2);
        for z in [0.1, 0.2] {
            b.push_frame(
                &chain(2, z),
                || unreachable!(),
                None,
                FrameChange::default(),
            );
        }
        assert_eq!(b.extra_frames(), 2);
        assert!(!b.varies_atoms() && !b.varies_topology() && !b.varies_cell());
        let (flat, hetero) = b.finish(&[1, 1], None);
        assert_eq!(flat.len(), 12);
        assert!(hetero.is_none());
    }

    #[test]
    fn builder_backfills_elements_before_first_atom_count_change() {
        let mut b = HeteroFramesBuilder::new(2);
        b.push_frame(&chain(2, 0.1), || vec![9, 9], None, FrameChange::default());
        b.push_frame(
            &chain(3, 0.2),
            || vec![1, 1, 1],
            None,
            FrameChange::default(),
        );
        assert!(b.varies_atoms());
        let (flat, hetero) = b.finish(&[1, 1], None);
        assert_eq!(flat.len(), 15);
        let h = hetero.expect("atom count varies");
        assert_eq!(h.atom_offsets, vec![0, 2, 5]);
        // Frame 0 is backfilled with frame-0 elements (its closure never ran).
        assert_eq!(h.elements_flat, vec![1, 1, 1, 1, 1]);
        // One H-H bond in the 2-atom frame, two in the 3-atom chain.
        assert_eq!(h.bond_offsets, vec![0, 1, 3]);
        assert_eq!(h.bonds_flat, vec![0, 1, 0, 1, 1, 2]);
        assert!(h.varies_atoms && h.varies_topology && !h.varies_cell);
        assert!(h.cells_flat.is_empty());
        assert_eq!(h.max_atoms, 3);
    }

    #[test]
    fn builder_eager_elements_records_every_frame() {
        let mut b = HeteroFramesBuilder::new(2).eager_elements();
        b.push_frame(&chain(2, 0.1), || vec![9, 9], None, FrameChange::default());
        b.push_frame(&chain(1, 0.2), || vec![1], None, FrameChange::default());
        let (_, hetero) = b.finish(&[1, 1], None);
        assert_eq!(hetero.unwrap().elements_flat, vec![9, 9, 1]);

        // Eager snapshots are dropped when the file turns out uniform.
        let mut b = HeteroFramesBuilder::new(1).eager_elements();
        b.push_frame(&chain(1, 0.1), || vec![9], None, FrameChange::default());
        assert!(b.finish(&[1], None).1.is_none());
    }

    #[test]
    fn builder_topology_verdict_is_sticky_and_snapshots_are_aligned() {
        let mut b = HeteroFramesBuilder::new(2);
        b.push_frame(
            &chain(2, 0.1),
            || unreachable!(),
            None,
            FrameChange::default(),
        );
        let topo = FrameChange {
            topology: true,
            cell: false,
        };
        b.push_frame(&chain(2, 0.2), || vec![8, 1], None, topo);
        // A later frame without a verdict is still recorded, and a malformed
        // snapshot is padded to the frame's atom count.
        b.push_frame(&chain(2, 0.3), || vec![8], None, FrameChange::default());
        assert!(b.varies_topology() && !b.varies_atoms());
        let h = b.finish(&[1, 1], None).1.unwrap();
        assert_eq!(h.elements_flat, vec![1, 1, 8, 1, 8, 0]);
        assert!(h.varies_topology && !h.varies_atoms);
        assert_eq!(h.bond_offsets.len(), 4);
    }

    #[test]
    fn builder_cell_only_variation_backfills_frame0_cell() {
        let base = [5.0, 0.0, 0.0, 0.0, 5.0, 0.0, 0.0, 0.0, 5.0];
        let bigger = [6.0, 0.0, 0.0, 0.0, 6.0, 0.0, 0.0, 0.0, 6.0];
        let cell = FrameChange {
            topology: false,
            cell: true,
        };
        let mut b = HeteroFramesBuilder::new(1);
        b.push_frame(&chain(1, 0.1), Vec::new, Some(base), FrameChange::default());
        b.push_frame(&chain(1, 0.2), Vec::new, Some(bigger), cell);
        // Once recording, a frame with no cell is stored as zeros.
        b.push_frame(&chain(1, 0.3), Vec::new, None, FrameChange::default());
        assert!(b.varies_cell());
        let h = b.finish(&[1], Some(base)).1.unwrap();
        let mut want = base.to_vec();
        want.extend_from_slice(&bigger);
        want.extend_from_slice(&[0.0; 9]);
        assert_eq!(h.cells_flat, want);
        assert_eq!(h.atom_offsets, vec![0, 1, 2, 3]);
        assert!(h.elements_flat.is_empty() && h.bond_offsets.is_empty());
        assert!(h.bonds_flat.is_empty());
        assert!(h.varies_cell && !h.varies_atoms && !h.varies_topology);
        assert_eq!(h.max_atoms, 1);

        // No frame-0 cell: the backfill is zeros as well.
        let mut b = HeteroFramesBuilder::new(1);
        b.push_frame(&chain(1, 0.1), Vec::new, None, FrameChange::default());
        b.push_frame(&chain(1, 0.2), Vec::new, Some(bigger), cell);
        let h = b.finish(&[1], None).1.unwrap();
        assert_eq!(&h.cells_flat[..9], &[0.0; 9]);
    }

    #[test]
    fn builder_push_frame_iter_matches_push_frame() {
        let pos = chain(3, 0.5);
        let mut a = HeteroFramesBuilder::new(2);
        a.push_frame(&pos, || vec![1, 1, 1], None, FrameChange::default());
        let mut b = HeteroFramesBuilder::new(2);
        b.push_frame_iter(
            pos.iter().copied(),
            || vec![1, 1, 1],
            None,
            FrameChange::default(),
        );
        let (fa, ha) = a.finish(&[1, 1], None);
        let (fb, hb) = b.finish(&[1, 1], None);
        assert_eq!(fa, fb);
        let (ha, hb) = (ha.unwrap(), hb.unwrap());
        assert_eq!(ha.atom_offsets, hb.atom_offsets);
        assert_eq!(ha.elements_flat, hb.elements_flat);
        assert_eq!(ha.bonds_flat, hb.bonds_flat);
    }

    // ---- SsRange / ss_type_at ----

    #[test]
    fn ss_type_at_matches_chain_and_inclusive_range() {
        let ranges = [
            SsRange {
                chain_id: b'A',
                start: 2,
                end: 4,
                ss_type: 1,
            },
            SsRange {
                chain_id: b'B',
                start: 1,
                end: 3,
                ss_type: 2,
            },
        ];
        assert_eq!(ss_type_at(&ranges, b'A', 1), 0);
        assert_eq!(ss_type_at(&ranges, b'A', 2), 1);
        assert_eq!(ss_type_at(&ranges, b'A', 4), 1);
        assert_eq!(ss_type_at(&ranges, b'A', 5), 0);
        // Same residue number on another chain follows that chain's range.
        assert_eq!(ss_type_at(&ranges, b'B', 2), 2);
        assert_eq!(ss_type_at(&ranges, b'C', 2), 0);
        assert_eq!(ss_type_at(&[], b'A', 2), 0);
    }

    #[test]
    fn ss_type_at_first_range_in_file_order_wins() {
        let ranges = [
            SsRange {
                chain_id: b'A',
                start: 1,
                end: 10,
                ss_type: 2,
            },
            SsRange {
                chain_id: b'A',
                start: 3,
                end: 5,
                ss_type: 1,
            },
        ];
        assert_eq!(ss_type_at(&ranges, b'A', 4), 2);
    }
}
