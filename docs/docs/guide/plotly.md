# Plotly

Control the megane viewer from Plotly charts using ipywidgets event interop. Click a data point on a Plotly `FigureWidget` to jump to the corresponding trajectory frame.

## Click to Select Frame

```python
import plotly.graph_objects as go
import ipywidgets as widgets
import megane

viewer = megane.view_traj("protein.pdb", xtc="trajectory.xtc")

# Create a Plotly time-series chart
fig = go.FigureWidget(
    data=[go.Scatter(x=frames, y=energy, mode="lines+markers", name="Energy")],
    layout=go.Layout(
        xaxis_title="Frame", yaxis_title="Energy (kJ/mol)",
    ),
)

# Plotly click → megane frame selection
def on_click(trace, points, state):
    if points.point_inds:
        viewer.frame_index = points.point_inds[0]

fig.data[0].on_click(on_click)

# Display side by side
widgets.VBox([fig, viewer])
```

## Sync Plotly Marker with Current Frame

Use megane's `on_event("frame_change")` callback to update a marker on the Plotly chart:

```python
# megane → Plotly (update red marker on the chart)
@viewer.on_event("frame_change")
def update_marker(data):
    idx = data["frame_index"]
    with fig.batch_update():
        marker_trace.x = [idx]
        marker_trace.y = [energy[idx]]
```

## Dihedral Trajectory Analysis

Collect dihedral angles across all frames and plot the result:

```python
import time

viewer.selected_atoms = [10, 20, 30, 40]  # define the dihedral
dihedrals = []

@viewer.on_event("measurement")
def collect(data):
    if data and data["type"] == "dihedral":
        dihedrals.append(data["value"])

# Scan all frames
for i in range(viewer.total_frames):
    viewer.frame_index = i
    time.sleep(0.01)  # allow widget sync

viewer.off_event("measurement", collect)  # clean up

# Plot with Plotly
fig = go.FigureWidget(
    data=[go.Scatter(y=dihedrals, mode="lines", name="Dihedral")],
    layout=go.Layout(xaxis_title="Frame", yaxis_title="Angle (°)"),
)
fig
```

See [`examples/external_events.ipynb`](https://github.com/megane-labs/megane/blob/main/examples/external_events.ipynb) for complete working examples.
