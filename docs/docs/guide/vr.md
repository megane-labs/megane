# VR and AR headsets

Megane can move its 3D view into a headset through [WebXR](https://immersiveweb.dev/):
the structure floats at arm's length in front of you, and you grab it with
your hands or controllers to turn it, carry it and scale it. It works in
the viewer and in Megane Builder, on any page that shows the **VR** / **AR**
buttons under the view-axis buttons in the top-left corner.

The buttons appear only where the browser can actually start an immersive
session — for example Meta Quest Browser on a Quest headset, or Chrome / Edge
on a PC with a VR runtime (SteamVR, Quest Link) running. Each button is shown
only for a mode the browser supports.

**AR** is passthrough mixed reality (on Quest 3 / 3S, for example): the
background disappears and the structure floats in your room as the headset
cameras see it.

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

| Action | Controllers | Hands (Quest hand tracking) |
|---|---|---|
| Carry and turn | Hold trigger or grip, move the controller | Pinch and move the hand |
| Scale | Hold with both controllers, pull apart / push together | Pinch with both hands, pull apart / push together |
| Zoom | Thumbstick forward / back | — |
| Spin about the vertical axis | Thumbstick left / right | — |
| Put it back in front of you | A or X | — |
| Leave | The headset's system menu | The headset's system menu |

The structure enters the room the same side up as the desktop view showed
it, about 70 cm ahead and slightly below eye level, scaled so that it is
about half a metre across. Scaling anchors at the point between your hands,
so put your hands on the part you want to enlarge.

The pipeline, representation and colours are the ones the desktop view had;
change them on the page before entering.

## What stays on the desktop

The immersive view is for looking at a structure. These still need the page:

- the pipeline editor, Inspector and every other panel;
- atom labels, the cell-axes inset, the pivot crosshair and the hover tooltip;
- picking atoms, measurements and the Builder's editing tools.

For contributors, the implementation is in `src/renderer/xr/`: placement and
gestures in `xrMath.ts`, the session in `XRSessionController.ts`. In a
session the impostor shaders switch to an exact perspective ray-cast
(`uExactImpostor`), so spheres and sticks stay round however close you lean
in. The `xr` Playwright project (`npm run test:e2e:xr`) runs the whole flow
in headless Chromium under Meta's [IWER](https://github.com/meta-quest/immersive-web-emulation-runtime)
Quest 3 emulator.
