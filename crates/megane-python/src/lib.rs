use megane_core::parser::ParsedStructure;
use numpy::ndarray::{Array1, Array2};
use numpy::{IntoPyArray, PyArray1, PyArray2, PyReadonlyArray1, PyReadonlyArray2};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;

#[pyclass]
struct PyStructure {
    #[pyo3(get)]
    n_atoms: usize,
    #[pyo3(get)]
    n_frames: usize,
    #[pyo3(get)]
    positions: Py<PyArray2<f32>>,
    #[pyo3(get)]
    elements: Py<PyArray1<u8>>,
    #[pyo3(get)]
    bonds: Py<PyArray2<u32>>,
    #[pyo3(get)]
    bond_orders: Py<PyArray1<u8>>,
    #[pyo3(get)]
    box_matrix: Py<PyArray2<f32>>,
    /// World-space lower corner (xlo,ylo,zlo) the box is anchored at, shape
    /// `(3,)`. `(0,0,0)` when the format carries no explicit origin. Atom
    /// coordinates stay absolute; this only positions the rendered cell.
    #[pyo3(get)]
    box_origin: Py<PyArray1<f32>>,
    /// Extra-frame positions reshaped to `(n_frames, n_atoms*3)`. Populated only
    /// for *uniform* trajectories; empty when `heterogeneous` (use the flat
    /// arrays below, which can represent jagged frames).
    #[pyo3(get)]
    frame_positions: Py<PyArray2<f32>>,
    /// Crystallographic symmetry operations as a list of `x,y,z` strings.
    /// Empty for formats that carry no space-group information.
    #[pyo3(get)]
    symmetry_ops: Vec<String>,
    /// True when frames differ in atom count, cell, or elements. When false the
    /// consumer uses the rectangular `frame_positions` fast path.
    #[pyo3(get)]
    heterogeneous: bool,
    /// Maximum atom count across all frames.
    #[pyo3(get)]
    max_atoms: usize,
    /// Flat extra-frame positions `[x,y,z,…]` (jagged), sliced by
    /// `frame_atom_offsets`. Empty for uniform trajectories.
    #[pyo3(get)]
    frame_positions_flat: Py<PyArray1<f32>>,
    /// Prefix-sum atom offsets over extra frames (length `n_frames+1`).
    #[pyo3(get)]
    frame_atom_offsets: Py<PyArray1<u32>>,
    /// Concatenated per-extra-frame atomic numbers. Empty when topology is
    /// constant (reuse `elements`).
    #[pyo3(get)]
    frame_elements: Py<PyArray1<u8>>,
    /// Per-extra-frame cells, flat (9 floats each; reshape to `(-1,3,3)`).
    /// Empty when the cell is constant (reuse `box_matrix`).
    #[pyo3(get)]
    frame_cells: Py<PyArray1<f32>>,
    /// Prefix-sum bond offsets (in pairs) over extra frames. Empty when
    /// topology is constant.
    #[pyo3(get)]
    frame_bond_offsets: Py<PyArray1<u32>>,
    /// Concatenated per-extra-frame bonds `[a,b,…]`. Empty when topology is
    /// constant.
    #[pyo3(get)]
    frame_bonds: Py<PyArray1<u32>>,
    /// Embedded per-atom scalar channels the file carries (charges,
    /// selective-dynamics flags, dump computes, …) as
    /// `[(name, [frame0_values, …]), …]`. A single-frame channel is static.
    #[pyo3(get)]
    scalar_channels: Vec<(String, Vec<Py<PyArray1<f32>>>)>,
    /// Non-fatal parse warnings (e.g. atoms the file declares but the parser
    /// could not represent). Empty for a clean parse.
    #[pyo3(get)]
    warnings: Vec<String>,
}

