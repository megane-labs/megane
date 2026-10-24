# VR and AR headsets

Megane can move its 3D view into a headset through [WebXR](https://immersiveweb.dev/):
the structure floats at arm's length in front of you, and you grab it with
your hands or controllers to turn it, carry it and scale it. A panel below
it plays the trajectory, measures distances and angles, and takes you back
out, so the page is not needed while you are inside. It works in the viewer
and in Megane Builder — where the hands also edit the structure (see
[Building in the headset](#building-in-the-headset-megane-builder)) — on any
page that shows the **VR** / **AR** buttons under the view-axis buttons in
the top-left corner.

The buttons appear only where the browser can actually start an immersive
session — for example Meta Quest Browser on a Quest headset, or Chrome / Edge
on a PC with a VR runtime (SteamVR, Quest Link) running. Each button is shown
only for a mode the browser supports.

**AR** is passthrough mixed reality (on Quest 3 / 3S, for example): the
background disappears and the structure floats in your room as the headset
cameras see it.

Everything in the headset works with **hands alone** — pinch where a
controller would pull its trigger — so glasses that track hands rather than
controllers can drive it too, for example XREAL AURA (Android XR) if its
browser offers WebXR. Display-only glasses that plug into a phone or PC as a
second screen (XREAL Air / One) have no WebXR; they show the page itself.

## Opening Megane on the headset

WebXR only runs on a *secure* page: one served over HTTPS, or from
`localhost`. Any of these works:

- **An HTTPS deployment** of the web app — the hosted demo, or your own
  `megane serve` behind an HTTPS reverse proxy. Open its address in the
  headset's browser.
- **Your computer's dev server over USB (Quest)**: with the Quest in
  developer mode and connected by USB, forward the port so the headset sees it
  as its own `localhost`:

  ```bash
  npm run build:wasm
  npm run dev                      # http://localhost:5173 on the computer
  adb reverse tcp:5173 tcp:5173    # now also http://localhost:5173 on the Quest
  ```

  Then open `http://localhost:5173` (viewer) or
  `http://localhost:5173/builder.html` (Builder) in Meta Quest Browser.
- **PC VR**: open the page in Chrome or Edge on the PC with the headset's
  runtime running; the desktop page keeps an **Exit VR** button while the
  session runs.

A plain `http://<computer-ip>:5173` address from another device is *not* a
secure context, so the buttons stay hidden there.

On JupyterLab, the viewer shows the buttons when JupyterLab itself is opened
in the headset's browser over HTTPS (or `localhost`). The VS Code webview has
no WebXR, so the VS Code extension never shows them.

## Controls

| Action | Controllers | Hands |
|---|---|---|
| Carry and turn | Hold the grip (or the trigger, pointing at nothing), move the controller | Pinch away from the panel and move the hand |
| Scale | Hold with both controllers, pull apart / push together | Pinch with both hands, pull apart / push together |
| Zoom | Thumbstick forward / back | Both hands (above) |
| Spin about the vertical axis | Thumbstick left / right | One hand (above) |
| Press a panel button | Point at it, pull the trigger | Point at it, pinch |
| Play / pause the trajectory | B or Y, or the panel | The panel |
| Put it back in front of you | A or X, or the panel's **Reset** | The panel's **Reset** |
| Leave | The panel's **Exit**, or the system menu | The panel's **Exit**, or the system menu |

The structure enters the room the same side up as the desktop view showed
it, about 1.1 m ahead and slightly below eye level, scaled so that it is
about 80 cm across. Scaling anchors at the point between your hands, so put
your hands on the part you want to enlarge.

A thin ray shows what you are pointing at whenever it lands on the panel (or,
while measuring, on an atom). The trigger or a pinch acts on what the ray
points at — a panel button, then an atom — and grabs the structure only when
it points at neither. The grip always grabs.

### The panel

The panel floats below the structure, about 35° below your line of sight:
look down to use it. It stays put while you look around, and glides back in
front of you once you turn or walk away from it.

- **⏮ ▶ ⏭ and the bar** step, play / pause and scrub the trajectory (hold the
  trigger or pinch on the bar and slide). The page's timeline follows.
- **Measure** turns the measure mode on and off; **Clear** drops the atoms
  picked so far.
- **Reset** puts the structure back in front of you, as A / X does.
- **Exit** leaves the headset view.

The top line shows the frame and, while measuring, the measurement. Megane
Builder's panel carries its tools instead; see the next section.

## Building in the headset (Megane Builder)

In Manual mode the Builder's panel is wider and carries what the desktop
keeps on its left rails and in its Details panel:

- **the tools** — Select, Move, Add atom, Bond, Element, Delete, Place;
- **the current tool's settings** in the two rows under them — the element
  (C H N O F P S Cl Br Si a press away, **More…** for the whole periodic
  table), the bond order, how hydrogens are kept (**H auto / on / off**),
  **Snap** and the selection commands (**All**, **Invert**, **Clear**,
  **Molecule**, **Same element**), and for Place the library molecules
  (**‹ ›** page through them) and **On atoms**;
- **Undo**, **Redo**, **Delete sel.**, **Clean up**, **Original** (show the
  structure without its edits) and **Save** (in the document's own format, as
  ⌘ / Ctrl + S) before Reset and Exit.

The top lines say what the next pinch does, or show the Builder's notice or a
drag's readout.

The hands work like the mouse:

| Desktop | Headset |
|---|---|
| Click an atom with the current tool | Point at it, pinch and let go |
| Click empty space (Add atom, Place) | Point past the structure, pinch and let go: the atom or molecule goes where the ray passes the structure's middle, which the ray shows while it points at nothing |
| Drag the selection (Select) / any atom (Move) | Pinch the atom and move your hand: the atoms follow it, turning with your wrist, as one Undo step |
| Ctrl / Shift-click to add to or take from the selection | A pinch with Select or Move adds the atom or takes it out; one on empty space clears the selection |
| Shift-click the second atom to remove a bond | Bond tool with **Remove** on |
| Drag empty space to turn the view | Pinch empty space and move your hand (or hold the grip), as in the viewer |

While the ray rests on an atom, what a pinch would act on lights up in the
desktop's colours — blue to select, red to delete, amber to change the
element, violet to attach, bond or adsorb onto. Atoms a drag brings too close
turn red, as on the desktop, and **Snap** rounds a drag to 0.1 Å and 15°.

The File menu (opening a file, a new cell or crystal), the Structure and
Tools menus, the Inspector's fields, the History list and Flow mode stay on
the page. In Flow mode the headset shows the picked block's result, with
just Reset and Exit.

### Measuring

With **Measure** on, point at an atom: it lights up blue and the ray turns
blue. Pinch (or pull the trigger) to add it to the measurement, again to take
it out. Two atoms give a distance, three an angle, four a dihedral — the same
selection as right-clicking atoms on the desktop, so the page's Measurement
panel shows it too. The value floats above the atoms in the room and on the
panel.

Atoms are easy to hit even when small: each counts as at least 8 mm across in
the room, and an atom the ray passes through wins over one it only grazes.

### Labels

Atom labels from a Label node show in the headset too, for the 64 labelled
atoms nearest you in front of you, refreshed a few times a second as you move.

### Comfort

A headset's lenses focus at a fixed distance of one to two metres. Looking
at something much nearer makes your eyes converge on one distance while
focusing at another, which tires them quickly and, very close, stops the two
images from fusing into one. So:

- To see detail, **make the structure bigger** (both hands, or the
  thumbstick) rather than leaning in.
- Anything within 50 cm of your eyes fades out, and nothing within 30 cm is
  drawn.
- The far side of the structure fades toward the background colour (toward
  black in AR). Near atoms stay crisp, so depth reads clearly, even from
  inside a large model. On a white background the hydrogens fade first; a
  dark theme keeps them visible further back.

Cartoons, surfaces and polyhedra are lit from your side, as the desktop view
lights them, wherever you carry the structure in the room.

The pipeline, representation and colours are the ones the desktop view had;
change them on the page before entering.

## What stays on the desktop

The immersive view is for looking, measuring and (in the Builder) editing
atoms and bonds. These still need the page:

- the pipeline editor, Inspector and every other panel;
- the cell-axes inset, the pivot crosshair and the hover tooltip;
- the Builder's File, Structure and Tools menus, its Inspector fields,
  History list and Flow mode (its tools, settings and Undo / Redo / Save are
  on the headset panel).

For contributors, the implementation is in `src/renderer/xr/`: placement,
gestures and the panel's geometry in `xrMath.ts`, the session and its input
in `XRSessionController.ts`, the panel in `XRPanel.ts`, labels in
`xrLabels.ts` (drawn with `xrText.ts`), and the head-relative lights in
`xrLights.ts`. The page hands the session its playback and measurement
through an `XRBridge` (`XRControls.tsx`); atoms are picked along the ray by
`pickAtomOnRay` (`Picking.ts`). An editing page adds an `XREditBridge`: it
describes the panel's buttons (`XREditPanel`, laid out and drawn by
`XRPanel.ts`) and answers presses, clicks and drags, which the session tells
apart with a click slop (`movedPastSlop`) and turns into a rigid motion of the
grabbed atoms (`handMotion`). The Builder's bridge is `src/builder/xr.ts`,
which goes through the same `BuildHandlers` as the mouse (`dragRigid` for a
hand's drag). In a session the impostor shaders switch to
an exact perspective ray-cast (`uExactImpostor`) and finish every fragment
with `xrFinish` (`shaders.ts`): the near fade, the depth cue, and a one-pixel
edge ramp that alpha-to-coverage turns into anti-aliased silhouettes. The `xr`
Playwright project (`npm run test:e2e:xr`) runs the whole flow — entering,
grabbing, pressing the panel, and deleting, adding and dragging atoms in the
Builder — in headless Chromium under Meta's
[IWER](https://github.com/meta-quest/immersive-web-emulation-runtime) Quest 3
emulator.
