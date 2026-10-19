"""Write the open-latency fixtures for tests/e2e/perf/host-open.perf.ts.

A water box of 334 molecules (1002 atoms) vibrating over 900 frames, as:
  w1002.pdb + w1002.xtc + w1002.megane.json   topology + trajectory pipeline
  w1002_traj.xyz                              multi-frame XYZ   (~22 MB)
  w1002_traj.pdb                              multi-MODEL PDB   (~73 MB)
  w1002.traj                                  ASE trajectory    (~22 MB)

Usage: python tests/e2e/perf/gen_fixtures.py <out dir> [n_atoms] [n_frames]
Needs numpy, MDAnalysis and ASE (not megane dependencies; use a scratch venv).
"""

import json
import os
import sys

import MDAnalysis as mda
import numpy as np
from ase import Atoms
from ase.io import write as ase_write
from MDAnalysis.coordinates.XTC import XTCWriter


def main() -> None:
    out = sys.argv[1]
    n_res = int(sys.argv[2]) // 3 if len(sys.argv) > 2 else 334
    n_frames = int(sys.argv[3]) if len(sys.argv) > 3 else 900
    os.makedirs(out, exist_ok=True)

    rng = np.random.default_rng(0)
    box = (n_res * 30.0) ** (1 / 3)
    oxygens = rng.uniform(0, box, (n_res, 3))
    pos = np.concatenate([np.stack([o, o + [0.96, 0, 0], o + [-0.24, 0.93, 0]]) for o in oxygens]).astype(np.float32)
    n_atoms = len(pos)
    elements = ["O", "H", "H"] * n_res

    u = mda.Universe.empty(
        n_atoms,
        n_residues=n_res,
        atom_resindex=np.repeat(np.arange(n_res), 3),
        trajectory=True,
    )
    u.add_TopologyAttr("name", ["OW", "HW1", "HW2"] * n_res)
    u.add_TopologyAttr("type", elements)
    u.add_TopologyAttr("element", elements)
    u.add_TopologyAttr("resname", ["SOL"] * n_res)
    u.add_TopologyAttr("resid", np.arange(1, n_res + 1))
    u.add_TopologyAttr("chainIDs", ["A"] * n_atoms)
    u.add_TopologyAttr("altLocs", [""] * n_atoms)
    u.add_TopologyAttr("occupancies", [1.0] * n_atoms)
    u.add_TopologyAttr("tempfactors", [0.0] * n_atoms)
    u.add_TopologyAttr("segids", ["W"])
    u.add_TopologyAttr("icodes", [""] * n_res)
    u.dimensions = [box, box, box, 90, 90, 90]
    u.atoms.positions = pos

    base = f"w{n_atoms}"
    u.atoms.write(os.path.join(out, f"{base}.pdb"))

    phase = np.arange(n_atoms)[:, None]
    frames = [(pos + 0.3 * np.sin(i * 0.1 + phase)).astype(np.float32) for i in range(n_frames)]

    with XTCWriter(os.path.join(out, f"{base}.xtc"), n_atoms=n_atoms) as w:
        for i, p in enumerate(frames):
            u.atoms.positions = p
            u.trajectory.ts.frame = i
            u.trajectory.ts.time = float(i)
            w.write(u.atoms)

    with mda.Writer(os.path.join(out, f"{base}_traj.pdb"), multiframe=True, n_atoms=n_atoms) as w:
        for p in frames:
            u.atoms.positions = p
            w.write(u.atoms)

    with open(os.path.join(out, f"{base}_traj.xyz"), "w") as f:
        for i, p in enumerate(frames):
            f.write(f"{n_atoms}\nframe {i}\n")
            f.writelines(f"{e} {x:.4f} {y:.4f} {z:.4f}\n" for e, (x, y, z) in zip(elements, p))

    ase_write(
        os.path.join(out, f"{base}.traj"),
        [Atoms(elements, positions=p, cell=[box] * 3, pbc=True) for p in frames],
    )

    pipeline = {
        "version": 3,
        "nodes": [
            {
                "id": "load-1",
                "type": "load_structure",
                "fileName": f"{base}.pdb",
                "hasTrajectory": False,
                "hasCell": True,
                "position": {"x": 0, "y": 0},
                "enabled": True,
            },
            {
                "id": "traj-1",
                "type": "load_trajectory",
                "fileName": f"{base}.xtc",
                "position": {"x": 0, "y": 200},
                "enabled": True,
            },
            {
                "id": "viewport-1",
                "type": "viewport",
                "perspective": True,
                "cellAxesVisible": False,
                "pivotMarkerVisible": False,
                "position": {"x": 400, "y": 0},
                "enabled": True,
            },
        ],
        "edges": [
            {"source": "load-1", "sourceHandle": "particle", "target": "viewport-1", "targetHandle": "particle"},
            {"source": "load-1", "sourceHandle": "particle", "target": "traj-1", "targetHandle": "particle"},
            {"source": "traj-1", "sourceHandle": "trajectory", "target": "viewport-1", "targetHandle": "trajectory"},
        ],
    }
    with open(os.path.join(out, f"{base}.megane.json"), "w") as f:
        json.dump(pipeline, f, indent=2)
    print(f"wrote {n_atoms} atoms x {n_frames} frames to {out}")


if __name__ == "__main__":
    main()