impl PyStructure {
    fn from_parsed(py: Python<'_>, data: ParsedStructure) -> PyResult<Self> {
        let n = data.n_atoms;
        let n_bonds = data.bonds.len();

        let pos_array = Array2::from_shape_vec((n, 3), data.positions).map_err(|e| {
            PyValueError::new_err(format!("failed to reshape positions into ({n}, 3): {e}"))
        })?;

        let elem_array = Array1::from_vec(data.elements);

        let bonds_flat: Vec<u32> = data.bonds.iter().flat_map(|(a, b)| [*a, *b]).collect();
        let bond_array = if n_bonds > 0 {
            Array2::from_shape_vec((n_bonds, 2), bonds_flat).map_err(|e| {
                PyValueError::new_err(format!("failed to reshape bonds into ({n_bonds}, 2): {e}"))
            })?
        } else {
            Array2::from_shape_vec((0, 2), vec![]).map_err(|e| {
                PyValueError::new_err(format!("failed to create empty bonds array: {e}"))
            })?
        };

        let bo_vec = data.bond_orders.unwrap_or_else(|| vec![1u8; n_bonds]);
        let bo_array = Array1::from_vec(bo_vec);

        let box_vec = match data.box_matrix {
            Some(m) => m.to_vec(),
            None => vec![0.0f32; 9],
        };
        let box_array = Array2::from_shape_vec((3, 3), box_vec).map_err(|e| {
            PyValueError::new_err(format!("failed to reshape box_matrix into (3, 3): {e}"))
        })?;

        let origin_vec = data
            .box_origin
            .map(|o| o.to_vec())
            .unwrap_or_else(|| vec![0.0f32; 3]);
        let box_origin_array = Array1::from_vec(origin_vec);

        // Frame positions for multi-frame formats (e.g. .traj). Core already stores
        // the extra frames as one contiguous buffer. For *uniform* trajectories it
        // reshapes directly to (n_frames, n_atoms*3) — the existing fast path. For
        // *heterogeneous* ones the frames are jagged and cannot be rectangular, so
        // `frame_positions` is left empty and the flat + offsets arrays are used.
        let hetero = data.hetero;
        let heterogeneous = hetero.is_some();
        let max_atoms = hetero.as_ref().map(|h| h.max_atoms as usize).unwrap_or(n);
        let stride = n * 3;
        let frame_flat = data.frame_positions_flat;

        let (n_frames, frame_array, frame_flat_arr) = if let Some(h) = &hetero {
            let n_frames = h.atom_offsets.len().saturating_sub(1);
            // Rectangular reshape is impossible; expose the raw flat buffer instead.
            let empty = Array2::<f32>::from_shape_vec((0, 0), vec![]).map_err(|e| {
                PyValueError::new_err(format!("failed to create empty frame array: {e}"))
            })?;
            (n_frames, empty, Array1::from_vec(frame_flat))
        } else {
            let n_frames = frame_flat.len().checked_div(stride).unwrap_or(0);
            let frame_array =
                Array2::from_shape_vec((n_frames, stride), frame_flat).map_err(|e| {
                    PyValueError::new_err(format!(
                        "failed to reshape frame_positions into ({n_frames}, {stride}): {e}"
                    ))
                })?;
            (n_frames, frame_array, Array1::<f32>::from_vec(vec![]))
        };

        let (frame_atom_offsets, frame_elements, frame_cells, frame_bond_offsets, frame_bonds) =
            match hetero {
                Some(h) => (
                    Array1::from_vec(h.atom_offsets),
                    Array1::from_vec(h.elements_flat),
                    Array1::from_vec(h.cells_flat),
                    Array1::from_vec(h.bond_offsets),
                    Array1::from_vec(h.bonds_flat),
                ),
                None => (
                    Array1::<u32>::from_vec(vec![]),
                    Array1::<u8>::from_vec(vec![]),
                    Array1::<f32>::from_vec(vec![]),
                    Array1::<u32>::from_vec(vec![]),
                    Array1::<u32>::from_vec(vec![]),
                ),
            };

        let scalar_channels: Vec<(String, Vec<Py<PyArray1<f32>>>)> = data
            .scalar_channels
            .into_iter()
            .map(|ch| {
                let frames: Vec<Py<PyArray1<f32>>> = ch
                    .frames
                    .into_iter()
                    .map(|f| Array1::from_vec(f.values).into_pyarray(py).into())
                    .collect();
                (ch.name, frames)
            })
            .collect();

        Ok(Self {
            n_atoms: n,
            n_frames,
            positions: pos_array.into_pyarray(py).into(),
            elements: elem_array.into_pyarray(py).into(),
            bonds: bond_array.into_pyarray(py).into(),
            bond_orders: bo_array.into_pyarray(py).into(),
            box_matrix: box_array.into_pyarray(py).into(),
            box_origin: box_origin_array.into_pyarray(py).into(),
            frame_positions: frame_array.into_pyarray(py).into(),
            symmetry_ops: data.symmetry_ops,
            heterogeneous,
            max_atoms,
            frame_positions_flat: frame_flat_arr.into_pyarray(py).into(),
            frame_atom_offsets: frame_atom_offsets.into_pyarray(py).into(),
            frame_elements: frame_elements.into_pyarray(py).into(),
            frame_cells: frame_cells.into_pyarray(py).into(),
            frame_bond_offsets: frame_bond_offsets.into_pyarray(py).into(),
            frame_bonds: frame_bonds.into_pyarray(py).into(),
            scalar_channels,
            warnings: data.warnings,
        })
    }
}

