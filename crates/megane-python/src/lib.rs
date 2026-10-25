use megane_core::formats::{StructureFormat, TrajectoryFormat};
use megane_core::parser::ParsedStructure;
use megane_core::trajectory::VectorChannel;
use numpy::ndarray::{Array1, Array2};
use numpy::{IntoPyArray, PyArray1, PyArray2, PyReadonlyArray1, PyReadonlyArray2};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;

/// Vector channels as handed to Python: `[(name, [(n, 3) array per frame])]`.
type PyVectorChannels = Vec<(String, Vec<Py<PyArray2<f32>>>)>;

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
    /// Embedded per-atom vector channels (GRO / LAMMPS velocities, forces, …)
    /// as `[(name, [frame0_vectors (n, 3), …]), …]`. A single-frame channel is
    /// static.
    #[pyo3(get)]
    vector_channels: PyVectorChannels,
    /// Non-fatal parse warnings (e.g. atoms the file declares but the parser
    /// could not represent). Empty for a clean parse.
    #[pyo3(get)]
    warnings: Vec<String>,
    /// Number of bonds (rows of `bonds`).
    #[pyo3(get)]
    n_bonds: usize,
    /// How many leading rows of `bonds` the file itself declares; the rest
    /// were inferred from distances (only for formats with no connectivity).
    #[pyo3(get)]
    n_file_bonds: usize,
    /// Per-atom labels (atom names), or `None` when the format carries none.
    #[pyo3(get)]
    atom_labels: Option<Vec<String>>,
    /// Per-atom chain IDs as raw ASCII bytes (e.g. 65 = `A`), or `None`.
    #[pyo3(get)]
    chain_ids: Option<Py<PyArray1<u8>>>,
    /// Per-atom B-factors, or `None` when the format carries none.
    #[pyo3(get)]
    bfactors: Option<Py<PyArray1<f32>>>,
    /// Indices of the Cα backbone atoms (empty when not a protein).
    #[pyo3(get)]
    ca_indices: Py<PyArray1<u32>>,
    /// Per-Cα chain identifier as an ASCII byte.
    #[pyo3(get)]
    ca_chain_ids: Py<PyArray1<u8>>,
    /// Per-Cα residue sequence number.
    #[pyo3(get)]
    ca_res_nums: Py<PyArray1<u32>>,
    /// Per-Cα secondary-structure type: 0 = coil, 1 = helix, 2 = sheet.
    #[pyo3(get)]
    ca_ss_type: Py<PyArray1<u8>>,
    /// True when the per-frame atom count changes (heterogeneous only).
    #[pyo3(get)]
    varies_atoms: bool,
    /// True when the per-frame unit cell changes (heterogeneous only).
    #[pyo3(get)]
    varies_cell: bool,
    /// True when per-frame elements / bonds change (heterogeneous only).
    #[pyo3(get)]
    varies_topology: bool,
}

/// Bond pairs as an `(n, 2)` uint32 array (shape `(0, 2)` when empty).
fn pairs_to_array(py: Python<'_>, pairs: &[(u32, u32)]) -> PyResult<Py<PyArray2<u32>>> {
    let n = pairs.len();
    let arr =
        Array2::from_shape_vec((n, 2), megane_core::bonds::flatten_pairs(pairs)).map_err(|e| {
            PyValueError::new_err(format!("failed to reshape bonds into ({n}, 2): {e}"))
        })?;
    Ok(arr.into_pyarray(py).unbind())
}

/// Vector channels as `[(name, [(n, 3) array per frame])]`. Frames can differ in
/// atom count on a heterogeneous trajectory, so each frame is reshaped on its
/// own.
fn vector_channels_to_py(
    py: Python<'_>,
    channels: Vec<VectorChannel>,
) -> PyResult<PyVectorChannels> {
    channels
        .into_iter()
        .map(|ch| {
            let frames = ch
                .frames
                .into_iter()
                .map(|f| {
                    let rows = f.vectors.len() / 3;
                    Array2::from_shape_vec((rows, 3), f.vectors)
                        .map(|a| a.into_pyarray(py).unbind())
                        .map_err(|e| {
                            PyValueError::new_err(format!(
                                "vector channel {:?} is not (n, 3): {e}",
                                ch.name
                            ))
                        })
                })
                .collect::<PyResult<Vec<_>>>()?;
            Ok((ch.name, frames))
        })
        .collect()
}

