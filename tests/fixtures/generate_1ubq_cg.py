"""Coarse-grain 1ubq.pdb to one bead per residue.

Writes ``1ubq_cg.pdb``: the ubiquitin backbone reduced to a single pseudo-atom
per amino-acid residue, placed at that residue's heavy-atom **center of mass**
(1UBQ is a 1.8 A X-ray structure, so it carries no hydrogens). Consecutive
beads within a chain are joined by ``CONECT`` records, which gives megane's
``add_bond`` node a file-declared bead chain to draw with
``bondSource: "structure"``.

This is the classic one-bead-per-residue mapping used by residue-level models
(Go / elastic-network / UNRES-style). It is deliberately *not* a Martini
mapping — Martini splits most residues into a backbone plus one or more
side-chain beads.

The beads are pseudo-atoms, not chemistry: each is written with element ``C``
(so the viewer gives it a defined radius) and atom name ``BB``, while keeping
the parent residue's name, chain and sequence number so ``resname`` filters and
color-by-residue still line up with the all-atom model. The header says so in
``REMARK`` lines.

The output shares 1ubq.pdb's coordinate frame exactly, so loading both puts the
coarse-grained beads right on top of the all-atom structure — which is what the
"Coarse-Grained Overlay" pipeline template does.

Usage:
    python tests/fixtures/generate_1ubq_cg.py
"""

import os

# Standard atomic weights (IUPAC 2021), for the elements 1UBQ contains.
ATOMIC_MASS = {"C": 12.011, "N": 14.007, "O": 15.999, "S": 32.06}

# The 20 standard amino acids — HETATM waters and any other residue are skipped.
AMINO_ACIDS = {
    "ALA", "ARG", "ASN", "ASP", "CYS", "GLN", "GLU", "GLY", "HIS", "ILE",
    "LEU", "LYS", "MET", "PHE", "PRO", "SER", "THR", "TRP", "TYR", "VAL",
}


def read_residues(path):
    """Group ATOM records by (chain, resSeq, iCode), preserving file order."""
    residues = []
    index = {}
    with open(path) as f:
        for line in f:
            if not line.startswith("ATOM"):
                continue
            res_name = line[17:20].strip()
            if res_name not in AMINO_ACIDS:
                continue
            chain = line[21]
            res_seq = line[22:26].strip()
            i_code = line[26]
            element = line[76:78].strip() or line[12:16].strip()[0]
            key = (chain, res_seq, i_code)
            if key not in index:
                index[key] = len(residues)
                residues.append(
                    {"name": res_name, "chain": chain, "seq": res_seq, "icode": i_code, "atoms": []}
                )
            residues[index[key]]["atoms"].append(
                (element, float(line[30:38]), float(line[38:46]), float(line[46:54]))
            )
    return residues


def center_of_mass(atoms):
    total = 0.0
    cx = cy = cz = 0.0
    for element, x, y, z in atoms:
        m = ATOMIC_MASS[element]
        total += m
        cx += m * x
        cy += m * y
        cz += m * z
    return cx / total, cy / total, cz / total, total


def write_cg_pdb(path, residues):
    lines = [
        "REMARK   1 COARSE-GRAINED UBIQUITIN, ONE BEAD PER RESIDUE",
        "REMARK   1 GENERATED FROM 1ubq.pdb BY tests/fixtures/generate_1ubq_cg.py",
        "REMARK   1 EACH BEAD SITS AT ITS RESIDUE'S HEAVY-ATOM CENTER OF MASS AND",
        "REMARK   1 CARRIES THE PARENT RESIDUE NAME / CHAIN / SEQUENCE NUMBER.",
        "REMARK   1 BEADS ARE PSEUDO-ATOMS WRITTEN AS ELEMENT C; THE OCCUPANCY",
        "REMARK   1 COLUMN HOLDS THE MAPPED RESIDUE MASS IN DALTON / 100.",
        "REMARK   1 CONECT RECORDS JOIN CONSECUTIVE BEADS ALONG EACH CHAIN.",
    ]

    for serial, residue in enumerate(residues, start=1):
        x, y, z, mass = center_of_mass(residue["atoms"])
        lines.append(
            f"ATOM  {serial:5d}  BB  {residue['name']:>3s} {residue['chain']}"
            f"{residue['seq']:>4s}{residue['icode']}   "
            f"{x:8.3f}{y:8.3f}{z:8.3f}{mass / 100:6.2f}{0.0:6.2f}"
            f"          {'C':>2s}  "
        )

    # Bead i is bonded to bead i+1 whenever they belong to the same chain.
    for serial, residue in enumerate(residues, start=1):
        if serial >= len(residues):
            break
        if residues[serial]["chain"] != residue["chain"]:
            continue
        lines.append(f"CONECT{serial:5d}{serial + 1:5d}")

    lines.append("END")
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    residues = read_residues(os.path.join(here, "1ubq.pdb"))
    out = os.path.join(here, "1ubq_cg.pdb")
    write_cg_pdb(out, residues)
    n_atoms = sum(len(r["atoms"]) for r in residues)
    print(f"wrote {out}: {len(residues)} beads from {n_atoms} all-atom heavy atoms")
    print(f"  first bead {residues[0]['name']}{residues[0]['seq']}, "
          f"last bead {residues[-1]['name']}{residues[-1]['seq']}")


if __name__ == "__main__":
    main()