/// Parse a PDB file text and return structured data.
#[pyfunction]
fn parse_pdb(py: Python<'_>, text: &str) -> PyResult<PyStructure> {
    let data = megane_core::parser::parse(text).map_err(PyValueError::new_err)?;
    PyStructure::from_parsed(py, data)
}

/// Parse a GRO file text and return structured data.
#[pyfunction]
fn parse_gro(py: Python<'_>, text: &str) -> PyResult<PyStructure> {
    let data = megane_core::gro::parse(text).map_err(PyValueError::new_err)?;
    PyStructure::from_parsed(py, data)
}

/// Parse an XYZ file text and return structured data.
#[pyfunction]
fn parse_xyz(py: Python<'_>, text: &str) -> PyResult<PyStructure> {
    let data = megane_core::xyz::parse(text).map_err(PyValueError::new_err)?;
    PyStructure::from_parsed(py, data)
}

/// Parse an XCrySDen structure file (`.xsf` / `.axsf`) and return structured
/// data. An `ANIMSTEPS` animation yields a multi-frame structure.
#[pyfunction]
fn parse_xsf(py: Python<'_>, text: &str) -> PyResult<PyStructure> {
    let data = megane_core::xsf::parse(text).map_err(PyValueError::new_err)?;
    PyStructure::from_parsed(py, data)
}

/// Parse a Chemical Markup Language (`.cml`) document and return structured data.
#[pyfunction]
fn parse_cml(py: Python<'_>, text: &str) -> PyResult<PyStructure> {
    let data = megane_core::cml::parse(text).map_err(PyValueError::new_err)?;
    PyStructure::from_parsed(py, data)
}

/// Parse a VASP POSCAR / CONTCAR / XDATCAR (also `.vasp`) text and return
/// structured data. An XDATCAR yields a multi-frame structure.
#[pyfunction]
fn parse_vasp(py: Python<'_>, text: &str) -> PyResult<PyStructure> {
    let data = megane_core::vasp::parse(text).map_err(PyValueError::new_err)?;
    PyStructure::from_parsed(py, data)
}

/// A decoded JCAMP-DX spectrum. Deliberately not a `PyStructure` -- a spectrum
/// has no coordinates, so nothing about atoms, bonds, or a cell applies.
#[pyclass]
struct PySpectrum {
    #[pyo3(get)]
    title: String,
    #[pyo3(get)]
    data_type: String,
    #[pyo3(get)]
    x_units: String,
    #[pyo3(get)]
    y_units: String,
    #[pyo3(get)]
    x: Py<PyArray1<f64>>,
    #[pyo3(get)]
    y: Py<PyArray1<f64>>,
    /// Non-fatal parse warnings (empty for a clean parse).
    #[pyo3(get)]
    warnings: Vec<String>,
}