impl PyStructure {
    fn from_parsed(py: Python<'_>, data: ParsedStructure) -> PyResult<Self> {
        let n = data.n_atoms;
        let n_bonds = data.bonds.len();

        let pos_array = Array2::from_shape_vec((n, 3), data.positions).map_err(|e| {
            PyValueError::new_err(format!("failed to reshape positions into ({n}, 3): {e}"))
        })?;

        let elem_array = Array1::from_vec(data.elements);

        let bond_array = pairs_to_array(py, &data.bonds)?;

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
        let (varies_atoms, varies_cell, varies_topology) = hetero
            .as_ref()
            .map(|h| (h.varies_atoms, h.varies_cell, h.varies_topology))
            .unwrap_or_default();
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
            bonds: bond_array,
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
            vector_channels: vector_channels_to_py(py, data.vector_channels)?,
            warnings: data.warnings,
            n_bonds,
            n_file_bonds: data.n_file_bonds,
            atom_labels: data.atom_labels,
            chain_ids: data
                .chain_ids
                .map(|c| Array1::from_vec(c).into_pyarray(py).unbind()),
            bfactors: data
                .bfactors
                .map(|b| Array1::from_vec(b).into_pyarray(py).unbind()),
            ca_indices: Array1::from_vec(data.ca_indices).into_pyarray(py).unbind(),
            ca_chain_ids: Array1::from_vec(data.ca_chain_ids)
                .into_pyarray(py)
                .unbind(),
            ca_res_nums: Array1::from_vec(data.ca_res_nums).into_pyarray(py).unbind(),
            ca_ss_type: Array1::from_vec(data.ca_ss_type).into_pyarray(py).unbind(),
            varies_atoms,
            varies_cell,
            varies_topology,
        })
    }
}

