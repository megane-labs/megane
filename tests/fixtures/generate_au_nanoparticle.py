"""Generate ``au_nanoparticle.xyz``, the faceted gold cluster the "Surface Mesh"
template wraps in an alpha-shape envelope.

The cluster is a Wulff-shaped fcc gold particle: every lattice site of bulk
Au (a = 4.078 A) that lies inside both a {111} octahedron and a {100} cube,

    |x| + |y| + |z| <= sqrt(3) * H111      ({111} facets)
    max(|x|, |y|, |z|) <= RATIO * H111     ({100} facets)

with RATIO = gamma_100 / gamma_111 = 1.15, the surface-energy ratio commonly
quoted for gold. The result is a truncated octahedron: eight hexagonal {111}
facets and six square {100} facets, which an alpha-shape surface reproduces
as flat polygons. A bulk periodic crystal (the template's previous fixture)
has no free surface, so its envelope degenerates to the box outline.

The cluster is centred on an atom so it has the full Oh symmetry, carries no
cell (it is an isolated particle), and is written in a deterministic order:
sorted by distance from the centre, then by x, y, z.

Usage:
    python tests/fixtures/generate_au_nanoparticle.py
"""

import math
import os

LATTICE_A = 4.078  # fcc gold, Angstroms
H111 = 16.0  # centre-to-{111}-facet distance, Angstroms
RATIO = 1.15  # gamma_100 / gamma_111 -> h_100 / h_111 (Wulff construction)
EPS = 1e-6

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "au_nanoparticle.xyz")


def fcc_sites(extent):
    """fcc sites (i + j + k even on the a/2 grid) within a cube of half-width extent."""
    half = LATTICE_A / 2
    n = int(math.ceil(extent / half)) + 1
    for i in range(-n, n + 1):
        for j in range(-n, n + 1):
            for k in range(-n, n + 1):
                if (i + j + k) % 2 == 0:
                    yield (i * half, j * half, k * half)


def inside(x, y, z):
    ax, ay, az = abs(x), abs(y), abs(z)
    return ax + ay + az <= math.sqrt(3) * H111 + EPS and max(ax, ay, az) <= RATIO * H111 + EPS


def main():
    atoms = [p for p in fcc_sites(RATIO * H111) if inside(*p)]
    atoms.sort(key=lambda p: (round(math.dist(p, (0, 0, 0)), 6), p))
    lines = [
        str(len(atoms)),
        f"Au Wulff nanoparticle, fcc a={LATTICE_A} A, h111={H111} A, "
        f"h100/h111={RATIO} -- see generate_au_nanoparticle.py",
    ]
    lines += [f"Au {x:10.4f} {y:10.4f} {z:10.4f}" for x, y, z in atoms]
    with open(OUT, "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"wrote {OUT} ({len(atoms)} atoms)")


if __name__ == "__main__":
    main()