/// Parse a JCAMP-DX spectrum (`.jdx` / `.jcamp`) into its decoded
/// abscissa/ordinate arrays.
#[pyfunction]
fn parse_jcampdx(py: Python<'_>, text: &str) -> PyResult<PySpectrum> {
    let s = megane_core::jcampdx::parse(text).map_err(PyValueError::new_err)?;
    Ok(PySpectrum {
        title: s.title,
        data_type: s.data_type,
        x_units: s.x_units,
        y_units: s.y_units,
        x: Array1::from(s.x).into_pyarray(py).unbind(),
        y: Array1::from(s.y).into_pyarray(py).unbind(),
        warnings: s.warnings,
    })
}

/// Parse a Molden file (`.molden`) and return structured data. A `[GEOMETRIES] XYZ` block yields a multi-frame structure.
#[pyfunction]
fn parse_molden(py: Python<'_>, text: &str) -> PyResult<PyStructure> {
    let data = megane_core::molden::parse(text).map_err(PyValueError::new_err)?;
    PyStructure::from_parsed(py, data)
}

/// Parse a Chem3D XML (`.c3xml`) document and return structured data.
#[pyfunction]
fn parse_c3xml(py: Python<'_>, text: &str) -> PyResult<PyStructure> {
    let data = megane_core::c3xml::parse(text).map_err(PyValueError::new_err)?;
    PyStructure::from_parsed(py, data)
}
/// Parse a Wavefunction Odyssey (`.xodydata` / `.odydata`) file and return structured data. The XML and text flavours are detected from the content.
#[pyfunction]
fn parse_odydata(py: Python<'_>, text: &str) -> PyResult<PyStructure> {
    let data = megane_core::odydata::parse(text).map_err(PyValueError::new_err)?;
    PyStructure::from_parsed(py, data)
}
/// Parse a CASTEP / Quantum ESPRESSO NMR `.magres` file and return structured data from its `[atoms]` block.
#[pyfunction]
fn parse_magres(py: Python<'_>, text: &str) -> PyResult<PyStructure> {
    let data = megane_core::magres::parse(text).map_err(PyValueError::new_err)?;
    PyStructure::from_parsed(py, data)
}
/// Parse a GAMESS (US / Firefly) output file and return structured data. Each `COORDINATES OF ALL ATOMS ARE` block becomes a frame.
#[pyfunction]
fn parse_gamess(py: Python<'_>, text: &str) -> PyResult<PyStructure> {
    let data = megane_core::gamess::parse(text).map_err(PyValueError::new_err)?;
    PyStructure::from_parsed(py, data)
}
/// Parse a CASTEP `.phonon` lattice-dynamics file and return the periodic structure from its header.
#[pyfunction]
fn parse_phonon(py: Python<'_>, text: &str) -> PyResult<PyStructure> {
    let data = megane_core::phonon::parse(text).map_err(PyValueError::new_err)?;
    PyStructure::from_parsed(py, data)
}

/// Parse an MDL Molfile (V2000) text and return structured data.
#[pyfunction]
fn parse_mol(py: Python<'_>, text: &str) -> PyResult<PyStructure> {
    let data = megane_core::mol::parse(text).map_err(PyValueError::new_err)?;
    PyStructure::from_parsed(py, data)
}

/// Parse a Tripos MOL2 file text and return structured data.
#[pyfunction]
fn parse_mol2(py: Python<'_>, text: &str) -> PyResult<PyStructure> {
    let data = megane_core::mol2::parse(text).map_err(PyValueError::new_err)?;
    PyStructure::from_parsed(py, data)
}

/// Parse a LAMMPS data file text and return structured data.
#[pyfunction]
fn parse_lammps_data(py: Python<'_>, text: &str) -> PyResult<PyStructure> {
    let data = megane_core::lammps_data::parse(text).map_err(PyValueError::new_err)?;
    PyStructure::from_parsed(py, data)
}

