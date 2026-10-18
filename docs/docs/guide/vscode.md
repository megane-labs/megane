# VS Code extension

The megane VS Code extension opens molecular structure and trajectory files directly in the editor as a custom editor — no separate app, no export step. Click a supported file in the explorer and it renders in a megane viewport with the full pipeline editor.

## Installation

Install **megane - Molecular Viewer** from the Visual Studio Code Marketplace:

- Marketplace page: [hodakamori.vscode-megane](https://marketplace.visualstudio.com/items?itemName=hodakamori.vscode-megane)
- Or, in VS Code: open the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`), search for **megane**, and click **Install**.

## Opening files

Once installed, the extension registers a custom editor for the supported file types. Open any of them from the VS Code explorer (or `File → Open`) and megane renders it inline:

| File type | Extensions |
|-----------|-----------|
| Structures | `.pdb`, `.gro`, `.xyz`, `.jxyz`, `.extxyz`, `.mol`, `.sdf`, `.mol2`, `.cif`, `.mmcif`, `.data`, `.lammps`, `.prmtop`, `.traj`, `.lammpstrj`, `.dump`, `.trj`, `POSCAR*`, `CONTCAR*`, `XDATCAR*`, `.vasp`, `.molden`, `.xsf`, `.axsf`, `.cml`, `.c3xml`, `.xodydata`, `.odydata`, `.magres`, `.gamess`, `.phonon` |
| Trajectories | `.xtc`, `.dcd`, `.nc` |
| Volumetric grids | `.cube`, `.cub`, `.dx` |
| Spectra | `.jdx`, `.jcamp` |
| Pipelines | `.megane.json` |

The VASP entries are registered as filename globs rather than extensions, so `POSCAR`, `CONTCAR.bak` and similar all open.

`.dx` is shared by OpenDX grids and JCAMP-DX spectra, and the editor selector can only match on the name, so opening a `.dx` file always takes the volumetric-grid path. Load a JCAMP-DX `.dx` spectrum through the **Load Spectrum** node instead, which tells the two apart by content.

When you open a `.gro` file, the extension also looks for a GROMACS topology with the same stem next to it (`conf.gro` → `conf.top`) and, if one exists, uses its bonds.

Trajectory-only formats (`.xtc`, `.dcd`, `.nc`) and volumetric grids (`.cube`, `.cub`, `.dx`) need a structure loaded first — open the structure file, then wire the trajectory or grid in via the pipeline editor. Opening one directly surfaces an actionable error. Spectra (`.jdx`, `.jcamp`) have no atoms at all; opening one points you at the **Load Spectrum** → **Spectrum Plot** nodes. LAMMPS dumps are *not* in that group: frame 0 supplies the topology, so `.lammpstrj` / `.dump` / `.trj` open standalone as multi-frame structures (and can still be attached to a separate topology through the Load Trajectory node).

## Visual pipeline editor

The VS Code custom editor mounts the full visual pipeline editor. You can build and edit visualization workflows by wiring nodes, just like in the standalone web app.

Pipelines are saved as `.megane.json` files, which open in a dedicated **megane Pipeline Viewer** editor. Save, share, and version-control these recipes alongside your project. When a pipeline opens, the files its Load Structure and Load Trajectory nodes name are read relative to the `.megane.json` file's folder; absolute paths and paths that leave that folder are ignored. Only version 3 pipeline files are accepted.

Both editors are read-only views of the file on disk: editing the pipeline does not rewrite the opened file. Exports (pipeline JSON, renders, animations, measurements, structures) go through VS Code's native save dialog. The camera position is remembered per editor tab.

In a remote window (Remote - SSH, WSL, Dev Containers, Codespaces) or in code-server, the **Load Structure** and **Load Trajectory** nodes also show **Open from remote…**. The node's own *Load structure…* / *Load trajectory…* button opens your computer's file dialog; *Open from remote…* opens VS Code's open dialog instead, which browses the workspace's machine and starts in the folder of the open file.

## megane Builder (structure editor)

Click the *megane* icon (a pair of glasses) in the activity bar: its *Builder*
view has **New Structure** and **Open File in Builder…**. A structure file
also has **Open in megane Builder** in the Explorer's context menu, and a
megane viewer tab has the same button in its title bar. The Builder opens in
an editor tab; *Save* goes through VS Code's save dialog. See
[megane Builder](builder.md#in-vs-code-jupyterlab-and-notebooks).

## Status bar integration

The current trajectory frame index, atom selection count, and measurement label are reflected in the VS Code status bar. Other extensions can drive the viewer programmatically — e.g. `vscode.commands.executeCommand('megane.seekFrame', N)` seeks the most recently active megane webview to frame `N`.

For a per-platform breakdown of supported formats and UI features (including known gaps), see [Platform Support](/platform-support).
