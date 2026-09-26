# megane Builder (Structure Editor)

**megane Builder** is a separate app for *making* structures: open a PDB (or
any format megane reads) or start from an empty cell, add and delete atoms,
drag them around, change elements, draw or remove bonds, and save the result
as XYZ, PDB, or MOL. It lives beside the viewer at `/builder.html` — on the
hosted demo ([megane-labs.github.io/megane/app/builder.html](https://megane-labs.github.io/megane/app/builder.html)), in the
web app that `megane serve` hosts, and in the Vite dev server (`npm run dev`,
then open `http://localhost:5173/builder.html`).

The viewer and the Builder are deliberately different tools. The viewer's
pipeline describes how a structure is *shown* (bonds, filters, colours,
supercells, trajectories); the Builder changes what a structure *is*. So the
Builder has no pipeline: its 3D view always shows the document — the structure
as opened plus your edits — drawn as ball-and-stick with every atom, its own
bonds and its cell, and every click in the view is an edit. Bringing a Builder
document into the viewer is a planned follow-up; the two already share the
same edit-history format (the `load_structure` node's `edits` list), so
nothing has to be re-encoded when they meet.

## The window

The top bar owns the **document**: *Open…*, *New* (an empty cell or a bulk
crystal), *Undo* / *Redo*, *Save*, and the theme. The sidebar owns the
**structure**: the tool and the settings that tool uses, the molecule library,
the crystal tools, and the history. The bar along the bottom says what is on
screen (atoms, bonds, cell, selection) and what the current tool does, and any
message — a file that would not parse, a molecule added to the library —
appears on one line just above it until you dismiss it.

The sidebar's *Library*, *Crystal* and *History* sections fold away; each one
remembers whether you left it open. Their headers keep the summary visible
while they are closed (the number of molecules, the cell, the number of edits).

## Getting started

- **Open…** loads a structure file. Any format the viewer reads works
  (PDB, XYZ, MOL / SDF, MOL2, CIF, GRO, LAMMPS data, …). Only the structure
  is taken; trajectory frames are ignored. Dropping a file anywhere on the 3D
  view opens it too.
- **New** starts a document from scratch, in a dialog with two tabs:
  *Empty cell* — an atom-less cubic cell of the edge you give in Å; the cell
  is what the camera frames and what the *Add atom* tool places free atoms
  against, so the first click already puts an atom in the box, and the
  document is called `untitled` until you save it — and *Bulk crystal*, a
  prototype structure (see [Crystal](#crystal)). Either replaces whatever is
  open, which the dialog says when there is something to replace.
- **Save XYZ / PDB / MOL** bakes the edited structure into a file named after
  the document (`caffeine.sdf` → `caffeine.xyz`). XYZ becomes extended XYZ
  with a `Lattice="…"` header when there is a cell; PDB carries `CRYST1`,
  residue labels and `CONECT` records; MOL is V2000 with bond orders.
- **Undo / Redo** in the top bar, in the sidebar's *History* section, or with
  the keys below.

## Tools

| Tool | Key | What a click in the 3D view does |
|---|---|---|
| **Select** | S | Selects the atom (Shift-click adds to the selection; clicking empty space clears it). The selection feeds *Delete* / *Set to element* / *Save selection* and lets *Move* drag several atoms at once. |
| **Add atom** | A | On an atom: attaches a new atom of the chosen element at bond length (sum of covalent radii), pointing away from the atom's existing neighbours, and bonds it with the chosen bond order. On empty space: places a free atom at that point, at the depth of the rotation pivot. |
| **Bond** | B | Click two atoms to bond them. Clicking an already bonded pair changes the bond order to the one chosen in the sidebar. |
| **Delete** | D | Removes the atom and every bond it had. |
| **Move** | M | Drag an atom in the screen plane (the plane through the atom facing the camera). If the atom is part of the current selection, the whole selection moves. Dragging empty space still orbits the camera. |
| **Element** | E | Changes the clicked atom to the chosen element (and rebalances its hydrogens, see below). |
| **Place** | P | Stamps the library molecule chosen below (see [Library](#library)). |

**Hydrogens are kept balanced.** When the structure already carries explicit
hydrogens, *Add atom* and *Element* edit it the way a chemist expects:

- *Add atom* on a **hydrogen replaces it** with the chosen element, which is
  moved out to the right bond length. Clicking an H of methane with C gives
  ethane (C–C), not C–H–C. On a heavy atom that has no free valence left,
  one of its hydrogens is replaced the same way.
- The new or changed atom gets as many hydrogens as its usual valence leaves
  room for (C 4, N 3, O 2, halogens 1, …), in a tetrahedral / trigonal /
  linear geometry depending on its bond orders, and surplus ones are removed.
  Setting propane's middle C to O gives CH₃–O–CH₃; replacing the H of an
  ethanol OH with C gives CH₃–CH₂–O–CH₃. A double bond also trims the
  neighbour's extra hydrogen.
- Each click, hydrogens included, is **one Undo step**.

A bare skeleton (no hydrogen anywhere) is left bare, as are elements with no
single usual valence (metals); add hydrogens yourself in that case.

The *Tool* panel shows **only the settings the current tool uses**: the element
(quick chips for the common ones, or any atomic number) for *Add atom* and
*Element*, the bond order for *Add atom* and *Bond*, and *Place on atoms* for
*Place*. Whenever atoms are selected, the actions for that selection appear
under the tool as well.

## Keyboard

| Key | What it does |
|---|---|
| S A B D M E P | Pick the tool of that letter |
| Ctrl/⌘ + Z, Ctrl/⌘ + Shift + Z (or Ctrl + Y) | Undo, redo |
| Delete, Backspace | Delete the selected atoms |
| Esc | Drop the pending bond, then the selection, then the *Place* molecule |
| Ctrl/⌘ + O, Ctrl/⌘ + S | Open a file, save XYZ |
| R | Reset the view |

Keys are ignored while a text field or a dialog has the keyboard, so typing a
lattice constant never switches tools.

Editing never moves the camera: the view keeps its zoom and orientation across
every operation (and across Undo / Redo / Clear all). Only opening a file or
starting a new document re-fits the view. *Reset View* and the axis buttons
(±x / ±y / ±z, and ±a / ±b / ±c while there is a cell) work as in the viewer.

## Library

The **Library** section of the sidebar keeps molecules ready to drop into the
document. It starts with a set of presets — water, ammonia, methane, carbon
dioxide, methanol, ethanol, benzene, H₂, N₂, O₂ — with real 3D geometries,
and grows with your own molecules:

- **Sketch…** opens [Ketcher](https://lifescience.opensource.epam.com/ketcher/),
  the open-source 2D structure editor, in a dialog (it runs entirely in the
  browser with its standalone Indigo engine, so it loads on first use and
  needs no server). Draw the molecule, give it a name (the formula is used
  when you leave it blank), and press **Add to library**. The sketch is read
  back as a molfile and embedded in 3D by [RDKit](https://www.rdkit.org/) —
  the [`megane-rdkit`](https://github.com/hodakamori/megane-rdkit)
  WebAssembly build, loaded on first use and run in a Web Worker: ETKDG
  conformer generation, the hydrogens you left implicit added first, then an
  MMFF94s minimisation (UFF when MMFF has no parameters for the molecule).
  Wedge bonds in the drawing set the stereochemistry of the conformer, and
  the same sketch always embeds to the same geometry. The result goes
  through the same MOL parser every megane host uses and is centred; the
  molecule is a real 3D structure, with tetrahedral carbons and force-field
  bond lengths, not a flat drawing. Untick **Add hydrogens** to embed the
  bare skeleton you drew (hydrogens you drew explicitly in Ketcher are
  always kept). RDKit is the only way a sketch becomes 3D: if it cannot run
  (a browser without Web Workers, or a drawing it cannot sanitise) the
  dialog reports the error and nothing is added.
  **Paste MOL** in the dialog takes a molfile from elsewhere instead of
  drawing (it is embedded the same way); it is also what the dialog falls
  back to if Ketcher cannot load.
- **From file…** imports any structure file megane reads as a molecule (3D
  coordinates are kept as they are).
- **Save selection** keeps the selected atoms, with the bonds between them,
  as a molecule — a quick way to lift a 3D fragment out of an opened file.
  A flat 2D file (a molfile without z coordinates) is only rescaled to
  ångström and marked *flat* in the list; the Builder never invents a
  conformer for it.
- **Edit** (on a sketched molecule) reopens the sketch in Ketcher; adding the
  result makes a new library entry. **×** removes a molecule you added.

Your molecules are stored in the browser (`localStorage`), so they are there
after a reload; the presets are always listed first and cannot be removed.

Each molecule has two ways into the document:

- **Add** drops it beside the structure: past the structure's bounding box
  along +x, level with its centre (or at the cell centre when the cell is
  still empty). The new atoms are selected, so switching to *Move* and
  dragging one of them carries the whole molecule to where you want it.
- **Place** chooses it for the **Place** tool: every click on empty space in
  the 3D view stamps a copy with its centre at that point (at the depth of
  the rotation pivot, like *Add atom*). Clicking an atom does nothing, so a
  molecule never lands on top of one. Press *Place* again on the same
  molecule to turn the tool off.

Either way the molecule enters the history as one `add_fragment` operation
(named after the molecule, e.g. `Add water-3 (3 atoms)`), so Undo removes it
whole and the fragment's atoms can be addressed by later operations.

To put a molecule *on* a surface, tick **Place on atoms** in the *Place*
tool's settings and give a height:
the Place tool then also accepts a click on an atom and stamps the molecule
that many Å above it along the cell's c axis (the slab normal; +z without a
cell) — an adsorbate on the site you clicked. Leave it unticked and clicks on
atoms stay inert.

## Crystal

The **Crystal** section edits the solid the document holds. Its three tabs,
plus the symmetry offer that appears for CIF files, cover the ASE-style
workflow of bulk → supercell → slab → adsorbate without leaving the browser;
the geometry is computed in TypeScript and pinned to what ASE produces by the
tests (`tests/fixtures/crystal/ase-oracle.json`).

- **Bulk crystal** is a *new document*, so it lives in the top bar's *New*
  dialog rather than in this section: a prototype structure — simple cubic,
  fcc, bcc, hcp, diamond, zincblende, rocksalt, CsCl, fluorite, wurtzite or
  perovskite, with the element(s), the lattice constant `a`, `c/a` for the
  hexagonal ones, and *conventional cell* for the cubic ones (the primitive
  cell otherwise, exactly as `ase.build.bulk`). The **Examples…** list fills
  the fields with reference lattice constants (Cu, Al, Fe, Mg, Si, NaCl, GaAs,
  SrTiO₃, …). The document is named after the crystal (`Cu-fcc`) and, like
  an empty cell, replaces whatever is open.
- **Cell** edits the cell as `a b c α β γ`. With *move atoms with the cell*
  on, the atoms keep their fractional coordinates (ASE's `scale_atoms`);
  off, they stay where they are. **Wrap atoms** folds every atom back into
  the cell; **Center + vacuum** centres the atoms along the chosen axes and
  resizes those cell vectors to leave the given vacuum on each side
  (`Atoms.center`). **Remove cell** drops the cell.
- **Supercell** repeats the cell `na × nb × nc` — or, with **Matrix**, by any
  integer 3×3 transformation whose rows are the new lattice vectors in units
  of the old ones (`make_supercell`; `[1 1 0 / −1 1 0 / 0 0 1]` is the √2×√2
  R45° cell, `[−1 1 1 / 1 −1 1 / 1 1 −1]` turns a primitive fcc cell into the
  conventional one). The line beside the button says how many atoms the
  result will have. Bonds are carried along: a bond that crossed the cell
  face now reaches the neighbouring image, as the viewer's Replicate node
  draws it.
- **Slab** cuts the (h k l) surface out of the current cell
  (`ase.build.surface`): the surface unit cell is repeated *layers* times
  along the normal, rotated so the first surface vector lies along x and
  the normal along z, and centred in *vacuum* Å of empty space on each side
  (0 keeps the slab periodic). The **termination** slider slides the cut
  along the normal so a different plane ends up on top. The line beside the
  button previews the atom count and thickness before you commit. Bonds that
  would have crossed into the vacuum are dropped; in-plane periodic ones are
  kept.
- **Expand symmetry** appears when the opened file (a CIF) lists space-group
  operations for its asymmetric unit, and fills the unit cell with the
  symmetry-equivalent atoms the way the viewer's Symmetry node does. Do it
  before cutting a supercell or slab; the offer goes away once the cell has
  been changed, because the operations no longer apply.

Each action is one operation in the history (`Supercell 2×2×1`,
`Slab (1 1 1), 4 layers, 10 Å vacuum`, `Expand symmetry`, …), so Undo takes
it back whole. Supercell, slab and symmetry expansion replace every atom;
atoms you had selected are deselected and later operations address the new
structure.

## Python tools

Structure generators written in Python — packmol liquid boxes, RadonPy
polymer chains, solvation — appear as buttons in the **Python tools**
section. They run in a separate *tool server*, an
[MCP](https://modelcontextprotocol.io/) server that follows the
[Builder Tool Contract](../dev/builder-tools.md). Start the reference server
with HTTP on your machine, allowing the page you opened Builder from:

```bash
uvx megane-builder-tools --transport http --port 8765 \
    --allow-origin http://localhost:8080
```

It prints a bearer token. Paste the server URL (`http://127.0.0.1:8765/mcp`)
and the token into the section and press **Connect**; the tools appear grouped
by category. A button opens the tool's form: molecules are picked from the
library, atoms (such as a monomer's head and tail) from a list of the chosen
molecule's atoms, and the seed is filled in for you. **Run** shows the
server's progress and can be cancelled.

- Tools that build something new (*Liquid box*, *Polymer chain*) replace the
  open document; the form warns you when that would discard edits.
- Tools that add to the open structure (*Solvate*) add their atoms as one
  operation in the history, so a single **Undo** removes them.
- If the tool refuses (not enough room, a head atom without a hydrogen, …),
  its message is shown and the form stays open with your values.

Opening Builder with `#tools=<url>&token=<token>` at the end of its address
connects on load. Anyone can write a tool server with the
[`megane-builder-tools` SDK](https://github.com/hodakamori/megane-builder-tools).

## History

The **History** section lists every operation in order and offers **Undo**,
**Redo**, **Clear all**, and **Show original** (a preview of the structure as
opened; editing is paused while it is on, and a banner at the top of the
sidebar offers the way back). The history is the document: the
structure you opened is never changed, and what you see is always that
structure with the operations replayed on it. An operation that no longer
applies is skipped and reported as a warning in the section rather than
blanking the structure.

Operations refer to atoms in two ways: atoms from the file by their index in
the opened structure, and atoms you created by an id the operation assigned.
That is why deleting an atom never breaks a later operation.

## Not yet

Saving the document as a project file (the source plus its operations),
building a crystal from a space-group number and
Wyckoff positions, and enumerating the distinct terminations of a slab
(pymatgen's `SlabGenerator`) are deliberately not in this version; nor is
the Builder shipped inside the JupyterLab or VS Code hosts yet. The full design, including how a Builder
document is meant to travel into the viewer, is in
[Structure editing design](../dev/editor-design.md).
