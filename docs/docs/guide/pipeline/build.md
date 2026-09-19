# Build Panel (Structure Editing)

The **Build** panel lets you edit the loaded structure by clicking in the 3D
view: add atoms, delete them, drag them around, change elements, and draw or
remove bonds. When you are done, save the result as XYZ, PDB, or MOL.

It is a panel of its own, on the same footing as the Pipeline panel: its
collapsed **◀ Build** stub sits under the Pipeline panel at the bottom of the
right column, and expanding it opens the panel there (the Pipeline panel
shrinks to make room; *Open Build* on the `load_structure` node does the
same). While it is open, the viewer is in **edit mode** (below) and clicks in
the 3D view edit atoms; collapse it with the ▶ button in its header to get the
pipeline's view and the usual pick and measure behaviour back. Hosts can hide
it with the `build: false` UI option.

Building and the pipeline are kept apart on purpose. The pipeline describes
how a structure is *shown* (bonds, filters, colours, supercells); the Build
panel changes what the structure *is*. So every click appends one **edit
operation** to the `load_structure` node's edit list — the file plus its edits
is the input, and the rest of the graph never sees an unedited atom. Nothing
is hidden state: the history is

- **undoable** — Undo drops the last operation, Redo puts it back;
- **previewable** — *Show original* shows the file as loaded; turn it off to
  see your edits again;
- **saved with the pipeline** — a `.megane.json` export carries the operations
  on the loader, and reopening it (with the same file) replays them;
- **visible** — the Editor tab's `load_structure` node shows the edit count and
  an *Open Build* button, and nothing else changes in the graph.

Think of the edit list as the *recipe* of what you did and the exported
XYZ / PDB / MOL file as the *result*. For day-to-day work: click to edit, then
**Save** — the history is recorded in the background.

## Edit mode

While the Build panel is open the 3D view shows the structure you are editing,
not the pipeline's view of it: the `load_structure` node's output — the file
as loaded plus your edits — drawn as ball-and-stick with every atom, its own
bonds (from the file, or the ones you drew) and its cell. Filters, colours,
representations, supercells and trajectories from the rest of the pipeline are
not applied while the panel is open, and come back the moment you close it,
now acting on the edited structure. This is the same split as Blender's Edit
Mode: you edit the base mesh, and the modifier stack is re-applied on the way
out. It is what makes every click unambiguous — there is exactly one rendered
atom per loaded atom — so editing never has to pause because a `replicate` or
`symmetry` node is in the graph.

## Starting from nothing

To build a structure from scratch, use **New empty cell** in the panel's *New*
section (it is offered before anything is loaded, too). Enter the edge of the
cubic cell in Å and click the button: the loaded structure is replaced by an
empty cell with an empty edit history, the pipeline graph is kept as it is,
any trajectory of the old structure is dropped, and the `add_bond` nodes fed by
the loader are set to their *structure* source so the bonds you draw are the
bonds shown. The cell is what the camera frames and what the *Add atom* tool
places free atoms against (a click on empty space lands at the depth of the
rotation pivot, the cell centre), so the first click already puts an atom in
the box. Everything you add is an edit on that loader, like any other file, and
saves the same way; the loader shows the structure as `untitled`.

## Tools

| Tool | What a click in the 3D view does |
|---|---|
| **Select** | Selects the atom (Shift-click adds to the selection; clicking empty space clears it). The selection feeds *Delete selected* / *Set to element* in the panel and lets *Move* drag several atoms at once. |
| **Add atom** | On an atom: attaches a new atom of the chosen element at bond length (sum of covalent radii), pointing away from the atom's existing neighbours, and bonds it with the chosen bond order. On empty space: places a free atom at that point, at the depth of the rotation pivot. |
| **Bond** | Click two atoms to bond them. Clicking an already bonded pair changes the bond order to the one chosen in the panel. |
| **Delete** | Removes the atom and every bond it had. |
| **Move** | Drag an atom in the screen plane (the plane through the atom facing the camera). If the atom is part of the current selection, the whole selection moves. Dragging empty space still orbits the camera. |
| **Element** | Changes the clicked atom to the chosen element. |

The **Element** section picks the element for *Add* and *Element* (quick chips
for the common ones, or any atomic number), and the **bond order** used by
*Add* and *Bond*.

Editing never moves the camera: the view keeps its zoom and orientation across
every operation (and across Undo / Redo / Clear). Only loading a new file
re-fits the view.

## History and Undo

The **History** section shows every operation in order and offers **Undo**,
**Redo**, **Clear all**, and **Show original** (a preview of the file as
loaded; editing is paused while it is on). *Show in Editor* switches the
Pipeline panel above to the graph.

Operations refer to atoms in two ways: atoms from the file by their index in the
loaded structure, and atoms you created by an id the operation assigned. That is
why deleting an atom never breaks a later operation, and why the same history
replays correctly after a reload.

Because edit mode always shows the loaded atoms themselves, a `replicate`
supercell or a `symmetry` expansion in the pipeline never gets in the way of
editing; you see their effect again as soon as the panel is closed.

The history belongs to the file it was made against: loading a different file
into the `load_structure` node starts with an empty history. An operation that
no longer applies (for example after a hand edit of the list) is skipped and
reported as a warning on the node and in the panel rather than blanking the
structure.

## Saving

**Save XYZ / PDB / MOL** writes the structure as currently shown (all edits
applied) through megane's Rust writer. XYZ becomes extended XYZ (with a
`Lattice="…"` header) when the structure has a unit cell; PDB carries `CRYST1`,
residue labels when the file had them, and `CONECT` records for every bond;
MOL is a V2000 Molfile with bond orders (up to 999 atoms).

The same writer is available from Python:

```python
import megane

s = megane.load_pdb("water.pdb")
megane.save_structure(s, "water_edited.xyz")        # format from the extension
text = megane.write_structure(s, "pdb")              # or as a string
```

In the web app the file downloads; in the VS Code extension it goes through the
host save dialog.

## From code

The edit history is the `edits` field of the `load_structure` node, so
pipelines built in [Python](./python.md) or [TypeScript](./typescript.md) carry
the same operations:

```python
from megane import Pipeline, LoadStructure, Viewport

pipe = Pipeline()
s = pipe.add_node(LoadStructure("water.pdb", edits=[
    {"op": "add_atom", "id": "h3", "element": 1, "position": [1.0, 0.0, 0.0], "bondTo": 0},
    {"op": "delete_atoms", "atoms": [2]},
]))
v = pipe.add_node(Viewport())
pipe.add_edge(s.out.particle, v.inp.particle)
```

See [`load_structure`](/reference/node-reference#load_structure) in the Node
Reference for every operation and its fields. The AI chat can write these too
("delete all hydrogens", "add an oxygen bonded to atom 3").

## Availability

The Build panel is available everywhere the visual pipeline editor is — the
standalone web app, the JupyterLab extension, and the VS Code extension. It is
not shown in the in-cell Jupyter widget, which does not mount the pipeline
editor; pass `edits=` to `LoadStructure` from Python there. Trajectories follow
the file, not the edits: with a trajectory loaded, edits apply to the static
structure and frame playback keeps the file's atom count.