/// Parse a CIF file text and return structured data.
///
/// Auto-detects mmCIF (PDBx/macromolecular) vs small-molecule CIF.
#[pyfunction]
fn parse_cif(py: Python<'_>, text: &str) -> PyResult<PyStructure> {
    let data = if megane_core::mmcif::is_mmcif(text) {
        megane_core::mmcif::parse(text)
    } else {
        megane_core::cif::parse(text)
    }
    .map_err(PyValueError::new_err)?;
    PyStructure::from_parsed(py, data)
}

/// Parse an mmCIF (PDBx) file text and return structured data.
#[pyfunction]
fn parse_mmcif(py: Python<'_>, text: &str) -> PyResult<PyStructure> {
    let data = megane_core::mmcif::parse(text).map_err(PyValueError::new_err)?;
    PyStructure::from_parsed(py, data)
}

/// Parse an AMBER prmtop topology file (positions at origin, no inpcrd).
#[pyfunction]
fn parse_prmtop(py: Python<'_>, text: &str) -> PyResult<PyStructure> {
    let data = megane_core::amber::parse_prmtop(text).map_err(PyValueError::new_err)?;
    PyStructure::from_parsed(py, data)
}

/// Parse AMBER prmtop topology and inpcrd/rst7 coordinates together.
#[pyfunction]
fn parse_amber(py: Python<'_>, prmtop: &str, inpcrd: &str) -> PyResult<PyStructure> {
    let data = megane_core::amber::parse(prmtop, inpcrd).map_err(PyValueError::new_err)?;
    PyStructure::from_parsed(py, data)
}

/// Parse an XTC trajectory binary and return frame data.
#[pyfunction]
fn parse_xtc(py: Python<'_>, data: &[u8]) -> PyResult<PyTrajectoryData> {
    let traj = megane_core::xtc::parse_xtc(data).map_err(PyValueError::new_err)?;
    py_trajectory_from_data(py, traj)
}

/// Parse an ASE .traj file (binary) and return structured data.
#[pyfunction]
fn parse_traj(py: Python<'_>, data: &[u8]) -> PyResult<PyStructure> {
    let parsed = megane_core::traj::parse_traj(data).map_err(PyValueError::new_err)?;
    PyStructure::from_parsed(py, parsed)
}

/// Parsed trajectory data exposed to Python (shared by XTC / DCD / LAMMPS dump /
/// NetCDF). Uniform trajectories use the rectangular `frame_positions` fast path;
/// heterogeneous ones (variable cell for all formats, variable atom count / type
/// for LAMMPS dump) leave `frame_positions` empty and fill the flat side-table
/// arrays instead — mirrors `PyStructure`.
#[pyclass]
struct PyTrajectoryData {
    #[pyo3(get)]
    n_atoms: usize,
    #[pyo3(get)]
    n_frames: usize,
    #[pyo3(get)]
    timestep_ps: f32,
    #[pyo3(get)]
    box_matrix: Py<PyArray2<f32>>,
    /// Rectangular `(n_frames, n_atoms*3)` positions — populated only when the
    /// trajectory is uniform (empty otherwise).
    #[pyo3(get)]
    frame_positions: Py<PyArray2<f32>>,
    #[pyo3(get)]
    heterogeneous: bool,
    #[pyo3(get)]
    varies_atoms: bool,
    #[pyo3(get)]
    varies_cell: bool,
    #[pyo3(get)]
    varies_topology: bool,
    #[pyo3(get)]
    max_atoms: usize,
    /// Flat jagged positions (heterogeneous only), sliced by `frame_atom_offsets`.
    #[pyo3(get)]
    frame_positions_flat: Py<PyArray1<f32>>,
    /// Prefix-sum of per-frame atom counts, length `n_frames+1` (empty when the
    /// atom count is fixed).
    #[pyo3(get)]
    frame_atom_offsets: Py<PyArray1<u32>>,
    /// Concatenated per-frame element/type ids (empty when topology is constant).
    #[pyo3(get)]
    frame_elements: Py<PyArray1<u8>>,
    /// Per-frame row-major 3×3 cells (empty when the cell is constant).
    #[pyo3(get)]
    frame_cells: Py<PyArray1<f32>>,
}

