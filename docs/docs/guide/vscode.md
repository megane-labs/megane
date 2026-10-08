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
| Spectra | `.jdx`, `.jcamp`, `.dx` |
| Pipelines | `.megane.json` |

The VASP entries are registered as filename globs rather than extensions, so `POSCAR`, `CONTCAR.bak` and similar all open.

Trajectory-only formats (`.xtc`, `.dcd`, `.nc`) and volumetric grids (`.cube`, `.cub`, `.dx`) need a structure loaded first — open the structure file, then wire the trajectory or grid in via the pipeline editor. Opening one directly surfaces an actionable error. LAMMPS dumps are *not* in that group: frame 0 supplies the topology, so `.lammpstrj` / `.dump` / `.trj` open standalone as multi-frame structures (and can still be attached to a separate topology through the Load Trajectory node).

## Visual pipeline editor

The VS Code custom editor mounts the full visual pipeline editor. You can build and edit visualization workflows by wiring nodes, just like in the standalone web app.

Pipelines are saved as `.megane.json` files, which open in a dedicated **megane Pipeline Viewer** editor. Save, share, and version-control these recipes alongside your project.

## Status bar integration

The current trajectory frame index, atom selection count, and measurement label are reflected in the VS Code status bar. Other extensions can drive the viewer programmatically — e.g. `vscode.commands.executeCommand('megane.seekFrame', N)` seeks the most recently active megane webview to frame `N`.

For a per-platform breakdown of supported formats and UI features (including known gaps), see [Platform Support](/platform-support).
