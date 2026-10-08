"""Tests for multi-frame XYZ trajectory reader."""

from pathlib import Path

import numpy as np

from megane.parsers.xyz import InMemoryTrajectory, load_xyz_trajectory

FIXTURES = Path(__file__).parent.parent / "fixtures"


def test_load_xyz_trajectory():
    """Test loading a multi-frame XYZ file returns Structure and Trajectory."""
    structure, trajectory = load_xyz_trajectory(str(FIXTURES / "water_multiframe.xyz"))

    assert structure.n_atoms == 3
    assert structure.positions.shape == (3, 3)
    assert structure.positions.dtype == np.float32
    assert structure.elements.shape == (3,)
    assert set(structure.elements.tolist()) == {1, 8}  # H=1, O=8

    assert isinstance(trajectory, InMemoryTrajectory)
    assert trajectory.n_frames == 3
    assert trajectory.n_atoms == 3


def test_get_frame():
    """Test retrieving individual frames from InMemoryTrajectory."""
    _, trajectory = load_xyz_trajectory(str(FIXTURES / "water_multiframe.xyz"))

    frame0 = trajectory.get_frame(0)
    assert frame0.shape == (3, 3)
    assert frame0.dtype == np.float32

    frame1 = trajectory.get_frame(1)
    assert frame1.shape == (3, 3)
    # Frames should differ
    assert not np.allclose(frame0, frame1, atol=1e-6)


def test_single_frame_xyz():
    """Single-frame XYZ should surface as a 1-frame trajectory matching positions."""
    structure, trajectory = load_xyz_trajectory(str(FIXTURES / "si_diamond.xyz"))

    assert trajectory.n_frames == 1
    assert trajectory.n_atoms == structure.n_atoms
    np.testing.assert_allclose(trajectory.get_frame(0), structure.positions, atol=1e-6)


def test_view_traj_single_path_xyz():
    """view_traj("file.xyz") auto-detects a multi-frame XYZ trajectory."""
    import megane

    viewer = megane.view_traj(str(FIXTURES / "water_multiframe.xyz"))
    assert viewer.total_frames == 3


def test_load_extxyz_trajectory():
    """An ASE extended XYZ (`.extxyz`) reads through the XYZ reader with its cell."""
    structure, trajectory = load_xyz_trajectory(str(FIXTURES / "water_md.extxyz"))

    assert structure.n_atoms == 3
    assert trajectory.n_frames == 2
    np.testing.assert_allclose(np.diag(structure.box), [10.0, 10.0, 10.0], atol=1e-6)


def test_view_traj_single_path_extxyz():
    """view_traj("file.extxyz") auto-detects the trajectory like a `.xyz`."""
    import megane

    viewer = megane.view_traj(str(FIXTURES / "water_md.extxyz"))
    assert viewer.total_frames == 2


def test_widget_load_extxyz_infers_trajectory():
    """MolecularViewer.load("file.extxyz") takes the multi-frame XYZ path."""
    from megane.widget import MolecularViewer

    viewer = MolecularViewer()
    viewer.load(str(FIXTURES / "water_md.extxyz"))
    assert viewer.total_frames == 2


def test_uniform_xyz_is_not_heterogeneous():
    """A constant-atom multi-frame XYZ keeps the uniform fast path."""
    _, trajectory = load_xyz_trajectory(str(FIXTURES / "water_multiframe.xyz"))
    assert trajectory.heterogeneous is False
    assert trajectory.frames_list is None


def test_variable_atom_count_xyz():
    """A multi-frame XYZ whose atom count changes is loaded as a heterogeneous
    trajectory with per-frame atom counts and elements (previously dropped)."""
    structure, trajectory = load_xyz_trajectory(str(FIXTURES / "hetero_atoms.xyz"))

    # Frame 0 defines the base topology (2 atoms).
    assert structure.n_atoms == 2
    assert trajectory.heterogeneous is True
    assert trajectory.n_frames == 3
    assert trajectory.max_atoms == 3

    # Per-frame atom counts: 2, 3, 2.
    assert trajectory.n_atoms_at(0) == 2
    assert trajectory.n_atoms_at(1) == 3
    assert trajectory.n_atoms_at(2) == 2

    # Frame 1 grew an oxygen; per-frame elements reflect it.
    elems1 = trajectory.get_elements(1)
    assert elems1 is not None
    assert elems1.tolist() == [1, 1, 8]  # H, H, O

    frame1 = trajectory.get_frame(1)
    assert frame1.shape == (3, 3)
    np.testing.assert_allclose(frame1[2], [1.6, 0.0, 0.0], atol=1e-5)


def test_variable_cell_xyz():
    """A constant-topology XYZ with per-frame Lattice= changes exposes per-frame
    cells and leaves elements constant."""
    _, trajectory = load_xyz_trajectory(str(FIXTURES / "hetero_cell.xyz"))

    assert trajectory.heterogeneous is True
    # Topology constant → no per-frame element table.
    assert trajectory.get_elements(1) is None
    # Per-frame cell grows 10 → 12 → 14 on the diagonal.
    assert trajectory.get_cell(0)[0, 0] == 10.0
    assert trajectory.get_cell(1)[0, 0] == 12.0
    assert trajectory.get_cell(2)[0, 0] == 14.0
