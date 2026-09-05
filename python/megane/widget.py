"""anywidget-based Jupyter widget for megane molecular viewer."""

from __future__ import annotations

import json
import pathlib
import warnings
from collections import defaultdict
from typing import TYPE_CHECKING, Callable

import anywidget
import traitlets

from megane.parsers.common import encode_trajectory_frame
from megane.parsers.pdb import load_pdb
from megane.protocol import encode_snapshot

if TYPE_CHECKING:
    from megane.pipeline import Pipeline

_STATIC_DIR = pathlib.Path(__file__).parent / "static"


class MolecularViewer(anywidget.AnyWidget):
    """Interactive molecular viewer widget for Jupyter notebooks.

    Usage:
        >>> import megane
        >>> viewer = megane.MolecularViewer()
        >>> viewer.load("protein.pdb")
        >>> viewer  # displays in notebook cell

    With trajectory:
        >>> viewer.load("protein.pdb", xtc="trajectory.xtc")
        >>> viewer.frame_index = 50  # jump to frame 50

    External event triggers:
        >>> # Set atom selection programmatically
        >>> viewer.selected_atoms = [10, 20, 30, 40]
        >>> print(viewer.measurement)  # dihedral angle result

        >>> # React to events
        >>> @viewer.on_event("measurement")
        ... def on_measurement(data):
        ...     print(f"Measured: {data}")

        >>> # Plotly integration example
        >>> fig = go.FigureWidget(data=[go.Scatter(x=times, y=energies)])
        >>> def on_click(trace, points, state):
        ...     viewer.frame_index = points.point_inds[0]
        >>> fig.data[0].on_click(on_click)
    """

    _esm = _STATIC_DIR / "widget.js"
    _css = ""

    # Binary data synced to JS (as DataView)
    _snapshot_data = traitlets.Bytes(b"").tag(sync=True)
    _frame_data = traitlets.Bytes(b"").tag(sync=True)

    # Trajectory state
    frame_index = traitlets.Int(0).tag(sync=True)
    total_frames = traitlets.Int(0).tag(sync=True)

    # External event triggers (Python → JS)
    selected_atoms = traitlets.List(traitlets.Int(), []).tag(sync=True)

    # Measurement result (JS → Python)
    _measurement_json = traitlets.Unicode("").tag(sync=True)

    # Camera state (JS ↔ Python). Persisted by anywidget kernel-side storage.
    # Schema: {"mode": "orthographic"|"perspective", "position": [x,y,z],
    #           "target": [x,y,z], "zoom": float, "up": [x,y,z]}
    # `up` was added with the free-rotation trackball; states saved before it
    # (no `up`) still restore with the camera's current up vector.
    camera_state = traitlets.Dict({}).tag(sync=True)

    # Pipeline data delivery (the visual pipeline editor is intentionally
    # not surfaced in the widget — it lives in the standalone webapp,
    # JupyterLab labextension and VSCode extension only).
    _pipeline_json = traitlets.Unicode("").tag(sync=True)
    _node_snapshots_data = traitlets.Dict(
        value_trait=traitlets.Bytes(),
    ).tag(sync=True)

    # Internal (not synced)
    _structure = None
    _trajectory = None

    def __init__(self, *args, **kwargs):
        """Create a molecular viewer widget.

        Data is supplied via :meth:`load` (deprecated) or :meth:`set_pipeline`.
        The visual pipeline editor is not available in the widget; use the
        standalone web app, JupyterLab extension, or VSCode extension to
        edit pipelines visually.
        """
        super().__init__(*args, **kwargs)
        self._event_handlers: dict[str, list[Callable]] = defaultdict(list)
        self._pipeline_ref: Pipeline | None = None

    def load(
        self,
        pdb_path: str,
        xtc: str | None = None,
        traj: str | None = None,
    ) -> None:
        """Load a molecular structure, optionally with a trajectory.

        The structure path is dispatched by extension to the appropriate
        Rust-backed parser (PDB, GRO, XYZ, MOL, SDF, MOL2, CIF, LAMMPS data, .traj).
        For multi-frame XYZ files the trajectory is inferred automatically.

        .. deprecated::
            Use :meth:`set_pipeline` with a :class:`~megane.pipeline.Pipeline`
            instead. The legacy single-snapshot path remains for backward
            compatibility but does not expose the full pipeline graph API.

        Args:
            pdb_path: Path to a structure file. The argument retains its
                historic name but accepts any format supported by
                :func:`megane.pipeline._load_structure_file`.
            xtc: Optional path to an XTC trajectory file. Only valid when
                ``pdb_path`` is a PDB file (XTC requires PDB topology).
            traj: Optional path to an ASE .traj file. When provided,
                *pdb_path* is ignored and both structure and trajectory
                are read from the .traj file.
        """
        import pathlib

        warnings.warn(
            "MolecularViewer.load() is deprecated and will be removed in a future major release. "
            "Use set_pipeline() with a Pipeline instead. "
            "See the megane documentation for migration examples.",
            DeprecationWarning,
            stacklevel=2,
        )
        if traj is not None:
            from megane.parsers.traj import load_traj

            structure, trajectory = load_traj(traj)
            self._structure = structure
            self._snapshot_data = encode_snapshot(structure)
            self._trajectory = trajectory
            self.total_frames = trajectory.n_frames
            return

        ext = pathlib.Path(pdb_path).suffix.lower()

        # Multi-frame XYZ: structure + trajectory come from the same file.
        if ext == ".xyz":
            from megane.parsers.xyz import load_xyz_trajectory

            structure, trajectory = load_xyz_trajectory(pdb_path)
            self._structure = structure
            self._snapshot_data = encode_snapshot(structure)
            if trajectory.n_frames > 1:
                self._trajectory = trajectory
                self.total_frames = trajectory.n_frames
            if xtc is not None:
                raise ValueError(
                    "xtc= cannot be combined with an .xyz structure path; "
                    "use set_pipeline() with LoadTrajectory(xyz=...) instead."
                )
            return

        # Generic structure dispatch — covers PDB, GRO, MOL, SDF, CIF,
        # LAMMPS .data / .lammps. Falls back to the historic load_pdb
        # path so any caller that supplies extension-less PDB text still
        # works.
        if ext == ".pdb" or ext == "":
            structure = load_pdb(pdb_path)
        else:
            from megane.pipeline import _load_structure_file

            structure = _load_structure_file(pdb_path)

        self._structure = structure
        self._snapshot_data = encode_snapshot(structure)

        if xtc is not None:
            if ext not in (".pdb", ""):
                raise ValueError(
                    f"xtc= requires a PDB topology file; got {ext!r}. "
                    "Use set_pipeline() with LoadTrajectory(xtc=...) for non-PDB topologies."
                )
            from megane.parsers.xtc import load_trajectory

            self._trajectory = load_trajectory(pdb_path, xtc)
            self.total_frames = self._trajectory.n_frames

    @traitlets.observe("frame_index")
    def _on_frame_change(self, change: dict) -> None:
        """Send new frame data when frame_index changes."""
        idx = change["new"]

        # Legacy trajectory (from viewer.load())
        if self._trajectory is not None:
            if 0 <= idx < self._trajectory.n_frames:
                self._frame_data = encode_trajectory_frame(self._trajectory, idx)

        # Pipeline trajectory (from set_pipeline())
        if self._pipeline_ref is not None:
            for traj in self._pipeline_ref._trajectories.values():
                if 0 <= idx < traj.n_frames:
                    self._frame_data = encode_trajectory_frame(traj, idx)
                    break

        self._fire_event(
            "frame_change",
            {
                "frame_index": idx,
            },
        )

    @traitlets.observe("_measurement_json")
    def _on_measurement_change(self, change: dict) -> None:
        """Fire measurement event when JS sends measurement data."""
        raw = change["new"]
        if not raw:
            self._fire_event("measurement", None)
            return
        data = json.loads(raw)
        self._fire_event("measurement", data)

    @traitlets.observe("selected_atoms")
    def _on_selected_atoms_change(self, change: dict) -> None:
        """Fire selection_change event."""
        self._fire_event(
            "selection_change",
            {
                "atoms": list(change["new"]),
            },
        )

    @property
    def measurement(self) -> dict | None:
        """Current measurement result, or None if fewer than 2 atoms selected.

        Returns a dict with keys: type, value, label, atoms.
        Example: {'type': 'dihedral', 'value': 120.5, 'label': '120.5°',
                  'atoms': [10, 20, 30, 40]}
        """
        if not self._measurement_json:
            return None
        return json.loads(self._measurement_json)

    def on_event(self, event_name: str, callback: Callable | None = None):
        """Register a callback for an event.

        Can be used as a decorator or a method call:

            @viewer.on_event("measurement")
            def on_measurement(data):
                print(data)

            # or equivalently:
            viewer.on_event("measurement", on_measurement)

        Supported events:
            - "frame_change": fired when frame_index changes.
              Data: {"frame_index": int}
            - "selection_change": fired when selected_atoms changes.
              Data: {"atoms": list[int]}
            - "measurement": fired when a measurement is computed.
              Data: {"type": str, "value": float, "label": str,
                     "atoms": list[int]} or None

        Args:
            event_name: Name of the event.
            callback: Callable to invoke. If None, returns a decorator.

        Returns:
            The callback (for decorator usage).
        """
        if callback is not None:
            self._event_handlers[event_name].append(callback)
            return callback

        # Decorator usage
        def decorator(fn: Callable) -> Callable:
            self._event_handlers[event_name].append(fn)
            return fn

        return decorator

    def off_event(self, event_name: str, callback: Callable | None = None):
        """Remove event callback(s).

        Args:
            event_name: Name of the event.
            callback: Specific callback to remove. If None, removes all
                callbacks for the event.
        """
        if callback is None:
            self._event_handlers.pop(event_name, None)
        else:
            handlers = self._event_handlers.get(event_name, [])
            self._event_handlers[event_name] = [h for h in handlers if h is not callback]

    def set_pipeline(self, pipeline: Pipeline | None) -> None:
        """Apply a pipeline to this viewer.

        Args:
            pipeline: A :class:`~megane.pipeline.Pipeline` instance,
                or ``None`` to clear the pipeline.
        """
        if pipeline is None:
            self._pipeline_json = ""
            self._node_snapshots_data = {}
            self._pipeline_ref = None
            return

        # Send per-node binary snapshot data
        self._node_snapshots_data = dict(pipeline._node_data)

        # Send pipeline config JSON
        self._pipeline_json = json.dumps(pipeline.to_dict())

        # Store trajectory refs for lazy loading
        self._pipeline_ref = pipeline
        if pipeline._trajectories:
            first_traj = next(iter(pipeline._trajectories.values()))
            self.total_frames = first_traj.n_frames

    def _fire_event(self, event_name: str, data) -> None:
        """Invoke all registered callbacks for an event."""
        for handler in self._event_handlers.get(event_name, []):
            handler(data)
