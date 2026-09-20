# megane Builder (Structure Editor)

**megane Builder** is a separate app for *making* structures: open a PDB (or
any format megane reads) or start from an empty cell, add and delete atoms,
drag them around, change elements, draw or remove bonds, and save the result
as XYZ, PDB, or MOL. It lives beside the viewer at `/builder.html` — on the
hosted demo (<https://megane-labs.github.io/megane/app/builder.html>), in the
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

## Getting started

- **Open…** loads a structure file. Any format the viewer reads works
  (PDB, XYZ, MOL / SDF, MOL2, CIF, GRO, LAMMPS data, …). Only the structure
  is taken; trajectory frames are ignored.
- **New** (or *New empty cell* in the sidebar, with an edge length in Å)
  starts from an atom-less cubic cell. The cell is what the camera frames and
  what the *Add atom* tool places free atoms against, so the first click
  already puts an atom in the box. The document is called `untitled` until
  you save it.
- **Save XYZ / PDB / MOL** bakes the edited structure into a file named after
  the document (`caffeine.sdf` → `caffeine.xyz`). XYZ becomes extended XYZ
  with a `Lattice="…"` header when there is a cell; PDB carries `CRYST1`,
  residue labels and `CONECT` records; MOL is V2000 with bond orders.
- **Undo / Redo** in the top bar and in the sidebar's *History* section.

## Tools

| Tool | What a click in the 3D view does |
|---|---|
| **Select** | Selects the atom (Shift-click adds to the selection; clicking empty space clears it). The selection feeds *Delete selected* / *Set to element* in the sidebar and lets *Move* drag several atoms at once. |
| **Add atom** | On an atom: attaches a new atom of the chosen element at bond length (sum of covalent radii), pointing away from the atom's existing neighbours, and bonds it with the chosen bond order. On empty space: places a free atom at that point, at the depth of the rotation pivot. |
| **Bond** | Click two atoms to bond them. Clicking an already bonded pair changes the bond order to the one chosen in the sidebar. |
| **Delete** | Removes the atom and every bond it had. |
| **Move** | Drag an atom in the screen plane (the plane through the atom facing the camera). If the atom is part of the current selection, the whole selection moves. Dragging empty space still orbits the camera. |
| **Element** | Changes the clicked atom to the chosen element. |

The **Element** section picks the element for *Add* and *Element* (quick chips
for the common ones, or any atomic number), and the **bond order** used by
*Add* and *Bond*.

Editing never moves the camera: the view keeps its zoom and orientation across
every operation (and across Undo / Redo / Clear all). Only opening a file or
starting a new cell re-fits the view. *Reset View* and the axis buttons
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
  back as a molfile and, with **3D (RDKit)** ticked (the default), embedded
  in 3D by [RDKit](https://www.rdkit.org/) — the
  [`megane-rdkit`](https://github.com/hodakamori/megane-rdkit) WebAssembly
  build, loaded on first use and run in a Web Worker: ETKDG conformer
  generation, the hydrogens you left implicit added first, then an MMFF94s
  minimisation (UFF when MMFF has no parameters for the molecule). Wedge
  bonds in the drawing set the stereochemistry of the conformer, and the same
  sketch always embeds to the same geometry. The result goes through the same
  MOL parser every megane host uses and is centred; the molecule is a real 3D
  structure, with tetrahedral carbons and force-field bond lengths, not a
  flat drawing. Untick **Add hydrogens** to embed the bare skeleton you drew
  (hydrogens you drew explicitly in Ketcher are always kept).

  Untick **3D (RDKit)** to keep the drawing as it is instead: the unit-length
  sketch is rescaled to ångström (bond lengths from covalent radii),
  completed with the hydrogens you left implicit, and centred. Those
  hydrogens follow the usual valence rules (carbon fills to four bonds,
  nitrogen to three, oxygen to two, …; formal charges and the hypervalent S /
  P states are honoured, and an aromatic bond counts one and a half) and are
  placed in 3D from the atom's steric number — a CH₃ gets a tetrahedral cone,
  a CH₂ its pair above and below the drawing, a vinyl or aromatic CH stays in
  the plane — while the heavy atoms themselves stay exactly where you drew
  them, so the sketch is *flat* (the list marks it so) until you move its
  atoms. This is also the path the dialog falls back to where Web Workers are
  unavailable, and the one to pick when RDKit rejects a drawing it cannot
  sanitise (the dialog says so and points at the switch).
  **Paste MOL** in the dialog takes a molfile from elsewhere instead of
  drawing (it is embedded or kept flat by the same switch); it is also what
  the dialog falls back to if Ketcher cannot load.
- **From file…** imports any structure file megane reads as a molecule (3D
  coordinates are kept as they are).
- **Save selection** keeps the selected atoms, with the bonds between them,
  as a molecule — a quick way to lift a 3D fragment out of an opened file.
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

## History

The **History** section lists every operation in order and offers **Undo**,
**Redo**, **Clear all**, and **Show original** (a preview of the structure as
opened; editing is paused while it is on). The history is the document: the
structure you opened is never changed, and what you see is always that
structure with the operations replayed on it. An operation that no longer
applies is skipped and reported as a warning in the section rather than
blanking the structure.

Operations refer to atoms in two ways: atoms from the file by their index in
the opened structure, and atoms you created by an id the operation assigned.
That is why deleting an atom never breaks a later operation.

## Not yet

Editing the cell vectors themselves (only *New empty cell* sets a cell),
saving the document as a project file (the source plus its operations),
and keyboard shortcuts are deliberately not in this version; nor is the
Builder shipped inside the JupyterLab or VS Code hosts yet. The full design, including how a Builder
document is meant to travel into the viewer, is in
[Structure editing design](../dev/editor-design.md).
