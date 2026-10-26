# Selection Inspector

The **Selection Inspector** is a lightweight tab in the pipeline panel — the
**Inspector** button on the panel's rail, under **Editor** — for
the most common tasks in molecular visualization: *change how the structure
looks*, and *select a subset of atoms and change how that looks*. The
**Quick style** section at the top does the first; the **Selections** below it
do the second. It is
inspired by OVITO's Expression Select, but you rarely have to type an
expression — you build selections by clicking chips for the elements, residues,
and chains that are actually present in your structure, or by picking atoms
directly in the 3D view.

Everything the Inspector does is compiled straight into ordinary pipeline nodes,
so a selection you make here appears as a `filter` → `color` / `representation`
/ `modify` chain in the **Editor** tab. The Inspector is just a friendlier front
end to the same pipeline — nothing is hidden or parallel.

## Quick style

A few global controls, applied to the whole structure:

| Control | What it changes in the pipeline |
|---|---|
| **Style** | adds a `representation` node (`insp-global-rep`) to the main particle stream |
| **Color** | adds a `color` node (`insp-global-color`) |
| **Atom size**, **Atom opacity** | adds a `modify` node (`insp-global-atoms`) |
| **Bond width**, **Bond opacity** | adds a `modify` node on the bond stream (`insp-global-bonds`) |
| **Bond tolerance** | the `add_bond` node's distance factor — shown only when bonds are inferred by distance |
| **Polyhedra** (Show, Edges, Poly. opacity) | adds a `coordination_generator` → `polyhedron_generator` branch (`insp-global-coord` → `insp-global-poly`) from the main particle stream into the viewport's mesh input; if the pipeline already draws polyhedra, switches and edits its own Polyhedra node instead |
| **Labels** (None / Element / Residue / Index) | adds a `label_generator` node (`insp-global-labels`) |
| **Arrow scale** | the `vector_overlay` node's scale — shown only when the pipeline draws vectors |
| **Perspective**, **Cell axes** | the `viewport` node's settings |

The nodes are inserted in line, between the node that feeds the viewport and
the viewport itself, so they show up in the **Editor** tab like any other node.
A control set back to its default removes its node again, and **↺ Reset**
removes them all — an untouched Quick style leaves the pipeline exactly as it
was. *Pipeline default* for Style or Color means "don't override what the
pipeline already draws". Everything is read back from the pipeline, so the
panel stays correct after you edit those nodes in the Editor, apply a template
or an AI assistant result, or re-open a saved `.megane.json`.

If the pipeline already carries `color` / `representation` / `modify` nodes of
its own, the panel says how many: they also affect the look, and Quick style
does not take them over.

**Polyhedra** are drawn around the auto-detected metal and metalloid centers,
with the anion-forming neighbors (N, O, F, P, S, Cl, …) within the
covalent-radius cutoff as corners, completed across periodic boundaries; a
center needs at least four neighbors. When nothing is drawn the panel shows why (for example *No
coordination pairs found* for a structure without metal centers). To choose the
centers or neighbors yourself, set *Center atoms* / *Neighbor atoms* on the
`insp-global-coord` node in the **Editor** — Quick style keeps that choice. A
pipeline that already has a Polyhedra node wired to the viewport (the *Solid*
template, or `AddPolyhedra` in Python) gets no second set: **Show** turns that
node on and off (like the Editor's toggle, leaving its Coordination node and
bonds alone) and the edge and opacity controls edit it. **↺ Reset** leaves it
as it is.

## Selections

Each **layer** is one "select these atoms, style them like this" rule. Click
**+ Add selection** to create one, and the ✕ beside a layer to delete it. Add as
many as you need — e.g. a layer that colors the protein backbone, another that
draws the ligand as licorice, another that hides the solvent. Layers are drawn
on top of the Quick style: atoms no layer selects keep the global look, and a
layer's settings win for the atoms it selects (a layer at size 1.0 restores full
size under a global 0.5). Layers branch from the end of the Quick style chain,
and the Inspector recognises its nodes by their `insp-<layer>-<role>` ids, so
layers survive saving and re-opening the pipeline.

## Building a selection

- **Chips** — click the elements, residues, or chains present in the loaded
  structure. Selected categories are AND-ed together (e.g. carbons *and* chain A).
- **Within (Å)** — expand the current selection to every atom within a distance
  of it (`within R of (…)`), handy for "everything around the active site".
- **Expression** — the raw selection expression is always shown and editable for
  full control. Editing it directly overrides the chips. Below it the panel
  shows how many atoms the expression selects, or the syntax error.
- **From the 3D view** — turn on **Box select** and drag a rectangle in the
  viewer to select atoms, or click an atom and choose *same element / same
  residue / same chain / same molecule / just this*. The current selection is
  highlighted live in green.

The selection language supports the fields `element`, `index`, `x`/`y`/`z`,
`resname`, `resid`, `chain`, `mass`, and `molecule_id`, combined with
`and` / `or` / `not`, parentheses, and `within R of (…)`.

## Appearance

For the active layer you can set the **color** (uniform or by
element/residue/chain/B-factor/property/illustrative), the **style**
(representation: ball, licorice, cartoon, cartoon + atoms, surface, line,
illustrative), the atom **size** and **opacity**, and toggle **visibility**
(a hidden layer drives its atoms to opacity 0). Color and style each have a
checkbox; only the enabled ones add a `color` / `representation` node to the
chain. Changes apply immediately and are reflected in the Editor tab — **Open
generated nodes in Editor →** jumps there.

## Availability

The Inspector is available everywhere the visual pipeline editor is — the
standalone web app, the JupyterLab extension, and the VS Code extension. The
in-cell Jupyter widget does not mount the pipeline editor, but it can show the
**Quick style** controls on their own:

```python
from megane import MolecularViewer

viewer = MolecularViewer(quick_style=True)
viewer.set_pipeline(pipe)
viewer.quick_style = False  # hide it again
```

The panel opens in the viewer's top-right corner and collapses to a **Style**
button. Its changes are written back to the widget's pipeline, so they survive
re-displaying the widget and are saved with the notebook; calling
`set_pipeline()` again replaces them. It needs data loaded with
`set_pipeline()` (it is disabled on the deprecated `load()` path), and the
Selections part is not available in the widget.
