"""Tests for Jupyter widget (Python side)."""

import struct
import warnings
from pathlib import Path

import pytest

import megane.widget
from megane.parsers.common import encode_trajectory_frame
from megane.pipeline import Pipeline, LoadStructure, LoadTrajectory, AddBonds
from megane.protocol import MAGIC, MSG_SNAPSHOT, MSG_TRAJECTORY
from megane.widget import MolecularViewer

FIXTURES = Path(__file__).parent.parent / "fixtures"


def _make_pdb_pipeline(pdb_path: str) -> Pipeline:
    """Helper: create a Pipeline that loads a PDB with bonds."""
    pipe = Pipeline()
    s = pipe.add_node(LoadStructure(pdb_path))
    b = pipe.add_node(AddBonds(source="structure"))
    pipe.add_edge(s.out.particle, b.inp.particle)
    return pipe


def _make_trajectory_pipeline() -> Pipeline:
    """Helper: 1crn.pdb + its XTC trajectory."""
    pipe = Pipeline()
    s = pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
    t = pipe.add_node(LoadTrajectory(xtc=str(FIXTURES / "1crn_vibration.xtc")))
    pipe.add_edge(s.out.particle, t.inp.particle)
    return pipe


def _embedded_frames(data: bytes) -> list[bytes]:
    """Split a MSG_TRAJECTORY message into its frame messages."""
    assert data[:4] == MAGIC
    assert data[4] == MSG_TRAJECTORY
    (n_frames,) = struct.unpack_from("<I", data, 8)
    offsets = struct.unpack_from(f"<{n_frames + 1}I", data, 12)
    assert offsets[-1] == len(data)
    return [data[offsets[i] : offsets[i + 1]] for i in range(n_frames)]


def test_widget_instantiation():
    """Widget can be created without errors."""
    v = MolecularViewer()
    assert v is not None
    assert v.frame_index == 0
    assert v.total_frames == 0
    assert v._snapshot_data == b""
    assert v._frame_data == b""


def test_esm_is_valid_js():
    """_esm resolves to non-empty JS string containing the render export."""
    v = MolecularViewer()
    esm = v._esm
    assert isinstance(esm, str)
    assert len(esm) > 1000  # widget.js is ~670KB
    assert "render" in esm
    assert "export" in esm


def test_esm_has_default_export():
    """_esm has a valid ESM default export."""
    v = MolecularViewer()
    esm = v._esm
    # Built by vite as: export { n_ as default }
    assert "as default" in esm


def test_set_pipeline_populates_snapshot():
    """set_pipeline() sets _node_snapshots_data with valid binary."""
    v = MolecularViewer()
    pipe = _make_pdb_pipeline(str(FIXTURES / "1crn.pdb"))
    v.set_pipeline(pipe)

    assert v._pipeline_json != ""
    assert len(v._node_snapshots_data) > 0


def test_pipeline_snapshot_has_magic():
    """Pipeline node snapshot data starts with MEGN magic."""
    v = MolecularViewer()
    pipe = _make_pdb_pipeline(str(FIXTURES / "1crn.pdb"))
    v.set_pipeline(pipe)

    for data in v._node_snapshots_data.values():
        if len(data) > 4:
            assert data[:4] == MAGIC
            msg_type = struct.unpack("<B", data[4:5])[0]
            assert msg_type == MSG_SNAPSHOT


def test_widget_state_keys():
    """get_state() contains all required widget keys."""
    v = MolecularViewer()
    state = v.get_state()

    required_keys = {
        "_esm",
        "_snapshot_data",
        "_frame_data",
        "_trajectory_data",
        "frame_index",
        "total_frames",
    }
    assert required_keys.issubset(set(state.keys()))


def test_model_metadata():
    """Widget uses anywidget model/view names."""
    v = MolecularViewer()
    assert v._model_name == "AnyModel"
    assert v._view_name == "AnyView"
    assert "anywidget" in v._model_module


def _version_tuple(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.split(".")[:3] if part.isdigit())


def test_frontend_version_range_accepts_every_anywidget_frontend():
    """The synced (and saved) front-end range is not anywidget's per-minor pin.

    anywidget defaults to "~<major>.<minor>.*", so a notebook saved with one
    anywidget minor version fails to render ("Module anywidget, version
    ~0.9.* is not registered, however, 0.11.0 is") where another is installed.
    """
    import anywidget

    state = MolecularViewer().get_state()
    frontend_range = megane.widget.ANYWIDGET_FRONTEND_RANGE
    assert state["_model_module_version"] == frontend_range
    assert state["_view_module_version"] == frontend_range

    assert frontend_range.startswith(">=")
    floor = _version_tuple(frontend_range[2:])
    for version in (anywidget.__version__, "0.9.0", "0.9.21", "0.10.0", "0.11.0"):
        assert _version_tuple(version) >= floor, version


