# Megane Builder (Structure Editor)

**Megane Builder** is a separate app for *making* structures: open a PDB (or
any format Megane reads) or start from an empty cell, add and delete atoms,
drag them around, change elements, draw or remove bonds, and save the result
as XYZ, PDB, MOL, or — for a crystal, slab or anything else with a unit cell —
CIF or VASP POSCAR. It lives beside the viewer at `/builder.html` — on the
hosted demo ([megane-labs.github.io/megane/app/builder.html](https://megane-labs.github.io/megane/app/builder.html)), in the
web app that `megane serve` hosts, and in the Vite dev server (`npm run dev`,
then open `http://localhost:5173/builder.html`) — and inside VS Code,
JupyterLab and Jupyter notebooks (see
[In VS Code, JupyterLab and notebooks](#in-vs-code-jupyterlab-and-notebooks)).

The viewer and the Builder are deliberately different tools. The viewer's
pipeline describes how a structure is *shown* (bonds, filters, colours,
supercells, trajectories); the Builder changes what a structure *is*. It has
two modes, switched at the top of the rails on the left. In **Manual** mode
the 3D view always shows the document — the structure as opened plus your
edits — drawn as ball-and-stick with every atom, its own bonds and its cell,
and every click in the view is an edit. In **Flow** mode you build a model by
connecting blocks instead — a molecule from SMILES, a packmol liquid box fed
by it — and run them (see [Flow mode](#flow-mode)). Both modes work on the
same structure: what a Flow run builds is what Manual mode then edits, and
what you edit in Manual mode is what Flow mode shows and reads. Bringing a Builder
document into the viewer is a planned follow-up; the two already share the
same edit-history format (the `load_structure` node's `edits` list), so
nothing has to be re-encoded when they meet.

## The window

The Builder looks and behaves like the viewer: the 3D view fills the window
and every control floats over it on the same frosted-glass panels.

Everything you *do* is on the left of the view; the options of what you
picked, and the history, are on the right; what you are looking at is along
the top.

The **top-left corner** has the viewer's camera controls — *Reset View* and
the axis buttons (look along ±x / ±y / ±z, and ±a / ±b / ±c while there is a
cell). Under them the **mode switch** picks *Manual* or *Flow*; the rails
under it follow the mode. In Manual mode the **tool rail** picks the tool, one icon per tool, each
marked with its key, and under that the **operations rail** holds every
action, top to bottom: **File** (*Open…*, *New empty cell…* /
*New bulk crystal…* and *Save* in each format); **Structure**, the operations
on the cell and the crystal (see [Crystal](#crystal)), and **Tools**, the
Python tools (see [Python tools](#python-tools)); *Undo* and *Redo*; and the theme button
(Light → Dark → Auto, as in the viewer; the 3D view's background follows it).
The menus open to the right of their button; hover a button for its name.

The **info line** beside *Reset View*, where the viewer shows its atom and
bond counts, says what you are looking at: the document's name and how many
edits it carries, then the structure's formula (Hill order), atoms and
bonds, molar mass, and cell.

On the right are two of the viewer's collapsible panels (where the viewer
keeps its *Pipeline*); ▶ folds either to a small button, and with both folded
the view has the whole window. **Details** shows the options of whatever you
picked on the left: the current tool's settings (see below) and the selected
atoms (see [Inspector](#inspector)), or — while one is open — the form a menu
item opened: a Structure operation, *New structure*, the tool server or a
Python tool. One form at a time; *Cancel*, *Close* or Esc returns to the
tool's settings. **History**, under it, lists the edits (see
[History](#history)); it starts folded for a document without edits, and
both panels remember whether you left them open.

The line at the **bottom left**, right of the rails, says what the current
tool does (and what is selected, and when the view shows a preview), and any
message — a file that would not parse, a molecule added to the library —
appears on one line just above it until you dismiss it.

## Getting started

With nothing open, the view shows *Build a structure* with **Open…**,
**New empty cell…** and **New bulk crystal…**, the same as the *File* menu.

- **File › Open…** loads a structure file. Any format the viewer reads works
  (PDB, XYZ, MOL / SDF, MOL2, CIF, GRO, LAMMPS data, …). Only the structure
  is taken; trajectory frames are ignored. Dropping a file anywhere on the 3D
  view opens it too.
- **File › New empty cell… / New bulk crystal…** starts a document from
  scratch, in a form with two tabs in the Details panel:
  *Empty cell* — an atom-less cubic cell of the edge you give in Å; the cell
  is what the camera frames and what the *Add atom* tool places free atoms
  against, so the first click already puts an atom in the box, and the
  document is called `untitled` until you save it — and *Bulk crystal*, a
  prototype structure (see [Crystal](#crystal)). Either replaces whatever is
  open, which the form says when there is something to replace.
- **File › Save XYZ / PDB / MOL / CIF / POSCAR** bakes the edited structure into a file named after
  the document (`caffeine.sdf` → `caffeine.xyz`). XYZ becomes extended XYZ
  with a `Lattice="…"` header when there is a cell; PDB carries `CRYST1`,
  residue labels and `CONECT` records; MOL is V2000 with bond orders.
  CIF and POSCAR need a unit cell and are unavailable without one. CIF is
  written in space group P 1 with fractional coordinates (`quartz.cif`);
  POSCAR is VASP 5 with Cartesian coordinates (`quartz.vasp`, or the
  document's own name for `POSCAR` / `CONTCAR`), and lists the atoms element
  by element in order of first appearance, so its atom order can differ from
  the Builder's. Neither format stores bonds: readers infer them again.
- **Undo / Redo** on the operations rail, in the *History* panel, or with
  the keys below.
- Or skip all of that: pick **Place** (P) and place a library molecule with
  nothing open — the first molecule starts an `untitled` document without a
  cell (see [Library](#library)).

## Tools

| Tool | Key | What a click in the 3D view does |
|---|---|---|
| **Select** | S | Selects the atom (Shift- or Ctrl/⌘-click toggles it in or out of the selection; clicking empty space clears it); right-click an atom to select its molecule. Dragging a selected atom moves the selection; dragging anywhere else turns the view, or draws a box while **Box** is on (see [Mouse](#mouse)). Its settings add **Box**, **All**, **Invert**, one chip per element with its count (selects every atom of that element), and **Snap**. The selection feeds the [Inspector](#inspector) (*Delete*, *Set to*, *Save as fragment*, *Clean up*, the measurement, *Transform*). |
| **Add atom** | A | On an atom: attaches a new atom of the chosen element at bond length (sum of covalent radii), pointing away from the atom's existing neighbours, and bonds it with the chosen bond order. On empty space: places a free atom at that point, at the depth of the rotation pivot. |
| **Bond** | B | Click two atoms to bond them. Clicking an already bonded pair changes the bond order to the one chosen in its settings. |
| **Delete** | D | Removes the atom and every bond it had. |
| **Move** | M | Like *Select*, except that dragging *any* atom moves it at once, without selecting it first: the atom alone, or the whole selection when it is part of it. Clicks select as with *Select*. |
| **Element** | E | Changes the clicked atom to the chosen element (and rebalances its hydrogens, see below). |
| **Place** | P | Stamps the library molecule chosen in its settings (see [Library](#library)). |

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

The Details panel shows **only the settings the current tool uses**: the
element (one-click buttons for the common ones; **Periodic table** opens a
table of every element up to U beside the panel — cells tinted by family,
and pointing at one shows its name, atomic number, mass, family and the
colour the view draws it in; or any atomic number in the *Z* field) for
*Add atom* and *Element*, the bond order (single, double, triple, aromatic)
for *Add atom* and *Bond*, Box / All / Invert and the element chips for *Select*,
**Snap** and a list of the drag gestures for *Select* and *Move*, and the
molecule and *On atoms* for *Place*. *Delete* has no settings.

## Mouse

The Builder takes the mouse the way the [viewer](./web.md#mouse-controls)
does: a drag turns the view, and only a drag that starts on an atom the
current tool can move edits the structure.

| Gesture | What it does |
|---|---|
| Left drag | Rotate the view, as in the viewer |
| Right drag, Shift + left drag | Pan the view |
| Middle drag, wheel | Zoom |
| Double-click an atom or bond | Make it the rotation center; on empty space, reset it to the model center |
| Click | The current tool's action (*Select* / *Move*: select the atom) |
| Shift- or Ctrl/⌘-click | Toggle the atom in or out of the selection |
| Drag a selected atom (*Select*), any atom (*Move*) | Move the selection in the screen plane |
| … with Shift | Move it in depth: up pushes it away from you, down pulls it toward you |
| … with Ctrl/⌘ | Rotate it about its centre, like a trackball |
| … with Ctrl/⌘ + Shift | Spin it about the line of sight, following the pointer around the centre |
| X, Y, Z (or A, B, C with a cell) during a drag | Lock the motion to that axis (moves go along it, rotations turn about it); press it again to free the drag |
| Esc during a drag | Cancel the drag: the atoms go back where they were |
| Alt + left drag | Rotate the view, even from an atom |
| Drag with **Box** on (*Select*) | Draw a box from anywhere but a selected atom and select what it holds; Shift adds to the selection, Ctrl/⌘ removes from it. The view stops turning on a left drag while Box is on, as with the viewer's *Box select* |
| Right-click an atom | The [atom menu](#inspector): select its molecule or every atom of its element, and more |

While a drag runs, the status line under the view says what it did so far —
`Move 1.20 Å (1.00, 0.50, 0.00)`, `Move 0.80 Å along x`, `Rotate 30.0°` —
with *snap* when **Snap** is on (moves rounded to 0.1 Å, turns to 15°). Atoms
the drag brings **too close** to an atom they are not bonded to (nearer than
half the sum of their van der Waals radii) turn red, and when the drag ends
there, the notice line says so — Undo takes the move back. However long it
runs, a drag is **one Undo step**.

Under the pointer, the atom a click would act on is marked in the colour of
what the click does: blue to select, red to delete, amber to change its
element, violet to attach to, bond or place onto it.

## Inspector

The structure as a whole is on the info line over the view. The Details
panel describes the selection:

- **Atoms selected**: each selected atom (element, index and x y z in Å; the
  first six are listed and the rest counted) and, for **2, 3 or 4 atoms, the
  distance, angle or dihedral** they span, taken in the order you picked
  them (Shift-click adds the next one). Below that, what can be done with
  them: **Set to** an element chosen in the list, **Save as fragment** (keeps
  them in the library, see below), **Clean up** (see
  [Clean up geometry](#clean-up-geometry)), **Delete**, and **×** to clear the
  selection (or Esc).
- **Setting a measurement**: type a new distance (Å), angle or dihedral (°)
  under the measurement and press **Set**. The *last* atom you picked moves,
  together with everything bonded to it on its side — the rest of the chain
  for a bond, the whole substituent for an angle or a torsion — so a
  molecule keeps its shape while one coordinate changes. When that atom is
  in a ring with the others, only the atom itself moves. The change is one
  Undo step.
- **Transform**: **Move by** a typed displacement (Δx Δy Δz in Å), or
  **Rotate** by a typed angle about x, y or z (or the cell's a, b or c) through
  the selection's centre. Each is one Undo step.

**Right-click an atom** (click and release without moving; a right *drag*
pans the view) for a menu (it opens beside the pointer, flipped to
stay on screen near an edge): *Select molecule* (every atom bonded to
it, directly or not), *Select all* of its element, *Set to* the current
element, *Clean up molecule* and *Delete atom*.

### Clean up geometry

**Structure › Clean up geometry** (*Clean up selected molecules* while atoms
are selected; or *Clean up* in the Inspector, or *Clean up molecule* in the
atom menu) hands each molecule — the selected ones, or
all of them when nothing is selected — to [RDKit](https://www.rdkit.org/):
it is embedded again from its atoms and bonds (ETKDG), minimised with
MMFF94s (UFF when MMFF has no parameters), and put back where it was by a
rigid fit on the old positions, so only its shape changes. Hydrogens are
kept as they are (add them first if you want them). Two things are sorted out
before RDKit sees a molecule: one split across the periodic cell is made whole
first (each bonded atom taken at the image nearest its neighbour), so it comes
back as one piece next to where it started; and an atom with more bonds than
its neutral valence gets the formal charge that explains them — four bonds on
N or P, three on O or S make it +1, four on B make it −1 — so ammonium,
oxonium and borate groups embed instead of being refused. A molecule of one
atom or of more than 999 atoms is skipped; a molecule RDKit still cannot read
is left as it is, and the notice counts it with RDKit's message while every
other molecule is cleaned up. All the moved atoms are one Undo step.

## Keyboard

| Key | What it does |
|---|---|
| S A B D M E P | Pick the tool of that letter |
| Ctrl/⌘ + Z, Ctrl/⌘ + Shift + Z (or Ctrl + Y) | Undo, redo |
| Delete, Backspace | Delete the selected atoms |
| Esc | Drop the pending bond, then the selection, then the *Place* molecule; during a drag, cancel it |
| X Y Z, A B C (during a drag) | Lock the drag to that axis (see [Mouse](#mouse)) |
| Ctrl/⌘ + O, Ctrl/⌘ + S | Open a file, save XYZ |
| Ctrl/⌘ + A | Select every atom |
| R | Reset the view |

Keys are ignored while a text field or the Ketcher sketcher has the keyboard, so typing a
lattice constant never switches tools.

Editing never moves the camera: the view keeps its zoom and orientation across
every operation (and across Undo / Redo / Clear all). Only opening a file or
starting a new document re-fits the view. **Reset View** (R) and the axis
buttons in the top-left corner (±x / ±y / ±z, and ±a / ±b / ±c while there
is a cell) work as the viewer's.

## Library

The **Library** keeps molecules ready to drop into the document. It is the
**Place** tool's gallery: pick *Place* (P) and
the list opens in its settings in the Details panel; once you choose a
molecule it closes, and the button there that names the molecule opens it
again. It starts with a set of presets — water, ammonia, methane, carbon
dioxide, methanol, ethanol, benzene, H₂, N₂, O₂ — with real 3D geometries,
and grows with your own molecules:

- **Sketch…** (in the gallery) opens [Ketcher](https://lifescience.opensource.epam.com/ketcher/),
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
  through the same MOL parser every Megane host uses and is centred; the
  molecule is a real 3D structure, with tetrahedral carbons and force-field
  bond lengths, not a flat drawing. Untick **Add hydrogens** to embed the
  bare skeleton you drew (hydrogens you drew explicitly in Ketcher are
  always kept). RDKit is the only way a sketch becomes 3D: if it cannot run
  (a browser without Web Workers, or a drawing it cannot sanitise) the
  dialog reports the error and nothing is added.
  **Paste MOL** in the dialog takes a molfile (or a SMILES string) from
  elsewhere instead of drawing (it is embedded the same way); it is also what
  the dialog falls back to if Ketcher cannot load.
- **From file…** (in the gallery) imports any structure file Megane reads as a molecule (3D
  coordinates are kept as they are).
  A flat 2D file (a molfile without z coordinates) is only rescaled to
  ångström and marked *flat* in the list; the Builder never invents a
  conformer for it.
- **Save as fragment** in the Inspector keeps the selected atoms, with the bonds between them, as a
  molecule — a quick way to lift a 3D fragment out of an opened file.
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

*Place* closes the gallery; *Add* leaves it open, so several molecules can be
added one after another.

Neither needs an open document. With nothing open, *Place* still shows the
gallery, and the first molecule you place or add
starts an `untitled` document without a cell — build a molecule up from a
library piece without making a cell first.

Either way the molecule enters the history as one `add_fragment` operation
(named after the molecule, e.g. `Add water-3 (3 atoms)`), so Undo removes it
whole and the fragment's atoms can be addressed by later operations.

To put a molecule *on* a surface, tick **On atoms** in the *Place*
tool's settings and give a height (2 Å by default):
the Place tool then also accepts a click on an atom and stamps the molecule
that many Å above it along the cell's c axis (the slab normal; +z without a
cell) — an adsorbate on the site you clicked. Leave it unticked and clicks on
atoms stay inert.

## Crystal

The **Structure** menu on the operations rail edits the solid the document holds. Its
items, plus the symmetry offer that appears for CIF files, cover the ASE-style
workflow of bulk → supercell → slab → adsorbate without leaving the browser;
the geometry is computed in TypeScript and pinned to what ASE produces by the
tests (`tests/fixtures/crystal/ase-oracle.json`).

- **Bulk crystal** is a *new document*, so it lives in the *File* menu's *New*
  form rather than in this menu: a prototype structure — simple cubic,
  fcc, bcc, hcp, diamond, zincblende, rocksalt, CsCl, fluorite, wurtzite or
  perovskite, with the element(s), the lattice constant `a`, `c/a` for the
  hexagonal ones, and *conventional cell* for the cubic ones (the primitive
  cell otherwise, exactly as `ase.build.bulk`). The **Examples…** list fills
  the fields with reference lattice constants (Cu, Al, Fe, Mg, Si, NaCl, GaAs,
  SrTiO₃, …). The document is named after the crystal (`Cu-fcc`) and, like
  an empty cell, replaces whatever is open.
- **Set cell…** (*Edit cell…* once there is one) edits the cell as
  `a b c α β γ` (the info line over the view always shows the current cell).
  With *move atoms with the cell* on, the atoms keep their fractional
  coordinates (ASE's `scale_atoms`); off, they stay where they are.
  **Wrap atoms into cell** folds every atom back into the cell; **Center with
  vacuum…** centres the atoms along the chosen axes and resizes those cell
  vectors to leave the given vacuum on each side (`Atoms.center`). **Remove
  cell** drops the cell.
- **Supercell…** repeats the cell `na × nb × nc` — or, with **Matrix**, by any
  integer 3×3 transformation whose rows are the new lattice vectors in units
  of the old ones (`make_supercell`; `[1 1 0 / −1 1 0 / 0 0 1]` is the √2×√2
  R45° cell, `[−1 1 1 / 1 −1 1 / 1 1 −1]` turns a primitive fcc cell into the
  conventional one). The form says how many atoms the result will have. Bonds are carried along: a bond that crossed the cell
  face now reaches the neighbouring image, as the viewer's Replicate node
  draws it.
- **Cut slab…** cuts the (h k l) surface out of the current cell
  (`ase.build.surface`): the surface unit cell is repeated *layers* times
  along the normal, rotated so the first surface vector lies along x and
  the normal along z, and centred in *vacuum* Å of empty space on each side
  (0 keeps the slab periodic). The **termination** slider slides the cut
  along the normal so a different plane ends up on top. The form states the
  atom count and thickness before you commit. Bonds that
  would have crossed into the vacuum are dropped; in-plane periodic ones are
  kept.
- **Expand symmetry** is offered (in the menu, and once in the Details panel
  right after opening the file) when the opened file (a CIF) lists space-group operations for its
  asymmetric unit, and fills the unit cell with the symmetry-equivalent atoms
  the way the viewer's Symmetry node does. Do it before cutting a supercell or
  slab; the offer goes away once the cell has been changed, because the
  operations no longer apply.

The items that take parameters open a form in the Details panel.
While its fields describe a valid operation, **the view previews the result**
(the status line says *Preview*) and clicks in the view are paused; the
form's button (*Set cell*, *Center*, *Make supercell*, *Cut slab*) writes
the operation, **Cancel** or Esc leaves the structure as it was. A
result of more than 200 000 atoms is not previewed — the form says so — but
the button still builds it; a supercell or slab of more than 1 000 000 atoms
is refused. The view is refitted to what it shows when the preview
starts and ends, keeping the angle you were looking from.

Each action is one operation in the history (`Supercell 2×2×1`,
`Slab (1 1 1), 4 layers, 10 Å vacuum`, `Expand symmetry`, …), so Undo takes
it back whole. Supercell, slab and symmetry expansion replace every atom;
atoms you had selected are deselected and later operations address the new
structure.

## Python tools

Structure generators written in Python — packmol liquid boxes, RadonPy
polymer chains, solvation — appear in the **Tools** menu on the operations rail. They run
in a separate *tool server*, an
[MCP](https://modelcontextprotocol.io/) server that follows the
[Builder Tool Contract](../dev/builder-tools.md). Start the reference server
with HTTP on your machine, allowing the page you opened Builder from (here
`megane serve --port 8080`; `megane serve` defaults to port 8765, which the
tool server takes below):

```bash
uvx --from git+https://github.com/hodakamori/megane-builder-tools \
    megane-builder-tools --transport http --port 8765 \
    --allow-origin http://localhost:8080
```

It prints a bearer token. Choose **Tools › Tool server…**, paste the server
URL (`http://127.0.0.1:8765/mcp`) and the token, and press **Connect**; the
tools appear in the Tools menu, grouped by category. Choosing one opens the
tool's form: molecules are picked from the
library, atoms (such as a monomer's head and tail) from a list of the chosen
molecule's atoms, and the seed is filled in for you. **Run** shows the
server's progress and can be cancelled.

- Tools that build something new (*Liquid box*, *Polymer chain*) replace the
  open document; the form warns you when that would discard edits.
- Tools that add to the open structure (*Solvate*) add their atoms as one
  operation in the history, so a single **Undo** removes them.
- If the tool refuses (not enough room, a head atom without a hydrogen, …),
  its message is shown and the form stays open with your values.

On the demo site, Builder is already connected to a hosted reference server,
so the Python tools appear without starting anything; a call there is limited
to 100 seconds, so build large systems with your own server, which replaces it
once you connect to it (the URL is remembered).

Opening Builder with `#tools=<url>&token=<token>` at the end of its address
connects on load.

To add buttons of your own, write a tool server with the
[`megane-builder-tools` SDK](https://github.com/hodakamori/megane-builder-tools):
[Writing a Builder Tool Server](../dev/builder-tool-server.md) goes from an
empty folder to your tools in this menu.

## Flow mode

Building a model often takes several programs in a row: draw one molecule,
embed it in 3D, then hand it to packmol to fill a box. **Flow** mode shows that
recipe as blocks wired together, like the viewer's pipeline editor, and runs
it. Pick **Flow** in the mode switch at the top of the left rails: Manual
mode's rails make way, and the panel on the right becomes the Flow editor,
built like the viewer's Pipeline panel — the same resizable panel, node
cards, wires, minimap and properties pane. Its own rail, down the panel's
left edge, holds **Add**, **Templates**, **Auto Layout**, **Run** (**Stop**
while a run is going), the **File** menu (*Open flow…*, *Save flow*, *Clear
all blocks*) and the theme button; the graph is on top, and the selected block's settings
are under it, in the same rows as a pipeline node's.

**Add** puts a block in the middle of the graph and selects it. It offers
these blocks:

- **Molecule from SMILES**: type a SMILES string; when the flow runs, RDKit
  embeds it in 3D (hydrogens added, MMFF94s), as the library's sketches are.
  The optional name is the residue name tools give its copies.
- **Molecule from the library**: a preset or one of your own molecules.
- **Manual structure**: the structure open in Manual mode, as it is when the
  flow runs (so a slab you built by hand can be solvated here). Editing that
  structure in Manual mode marks the block, and everything after it, as
  changed.
- **Bulk crystal**: a prototype (FCC, BCC, HCP, diamond, rocksalt, perovskite,
  …) with its species and lattice constant, or one of the reference examples
  (*Pt (fcc)*, *NaCl (rocksalt)*, …) — Manual mode's bulk crystal as a block.
- **Polymer chain**: a linear homopolymer from a repeat unit written as SMILES
  with two `*` ends (`*CC(c1ccccc1)*` is polystyrene: the first `*` is the
  head, the last the tail). Pick a common polymer (PE, PP, PS, PVC, PTFE,
  PMMA, PEO, PVA, nylon 6, PET) or type your own, and set the number of
  repeat units; RDKit embeds the whole chain when the flow runs, the ends
  capped with hydrogen, and each repeat unit is its own residue.
- **Supercell**: its input repeated along a, b and c.
- **Slab**: a (h k l) slab cut from the bulk crystal wired into it, with
  vacuum on both sides and repeated in plane — cut exactly as Manual mode's
  *Cut slab…* cuts it.
- **Place on surface**: copies of the molecule wired into *Molecule* laid on
  an even grid over the slab wired into *Surface*, each one's lowest atom the
  given height above the slab's top atom.

  The bulk crystal, polymer, supercell, slab and placement blocks run in the
  browser: they need no tool server.
- **Tools**: every tool of the connected tool server (see
  [Python tools](#python-tools); *Tool server…* is in this menu too). The
  tool's form is the block's settings, except its molecule and structure
  arguments, which become **inputs** on top of the block. A liquid box's
  *Components* input takes any number of wires — one per molecule — and its
  *Count* is set per wire on the block.

**Templates** replaces the flow with a ready-made one to start from, as the
viewer's pipeline templates do:

- **Liquid mixture**: water and ethanol into a *Liquid box*.
- **Molecules on a slab**: bulk Pt → a Pt(111) slab → a 3 × 3 layer of water
  placed on it.
- **Polymer melt in a box**: a 20-unit polyethylene chain → ten chains in a
  *Liquid box*.
- **Water on a slab**: bulk Au → an Au(100) slab whose vacuum *Solvate* fills
  with water, a solid–liquid interface.
- **Crystal supercell**: rocksalt NaCl repeated 3 × 3 × 3.

The templates that pack a box or solvate use the reference tool server's
`liquid_box` and `solvate` (their menu line says they need a tool server);
their tool blocks take the tool's defaults for every setting the template
does not set once the server is connected. Each template's tool settings
include a fixed seed, so it builds the same structure every time.

Drag from a block's output (the dot at its bottom) to another block's input
(a dot on its top) to wire them; a wire that would make a loop is refused.
Hover a wire for its × to delete it, or select a block or wire and press
Delete.

**Run** builds every block in order. Each block's line shows what happened —
*3 atoms*, *300 atoms*, a tool's warning, or why it failed (a missing input,
the server's own error) — and the blocks after a failed one wait. Results are
kept: change the count of a liquid box and Run again, and only the box runs
again, not the molecules before it; a block you have changed since its last
run says so. *Run to here* in a block's settings runs just that block and the
ones it needs, and **Stop** abandons a run.

Manual and Flow mode share one structure. When **Run** finishes, the result
of the flow's last block (the one no wire leaves) becomes the structure open
in Manual mode — replacing the open one and its history — so switching to
Manual shows what the flow built, ready to edit further or save as XYZ, PDB,
MOL, CIF or POSCAR. A Run that gives back the very result it gave last time (nothing in
the flow changed) leaves the structure, and your Manual edits on it, alone;
when the last block fails, the structure is kept as it was.

The 3D view shows the result of the block you pick in the graph, with its
name and counts on the info line; with no block picked it shows the shared
structure, Manual edits included. Editing in the view is Manual mode's job.
**Open in Manual** makes the picked block's result the structure — an
intermediate molecule, say — and switches to Manual mode. *Run to here* only
builds up to the picked block to look at it; it leaves the structure alone.

*Save flow* writes the blocks, their settings and their wires as
`builder.megane-flow.json` (where *Save* writes structures on that host, see
[In VS Code, JupyterLab and notebooks](#in-vs-code-jupyterlab-and-notebooks));
*Open flow…* reads one back. A flow keeps each tool's settings, seed included,
so running it again with the same server builds the same structure. Library
blocks name the library molecule by id, so a flow that uses your own
molecules opens elsewhere only where those molecules are in the library.

## History

The **History** panel lists every step in order — one line per Undo, so an
atom and the hydrogens that came with it, or a cleaned-up molecule, is one
line — and offers **Undo**,
**Redo**, **Clear all**, and **Show original** (a preview of the structure as
opened; editing is paused while it is on, and a banner at the top of the
panel offers the way back). The history is the document: the
structure you opened is never changed, and what you see is always that
structure with the operations replayed on it. An operation that no longer
applies is skipped and reported as a warning in the panel rather than
blanking the structure.

Operations refer to atoms in two ways: atoms from the file by their index in
the opened structure, and atoms you created by an id the operation assigned.
That is why deleting an atom never breaks a later operation.

## In VS Code, JupyterLab and notebooks

The same Builder ships with the editor extensions and the Python package.
Everything above works the same; what differs is how you get to it and
where *Save* writes.

**VS Code.** The Megane extension adds a *Megane* icon (the Megane logo) to
the activity bar. Its *Builder* view has **New Structure** and **Open File in
Builder…**; a structure file also has **Open in Megane Builder** in the
Explorer's context menu, and a Megane viewer tab has the same button in its
title bar. Each opens the Builder in an editor tab (one tab per file; asking
again brings it back). *Save* asks where to write with VS Code's save dialog,
starting beside the file you opened.

The *Tools* menu works in VS Code too (VS Code 1.90 or later), and the
reference tools (*Liquid box*, *Polymer chain*, *Solvate*) need no setup
beyond [uv](https://docs.astral.sh/uv/):

1. Open a Builder tab (the *Megane* icon in the activity bar › **New
   Structure**, or **Open in Megane Builder** on a file).
2. Choose **Tools › Connect to megane-builder-tools** and press **Allow** when
   VS Code shows the command it is about to run. It asks once per command.
3. The tools appear in the Tools menu. *Liquid box* and *Polymer chain* make a
   new document. *Solvate* adds solvent to the open structure and needs a
   cell: give the structure one with **Structure › Set cell…** first (a polymer
   chain comes without a cell).

VS Code starts the reference server itself when you connect and stops it when
the last Builder tab disconnects or closes. If `megane-builder-tools` is on
your PATH (`uv tool install
git+https://github.com/hodakamori/megane-builder-tools`), that is what runs;
otherwise `uvx` runs the version Megane was tested with. The first connection
through `uvx` downloads the server and its dependencies (RDKit, packmol,
RadonPy; about 600 MB in uv's cache) and takes from a few seconds to a few
minutes depending on your connection; later ones start in seconds. Without uv
and without the command, the Tools menu has no server to offer.

To add servers, or to replace or hide the reference one, use the
`megane.builder.mcpServers` setting (**Preferences: Open User Settings
(JSON)**). An entry named `megane-builder-tools` replaces the built-in one, and
`"megane-builder-tools": null` hides it. Your own server goes in the same
setting: any command that runs an MCP server
over stdio (see [Builder Tool Contract §12.4](../dev/builder-tools.md#124-server-side)),
for example `{ "command": "uv", "args": ["run", "--directory",
"${workspaceFolder}", "python", "my_tools.py"] }`. `${workspaceFolder}` and
`${userHome}` are replaced, and `env` and `cwd` are optional.

A server that is already running over HTTP, such as the reference server
started with `megane-builder-tools --transport http --port 8765` on your
machine or a lab server, is an entry with its URL and the token it printed:

```json
"megane.builder.mcpServers": {
  "local-http": {
    "url": "http://127.0.0.1:8765/mcp",
    "headers": { "Authorization": "Bearer <token>" }
  }
}
```

Set `MEGANE_BUILDER_TOOLS_TOKEN` before starting the server to keep the same
token across restarts. An HTTP server must use `https://` unless it runs on
your machine.

More details:

- Builder tabs share one server process, which stops when the last tab
  disconnects or closes.
- **Tools › Tool server…** shows what each server runs and has **Configure
  tool servers…**, which opens the setting.
- A server's messages (and why it failed to start) are in the *Megane Builder
  Tools* output panel.
- In an untrusted workspace, VS Code ignores the workspace's own
  `megane.builder.mcpServers`, so a cloned repository cannot run commands this
  way. Your user setting still applies.

**JupyterLab.** The Megane extension adds a *Megane* panel (the logo icon)
to the left sidebar: **Open Builder**, and the structure files of the file
browser's current folder — click one to edit it. Structure files also have
**Open in Megane Builder** in the file browser's context menu, and the
launcher has a **Megane Builder** card. Each opens the Builder in a
main-area tab with a document of its own: **Open Builder** and the card open
a new tab every time, and a file opens in one tab (asking again brings it
back), as in VS Code. *Save* asks for a path in the server's file tree
(beside the opened file by default) and asks before replacing a file.

The *Tools* menu works in JupyterLab too. The Jupyter server starts the tool
server where Jupyter runs, not in the browser, so you need no HTTP, token or
`--allow-origin`. With [uv](https://docs.astral.sh/uv/) installed, the
reference tools need one step:

1. In the environment Jupyter runs from, install Megane with its `tools` extra
   (the MCP client) and restart JupyterLab:

   ```bash
   pip install "megane[tools]"
   ```

2. In the Builder tab, choose **Tools › Connect to megane-builder-tools** and
   press **Allow** when JupyterLab shows the command. This browser remembers
   the answer for that exact command.

As in VS Code, the server runs `megane-builder-tools` from PATH if it is
installed, else the tested version through `uvx`. The first connection through
`uvx` downloads it, from a few seconds to a few minutes.

To add servers, or to replace or hide the reference one, name them in the
Jupyter server's configuration, e.g. `~/.jupyter/jupyter_server_config.json`
(`jupyter --config-dir` prints the folder), then restart JupyterLab:

```json
{
  "MeganeBuilderTools": {
    "mcp_servers": {
      "my-tools": { "command": "uv", "args": ["run", "--directory", "/path/to/my-tools", "python", "my_tools.py"] }
    }
  }
}
```

The entries are the same as VS Code's `megane.builder.mcpServers` above:
stdio servers with `command`, `args`, `env` and `cwd`, and HTTP servers with
`url` and `headers`. `${workspaceFolder}` is the Jupyter server's root
directory. An entry named `megane-builder-tools` replaces the built-in one,
and `null` hides it.

The tools then work as in the web app: *Solvate* needs a cell (**Structure ›
Set cell…**). Builder tabs and browser windows share one server process,
which stops when the last one disconnects. The server's messages, and why
one failed to start, are in the Jupyter server's log. Megane's server
extension (`megane.builder_tools`) is enabled when Megane is installed; if
the Tools menu cannot reach it, check `jupyter server extension list`.

**Jupyter notebooks** (JupyterLab, Notebook, VS Code): `megane.Builder` is a
widget.

```python
import megane

b = megane.Builder("caffeine.sdf")   # or megane.Builder() for the start screen
b                                    # edit in the cell

b.n_atoms                            # the structure on screen, kept in sync
b.save("caffeine_edited.pdb")        # format from the extension
pdb_text = b.text("pdb")             # "xyz", "pdb", "mol", "cif" or "poscar"
b.save("POSCAR")                     # VASP names and .cif / .vasp need a cell
atoms = b.to_ase()                   # needs ASE
b.load("other.xyz")                  # open another file in the same widget
```

*File › Save* in the cell writes through the kernel into its working
directory (the notebook's folder; set `megane.Builder(save_dir=...)` to
change it) and never overwrites a file — a taken name gets `-1`, `-2`, ….
Each `Builder` edits its own document; displaying the same `Builder` in a
second output moves it there, and the first offers *Show here* to take it
back.

What the notebook widget leaves out: the *Tools* menu (MCP tool servers,
which the web app, VS Code and JupyterLab can reach), and the Ketcher
sketcher — *Sketch…* opens the dialog with *Paste MOL*, which takes a MOL
block or a SMILES string and embeds it in 3D with RDKit. RDKit (*Clean up* and
the 3D embedding) works on every host; the notebook widget fetches it from the
kernel the first time it is needed. The keyboard shortcuts act only while the
focus is in the Builder, so they never steal keys from the editor around it.

## Not yet

Saving the document as a project file (the source plus its operations),
building a crystal from a space-group number and
Wyckoff positions, and enumerating the distinct terminations of a slab
(pymatgen's `SlabGenerator`) are deliberately not in this version. The full design, including how a Builder
document is meant to travel into the viewer, is in
[Structure editing design](../dev/editor-design.md).
