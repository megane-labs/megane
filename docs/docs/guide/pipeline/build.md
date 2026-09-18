# Build Panel (Structure Editing)

The **Build** panel lets you edit the loaded structure by clicking in the 3D
view: add atoms, delete them, drag them around, change elements, and draw or
remove bonds. When you are done, save the result as XYZ, PDB, or MOL.

Open it with the **Build** button in the Pipeline panel header (or *Open
Build* on an `edit` node). It is its own panel, stacked under the Pipeline
panel, so the Editor tab stays visible while you work and you can watch the
`edit` node grow with every click. While it is open, clicks in the 3D view
edit atoms; close it with the ▶ button in its header to get the usual pick and
measure behaviour back.

Nothing you do here is hidden state. Every click appends one **edit
operation** to an `edit` node that megane places directly after the
`load_structure` node, so the edit history is:

- **undoable** — Undo drops the last operation, Redo puts it back;
- **switchable** — disable the `edit` node in the Editor tab to see the file
  as loaded, enable it to see your edits again;
- **saved with the pipeline** — a `.megane.json` export carries the operations,
  and reopening it (with the same file) replays them;
- **visible** — the Editor tab shows the node, its op count, and the same
  Undo / Clear controls.

Think of the pipeline as the *recipe* of what you did and the exported
XYZ / PDB / MOL file as the *result*. For day-to-day work: click to edit, then
**Save** — the pipeline records the history in the background.

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
**Redo**, and **Clear all**. *Show in Editor* switches the Pipeline panel above
to the graph where the `edit` node lives.

Operations refer to atoms in two ways: atoms from the file by their index in the
loaded structure, and atoms you created by an id the operation assigned. That is
why deleting an atom never breaks a later operation, and why the same history
replays correctly after a reload.

If a node after `edit` changes the atom count (a `replicate` supercell, or a
`symmetry` expansion), clicks in the 3D view can no longer be mapped back to
the loaded atoms and the panel pauses editing with a notice. Set those nodes to
`1×1×1` / `none` while building, then turn them back on.

If you open a different file under an existing history, the `edit` node warns
that its operations were authored against a different atom count; clear the
history to start fresh.

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

The edit history is an ordinary node, so pipelines built in
[Python](./python.md) or [TypeScript](./typescript.md) can carry the same
operations:

```python
from megane import Pipeline, LoadStructure, Edit, Viewport

pipe = Pipeline()
s = pipe.add_node(LoadStructure("water.pdb"))
e = pipe.add_node(Edit(ops=[
    {"op": "add_atom", "id": "h3", "element": 1, "position": [1.0, 0.0, 0.0], "bondTo": 0},
    {"op": "delete_atoms", "atoms": [2]},
]))
v = pipe.add_node(Viewport())
pipe.add_edge(s.out.particle, e.inp.particle)
pipe.add_edge(e.out.particle, v.inp.particle)
```

See [`edit`](/reference/node-reference#edit) in the Node Reference for every
operation and its fields. The AI chat can write these too ("delete all
hydrogens", "add an oxygen bonded to atom 3").

## Availability

The Build panel is available everywhere the visual pipeline editor is — the
standalone web app, the JupyterLab extension, and the VS Code extension. It is
not shown in the in-cell Jupyter widget, which does not mount the pipeline
editor; drive the `Edit` node from Python there. Trajectories are not routed
through the `edit` node: with a trajectory loaded, edits apply to the static
structure and frame playback keeps the file's atom count.
