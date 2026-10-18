# ipywidgets Events

The `MolecularViewer` widget supports event callbacks for reacting to user interactions.

## Available Events

| Event | Trigger | Data |
|-------|---------|------|
| `frame_change` | Frame index changes | `{"frame_index": int}` |
| `selection_change` | `selected_atoms` is set from Python | `{"atoms": list[int]}` |
| `measurement` | A measurement of 2–4 selected atoms (set from Python or right-clicked in the viewer) is computed, changes on a new frame, or is cleared | `{"type": str, "value": float, "label": str, "atoms": list[int]}` or `None` |

Callbacks run in the kernel. Events that come from the browser (`measurement`,
and `frame_change` when the user scrubs or plays the timeline) are delivered
only between cell executions: a cell that is still running — a `for` loop
setting `frame_index`, for example — does not receive them until it finishes.

## Registering Callbacks

Use `on_event()` as a decorator or method call:

```python
import megane

viewer = megane.view("protein.pdb")

# As decorator
@viewer.on_event("measurement")
def on_measurement(data):
    print(f"Measured: {data}")

# As method call
def on_frame(data):
    print(f"Frame: {data['frame_index']}")

viewer.on_event("frame_change", on_frame)

# React to atom selection changes
@viewer.on_event("selection_change")
def on_selection(data):
    print(f"Selected atoms: {data['atoms']}")
```

## Removing Callbacks

Use `off_event()` to unregister:

```python
viewer.off_event("measurement", on_measurement)  # remove specific callback
viewer.off_event("frame_change")                  # remove all frame_change callbacks
```

## Programmatic Atom Selection

Select atoms from Python and read the measurement result directly:

```python
viewer.selected_atoms = [10, 20, 30, 40]  # select 4 atoms → triggers selection_change
```

The measurement is computed by the displayed widget and sent back to the
kernel, so read it from a later cell (or a `measurement` callback):

```python
result = viewer.measurement                # read measurement without callback
# {"type": "dihedral", "value": 120.5, "label": "120.5°", "atoms": [10, 20, 30, 40]}
```

Only the first 4 atoms of `selected_atoms` are used. Atoms right-clicked in the
viewer update `measurement` but do not change `selected_atoms`, so they fire
`measurement` and not `selection_change`.

The `measurement` property returns:
- `None` if fewer than 2 atoms are selected
- A dict with `type` (`"distance"`, `"angle"`, or `"dihedral"`), `value` (float), `label` (formatted string), and `atoms` (list of indices)
