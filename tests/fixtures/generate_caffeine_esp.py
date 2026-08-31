"""Generate the caffeine ESP demo pair used by the "ESP Isosurface" template.

Writes two files that are guaranteed to share one coordinate frame:

* ``caffeine.sdf``      — caffeine as a V2000 MOL/SDF record (24 atoms, 25
  bonds with orders). Coordinates are PubChem CID 2519 (Conformer3D), the same
  geometry ``generate_caffeine_water.py`` solvates.
* ``caffeine_esp.cube`` — the molecular electrostatic potential of that
  geometry on a regular grid, in the Gaussian CUBE format megane's
  ``load_volumetric`` node reads.

## What the potential actually is

The cube holds a *classical point-charge* electrostatic potential, not a
quantum-chemical one:

    V(r) = sum_i  q_i * erf(|r - r_i| / (sqrt(2) * SIGMA)) / |r - r_i|

i.e. the potential of Gaussian-smeared partial charges, in atomic units
(Hartree/e) with distances in Bohr, as the CUBE format expects. The smearing
keeps V finite at the nuclei and converges to the bare Coulomb potential a
couple of Angstroms out, which is where the isosurface the template draws
lives.

The partial charges are NOT a force-field or RESP set. They come from a
deliberately simple, fully specified electronegativity bond-increment scheme:
each bond moves ``K * order * (chi_j - chi_i)`` electrons toward the more
electronegative partner, with Pauling electronegativities. That is enough to
reproduce the qualitative ESP a chemist expects from caffeine — negative lobes
over the two carbonyl oxygens and the imidazole nitrogen, positive caps over
the methyl hydrogens — while summing to exactly zero net charge and staying
reproducible from this script alone. Do not quote these numbers as caffeine's
real charges.

Usage:
    python tests/fixtures/generate_caffeine_esp.py
"""

import math
import os

# ─── Caffeine geometry: PubChem CID 2519 (Conformer3D), Angstroms ──────
# Identical to the caffeine block in generate_caffeine_water.py so the two
# demo fixtures show the same molecule.
# fmt: off
CAFFEINE_ATOMS = [
    # (element, x, y, z)
    ("O",   0.4700,  2.5688,  0.0006),
    ("O",  -3.1271, -0.4436, -0.0003),
    ("N",  -0.9686, -1.3125,  0.0000),
    ("N",   2.2182,  0.1412, -0.0003),
    ("N",  -1.3477,  1.0797, -0.0001),
    ("N",   1.4119, -1.9372,  0.0002),
    ("C",   0.8579,  0.2592, -0.0008),
    ("C",   0.3897, -1.0264, -0.0004),
    ("C",   0.0307,  1.4220, -0.0006),
    ("C",  -1.9061, -0.2495, -0.0004),
    ("C",   2.5032, -1.1998,  0.0003),
    ("C",  -1.4276, -2.6960,  0.0008),
    ("C",   3.1926,  1.2061,  0.0003),
    ("C",  -2.2969,  2.1881,  0.0007),
    ("H",   3.5163, -1.5787,  0.0008),
    ("H",  -1.0451, -3.1973, -0.8937),
    ("H",  -2.5186, -2.7596,  0.0011),
    ("H",  -1.0447, -3.1963,  0.8957),
    ("H",   4.1992,  0.7801,  0.0002),
    ("H",   3.0468,  1.8092, -0.8992),
    ("H",   3.0466,  1.8083,  0.9004),
    ("H",  -1.8087,  3.1651, -0.0003),
    ("H",  -2.9322,  2.1027,  0.8881),
    ("H",  -2.9346,  2.1021, -0.8849),
]

# Bond table (1-indexed atom pairs, bond order) from PubChem.
CAFFEINE_BONDS = [
    (1, 9, 2), (2, 10, 2), (3, 8, 1), (3, 10, 1), (3, 12, 1),
    (4, 7, 1), (4, 11, 1), (4, 13, 1), (5, 9, 1), (5, 10, 1),
    (5, 14, 1), (6, 8, 1), (6, 11, 2), (7, 8, 2), (7, 9, 1),
    (11, 15, 1), (12, 16, 1), (12, 17, 1), (12, 18, 1),
    (13, 19, 1), (13, 20, 1), (13, 21, 1),
    (14, 22, 1), (14, 23, 1), (14, 24, 1),
]
# fmt: on

ATOMIC_NUMBER = {"H": 1, "C": 6, "N": 7, "O": 8}

# Pauling electronegativities.
ELECTRONEGATIVITY = {"H": 2.20, "C": 2.55, "N": 3.04, "O": 3.44}

# Electrons transferred per unit of bond order per unit electronegativity
# difference. Chosen so the carbonyl oxygens land near -0.5 e, the range a
# chemist expects for an amide C=O.
BOND_INCREMENT_K = 0.28

# ─── Grid / potential parameters ───────────────────────────────────────

BOHR_TO_ANGSTROM = 0.529177210903  # CODATA 2018, matches src/.../parseCube.ts

# Gaussian width of each smeared point charge, in Angstroms. Roughly an atomic
# charge-cloud size: large enough to tame the 1/r singularity, small enough
# that the potential is essentially the bare Coulomb one where the template's
# isosurface sits.
SIGMA = 0.9

# Padding around the molecular bounding box and the grid step, both Angstroms.
# 0.55 A keeps the file around 130 kB while staying well under the length scale
# on which this (smooth, smeared) potential varies.
PADDING = 3.6
STEP = 0.55


