# JupyterLab extension

The megane JupyterLab extension adds a document-style molecular viewer to JupyterLab. Open a supported file from the JupyterLab file browser and it renders in its own tab with the full pipeline editor — no notebook cell required.

## Installation

The labextension ships inside the `megane` wheel, so a single install covers it:

```bash
pip install megane
```

Restart JupyterLab after installing. The extension registers automatically — no `jupyter labextension install` step is needed.

## Opening files

Double-click any supported file in the JupyterLab file browser and megane opens it in a document tab:

| File type | Extensions |
|-----------|-----------|
| Structures | `.pdb`, `.gro`, `.xyz`, `.jxyz`, `.extxyz`, `.mol`, `.sdf`, `.mol2`, `.cif`, `.mmcif`, `.data`, `.lammps`, `.prmtop`, `.traj`, `.lammpstrj`, `.dump`, `.trj`, `POSCAR`, `CONTCAR`, `XDATCAR`, `.vasp`, `.molden`, `.xsf`, `.axsf`, `.cml`, `.c3xml`, `.xodydata`, `.odydata`, `.magres`, `.gamess`, `.phonon` |
| Trajectories | `.xtc`, `.dcd`, `.nc` |
| Volumetric grids | `.cube`, `.cub`, `.dx` |
| Spectra | `.jdx`, `.jcamp`, `.dx` |
| Pipelines | `.megane.json` |

The VASP names are matched as filenames rather than extensions, so `POSCAR`, `POSCAR.orig` and friends all open.

Trajectory-only formats (`.xtc`, `.dcd`, `.nc`) and volumetric grids (`.cube`, `.cub`, `.dx`) need a structure loaded first — open the structure file, then wire the trajectory or grid in through the pipeline editor. Opening one directly surfaces an actionable error. LAMMPS dumps are *not* in that group: they carry their own topology in frame 0, so `.lammpstrj` / `.dump` / `.trj` open standalone as multi-frame structures (and can still be attached to a separate topology through the Load Trajectory node).

## Visual pipeline editor

The JupyterLab DocWidget mounts the full visual pipeline editor, so you can build and edit visualization workflows by wiring nodes, just as in the standalone web app. Pipelines saved as `.megane.json` reopen in the same editor.

## Events for other extensions

The JupyterLab DocWidget has no Python kernel connection, so events are surfaced as a subscription API rather than a Python callback. Other JupyterLab extensions can react to viewer state via `MeganeReactView.subscribeFrameChange`, `subscribeSelectionChange`, and `subscribeMeasurementChange`. When `IStatusBar` is available, the current frame index is also shown in the JupyterLab status bar.

For a per-platform breakdown of supported formats and UI features (including known gaps), see [Platform Support](/platform-support).
