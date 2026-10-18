# Use with Vue, Svelte & Vanilla JS

`MoleculeRenderer` is a plain Three.js class — the same renderer powering all Megane components — that you can mount without React. Use it to embed Megane in Vue, Svelte, or any other framework, or directly in a vanilla `<div>`.

`megane-viewer/lib` is a single entry that also exports the React components, so `react` and `react-dom` (its peer dependencies) still have to be installed even when you only use `MoleculeRenderer`.

```ts
import { MoleculeRenderer, parseStructureText } from "megane-viewer/lib";

// Create and mount
const renderer = new MoleculeRenderer();
renderer.mount(document.getElementById("viewer")!);

// Load data (the file name picks the parser; PDB when omitted)
const text = await (await fetch("/data/caffeine_water.pdb")).text();
const { snapshot, frames } = await parseStructureText(text, "caffeine_water.pdb");
renderer.loadSnapshot(snapshot);

// Update positions for animation (multi-frame files fill `frames`)
if (frames.length > 0) renderer.updateFrame(frames[0]);

// Control appearance
renderer.setAtomScale(1.2);
renderer.setAtomOpacity(0.8);
renderer.setBondScale(0.5);
renderer.setPerspective(true);
renderer.setCellVisible(true);
renderer.setBackgroundColor(0x0f172a);

// Cleanup
renderer.dispose();
```

## Atom Selection & Measurement

```ts
// Select atoms programmatically
renderer.toggleAtomSelection(0);
renderer.toggleAtomSelection(1);

// Get measurement (distance, angle, or dihedral based on # selected)
const measurement = renderer.getMeasurement();
// { type: 'distance', value: 3.82, label: '3.820 Å', atoms: [0, 1] }

// Clear selection
renderer.clearSelection();
```

## Picking (Hover & Click)

Screen-space picking for identifying atoms and bonds. It takes client (viewport) coordinates, as found on a `PointerEvent`:

```ts
const hit = renderer.raycastAtPixel(event.clientX, event.clientY);
if (hit) {
  if (hit.kind === "atom") {
    console.log(`Atom ${hit.atomIndex}: ${hit.elementSymbol}`);
  } else if (hit.kind === "bond") {
    console.log(`Bond: ${hit.atomA}–${hit.atomB}, length=${hit.bondLength.toFixed(2)} Å`);
  }
}
```

For decoding binary WebSocket messages from the `megane serve` backend, see the [Protocol Utilities](/guide/web#protocol-utilities) section of the React component guide.