def test_set_pipeline_and_clear():
    """set_pipeline(None) clears the pipeline."""
    v = MolecularViewer()
    pipe = _make_pdb_pipeline(str(FIXTURES / "1crn.pdb"))
    v.set_pipeline(pipe)
    assert v._pipeline_json != ""

    v.set_pipeline(None)
    assert v._pipeline_json == ""
    assert v._node_snapshots_data == {}


def _frame_state(v: MolecularViewer) -> tuple:
    return v._frame_data, v.frame_index, v.total_frames, v._trajectory_data


def test_set_pipeline_resets_the_previous_trajectorys_frame():
    """A second run with the same topology must not show the first run's frame 5."""
    v = MolecularViewer()
    v.set_pipeline(_make_trajectory_pipeline())
    v.frame_index = 5
    assert v._frame_data != b""

    second = _make_trajectory_pipeline()
    v.set_pipeline(second)
    fresh = MolecularViewer()
    fresh.set_pipeline(second)
    assert _frame_state(v) == _frame_state(fresh) == (b"", 0, next(iter(second._trajectories.values())).n_frames, b"")

    # Seeking still serves the new pipeline's frames.
    v.frame_index = 2
    assert v._frame_data == encode_trajectory_frame(next(iter(second._trajectories.values())), 2)


def test_set_pipeline_without_trajectory_hides_the_timeline():
    v = MolecularViewer()
    v.set_pipeline(_make_trajectory_pipeline())
    v.frame_index = 3
    v.set_pipeline(_make_pdb_pipeline(str(FIXTURES / "1crn.pdb")))
    assert _frame_state(v) == (b"", 0, 0, b"")


def test_set_pipeline_none_resets_frames():
    v = MolecularViewer()
    v.set_pipeline(_make_trajectory_pipeline(), embed_trajectory=True)
    v.frame_index = 4
    v.set_pipeline(None)
    assert _frame_state(v) == (b"", 0, 0, b"")
    assert v._pipeline_ref is None


def test_set_pipeline_keeps_a_legacy_load_trajectorys_frame_count():
    """load(xtc=...) frames are still served after a pipeline without a trajectory."""
    v = MolecularViewer()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        v.load(str(FIXTURES / "1crn.pdb"), xtc=str(FIXTURES / "1crn_vibration.xtc"))
    n_frames = v.total_frames
    v.frame_index = 3
    v.set_pipeline(None)
    assert _frame_state(v) == (b"", 0, n_frames, b"")


def test_set_pipeline_resets_frames_in_one_state_update():
    """The front end gets the new pipeline and the reset frame state in one message."""

    class Comm:
        kernel = object()
        comm_id = "test-comm"

        def __init__(self):
            self.sent = []

        def send(self, data=None, buffers=None, **kwargs):
            self.sent.append(data)

        def on_msg(self, callback):
            pass

        def close(self, *args, **kwargs):
            pass

    v = MolecularViewer()
    v.set_pipeline(_make_trajectory_pipeline())
    v.frame_index = 5
    v.comm = Comm()
    v.comm.sent.clear()
    v.set_pipeline(_make_pdb_pipeline(str(FIXTURES / "1crn.pdb")))
    updates = [m for m in v.comm.sent if m and m.get("method") == "update"]
    assert len(updates) == 1
    state = updates[0]["state"]
    assert state["frame_index"] == 0 and state["total_frames"] == 0
    buffers = {path[0] for path in updates[0].get("buffer_paths", [])}  # bytes traits travel as buffers
    assert {"_pipeline_json", "_frame_data"} <= set(state) | buffers


def test_deprecated_load_warns():
    """load() emits DeprecationWarning."""
    v = MolecularViewer()
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        v.load(str(FIXTURES / "1crn.pdb"))
    assert len(w) == 1
    assert issubclass(w[0].category, DeprecationWarning)
    assert "set_pipeline" in str(w[0].message)


# ─── embed_trajectory ──────────────────────────────────────────────────


def test_set_pipeline_does_not_embed_by_default():
    """Without embed_trajectory the frames stay in the kernel."""
    v = MolecularViewer()
    v.set_pipeline(_make_trajectory_pipeline())
    assert v.total_frames > 1
    assert v._trajectory_data == b""

    v.frame_index = 2
    assert v._frame_data != b""


