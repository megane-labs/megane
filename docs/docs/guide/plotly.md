# Plotly

Control the Megane viewer from Plotly charts using ipywidgets event interop. Click a data point on a Plotly `FigureWidget` to jump to the corresponding trajectory frame.

## Click to Select Frame

```python
import plotly.graph_objects as go
import ipywidgets as widgets
import megane

viewer = megane.view_traj("protein.pdb", xtc="trajectory.xtc")
frames = list(range(viewer.total_frames))
energy = ...  # one value per frame, e.g. from your simulation log

# Create a Plotly time-series chart, plus a marker for the current frame
fig = go.FigureWidget(
    data=[
        go.Scatter(x=frames, y=energy, mode="lines+markers", name="Energy"),
        go.Scatter(x=[0], y=[energy[0]], mode="markers", marker=dict(size=12, color="red"), name="Current"),
    ],
    layout=go.Layout(
        xaxis_title="Frame", yaxis_title="Energy (kJ/mol)",
    ),
)

# Plotly click → Megane frame selection
def on_click(trace, points, state):
    if points.point_inds:
        viewer.frame_index = points.point_inds[0]

fig.data[0].on_click(on_click)

# Display side by side
widgets.VBox([fig, viewer])
```

## Sync Plotly Marker with Current Frame

Use Megane's `on_event("frame_change")` callback to update a marker on the Plotly chart:

```python
# Megane → Plotly (update red marker on the chart)
marker_trace = fig.data[1]

@viewer.on_event("frame_change")
def update_marker(data):
    idx = data["frame_index"]
    with fig.batch_update():
        marker_trace.x = [idx]
        marker_trace.y = [energy[idx]]
```

## Dihedral Trajectory Analysis

Collect dihedral angles across all frames and plot the result. The viewer
computes measurements in the browser, and the kernel cannot receive them while
a cell is still running, so a loop that sets `frame_index` and waits for
`measurement` events collects nothing. Compute the series from the trajectory
in Python and let the viewer highlight the same atoms:

```python
import numpy as np
from megane import load_trajectory

atoms = [10, 20, 30, 40]
viewer.selected_atoms = atoms  # live dihedral in the viewer

def dihedral_deg(p0, p1, p2, p3):
    b0, b1, b2 = p0 - p1, p2 - p1, p3 - p2
    b1n = b1 / np.linalg.norm(b1)
    v = b0 - np.dot(b0, b1n) * b1n
    w = b2 - np.dot(b2, b1n) * b1n
    return float(np.degrees(np.arctan2(np.dot(np.cross(b1n, v), w), np.dot(v, w))))

trajectory = load_trajectory("protein.pdb", "trajectory.xtc")
dihedrals = [
    dihedral_deg(*trajectory.get_frame(i)[atoms]) for i in range(trajectory.n_frames)
]

# Plot with Plotly
fig = go.FigureWidget(
    data=[go.Scatter(y=dihedrals, mode="lines", name="Dihedral")],
    layout=go.Layout(xaxis_title="Frame", yaxis_title="Angle (°)"),
)
fig
```

See [`examples/external_events.ipynb`](https://github.com/megane-labs/megane/blob/main/examples/external_events.ipynb) for complete working examples.