def bond_increment_charges(atoms, bonds):
    """Partial charges from the electronegativity bond-increment scheme.

    Returns a list of per-atom charges summing to exactly zero (every transfer
    adds to one atom and subtracts from another).
    """
    charges = [0.0] * len(atoms)
    for i, j, order in bonds:
        chi_i = ELECTRONEGATIVITY[atoms[i - 1][0]]
        chi_j = ELECTRONEGATIVITY[atoms[j - 1][0]]
        delta = BOND_INCREMENT_K * order * (chi_j - chi_i)
        charges[i - 1] += delta
        charges[j - 1] -= delta
    return charges


def smeared_potential(px, py, pz, positions, charges):
    """ESP at (px, py, pz) in Hartree/e; every argument in Bohr except charges."""
    sqrt2_sigma = math.sqrt(2.0) * (SIGMA / BOHR_TO_ANGSTROM)
    total = 0.0
    for (ax, ay, az), q in zip(positions, charges):
        dx, dy, dz = px - ax, py - ay, pz - az
        r = math.sqrt(dx * dx + dy * dy + dz * dz)
        if r < 1e-8:
            # erf(r/a)/r -> 2/(a*sqrt(pi)) as r -> 0.
            total += q * 2.0 / (sqrt2_sigma * math.sqrt(math.pi))
        else:
            total += q * math.erf(r / sqrt2_sigma) / r
    return total


def write_sdf(path, atoms, bonds):
    """Write caffeine as a V2000 MOL/SDF record."""
    lines = [
        "caffeine",
        "  megane   PubChem CID 2519 (Conformer3D)",
        "",
        f"{len(atoms):3d}{len(bonds):3d}  0  0  0  0  0  0  0  0999 V2000",
    ]
    for element, x, y, z in atoms:
        lines.append(
            f"{x:10.4f}{y:10.4f}{z:10.4f} {element:<3s} 0  0  0  0  0  0  0  0  0  0  0  0"
        )
    for i, j, order in bonds:
        lines.append(f"{i:3d}{j:3d}{order:3d}  0  0  0  0")
    lines.append("M  END")
    lines.append("$$$$")
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")


def write_cube(path, atoms, charges):
    """Write the smeared point-charge ESP of `atoms` as a Gaussian CUBE file."""
    xs = [a[1] for a in atoms]
    ys = [a[2] for a in atoms]
    zs = [a[3] for a in atoms]
    origin_a = (min(xs) - PADDING, min(ys) - PADDING, min(zs) - PADDING)
    span_a = (
        max(xs) - min(xs) + 2 * PADDING,
        max(ys) - min(ys) + 2 * PADDING,
        max(zs) - min(zs) + 2 * PADDING,
    )
    nx, ny, nz = (int(round(s / STEP)) + 1 for s in span_a)

    # CUBE lengths are Bohr.
    ox, oy, oz = (v / BOHR_TO_ANGSTROM for v in origin_a)
    step_b = STEP / BOHR_TO_ANGSTROM
    positions = [
        (x / BOHR_TO_ANGSTROM, y / BOHR_TO_ANGSTROM, z / BOHR_TO_ANGSTROM)
        for _, x, y, z in atoms
    ]

    header = [
        "Caffeine electrostatic potential (demo fixture)",
        "Gaussian-smeared point-charge ESP in Hartree/e -- see generate_caffeine_esp.py",
        f"{len(atoms):5d}{ox:12.6f}{oy:12.6f}{oz:12.6f}",
        f"{nx:5d}{step_b:12.6f}{0.0:12.6f}{0.0:12.6f}",
        f"{ny:5d}{0.0:12.6f}{step_b:12.6f}{0.0:12.6f}",
        f"{nz:5d}{0.0:12.6f}{0.0:12.6f}{step_b:12.6f}",
    ]
    for (element, _, _, _), (bx, by, bz), q in zip(atoms, positions, charges):
        z_num = ATOMIC_NUMBER[element]
        header.append(f"{z_num:5d}{q:12.6f}{bx:12.6f}{by:12.6f}{bz:12.6f}")

    values = []
    vmin, vmax = math.inf, -math.inf
    for ix in range(nx):
        px = ox + ix * step_b
        for iy in range(ny):
            py = oy + iy * step_b
            for iz in range(nz):
                pz = oz + iz * step_b
                v = smeared_potential(px, py, pz, positions, charges)
                values.append(v)
                vmin = min(vmin, v)
                vmax = max(vmax, v)

    body = []
    for start in range(0, len(values), 6):
        body.append("".join(f"{v:13.5E}" for v in values[start : start + 6]))

    with open(path, "w") as f:
        f.write("\n".join(header + body) + "\n")

    return nx, ny, nz, vmin, vmax


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    charges = bond_increment_charges(CAFFEINE_ATOMS, CAFFEINE_BONDS)

    sdf_path = os.path.join(here, "caffeine.sdf")
    write_sdf(sdf_path, CAFFEINE_ATOMS, CAFFEINE_BONDS)
    print(f"wrote {sdf_path} ({len(CAFFEINE_ATOMS)} atoms, {len(CAFFEINE_BONDS)} bonds)")

    cube_path = os.path.join(here, "caffeine_esp.cube")
    nx, ny, nz, vmin, vmax = write_cube(cube_path, CAFFEINE_ATOMS, charges)
    size_kb = os.path.getsize(cube_path) / 1024
    print(f"wrote {cube_path} ({nx}x{ny}x{nz} = {nx * ny * nz} voxels, {size_kb:.0f} kB)")
    print(f"  net charge {sum(charges):+.6f} e")
    print(f"  potential range [{vmin:.4f}, {vmax:.4f}] Hartree/e")
    print(f"  most negative charge {min(charges):+.3f} e, most positive {max(charges):+.3f} e")


if __name__ == "__main__":
    main()
