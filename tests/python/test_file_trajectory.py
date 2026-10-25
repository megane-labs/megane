"""``FileTrajectory``: XTC / DCD / NetCDF trajectories read one frame at a time.

The file-backed reader must give the same frames, cells and time step as the
whole-file parse (``trajectory_from_traj_result``), while keeping only a few
frames in memory.
"""

from __future__ import annotations

import struct
from pathlib import Path

import numpy as np
import pytest

from megane import megane_parser
from megane.parsers.common import FileTrajectory, open_file_trajectory, trajectory_from_traj_result
from megane.parsers.xtc import load_trajectory

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"

PARSERS = {"xtc": megane_parser.parse_xtc, "dcd": megane_parser.parse_dcd, "netcdf": megane_parser.parse_netcdf}


def _eager(path: Path, kind: str):
    return trajectory_from_traj_result(PARSERS[kind](path.read_bytes()))


@pytest.mark.parametrize(
    ("name", "kind"),
    [("1crn_vibration.xtc", "xtc"), ("water.dcd", "dcd"), ("water.nc", "netcdf")],
)
def test_frames_match_the_whole_file_parse(name: str, kind: str) -> None:
    path = FIXTURES / name
    eager = _eager(path, kind)
    lazy = open_file_trajectory(str(path), kind)
    assert isinstance(lazy, FileTrajectory)
    assert (lazy.n_frames, lazy.n_atoms) == (eager.n_frames, eager.n_atoms)
    assert lazy.timestep_ps == pytest.approx(eager.timestep_ps)
    np.testing.assert_array_equal(lazy.box, eager.box)
    assert lazy.heterogeneous == eager.heterogeneous
    for i in range(lazy.n_frames):
        np.testing.assert_array_equal(lazy.get_frame(i), eager.get_frame(i))
        np.testing.assert_array_equal(lazy.get_cell(i), eager.get_cell(i))
        assert lazy.n_atoms_at(i) == eager.n_atoms_at(i)
        assert lazy.get_elements(i) is None


def _dcd_with_cells(path: Path, edges: list[float], n_atoms: int = 2) -> None:
    """A little-endian CHARMM DCD with one cell per frame."""

    def record(payload: bytes) -> bytes:
        return struct.pack("<i", len(payload)) + payload + struct.pack("<i", len(payload))

    header = bytearray(84)
    header[0:4] = b"CORD"
    struct.pack_into("<i", header, 4, len(edges))
    struct.pack_into("<i", header, 12, 1)
    struct.pack_into("<f", header, 40, 0.5)
    struct.pack_into("<i", header, 44, 1)
    struct.pack_into("<i", header, 80, 24)
    out = record(bytes(header)) + record(struct.pack("<i", 1) + b"t".ljust(80)) + record(struct.pack("<i", n_atoms))
    for f, edge in enumerate(edges):
        out += record(struct.pack("<6d", edge, 90, edge, 90, 90, edge))
        for axis in range(3):
            out += record((np.arange(n_atoms, dtype="<f4") + f + axis).tobytes())
    path.write_bytes(out)


def test_a_changing_cell_is_read_up_front(tmp_path: Path) -> None:
    path = tmp_path / "npt.dcd"
    _dcd_with_cells(path, [10.0, 11.0, 12.0])
    eager = _eager(path, "dcd")
    lazy = open_file_trajectory(str(path), "dcd")
    assert lazy.heterogeneous and eager.heterogeneous
    np.testing.assert_allclose(lazy.cells, eager.cells)
    assert lazy.get_cell(2)[0, 0] == pytest.approx(12.0)
    with pytest.raises(ValueError):
        lazy.get_cell(3)


def test_a_constant_cell_is_not_heterogeneous(tmp_path: Path) -> None:
    path = tmp_path / "nvt.dcd"
    _dcd_with_cells(path, [10.0, 10.0])
    lazy = open_file_trajectory(str(path), "dcd")
    assert not lazy.heterogeneous
    assert lazy.cells is None
    assert lazy.get_cell(1)[0, 0] == pytest.approx(10.0)