def test_embed_trajectory_true_embeds_every_frame():
    """embed_trajectory=True sends every frame, identical to the per-frame path."""
    pipe = _make_trajectory_pipeline()
    v = MolecularViewer()
    v.set_pipeline(pipe, embed_trajectory=True)

    traj = next(iter(pipe._trajectories.values()))
    frames = _embedded_frames(v._trajectory_data)
    assert len(frames) == traj.n_frames == v.total_frames
    for idx, frame in enumerate(frames):
        assert frame == encode_trajectory_frame(traj, idx)


def test_embedded_frame_change_skips_kernel_frames():
    """With an embedded trajectory a frame change sends no _frame_data but still fires events."""
    v = MolecularViewer()
    v.set_pipeline(_make_trajectory_pipeline(), embed_trajectory=True)
    seen = []
    v.on_event("frame_change", seen.append)

    v.frame_index = 3
    assert v._frame_data == b""
    assert seen == [{"frame_index": 3}]


def test_embed_trajectory_auto_embeds_small_trajectory():
    v = MolecularViewer()
    v.set_pipeline(_make_trajectory_pipeline(), embed_trajectory="auto")
    assert len(_embedded_frames(v._trajectory_data)) == v.total_frames


def test_embed_trajectory_auto_falls_back_over_limit(monkeypatch):
    """Over the auto limit: warn, embed nothing, keep serving frames from the kernel."""
    monkeypatch.setattr(megane.widget, "EMBED_TRAJECTORY_AUTO_LIMIT", 1024)
    v = MolecularViewer()
    with pytest.warns(UserWarning, match="embed_trajectory=True"):
        v.set_pipeline(_make_trajectory_pipeline(), embed_trajectory="auto")
    assert v._trajectory_data == b""
    assert v.total_frames > 1

    v.frame_index = 1
    assert v._frame_data != b""


def test_embed_trajectory_true_ignores_auto_limit(monkeypatch):
    monkeypatch.setattr(megane.widget, "EMBED_TRAJECTORY_AUTO_LIMIT", 1024)
    v = MolecularViewer()
    v.set_pipeline(_make_trajectory_pipeline(), embed_trajectory=True)
    assert len(_embedded_frames(v._trajectory_data)) == v.total_frames


def test_embed_trajectory_without_trajectory_is_noop():
    v = MolecularViewer()
    v.set_pipeline(_make_pdb_pipeline(str(FIXTURES / "1crn.pdb")), embed_trajectory=True)
    assert v._trajectory_data == b""


def test_embed_trajectory_rejects_invalid_value():
    v = MolecularViewer()
    with pytest.raises(ValueError, match="embed_trajectory"):
        v.set_pipeline(_make_trajectory_pipeline(), embed_trajectory="always")  # type: ignore[arg-type]


def test_embedded_trajectory_cleared_by_later_calls():
    """A later set_pipeline / set_pipeline(None) / load() drops stale embedded frames."""
    v = MolecularViewer()
    v.set_pipeline(_make_trajectory_pipeline(), embed_trajectory=True)
    v.set_pipeline(_make_trajectory_pipeline())
    assert v._trajectory_data == b""

    v.set_pipeline(_make_trajectory_pipeline(), embed_trajectory=True)
    v.set_pipeline(None)
    assert v._trajectory_data == b""

    v.set_pipeline(_make_trajectory_pipeline(), embed_trajectory=True)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        v.load(str(FIXTURES / "1crn.pdb"))
    assert v._trajectory_data == b""


def test_quick_style_defaults_off_and_syncs():
    """quick_style is off by default, settable at construction, and synced."""
    assert MolecularViewer().quick_style is False
    v = MolecularViewer(quick_style=True)
    assert v.quick_style is True
    assert v.get_state()["quick_style"] is True
    v.quick_style = False
    assert v.get_state()["quick_style"] is False


def test_set_pipeline_replaces_quick_style_edits():
    """A pipeline JSON written back by the front end is replaced by set_pipeline()."""
    v = MolecularViewer(quick_style=True)
    pipe = _make_pdb_pipeline(str(FIXTURES / "1crn.pdb"))
    v.set_pipeline(pipe)
    original = v._pipeline_json
    v._pipeline_json = '{"version": 3, "nodes": [], "edges": []}'  # as the JS side would
    v.set_pipeline(pipe)
    assert v._pipeline_json == original