/// Generates one `#[pyfunction]` structure parser per
/// `megane_core::for_each_structure_format!` entry (`parse_pdb`, `parse_gro`,
/// …) plus `add_structure_parsers`, which registers them all on the module.
/// The registry is shared with the WASM binding, so both hosts expose the
/// same formats under the same names.
macro_rules! py_structure_parsers {
    ($( $(#[doc = $doc:tt])* $variant:ident => $binding:ident($arg:ident: $ty:ty); )*) => {
        $(
            $(#[doc = $doc])*
            #[pyfunction]
            fn $binding(py: Python<'_>, $arg: $ty) -> PyResult<PyStructure> {
                let data = StructureFormat::$variant
                    .parse($arg.into())
                    .map_err(PyValueError::new_err)?;
                PyStructure::from_parsed(py, data)
            }
        )*

        fn add_structure_parsers(m: &Bound<'_, PyModule>) -> PyResult<()> {
            $( m.add_function(wrap_pyfunction!($binding, m)?)?; )*
            Ok(())
        }
    };
}

megane_core::for_each_structure_format!(py_structure_parsers);

/// Generates one `#[pyfunction]` trajectory parser per
/// `megane_core::for_each_trajectory_format!` entry, using the entry's Python
/// name (`parse_xtc`, `parse_dcd`, …), plus `add_trajectory_parsers`.
macro_rules! py_trajectory_parsers {
    ($( $(#[doc = $doc:tt])* $variant:ident => $wasm:ident / $py:ident($arg:ident: $ty:ty); )*) => {
        $(
            $(#[doc = $doc])*
            #[pyfunction]
            fn $py(py: Python<'_>, $arg: $ty) -> PyResult<PyTrajectoryData> {
                let traj = TrajectoryFormat::$variant
                    .parse($arg.into())
                    .map_err(PyValueError::new_err)?;
                py_trajectory_from_data(py, traj)
            }
        )*

        fn add_trajectory_parsers(m: &Bound<'_, PyModule>) -> PyResult<()> {
            $( m.add_function(wrap_pyfunction!($py, m)?)?; )*
            Ok(())
        }
    };
}

megane_core::for_each_trajectory_format!(py_trajectory_parsers);

/// Where the frames of a [`TrajectoryFile`] are.
enum FrameLayout {
    Xtc(megane_core::xtc::XtcIndex),
    Dcd(megane_core::dcd::DcdLayout),
    Netcdf(megane_core::netcdf::NetcdfLayout),
}

/// A trajectory (XTC, DCD or AMBER NetCDF) read from its file one frame at a
/// time instead of decoded whole into memory: opening it reads the frame index
/// (XTC frame headers, a DCD / NetCDF header and each frame's cell) and
/// `read_frame(i)` reads and decodes just frame `i`. Backs
/// `megane.parsers.common.FileTrajectory`.
#[pyclass(module = "megane.megane_parser")]
struct TrajectoryFile {
    file: std::sync::Mutex<std::fs::File>,
    file_len: u64,
    layout: FrameLayout,
    #[pyo3(get)]
    n_atoms: usize,
    #[pyo3(get)]
    n_frames: usize,
    #[pyo3(get)]
    timestep_ps: f32,
    first_box: Option<[f32; 9]>,
    frame_cells: Option<Vec<[f32; 9]>>,
}

/// Bytes read at a time while scanning an XTC's frame headers.
const XTC_SCAN_WINDOW: usize = 4 * 1024 * 1024;
/// First bytes read for a DCD / NetCDF header (read 4x longer while too short).
const HEAD_BYTES: usize = 64 * 1024;

fn io_err(e: std::io::Error) -> PyErr {
    pyo3::exceptions::PyOSError::new_err(e.to_string())
}

/// Bytes `start..end` of `file`, or fewer where the file ends first. `end`
/// may come from a header (a NetCDF record span), so the buffer is reserved
/// only for the bytes the file actually has past `start`.
fn read_range(file: &mut std::fs::File, start: u64, end: u64) -> std::io::Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let available = file.metadata()?.len().saturating_sub(start);
    file.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity(end.saturating_sub(start).min(available) as usize);
    file.take(end.saturating_sub(start)).read_to_end(&mut buf)?;
    Ok(buf)
}

/// Every frame's cell when they are not all the same as frame 0's.
fn varying_cells(cells: Vec<[f32; 9]>) -> Option<Vec<[f32; 9]>> {
    let first = *cells.first()?;
    cells.iter().any(|c| *c != first).then_some(cells)
}

impl TrajectoryFile {
    fn read(&self, start: u64, end: u64) -> PyResult<Vec<u8>> {
        let mut file = self
            .file
            .lock()
            .map_err(|_| PyValueError::new_err("file lock poisoned"))?;
        read_range(&mut file, start, end.min(self.file_len)).map_err(io_err)
    }

    /// Decode frame `i`: positions (Å) and the frame's cell, when it has one.
    fn decode(&self, i: usize) -> PyResult<(Vec<f32>, Option<[f32; 9]>)> {
        if i >= self.n_frames {
            return Err(PyValueError::new_err(format!(
                "frame {i} is out of range for a trajectory of {} frames",
                self.n_frames
            )));
        }
        let err = |e: String| PyValueError::new_err(e);
        match &self.layout {
            FrameLayout::Xtc(index) => {
                let start = index.offsets[i];
                let end = index.offsets.get(i + 1).copied().unwrap_or(self.file_len);
                let bytes = self.read(start, end)?;
                let positions =
                    megane_core::xtc::decode_frame_at(&bytes, 0, self.n_atoms).map_err(err)?;
                Ok((positions, None))
            }
            FrameLayout::Dcd(l) => {
                let start = l.frames_start + i as u64 * l.frame_bytes;
                let bytes = self.read(start, start + l.frame_bytes)?;
                megane_core::dcd::decode_layout_frame(l, &bytes).map_err(err)
            }
            FrameLayout::Netcdf(l) => {
                let start = l.record_start + i as u64 * l.recsize;
                let bytes = self.read(start, start + l.record_span())?;
                let f = megane_core::netcdf::decode_layout_record(l, &bytes, i).map_err(err)?;
                Ok((f.positions, f.cell))
            }
        }
    }
}

#[pymethods]
impl TrajectoryFile {
    /// Open `path` as `kind` (`"xtc"`, `"dcd"` or `"netcdf"`) and read its index.
    #[new]
    fn new(path: &str, kind: &str) -> PyResult<Self> {
        let mut file = std::fs::File::open(path).map_err(io_err)?;
        let file_len = file.metadata().map_err(io_err)?.len();
        let err = |e: String| PyValueError::new_err(e);
        let head = |file: &mut std::fs::File,
                    parse: &mut dyn FnMut(&[u8]) -> Result<(), String>| {
            let mut size = HEAD_BYTES as u64;
            loop {
                let end = size.min(file_len);
                let bytes = read_range(file, 0, end).map_err(io_err)?;
                match parse(&bytes) {
                    Ok(()) => return Ok(()),
                    Err(e) if end == file_len => return Err(err(e)),
                    Err(_) => size *= 4,
                }
            }
        };
        let mut this = TrajectoryFile {
            file: std::sync::Mutex::new(file.try_clone().map_err(io_err)?),
            file_len,
            layout: FrameLayout::Xtc(megane_core::xtc::XtcIndex {
                n_atoms: 0,
                n_frames: 0,
                timestep_ps: 0.0,
                box_matrix: None,
                offsets: Vec::new(),
                times: Vec::new(),
                first_box: None,
                frame_cells: None,
            }),
            n_atoms: 0,
            n_frames: 0,
            timestep_ps: 1.0,
            first_box: None,
            frame_cells: None,
        };
        match kind {
            "xtc" => {
                let mut builder = megane_core::xtc::XtcIndexBuilder::new();
                while builder.next_offset() < file_len {
                    let start = builder.next_offset();
                    let end = (start + XTC_SCAN_WINDOW as u64).min(file_len);
                    let window = read_range(&mut file, start, end).map_err(io_err)?;
                    builder.scan(&window, end == file_len).map_err(err)?;
                    if end == file_len {
                        break;
                    }
                    if builder.next_offset() <= start {
                        return Err(err("XTC index scan made no progress".into()));
                    }
                }
                let index = builder.finish(file_len).map_err(err)?;
                this.n_atoms = index.n_atoms;
                this.n_frames = index.n_frames;
                this.timestep_ps = index.timestep_ps;
                this.first_box = index.first_box;
                this.frame_cells = index.frame_cells.clone();
                this.layout = FrameLayout::Xtc(index);
            }
            "dcd" => {
                let mut layout = None;
                head(&mut file, &mut |b| {
                    layout = Some(megane_core::dcd::read_layout(b, file_len)?);
                    Ok(())
                })?;
                let layout = layout.expect("set by a successful parse");
                this.n_atoms = layout.n_atoms;
                this.n_frames = layout.n_frames;
                this.timestep_ps = layout.timestep_ps;
                this.layout = FrameLayout::Dcd(layout);
            }
            "netcdf" => {
                let mut layout = None;
                head(&mut file, &mut |b| {
                    layout = Some(megane_core::netcdf::read_layout(b, file_len)?);
                    Ok(())
                })?;
                let layout = layout.expect("set by a successful parse");
                this.n_atoms = layout.n_atoms;
                this.n_frames = layout.n_frames;
                this.layout = FrameLayout::Netcdf(layout);
            }
            _ => {
                return Err(PyValueError::new_err(format!(
                    "unsupported trajectory kind {kind:?}"
                )))
            }
        }
        // DCD / NetCDF: read each frame's cell (a few bytes per frame) so a
        // changing cell is known up front, as the whole-file readers know it.
        match &this.layout {
            FrameLayout::Dcd(l) if l.has_cell => {
                let mut cells = Vec::with_capacity(this.n_frames);
                for i in 0..this.n_frames {
                    let start = l.frames_start + i as u64 * l.frame_bytes;
                    let rec = read_range(&mut file, start, start + 56).map_err(io_err)?;
                    cells.push(megane_core::dcd::decode_layout_cell(l, &rec).map_err(err)?);
                }
                this.first_box = cells.first().copied();
                this.frame_cells = varying_cells(cells);
            }
            FrameLayout::Netcdf(l) => {
                let mut times = [None, None];
                for (i, t) in times.iter_mut().enumerate().take(this.n_frames) {
                    let start = l.record_start + i as u64 * l.recsize;
                    let rec =
                        read_range(&mut file, start, start + l.record_span()).map_err(io_err)?;
                    *t = megane_core::netcdf::decode_layout_record(l, &rec, i)
                        .map_err(err)?
                        .time;
                }
                this.timestep_ps =
                    megane_core::netcdf::netcdf_timestep(this.n_frames, l.has_time(), times);
                if let Some((lo, len)) = l.cell_range() {
                    let mut cells = Vec::with_capacity(this.n_frames);
                    for i in 0..this.n_frames {
                        let start = l.record_start + i as u64 * l.recsize + lo;
                        let rec = read_range(&mut file, start, start + len).map_err(io_err)?;
                        // Cells past the end of a truncated file stop, as in the eager reader.
                        match megane_core::netcdf::decode_layout_cell(l, &rec, i).map_err(err)? {
                            Some(c) => cells.push(c),
                            None => break,
                        }
                    }
                    this.first_box = cells.first().copied();
                    this.frame_cells = varying_cells(cells);
                }
            }
            _ => {}
        }
        Ok(this)
    }

    /// Frame 0's cell as a (3, 3) array (zeros without one).
    #[getter]
    fn box_matrix(&self, py: Python<'_>) -> Py<PyArray2<f32>> {
        let m = self.first_box.unwrap_or([0.0; 9]);
        Array2::from_shape_vec((3, 3), m.to_vec())
            .expect("3x3")
            .into_pyarray(py)
            .unbind()
    }

    /// Every frame's cell as an (n_frames, 3, 3) array when the cell changes
    /// between frames, else None.
    #[getter]
    fn frame_cells(&self, py: Python<'_>) -> Option<Py<numpy::PyArray3<f32>>> {
        let cells = self.frame_cells.as_ref()?;
        let flat: Vec<f32> = cells.iter().flatten().copied().collect();
        Some(
            numpy::ndarray::Array3::from_shape_vec((cells.len(), 3, 3), flat)
                .expect("n x 3 x 3")
                .into_pyarray(py)
                .unbind(),
        )
    }

    /// Positions of frame `index` as an (n_atoms, 3) float32 array (Å).
    fn read_frame(&self, py: Python<'_>, index: usize) -> PyResult<Py<PyArray2<f32>>> {
        let (positions, _cell) = self.decode(index)?;
        Ok(Array2::from_shape_vec((self.n_atoms, 3), positions)
            .map_err(|e| PyValueError::new_err(e.to_string()))?
            .into_pyarray(py)
            .unbind())
    }
}

/// The shared format registry as JSON (`megane_core::formats::registry_json`):
/// every structure / trajectory format with its exported function names,
/// encoding, and file extensions. Lets the Python tests check this module's
/// exports and `megane.parsers.dispatch` against the one source of truth.
#[pyfunction]
fn format_registry() -> String {
    megane_core::formats::registry_json()
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

/// Parse AMBER prmtop topology and inpcrd/rst7 coordinates together.
#[pyfunction]
fn parse_amber(py: Python<'_>, prmtop: &str, inpcrd: &str) -> PyResult<PyStructure> {
    let data = megane_core::amber::parse(prmtop, inpcrd).map_err(PyValueError::new_err)?;
    PyStructure::from_parsed(py, data)
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
    /// World-space lower corner (xlo,ylo,zlo) the box is anchored at, shape
    /// `(3,)`. `(0,0,0)` when the format carries no explicit origin (only
    /// LAMMPS dumps do).
    #[pyo3(get)]
    box_origin: Py<PyArray1<f32>>,
    /// Embedded per-atom vector channels (LAMMPS dump velocities / forces) as
    /// `[(name, [frame_vectors (n, 3), …]), …]`, one array per frame.
    #[pyo3(get)]
    vector_channels: PyVectorChannels,
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

    let origin_vec = traj
        .box_origin
        .map(|o| o.to_vec())
        .unwrap_or_else(|| vec![0.0f32; 3]);
    let box_origin: Py<PyArray1<f32>> = Array1::from_vec(origin_vec).into_pyarray(py).unbind();
    let vector_channels = vector_channels_to_py(py, traj.vector_channels)?;

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
            box_origin,
            vector_channels,
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
        box_origin,
        vector_channels,
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

/// Parse a GROMACS `.top` topology file at `path` and return bond pairs,
/// resolving `#include` directives from the filesystem (relative to the
/// file's directory, then as absolute paths). Missing includes are skipped;
/// a circular include chain raises `ValueError` naming the chain.
///
/// Returns an (n_bonds, 2) uint32 array of 0-indexed atom index pairs.
#[pyfunction]
fn parse_top_bonds_from_path(py: Python<'_>, path: &str) -> PyResult<Py<PyArray2<u32>>> {
    let bonds = megane_core::top::parse_top_bonds_from_path(path, usize::MAX)
        .map_err(PyValueError::new_err)?;
    pairs_to_array(py, &bonds)
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
    pairs_to_array(py, &bonds)
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
    pairs_to_array(py, &bonds)
}

/// Serialize a structure as `xyz` (extended XYZ when a cell is given), `pdb`,
/// `mol`, `cif` or `poscar` text (`cif` / `poscar` need a cell). Arrays follow
/// the `PyStructure` layout: positions `(N, 3)`, elements `(N,)`, bonds
/// `(M, 2)`. An all-zero `box_matrix` means "no cell"; `box_origin` is the
/// cell corner the cell-based writers measure positions from.
#[pyfunction]
#[pyo3(signature = (format, positions, elements, bonds, bond_orders=None, box_matrix=None, atom_labels=None, chain_ids=None, box_origin=None))]
#[allow(clippy::too_many_arguments)]
fn write_structure(
    format: &str,
    positions: PyReadonlyArray2<f32>,
    elements: PyReadonlyArray1<u8>,
    bonds: PyReadonlyArray2<u32>,
    bond_orders: Option<PyReadonlyArray1<u8>>,
    box_matrix: Option<PyReadonlyArray2<f32>>,
    atom_labels: Option<Vec<String>>,
    chain_ids: Option<Vec<u8>>,
    box_origin: Option<Vec<f32>>,
) -> PyResult<String> {
    let positions_view = positions.as_array();
    let shape = positions_view.shape();
    if shape.len() != 2 || shape[1] != 3 {
        return Err(PyValueError::new_err(format!(
            "positions shape {:?} is not (n_atoms, 3)",
            shape
        )));
    }
    let bonds_view = bonds.as_array();
    let bshape = bonds_view.shape();
    if bshape.len() != 2 || (bshape[0] > 0 && bshape[1] != 2) {
        return Err(PyValueError::new_err(format!(
            "bonds shape {:?} is not (n_bonds, 2)",
            bshape
        )));
    }
    let positions_vec: Vec<f32> = positions_view.iter().copied().collect();
    let elements_vec: Vec<u8> = elements.as_array().iter().copied().collect();
    let bonds_vec: Vec<u32> = bonds_view.iter().copied().collect();
    let orders_vec: Option<Vec<u8>> = bond_orders.map(|o| o.as_array().iter().copied().collect());
    let cell: Option<[f32; 9]> = match box_matrix {
        Some(m) => {
            let v: Vec<f32> = m.as_array().iter().copied().collect();
            if v.len() != 9 {
                return Err(PyValueError::new_err("box_matrix must be (3, 3)"));
            }
            if v.iter().all(|x| *x == 0.0) {
                None
            } else {
                let mut arr = [0.0f32; 9];
                arr.copy_from_slice(&v);
                Some(arr)
            }
        }
        None => None,
    };
    let origin: Option<[f32; 3]> = match box_origin {
        Some(o) if o.len() == 3 => Some([o[0], o[1], o[2]]),
        Some(_) => return Err(PyValueError::new_err("box_origin must have 3 values")),
        None => None,
    };
    let view = megane_core::writer::StructureView {
        positions: &positions_vec,
        elements: &elements_vec,
        bonds: &bonds_vec,
        bond_orders: orders_vec.as_deref(),
        box_matrix: cell,
        box_origin: origin,
        atom_labels: atom_labels.as_deref(),
        chain_ids: chain_ids.as_deref(),
    };
    megane_core::writer::write(format, &view).map_err(PyValueError::new_err)
}

#[pymodule]
fn megane_parser(m: &Bound<'_, PyModule>) -> PyResult<()> {
    add_structure_parsers(m)?;
    add_trajectory_parsers(m)?;
    m.add_function(wrap_pyfunction!(format_registry, m)?)?;
    m.add_function(wrap_pyfunction!(parse_jcampdx, m)?)?;
    m.add_function(wrap_pyfunction!(parse_amber, m)?)?;
    m.add_function(wrap_pyfunction!(parse_psf_bonds, m)?)?;
    m.add_function(wrap_pyfunction!(parse_top_bonds_from_path, m)?)?;
    m.add_function(wrap_pyfunction!(default_bond_source, m)?)?;
    m.add_function(wrap_pyfunction!(infer_bonds_vdw, m)?)?;
    m.add_function(wrap_pyfunction!(write_structure, m)?)?;
    m.add_class::<TrajectoryFile>()?;
    Ok(())
}