/// Build a `PyTrajectoryData` from a core `TrajectoryData`, taking the uniform
/// rectangular fast path or the jagged hetero path. Shared by every trajectory
/// `parse_*` so the uniform boundary transfer is unchanged.
fn py_trajectory_from_data(
    py: Python<'_>,
    traj: megane_core::trajectory::TrajectoryData,
) -> PyResult<PyTrajectoryData> {
    let box_vec = match traj.box_matrix {
        Some(m) => m.to_vec(),
        None => vec![0.0f32; 9],
    };
    let box_array = Array2::from_shape_vec((3, 3), box_vec).map_err(|e| {
        PyValueError::new_err(format!("failed to reshape box_matrix into (3, 3): {e}"))
    })?;

    let empty_f32 = || Array1::<f32>::from_vec(Vec::new()).into_pyarray(py).into();
    let empty_u32 = || Array1::<u32>::from_vec(Vec::new()).into_pyarray(py).into();
    let empty_u8 = || Array1::<u8>::from_vec(Vec::new()).into_pyarray(py).into();

    if let Some(h) = traj.hetero {
        // Heterogeneous: flat jagged positions + side-table arrays; the
        // rectangular `frame_positions` stays empty.
        let frame_positions = Array2::<f32>::zeros((0, 0)).into_pyarray(py).into();
        return Ok(PyTrajectoryData {
            n_atoms: traj.n_atoms,
            n_frames: traj.n_frames,
            timestep_ps: traj.timestep_ps,
            box_matrix: box_array.into_pyarray(py).into(),
            frame_positions,
            heterogeneous: true,
            varies_atoms: h.varies_atoms,
            varies_cell: h.varies_cell,
            varies_topology: h.varies_topology,
            max_atoms: h.max_atoms as usize,
            frame_positions_flat: Array1::from_vec(traj.frame_positions_flat)
                .into_pyarray(py)
                .into(),
            frame_atom_offsets: Array1::from_vec(h.atom_offsets).into_pyarray(py).into(),
            frame_elements: Array1::from_vec(h.elements_flat).into_pyarray(py).into(),
            frame_cells: Array1::from_vec(h.cells_flat).into_pyarray(py).into(),
        });
    }

    // Uniform fast path: rectangular reshape without a flatten copy.
    let stride = traj.n_atoms * 3;
    let expected_len = traj.n_frames * stride;
    if traj.frame_positions_flat.len() != expected_len {
        return Err(PyValueError::new_err(format!(
            "frame_positions has length {}, but expected {expected_len} (n_frames * n_atoms * 3)",
            traj.frame_positions_flat.len(),
        )));
    }
    let frame_array = Array2::from_shape_vec((traj.n_frames, stride), traj.frame_positions_flat)
        .map_err(|e| {
            PyValueError::new_err(format!(
                "failed to reshape frame_positions into ({}, {stride}): {e}",
                traj.n_frames,
            ))
        })?;

    Ok(PyTrajectoryData {
        n_atoms: traj.n_atoms,
        n_frames: traj.n_frames,
        timestep_ps: traj.timestep_ps,
        box_matrix: box_array.into_pyarray(py).into(),
        frame_positions: frame_array.into_pyarray(py).into(),
        heterogeneous: false,
        varies_atoms: false,
        varies_cell: false,
        varies_topology: false,
        max_atoms: traj.n_atoms,
        frame_positions_flat: empty_f32(),
        frame_atom_offsets: empty_u32(),
        frame_elements: empty_u8(),
        frame_cells: empty_f32(),
    })
}

/// Parse a DCD trajectory binary (CHARMM/NAMD/X-PLOR) and return frame data.
#[pyfunction]
fn parse_dcd(py: Python<'_>, data: &[u8]) -> PyResult<PyTrajectoryData> {
    let traj = megane_core::dcd::parse_dcd(data).map_err(PyValueError::new_err)?;
    py_trajectory_from_data(py, traj)
}

