"""Write cu_slab_opt.traj: an ASE geometry optimization as an optimizer writes it.

A Cu(111) slab (3x3x4) with a CO molecule on top, the bottom two layers held
by FixAtoms, relaxed by BFGS on the EMT calculator for 8 steps. Every frame
carries what ASE's optimizers store and the MD fixtures do not: the
constraint, the atoms' tags and the calculator's energy, forces, stress and
per-atom energies (#960).

Usage: python tests/fixtures/generate_cu_slab_opt_traj.py
Needs ASE (not a megane dependency; use a scratch venv).
"""

import os

import numpy as np
from ase.build import add_adsorbate, fcc111, molecule
from ase.calculators.emt import EMT
from ase.constraints import FixAtoms
from ase.optimize import BFGS

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cu_slab_opt.traj")

slab = fcc111("Cu", size=(3, 3, 4), vacuum=6.0)
add_adsorbate(slab, molecule("CO"), 2.0, "ontop")
slab.set_constraint(FixAtoms(mask=[atom.tag > 2 for atom in slab]))
free = np.array([atom.tag <= 2 for atom in slab])
slab.positions += np.random.default_rng(0).normal(0, 0.05, slab.positions.shape) * free[:, None]
slab.calc = EMT()
if os.path.exists(OUT):
    os.remove(OUT)
# fmax this small never converges: exactly 8 steps, 9 frames.
BFGS(slab, trajectory=OUT, logfile=None).run(fmax=1e-9, steps=8)
