# Selection Inspector

The **Selection Inspector** is a lightweight third tab in the pipeline panel
(alongside **Editor** and **Chat**) for the most common task in molecular
visualization: *select a subset of atoms and change how it looks*. It is
inspired by OVITO's Expression Select, but you rarely have to type an
expression — you build selections by clicking chips for the elements, residues,
and chains that are actually present in your structure, or by picking atoms
directly in the 3D view.

Everything the Inspector does is compiled straight into ordinary pipeline nodes,
so a selection you make here appears as a `filter` → `color` / `representation`
/ `modify` chain in the **Editor** tab. The Inspector is just a friendlier front
end to the same pipeline — nothing is hidden or parallel.

## Layers

Each **layer** is one "select these atoms, style them like this" rule. Add as
many as you need — e.g. a layer that colors the protein backbone, another that
draws the ligand as licorice, another that hides the solvent. Layers are drawn
on top of the base structure, so atoms no layer selects keep their default
appearance.

## Building a selection

- **Chips** — click the elements, residues, or chains present in the loaded
  structure. Selected categories are AND-ed together (e.g. carbons *and* chain A).
- **Within (Å)** — expand the current selection to every atom within a distance
  of it (`within R of (…)`), handy for "everything around the active site".
- **Expression** — the raw selection expression is always shown and editable for
  full control. Editing it directly overrides the chips.
- **From the 3D view** — turn on **Box select** and drag a rectangle in the
  viewer to select atoms, or click an atom and choose *same element / same
  residue / same chain / same molecule / just this*. The current selection is
  highlighted live in green.

The selection language supports the fields `element`, `index`, `x`/`y`/`z`,
`resname`, `resid`, `chain`, `mass`, and `molecule_id`, combined with
`and` / `or` / `not`, parentheses, and `within R of (…)`.

## Appearance

For the active layer you can set the **color** (uniform or by
element/residue/chain/B-factor/illustrative), the **representation** (ball,
licorice, cartoon, surface, line, illustrative…), the atom **size** and
**opacity**, and toggle
**visibility**. Changes apply immediately and are reflected in the Editor tab.

## Availability

The Inspector is available everywhere the visual pipeline editor is — the
standalone web app, the JupyterLab extension, and the VS Code extension. It is
not shown in the in-cell Jupyter widget, which does not mount the pipeline
editor.