def test_keeps_only_a_bounded_number_of_frames() -> None:
    traj = FileTrajectory(megane_parser.TrajectoryFile(str(FIXTURES / "1crn_vibration.xtc"), "xtc"), cache_bytes=1)
    first = traj.get_frame(0)
    assert traj.get_frame(0) is first  # served from the cache
    traj.get_frame(1)
    traj.get_frame(2)
    assert len(traj._cache) == 2  # never fewer than two, never more than the budget allows
    assert 0 not in traj._cache
    assert not first.flags.writeable
    with pytest.raises(ValueError):
        traj.get_frame(traj.n_frames)
    with pytest.raises(ValueError):
        traj.n_atoms_at(-1)


def test_reader_errors() -> None:
    with pytest.raises(ValueError, match="unsupported"):
        megane_parser.TrajectoryFile(str(FIXTURES / "water.dcd"), "trr")
    with pytest.raises(OSError):
        megane_parser.TrajectoryFile("/nonexistent/traj.xtc", "xtc")
    with pytest.raises(ValueError):
        megane_parser.TrajectoryFile(str(FIXTURES / "1crn.pdb"), "dcd")
    reader = megane_parser.TrajectoryFile(str(FIXTURES / "water.dcd"), "dcd")
    with pytest.raises(ValueError, match="out of range"):
        reader.read_frame(reader.n_frames)


def test_load_trajectory_skips_the_topology_read_when_told_its_size(monkeypatch) -> None:
    import megane.parsers.xtc as xtc

    def boom(_path: str) -> int:
        raise AssertionError("topology parsed again")

    monkeypatch.setattr(xtc, "_topology_n_atoms", boom)
    traj = load_trajectory(str(FIXTURES / "1crn.pdb"), str(FIXTURES / "1crn_vibration.xtc"), n_atoms=327)
    assert traj.n_frames == 100
    with pytest.raises(ValueError, match="Atom count mismatch"):
        load_trajectory(str(FIXTURES / "1crn.pdb"), str(FIXTURES / "1crn_vibration.xtc"), n_atoms=5)


def test_view_traj_parses_a_multi_frame_file_once(monkeypatch) -> None:
    import megane.parsers.dispatch as dispatch
    from megane.pipeline import view_traj

    calls: list[str] = []
    real = dispatch._parse_structure_result

    def counting(path: str):
        calls.append(path)
        return real(path)

    monkeypatch.setattr(dispatch, "_parse_structure_result", counting)
    import megane.parsers.xyz as xyz_mod

    monkeypatch.setattr(xyz_mod, "load_xyz_trajectory", lambda p: (_ for _ in ()).throw(AssertionError("parsed twice")))
    viewer = view_traj(str(FIXTURES / "water_multiframe.xyz"))
    assert calls == [str(FIXTURES / "water_multiframe.xyz")]
    assert viewer.total_frames == 3


def test_a_structure_only_pipeline_keeps_no_frames() -> None:
    from megane.pipeline import LoadStructure, Pipeline

    pipe = Pipeline()
    pipe.add_node(LoadStructure(str(FIXTURES / "water_multiframe.xyz")))
    assert pipe._file_frames == {}


def test_load_structure_file_with_frames() -> None:
    from megane.parsers.dispatch import load_structure_file_with_frames

    structure, frames = load_structure_file_with_frames(str(FIXTURES / "water_multiframe.xyz"))
    assert structure.n_atoms == 3
    assert frames is not None and frames.n_frames == 3
    structure, frames = load_structure_file_with_frames(str(FIXTURES / "1crn.pdb"))
    assert frames is None
    with pytest.raises(ValueError, match="Unsupported"):
        load_structure_file_with_frames("x.unknown")