/// Parse a LAMMPS dump trajectory text and return frame data.
#[pyfunction]
fn parse_lammpstrj(py: Python<'_>, text: &str) -> PyResult<PyTrajectoryData> {
    let data = megane_core::lammpstrj::parse_lammpstrj(text).map_err(PyValueError::new_err)?;
    py_trajectory_from_data(py, data)
}

/// Parse a LAMMPS dump as a standalone multi-frame structure (frame-0 topology
/// + extra frames). Element identities are the integer LAMMPS `type` ids used
/// as an atomic-number proxy; bonds are inferred from frame 0.
#[pyfunction]
fn parse_lammpstrj_structure(py: Python<'_>, text: &str) -> PyResult<PyStructure> {
    let parsed =
        megane_core::lammpstrj::parse_lammpstrj_structure(text).map_err(PyValueError::new_err)?;
    PyStructure::from_parsed(py, parsed)
}

/// Parse an AMBER NetCDF trajectory binary and return frame data.
#[pyfunction]
fn parse_netcdf(py: Python<'_>, data: &[u8]) -> PyResult<PyTrajectoryData> {
    let traj = megane_core::netcdf::parse_netcdf(data).map_err(PyValueError::new_err)?;
    py_trajectory_from_data(py, traj)
}

/// Parse a GROMACS `.top` topology file at `path` and return bond pairs,
/// resolving `#include` directives from the filesystem (relative to the
/// file's directory, then as absolute paths). Missing includes are skipped;
/// a circular include chain raises `ValueError` naming the chain.
///
/// Returns an (n_bonds, 2) uint32 array of 0-indexed atom index pairs.
#[pyfunction]
fn parse_top_bonds_from_path(py: Python<'_>, path: &str) -> PyResult<Py<PyArray2<u32>>> {
    let bonds =
        megane_core::top::parse_top_bonds_from_path(path, usize::MAX).map_err(PyValueError::new_err)?;
    let n = bonds.len();
    let flat: Vec<u32> = bonds.iter().flat_map(|(a, b)| [*a, *b]).collect();
    let arr = if n > 0 {
        Array2::from_shape_vec((n, 2), flat).map_err(|e| {
            PyValueError::new_err(format!("failed to reshape bonds into ({n}, 2): {e}"))
        })?
    } else {
        Array2::from_shape_vec((0, 2), vec![]).map_err(|e| {
            PyValueError::new_err(format!("failed to create empty bonds array: {e}"))
        })?
    };
    Ok(arr.into_pyarray(py).unbind())
}

/// The default AddBond source for a structure filename: `"structure"` for
/// formats that embed bonds, `"distance"` (VDW inference) otherwise.
/// Shared with the webapp so every host opens the same file with the same
/// bonds (see `megane_core::bonds::default_bond_source`).
#[pyfunction]
fn default_bond_source(filename: &str) -> &'static str {
    megane_core::bonds::default_bond_source(filename)
}

/// Parse a CHARMM/NAMD PSF topology file and return bond pairs.
///
/// Returns an (n_bonds, 2) uint32 array of 0-indexed atom index pairs.
/// PSF files carry no coordinate data; positions are not returned.
#[pyfunction]
fn parse_psf_bonds(py: Python<'_>, text: &str) -> PyResult<Py<PyArray2<u32>>> {
    let bonds = megane_core::psf::parse_psf_bonds(text, usize::MAX);
    let n = bonds.len();
    let flat: Vec<u32> = bonds.iter().flat_map(|(a, b)| [*a, *b]).collect();
    let arr = if n > 0 {
        Array2::from_shape_vec((n, 2), flat).map_err(|e| {
            PyValueError::new_err(format!("failed to reshape bonds into ({n}, 2): {e}"))
        })?
    } else {
        Array2::from_shape_vec((0, 2), vec![]).map_err(|e| {
            PyValueError::new_err(format!("failed to create empty bonds array: {e}"))
        })?
    };
    Ok(arr.into_pyarray(py).into())
}

