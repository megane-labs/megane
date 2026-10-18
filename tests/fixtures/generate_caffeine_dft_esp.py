"""Generate the caffeine structure + DFT density + ESP cube set used by the
"ESP Map" template.

Writes three files that share one coordinate frame:

* ``caffeine_b3lyp.sdf``          — ``caffeine.sdf`` (PubChem CID 2519,
  Conformer3D) with its bond table untouched and its coordinates rotated by
  the cyclic axis permutation (x, y, z) -> (z, x, y). The PubChem conformer
  lies in the xy plane, edge-on to the viewer's default camera (which looks
  in from near +x); after the rotation the ring plane is the yz plane, facing
  it. A proper rotation, so no geometry changes.
* ``caffeine_b3lyp_density.cube`` — the total electron density rho(r), in
  e/Bohr^3.
* ``caffeine_b3lyp_esp.cube``     — the molecular electrostatic potential
  V(r) = sum_A Z_A / |r - R_A| - integral rho(r') / |r - r'| dr', in
  Hartree/e.

Both grids come from a single closed-shell B3LYP/6-31G* calculation with PySCF
at that fixed geometry (no optimization, so the cubes stay registered with
the SDF). Drawing the rho = 0.002 e/Bohr^3 isosurface (the
conventional "molecular surface" contour) and painting it with V is the
standard ESP map: red over the carbonyl oxygens and the imidazole N9 lone
pair, blue over the methyl and C8-H hydrogens.

This replaces nothing: ``caffeine_esp.cube`` (a classical point-charge toy
potential from ``generate_caffeine_esp.py``) stays as the fixture the parser
tests and the LLM benchmark golden case read.

Requirements (generation only, not a runtime dependency of megane):
    pip install pyscf numpy

Usage:
    python tests/fixtures/generate_caffeine_dft_esp.py
"""

import os

import numpy as np

# ─── Geometry ──────────────────────────────────────────────────────────

BOHR_TO_ANGSTROM = 0.529177210903  # CODATA 2018, matches src/.../parseCube.ts

HERE = os.path.dirname(os.path.abspath(__file__))
SDF_PATH = os.path.join(HERE, "caffeine.sdf")
OUT_SDF_PATH = os.path.join(HERE, "caffeine_b3lyp.sdf")


def rotate(x, y, z):
    """Cyclic axis permutation (x, y, z) -> (z, x, y): a proper rotation."""
    return z, x, y


ATOMIC_NUMBER = {"H": 1, "C": 6, "N": 7, "O": 8}

# ─── Method / grid parameters ──────────────────────────────────────────

XC = "b3lyp"
BASIS = "6-31g*"

# Padding around the nuclei and the grid step, both Angstroms. The 0.002
# density contour sits ~1.6-2.0 A out from the nuclei, so 3.4 A of padding
# keeps it clear of the box faces; a 0.36 A step resolves that smooth surface
# while keeping each file around 300 kB.
PADDING = 3.4
STEP = 0.36

# Points evaluated per batch (bounds the (nao, nao, npts) integral buffer).
CHUNK = 2000


