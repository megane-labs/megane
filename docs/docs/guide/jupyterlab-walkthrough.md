---
sidebar_label: "JupyterLab: first steps"
description: A ten-minute tour of the Megane viewer in JupyterLab — open a structure, turn it, restyle it, measure it, and play a trajectory, without writing any code.
---

import Figure from '@site/src/components/Figure';

{/* The screenshots are taken by scripts/capture-jupyterlab-walkthrough.mjs from the sample files in docs/public/samples/; re-run it when the viewer's look changes. */}

# First steps in JupyterLab

This walkthrough takes you through the things you will do most often in the
Megane viewer for JupyterLab, using two small sample files. You need nothing but
JupyterLab with Megane installed (see [Installation](./jupyterlab.md#installation)):
no notebook, no code.

## Get the sample files

Download both files and drop them onto JupyterLab's file browser (or use its
**Upload** button):

- [`1crn.pdb`](pathname:///samples/1crn.pdb) — crambin, a 46-residue protein of 327 atoms,
  from the [Protein Data Bank](https://www.rcsb.org/structure/1CRN).
- [`cu_slab_opt.traj`](pathname:///samples/cu_slab_opt.traj) — an ASE geometry
  optimization of a CO molecule on a copper (111) surface: 38 atoms, nine
  steps of the BFGS optimizer.

## 1. Open a structure

Double-click `1crn.pdb` in the file browser. It opens in its own tab:

<Figure src="/screenshots/jupyterlab-open.png" alt="1crn.pdb open in a Megane tab in JupyterLab" caption="The 3D view on the left, the Visualization settings panel on the right." />

- The **3D view** draws the atoms and bonds; the line above it counts them
  (*Atoms 327 · Bonds 337*).
- The **Visualization settings** panel on the right is the pipeline that
  draws the view: a *Load Structure* node reads the file and a *Viewport* node
  at the bottom puts it on screen. You do not have to touch it to look at a
  file. The arrow in its top-right corner folds it away.
- The first time you open a file, a short guided tour points out these parts.
  The circled **i** at the foot of the panel's rail starts it again.

## 2. Turn, move and zoom

| Mouse | Does |
|---|---|
| Left drag | Rotates the structure |
| Right drag | Moves it |
| Wheel | Zooms |
| Right click on an atom | Selects it (see [step 4](#4-measure-a-distance)) |

**Reset View** fits the structure back into the view. The buttons below it turn
the camera to look straight down an axis: **+a**, **−a**, … along the unit
cell's edges (shown when the file has a cell) and **+x** … **−z** along the
Cartesian axes. They keep the zoom, so you can flip between faces.

## 3. Change how it looks

Click **Inspector** on the panel's rail (the second button, under **Editor**),
and set **Style** under *Quick style* to **Cartoon**:

<Figure src="/screenshots/jupyterlab-style.png" alt="The Inspector's Quick style set to Cartoon" caption="Quick style → Style → Cartoon draws crambin's helices and sheet." />

The other Quick style controls work the same way: **Color** (by element,
residue, chain, …), atom and bond size and opacity, **Labels**, and the
**Perspective** and **Cell axes** switches. Set a control back to its default,
or click **↺ Reset**, to undo it. Under *Selections*, **+ Add selection**
restyles part of the structure only, such as the water or a ligand. Everything
the Inspector does becomes ordinary nodes in the **Editor** tab; see
[Selection Inspector](./pipeline/inspector.md).

## 4. Measure a distance

Right-click an atom, then a second one. Both are highlighted, a line joins
them, and the **Selection** box in the lower right shows the distance:

<Figure src="/screenshots/jupyterlab-measure.png" alt="Two atoms selected with their distance shown" caption="Two right-clicked atoms and their distance in ångström." />

- A third atom gives the angle, a fourth the dihedral.
- **Pin** keeps the measurement in a *Measurements* list while you go on
  selecting, and **Clear** empties the selection.
- Right-clicking a selected atom again removes it from the selection.

## 5. Open and play a trajectory

Double-click `cu_slab_opt.traj`. A file with more than one frame gets a
timeline under the view:

<Figure src="/screenshots/jupyterlab-trajectory.png" alt="An ASE optimization trajectory with the timeline under the 3D view" caption="Step 6 of 9 of the optimization: the timeline and the frame number in JupyterLab's status bar." />

- **▶** plays and pauses; the buttons beside it step one frame back or
  forward.
- Drag the bar to scrub to any frame, or click it and step with **←** / **→**.
  The current frame is also shown in JupyterLab's status bar.
- **Loop** limits playback to a range of frames, and the last two menus set
  the speed and the frame rate.

The same works for any file that holds several frames: multi-frame XYZ or PDB,
LAMMPS dumps, VASP `XDATCAR`, XCrySDen `.axsf`, ASE `.traj`. Trajectory-only
formats (`.xtc`, `.dcd`, `.nc`) carry no atoms of their own: open the
structure first, then attach the trajectory with the **Load Trajectory** node
(see [Opening files](./jupyterlab.md#opening-files)).

## Where to go next

- [Visual pipeline editor](./pipeline/index.md): build your own pipelines, or
  start from a **Template** (the stacked-layers button on the rail).
- [Megane Builder](./builder.md): edit structures, also from JupyterLab's file
  browser.
- [Platform support](/platform-support): every format and feature, host by
  host.