/// Infer bonds from interatomic distances using VDW radii.
///
/// Returns an (n_bonds, 2) uint32 array of atom index pairs.  Mirrors the
/// per-frame inference the frontend performs when `bondSource == "distance"`.
#[pyfunction]
fn infer_bonds_vdw(
    py: Python<'_>,
    elements: PyReadonlyArray1<u8>,
    positions: PyReadonlyArray2<f32>,
) -> PyResult<Py<PyArray2<u32>>> {
    let elements_view = elements.as_array();
    let positions_view = positions.as_array();

    let n_atoms = elements_view.len();
    let shape = positions_view.shape();
    if shape.len() != 2 || shape[0] != n_atoms || shape[1] != 3 {
        return Err(PyValueError::new_err(format!(
            "positions shape {:?} does not match (n_atoms={}, 3)",
            shape, n_atoms
        )));
    }

    let elements_vec: Vec<u8> = elements_view.iter().copied().collect();
    let positions_vec: Vec<f32> = positions_view.iter().copied().collect();

    let bonds = megane_core::bonds::infer_bonds_vdw(&positions_vec, &elements_vec, n_atoms);

    let n_bonds = bonds.len();
    let mut flat: Vec<u32> = Vec::with_capacity(n_bonds * 2);
    for (a, b) in &bonds {
        flat.push(*a);
        flat.push(*b);
    }
    let arr = Array2::from_shape_vec((n_bonds, 2), flat).map_err(|e| {
        PyValueError::new_err(format!("failed to reshape bonds into (n_bonds, 2): {e}"))
    })?;
    Ok(arr.into_pyarray(py).into())
}

#[pymodule]
fn megane_parser(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(parse_pdb, m)?)?;
    m.add_function(wrap_pyfunction!(parse_gro, m)?)?;
    m.add_function(wrap_pyfunction!(parse_xyz, m)?)?;
    m.add_function(wrap_pyfunction!(parse_xsf, m)?)?;
    m.add_function(wrap_pyfunction!(parse_cml, m)?)?;
    m.add_function(wrap_pyfunction!(parse_vasp, m)?)?;
    m.add_function(wrap_pyfunction!(parse_molden, m)?)?;
    m.add_function(wrap_pyfunction!(parse_jcampdx, m)?)?;
    m.add_function(wrap_pyfunction!(parse_c3xml, m)?)?;
    m.add_function(wrap_pyfunction!(parse_odydata, m)?)?;
    m.add_function(wrap_pyfunction!(parse_magres, m)?)?;
    m.add_function(wrap_pyfunction!(parse_gamess, m)?)?;
    m.add_function(wrap_pyfunction!(parse_phonon, m)?)?;
    m.add_function(wrap_pyfunction!(parse_mol, m)?)?;
    m.add_function(wrap_pyfunction!(parse_mol2, m)?)?;
    m.add_function(wrap_pyfunction!(parse_lammps_data, m)?)?;
    m.add_function(wrap_pyfunction!(parse_cif, m)?)?;
    m.add_function(wrap_pyfunction!(parse_mmcif, m)?)?;
    m.add_function(wrap_pyfunction!(parse_prmtop, m)?)?;
    m.add_function(wrap_pyfunction!(parse_amber, m)?)?;
    m.add_function(wrap_pyfunction!(parse_xtc, m)?)?;
    m.add_function(wrap_pyfunction!(parse_dcd, m)?)?;
    m.add_function(wrap_pyfunction!(parse_traj, m)?)?;
    m.add_function(wrap_pyfunction!(parse_lammpstrj, m)?)?;
    m.add_function(wrap_pyfunction!(parse_lammpstrj_structure, m)?)?;
    m.add_function(wrap_pyfunction!(parse_netcdf, m)?)?;
    m.add_function(wrap_pyfunction!(parse_psf_bonds, m)?)?;
    m.add_function(wrap_pyfunction!(parse_top_bonds_from_path, m)?)?;
    m.add_function(wrap_pyfunction!(default_bond_source, m)?)?;
    m.add_function(wrap_pyfunction!(infer_bonds_vdw, m)?)?;
    Ok(())
}
