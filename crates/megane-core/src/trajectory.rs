/// A single frame of per-atom vector data (e.g. velocity or force).
pub struct VectorFrame {
    /// Index of the trajectory frame this data corresponds to.
    pub frame: usize,
    /// Flat array of per-atom vectors: [vx0,vy0,vz0, vx1,vy1,vz1, ...]
    pub vectors: Vec<f32>,
}

/// A named channel of per-atom vector data across one or more frames.
///
/// A channel with a single frame is treated as "static" — the same vectors
/// are shown for all playback frames. A channel with N frames advances in sync
/// with the trajectory.
pub struct VectorChannel {
    /// Human-readable name, e.g. "velocity" or "force".
    pub name: String,
    /// Per-frame vector data. Length 1 = static; length N = frame-synced.
    pub frames: Vec<VectorFrame>,
}

/// A single frame of per-atom scalar data (e.g. charge or a dump column).
pub struct ScalarFrame {
    /// Index of the trajectory frame this data corresponds to.
    pub frame: usize,
    /// Per-atom values: [s0, s1, ...] (one value per atom).
    pub values: Vec<f32>,
}

/// A named channel of per-atom scalar data across one or more frames.
///
/// Carries file information megane does not render yet (per-atom charges,
/// isotopes, selective-dynamics flags, LAMMPS dump computes, ...) so parsers
/// never silently discard it. Length-1 channels are static; length-N channels
/// advance in sync with the trajectory.
pub struct ScalarChannel {
    /// Name taken from the file, e.g. "charge", "mol_id", "c_pe".
    pub name: String,
    /// Per-frame values. Length 1 = static; length N = frame-synced.
    pub frames: Vec<ScalarFrame>,
}

/// Per-frame side table for a *heterogeneous* trajectory — one whose frames
/// vary in unit cell (all trajectory formats) or atom count / element type
/// (LAMMPS dump only). `None` on [`TrajectoryData`] means uniform (the common
/// case): a fixed atom count and a single `box_matrix` for the whole run, and
/// nothing here is allocated.
///
/// Unlike [`crate::parser::HeteroFrames`] (structure lane), the trajectory lane
/// keeps frame 0 *inside* `frame_positions_flat`, so every index here addresses
/// ALL frames (`atom_offsets` has length `n_frames + 1`). Each channel is
/// independently optional. Bonds are deliberately omitted — topology comes from
/// the separately-loaded structure and the renderer re-infers per frame from
/// positions + elements.
pub struct TrajHetero {
    /// Prefix-sum of atom counts over ALL frames, in atoms. Length
    /// `n_frames + 1`. Empty when the atom count is fixed (positions stay
    /// fixed-stride and are sliced by `n_atoms`).
    pub atom_offsets: Vec<u32>,
    /// Concatenated per-frame element/type ids, sliced by `atom_offsets`. Empty
    /// when topology is constant (host reuses the merged structure's elements).
    pub elements_flat: Vec<u8>,
    /// Per-frame row-major 3×3 cell, 9 floats each; length `n_frames * 9`. Empty
    /// when the cell is constant (host reuses `box_matrix`).
    pub cells_flat: Vec<f32>,
    /// Atom count changes between frames (LAMMPS dump only).
    pub varies_atoms: bool,
    /// Unit cell changes between frames.
    pub varies_cell: bool,
    /// Element/type identities change between frames (LAMMPS dump only).
    pub varies_topology: bool,
    /// Maximum atom count across ALL frames. Drives one-time GPU buffer sizing.
    pub max_atoms: u32,
}

/// Build a cell-only [`TrajHetero`] from per-frame cells collected by a
/// fixed-atom trajectory parser (XTC / DCD / NetCDF). Returns `None` when the
/// cell is constant, so the uniform fast path is unchanged. Atom count / element
/// channels stay empty — these formats never vary those.
pub fn build_cell_hetero(
    varies_cell: bool,
    per_frame_cells: Vec<[f32; 9]>,
    n_atoms: usize,
) -> Option<TrajHetero> {
    if !varies_cell {
        return None;
    }
    let mut cells_flat = Vec::with_capacity(per_frame_cells.len() * 9);
    for c in &per_frame_cells {
        cells_flat.extend_from_slice(c);
    }
    Some(TrajHetero {
        atom_offsets: Vec::new(),
        elements_flat: Vec::new(),
        cells_flat,
        varies_atoms: false,
        varies_cell: true,
        varies_topology: false,
        max_atoms: n_atoms as u32,
    })
}

pub struct TrajectoryData {
    pub n_atoms: usize,
    pub n_frames: usize,
    pub timestep_ps: f32,
    pub box_matrix: Option<[f32; 9]>,
    /// World-space lower corner of the simulation box (see
    /// [`crate::parser::ParsedStructure::box_origin`]). `None` ⇒ origin at
    /// `(0,0,0)`. Set only by formats that store an explicit box origin
    /// (LAMMPS dump); constant across frames (frame-0 origin).
    pub box_origin: Option<[f32; 3]>,
    /// Frame-major flat coordinates for ALL frames:
    /// `[frame0: x0,y0,z0,x1,…][frame1: …]…`. Length == `n_frames * n_atoms * 3`
    /// (or, when `hetero` carries `atom_offsets`, jagged and sliced by them).
    ///
    /// A single contiguous allocation (instead of one `Vec` per frame) so the
    /// WASM/PyO3 boundary can hand the whole trajectory to the host without a
    /// flatten copy or a 2× memory peak.
    pub frame_positions_flat: Vec<f32>,
    /// Embedded vector channels parsed from the trajectory file.
    /// Empty when the format carries no per-atom vector quantities.
    pub vector_channels: Vec<VectorChannel>,
    /// Per-frame side table for heterogeneous trajectories. `None` (the common
    /// case) means uniform: fixed atom count + single cell, fast fixed-stride
    /// path everywhere.
    pub hetero: Option<TrajHetero>,
}

