# API Reference

megane provides APIs for both Python and TypeScript/JavaScript.

## Python

The Python API is used for:

- **Jupyter widget** — Interactive viewer in a notebook cell (`MolecularViewer`), and the structure editor (`Builder`, see [megane Builder](/guide/builder#in-vs-code-jupyterlab-and-notebooks))
- **Standalone web app** — Served by `megane serve` over WebSocket
- **Python package** — Parse structure files and read trajectories programmatically

```python
import megane

# Quick start
viewer = megane.view("protein.pdb")

# With trajectory
viewer = megane.view_traj("protein.pdb", xtc="trajectory.xtc")
```

See the [Python Pipeline API guide](/guide/pipeline/python) for full documentation of the Pipeline class and all node types.

## TypeScript / JavaScript

The TypeScript API is used for:

- **React component (npm)** — Embed the viewer in web applications (`MeganeViewer`)
- **`MoleculeRenderer` core renderer** — Framework-agnostic Three.js rendering
- **Protocol decoding** — Parse binary messages from the `megane serve` backend

```ts
import { MeganeViewer, MoleculeRenderer } from "megane-viewer/lib";
```

See the [TypeScript Pipeline guide](/guide/pipeline/typescript) for full documentation of the TypeScript pipeline API and React component props.
