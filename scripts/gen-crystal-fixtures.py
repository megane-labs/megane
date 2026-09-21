#!/usr/bin/env python
"""Generate the ASE oracle fixtures for `src/crystal/` (bulk, supercell, slab, center).

The Builder's crystal tools are TypeScript ports of ASE's `bulk`,
`make_supercell`, `ase.build.surface` and `Atoms.center`; this script records
what ASE produces for a fixed set of inputs so `tests/ts/crystal/*.test.ts`
can compare atom for atom. Re-run it (and commit the JSON) whenever a case is
added:

    uv run --extra traj python scripts/gen-crystal-fixtures.py

ASE is an *oracle* only: megane never imports it at runtime.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from ase import Atoms
from ase.build import bulk, make_supercell, surface

OUT = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "crystal" / "ase-oracle.json"


def dump(atoms: Atoms) -> dict:
    return {
        "symbols": list(atoms.get_chemical_symbols()),
        "positions": np.round(atoms.get_positions(), 8).ravel().tolist(),
        "cell": np.round(np.array(atoms.cell), 8).ravel().tolist(),
    }


def bulk_case(name: str, structure: str, a: float, *, covera: float | None = None, cubic: bool = False):
    kwargs = {"a": a, "cubic": cubic}
    if covera is not None:
        kwargs["covera"] = covera
    atoms = bulk(name, structure, **kwargs)
    if covera is None and structure in ("hcp", "wurtzite"):
        # ASE falls back to the element's reference c/a; record what it used.
        covera = float(atoms.cell[2][2] / a)
    return {
        "kind": "bulk",
        "name": f"{name} {structure}{' cubic' if cubic else ''}",
        "input": {"name": name, "structure": structure, "a": a, "covera": covera, "cubic": cubic},
        "expected": dump(atoms),
    }


def supercell_case(name: str, base: Atoms, base_spec: dict, matrix: list[list[int]]):
    atoms = make_supercell(base, np.array(matrix))
    return {
        "kind": "supercell",
        "name": name,
        "input": {"base": base_spec, "matrix": [v for r in matrix for v in r]},
        "expected": dump(atoms),
    }


def slab_case(name: str, base: Atoms, base_spec: dict, miller: tuple, layers: int, vacuum: float | None):
    if vacuum is None:
        atoms = surface(base, miller, layers, periodic=True)
    else:
        atoms = surface(base, miller, layers, vacuum=vacuum)
    return {
        "kind": "slab",
        "name": name,
        "input": {"base": base_spec, "miller": list(miller), "layers": layers, "vacuum": vacuum or 0},
        "expected": dump(atoms),
    }


def center_case(name: str, base: Atoms, base_spec: dict, axes: list[int], vacuum: float | None):
    atoms = base.copy()
    atoms.center(vacuum=vacuum, axis=tuple(axes))
    return {
        "kind": "center",
        "name": name,
        "input": {"base": base_spec, "axes": axes, "vacuum": vacuum},
        "expected": dump(atoms),
    }


def spec(name: str, structure: str, a: float, **kw) -> tuple[Atoms, dict]:
    covera = kw.get("covera")
    cubic = kw.get("cubic", False)
    kwargs = {"a": a, "cubic": cubic}
    if covera is not None:
        kwargs["covera"] = covera
    return bulk(name, structure, **kwargs), {
        "name": name,
        "structure": structure,
        "a": a,
        "covera": covera,
        "cubic": cubic,
    }


def main() -> None:
    cases = []
    # Bulk prototypes, primitive and conventional.
    cases += [
        bulk_case("Cu", "sc", 2.5),
        bulk_case("Cu", "fcc", 3.61),
        bulk_case("Cu", "fcc", 3.61, cubic=True),
        bulk_case("Fe", "bcc", 2.87),
        bulk_case("Fe", "bcc", 2.87, cubic=True),
        bulk_case("Mg", "hcp", 3.21, covera=1.624),
        bulk_case("Ti", "hcp", 2.95),  # ideal c/a
        bulk_case("Si", "diamond", 5.43),
        bulk_case("Si", "diamond", 5.43, cubic=True),
        bulk_case("GaAs", "zincblende", 5.65),
        bulk_case("GaAs", "zincblende", 5.65, cubic=True),
        bulk_case("NaCl", "rocksalt", 5.64),
        bulk_case("NaCl", "rocksalt", 5.64, cubic=True),
        bulk_case("CsCl", "cesiumchloride", 4.12),
        bulk_case("CaFF", "fluorite", 5.46),
        bulk_case("CaFF", "fluorite", 5.46, cubic=True),
        bulk_case("ZnO", "wurtzite", 3.25, covera=5.21 / 3.25),
    ]
    cu_p, cu_p_spec = spec("Cu", "fcc", 3.61)
    cu_c, cu_c_spec = spec("Cu", "fcc", 3.61, cubic=True)
    fe_c, fe_c_spec = spec("Fe", "bcc", 2.87, cubic=True)
    mg, mg_spec = spec("Mg", "hcp", 3.21, covera=1.624)
    si_c, si_c_spec = spec("Si", "diamond", 5.43, cubic=True)
    nacl_c, nacl_c_spec = spec("NaCl", "rocksalt", 5.64, cubic=True)
    al_c, al_c_spec = spec("Al", "fcc", 4.05, cubic=True)
    cases += [
        supercell_case("Cu fcc primitive 2x2x2", cu_p, cu_p_spec, [[2, 0, 0], [0, 2, 0], [0, 0, 2]]),
        supercell_case("Cu fcc cubic 3x2x1", cu_c, cu_c_spec, [[3, 0, 0], [0, 2, 0], [0, 0, 1]]),
        supercell_case(
            "Cu fcc cubic sqrt2 rotated", cu_c, cu_c_spec, [[1, 1, 0], [-1, 1, 0], [0, 0, 1]]
        ),
        supercell_case("Cu fcc primitive to conventional", cu_p, cu_p_spec, [[-1, 1, 1], [1, -1, 1], [1, 1, -1]]),
        supercell_case("Mg hcp 2x2x1", mg, mg_spec, [[2, 0, 0], [0, 2, 0], [0, 0, 1]]),
    ]
    cases += [
        slab_case("Cu(111) cubic 3 layers 10 vac", cu_c, cu_c_spec, (1, 1, 1), 3, 10.0),
        slab_case("Cu(100) cubic 2 layers 5 vac", cu_c, cu_c_spec, (1, 0, 0), 2, 5.0),
        slab_case("Cu(110) cubic 3 layers 6 vac", cu_c, cu_c_spec, (1, 1, 0), 3, 6.0),
        slab_case("Cu(111) primitive 4 layers periodic", cu_p, cu_p_spec, (1, 1, 1), 4, None),
        slab_case("Al(211) cubic 3 layers 7 vac", al_c, al_c_spec, (2, 1, 1), 3, 7.0),
        slab_case("Fe(110) cubic 3 layers 8 vac", fe_c, fe_c_spec, (1, 1, 0), 3, 8.0),
        slab_case("Mg(0001) 3 layers 8 vac", mg, mg_spec, (0, 0, 1), 3, 8.0),
        slab_case("Mg(10-10) 2 layers 6 vac", mg, mg_spec, (1, 0, 0), 2, 6.0),
        slab_case("Si(111) cubic 2 layers 10 vac", si_c, si_c_spec, (1, 1, 1), 2, 10.0),
        slab_case("NaCl(100) cubic 2 layers 6 vac", nacl_c, nacl_c_spec, (1, 0, 0), 2, 6.0),
        slab_case("Cu(3-12) cubic 2 layers 4 vac", cu_c, cu_c_spec, (3, -1, 2), 2, 4.0),
    ]
    cases += [
        center_case("Mg hcp center c 5 vac", mg, mg_spec, [2], 5.0),
        center_case("Cu cubic center all 3 vac", cu_c, cu_c_spec, [0, 1, 2], 3.0),
        center_case("Cu cubic center all no vac", cu_c, cu_c_spec, [0, 1, 2], None),
    ]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"ase": __import__("ase").__version__, "cases": cases}, indent=1) + "\n")
    print(f"wrote {len(cases)} cases to {OUT}")


if __name__ == "__main__":
    main()