impl TrajectoryData {
    /// Flat `[x0,y0,z0,…]` slice for frame `i`. Panics if `i >= n_frames`.
    pub fn frame(&self, i: usize) -> &[f32] {
        match &self.hetero {
            Some(h) if !h.atom_offsets.is_empty() => {
                let a = h.atom_offsets[i] as usize * 3;
                let b = h.atom_offsets[i + 1] as usize * 3;
                &self.frame_positions_flat[a..b]
            }
            _ => {
                let stride = self.n_atoms * 3;
                &self.frame_positions_flat[i * stride..(i + 1) * stride]
            }
        }
    }

    /// Atom count of frame `i` (constant `n_atoms` unless `hetero` varies atoms).
    pub fn frame_atom_count(&self, i: usize) -> usize {
        match &self.hetero {
            Some(h) if !h.atom_offsets.is_empty() => {
                (h.atom_offsets[i + 1] - h.atom_offsets[i]) as usize
            }
            _ => self.n_atoms,
        }
    }

    /// Row-major 3×3 cell for frame `i`, or `None` when the cell is constant
    /// (reuse `box_matrix`).
    pub fn frame_cell(&self, i: usize) -> Option<&[f32]> {
        let h = self.hetero.as_ref()?;
        if h.cells_flat.is_empty() {
            return None;
        }
        Some(&h.cells_flat[i * 9..i * 9 + 9])
    }

    /// Element/type ids for frame `i`, or `None` when topology is constant
    /// (reuse the merged structure's elements).
    pub fn frame_elements(&self, i: usize) -> Option<&[u8]> {
        let h = self.hetero.as_ref()?;
        if h.elements_flat.is_empty() || h.atom_offsets.is_empty() {
            return None;
        }
        let a = h.atom_offsets[i] as usize;
        let b = h.atom_offsets[i + 1] as usize;
        Some(&h.elements_flat[a..b])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_frame_slicing() {
        // 2 frames, 2 atoms (stride 6): frame 1 starts at flat index 6.
        let traj = TrajectoryData {
            n_atoms: 2,
            n_frames: 2,
            timestep_ps: 1.0,
            box_matrix: None,
            box_origin: None,
            frame_positions_flat: vec![
                0.0, 1.0, 2.0, 3.0, 4.0, 5.0, // frame 0
                6.0, 7.0, 8.0, 9.0, 10.0, 11.0, // frame 1
            ],
            vector_channels: vec![],
            hetero: None,
        };
        assert_eq!(traj.frame(0), &[0.0, 1.0, 2.0, 3.0, 4.0, 5.0]);
        assert_eq!(traj.frame(1), &[6.0, 7.0, 8.0, 9.0, 10.0, 11.0]);
        // Uniform trajectory: accessors fall back to the fixed-stride path.
        assert_eq!(traj.frame_atom_count(1), 2);
        assert!(traj.frame_cell(0).is_none());
        assert!(traj.frame_elements(0).is_none());
    }

    #[test]
    fn build_cell_hetero_constant_is_none() {
        assert!(build_cell_hetero(false, vec![], 4).is_none());
    }

    #[test]
    fn build_cell_hetero_populates_cells() {
        let cells = vec![[1.0; 9], [2.0; 9]];
        let h = build_cell_hetero(true, cells, 4).expect("cell side table");
        assert!(h.varies_cell);
        assert!(!h.varies_atoms);
        assert_eq!(h.max_atoms, 4);
        assert!(h.atom_offsets.is_empty()); // fixed atom count
        assert_eq!(h.cells_flat.len(), 18);
        assert_eq!(&h.cells_flat[9..18], &[2.0; 9]);
    }

    #[test]
    fn jagged_frame_accessors() {
        // A variable-atom trajectory: frame 0 has 2 atoms, frame 1 has 1.
        let traj = TrajectoryData {
            n_atoms: 2,
            n_frames: 2,
            timestep_ps: 1.0,
            box_matrix: None,
            box_origin: None,
            frame_positions_flat: vec![0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0],
            vector_channels: vec![],
            hetero: Some(TrajHetero {
                atom_offsets: vec![0, 2, 3],
                elements_flat: vec![1, 8, 6],
                cells_flat: vec![],
                varies_atoms: true,
                varies_cell: false,
                varies_topology: true,
                max_atoms: 2,
            }),
        };
        assert_eq!(traj.frame_atom_count(0), 2);
        assert_eq!(traj.frame_atom_count(1), 1);
        assert_eq!(traj.frame(1), &[6.0, 7.0, 8.0]);
        assert_eq!(traj.frame_elements(1).unwrap(), &[6]);
    }
}