def write_rotated_sdf(src, dst):
    """Copy a V2000 SDF record, rotating its atom coordinates; return the atoms.

    Only the three coordinate fields of each atom line change; the counts
    line, the rest of every atom line and the bond block are copied verbatim.
    Returns [(symbol, x, y, z)] in Angstroms, in the rotated frame.
    """
    with open(src) as f:
        lines = f.read().splitlines()
    n_atoms = int(lines[3][:3])
    lines[1] = "  megane   PubChem CID 2519, rotated (x,y,z)->(z,x,y); see generate_caffeine_dft_esp.py"
    atoms = []
    for i in range(4, 4 + n_atoms):
        line = lines[i]
        x, y, z = rotate(float(line[0:10]), float(line[10:20]), float(line[20:30]))
        lines[i] = f"{x:10.4f}{y:10.4f}{z:10.4f}" + line[30:]
        atoms.append((line[31:34].strip(), x, y, z))
    with open(dst, "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"wrote {dst}")
    return atoms


def build_grid(atoms):
    """Axis-aligned grid enclosing the molecule. Returns (origin, n, step) in Bohr."""
    xyz = np.array([a[1:] for a in atoms])
    lo = xyz.min(axis=0) - PADDING
    hi = xyz.max(axis=0) + PADDING
    n = np.ceil((hi - lo) / STEP).astype(int) + 1
    return lo / BOHR_TO_ANGSTROM, n, STEP / BOHR_TO_ANGSTROM


def grid_points(origin, n, step):
    """All grid points in Bohr, x slowest and z fastest (CUBE order)."""
    axes = [origin[i] + step * np.arange(n[i]) for i in range(3)]
    gx, gy, gz = np.meshgrid(*axes, indexing="ij")
    return np.stack([gx.ravel(), gy.ravel(), gz.ravel()], axis=1)


def run_scf(atoms):
    from pyscf import dft, gto

    mol = gto.M(
        atom=[(s, (x, y, z)) for s, x, y, z in atoms],
        basis=BASIS,
        unit="Angstrom",
        charge=0,
        spin=0,
        verbose=3,
    )
    mf = dft.RKS(mol)
    mf.xc = XC
    mf.conv_tol = 1e-9
    energy = mf.kernel()
    if not mf.converged:
        raise RuntimeError("SCF did not converge")
    return mol, mf.make_rdm1(), energy


def evaluate_density(mol, dm, coords):
    from pyscf.dft import numint

    rho = np.empty(len(coords))
    for start in range(0, len(coords), CHUNK):
        chunk = coords[start : start + CHUNK]
        ao = numint.eval_ao(mol, chunk)
        rho[start : start + CHUNK] = numint.eval_rho(mol, ao, dm)
    return rho


def evaluate_esp(mol, dm, coords):
    from pyscf import df, gto

    # Nuclear part.
    v_nuc = np.zeros(len(coords))
    for z_a, r_a in zip(mol.atom_charges(), mol.atom_coords()):
        v_nuc += z_a / np.linalg.norm(coords - r_a, axis=1)
    # Electronic part: <mu| 1/|r - P| |nu> contracted with the density matrix,
    # one point charge per grid point (what pyscf.tools.cubegen.mep does).
    v_ele = np.empty(len(coords))
    for start in range(0, len(coords), CHUNK):
        chunk = coords[start : start + CHUNK]
        fakemol = gto.fakemol_for_charges(chunk)
        ints = df.incore.aux_e2(mol, fakemol)
        v_ele[start : start + CHUNK] = np.einsum("ijp,ij->p", ints, dm)
    return v_nuc - v_ele


def write_cube(path, comment, atoms, origin, n, step, values):
    lines = [
        "Caffeine B3LYP/6-31G* (caffeine_b3lyp.sdf geometry, PySCF)",
        comment,
        f"{len(atoms):5d} {origin[0]:12.6f} {origin[1]:12.6f} {origin[2]:12.6f}",
    ]
    for axis in range(3):
        vec = [0.0, 0.0, 0.0]
        vec[axis] = step
        lines.append(f"{n[axis]:5d} {vec[0]:12.6f} {vec[1]:12.6f} {vec[2]:12.6f}")
    for sym, x, y, z in atoms:
        zn = ATOMIC_NUMBER[sym]
        bx, by, bz = (c / BOHR_TO_ANGSTROM for c in (x, y, z))
        lines.append(f"{zn:5d} {float(zn):12.6f} {bx:12.6f} {by:12.6f} {bz:12.6f}")
    grid = values.reshape(n[0], n[1], n[2])
    for ix in range(n[0]):
        for iy in range(n[1]):
            row = grid[ix, iy]
            for k in range(0, len(row), 6):
                lines.append(" ".join(f"{v: .4E}" for v in row[k : k + 6]))
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"wrote {path} ({os.path.getsize(path) / 1024:.0f} kB)")


def main():
    atoms = write_rotated_sdf(SDF_PATH, OUT_SDF_PATH)
    origin, n, step = build_grid(atoms)
    coords = grid_points(origin, n, step)
    print(f"grid {n[0]}x{n[1]}x{n[2]} = {len(coords)} points")

    mol, dm, energy = run_scf(atoms)
    print(f"E({XC.upper()}/{BASIS}) = {energy:.8f} Eh")

    rho = evaluate_density(mol, dm, coords)
    esp = evaluate_esp(mol, dm, coords)

    write_cube(
        os.path.join(HERE, "caffeine_b3lyp_density.cube"),
        "Total electron density in e/Bohr^3 -- see generate_caffeine_dft_esp.py",
        atoms,
        origin,
        n,
        step,
        rho,
    )
    write_cube(
        os.path.join(HERE, "caffeine_b3lyp_esp.cube"),
        "Electrostatic potential in Hartree/e -- see generate_caffeine_dft_esp.py",
        atoms,
        origin,
        n,
        step,
        esp,
    )


if __name__ == "__main__":
    main()
