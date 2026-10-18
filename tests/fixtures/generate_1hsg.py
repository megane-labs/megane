"""Fetch PDB entry 1HSG and write ``1hsg.pdb``, the demo structure of the
"Protein" template.

1HSG is HIV-1 protease (a C2-symmetric homodimer, chains A and B) with the
inhibitor indinavir (residue MK1) bound in its active site, at 2.0 A
(Chen et al., J. Biol. Chem. 269, 26344, 1994). PDB data is CC0.

The entry is written back record-for-record except that only the records the
template draws from are kept: the identification header (HEADER, TITLE, COMPND, SOURCE, EXPDTA), the HELIX/SHEET
secondary structure the cartoon follows, and the coordinate and connectivity
records (ATOM, HETATM, TER, CONECT, END). Coordinates, residue names, chain
IDs, B-factors and CONECT are untouched.

The crystallographic cell (CRYST1, with ORIGX/SCALE) is deliberately dropped:
the viewer frames the camera on the cell whenever a structure carries one, and
1HSG's 59.6 x 87.1 x 46.7 A box holds the dimer in one corner, so the
template's first view would show the protein small and off-centre. The
template never draws the cell, so nothing it shows is lost.

Usage:
    python tests/fixtures/generate_1hsg.py
"""

import os
import urllib.request

URL = "https://files.rcsb.org/download/1HSG.pdb"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "1hsg.pdb")

KEEP = (
    "HEADER",
    "TITLE ",
    "COMPND",
    "SOURCE",
    "EXPDTA",
    "HELIX ",
    "SHEET ",
    "ATOM  ",
    "HETATM",
    "TER   ",
    "CONECT",
    "END   ",
)


def main():
    with urllib.request.urlopen(URL) as resp:
        lines = resp.read().decode("ascii").splitlines()
    kept = [line for line in lines if line.ljust(6)[:6] in KEEP or line.rstrip() == "END"]
    with open(OUT, "w") as f:
        f.write("\n".join(kept) + "\n")
    print(f"wrote {OUT} ({len(kept)} records)")


if __name__ == "__main__":
    main()
