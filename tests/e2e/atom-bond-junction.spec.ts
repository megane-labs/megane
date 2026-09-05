/**
 * Atom / bond junction under transparency.
 *
 * The bond impostor draws each cylinder from atom centre to atom centre, so
 * both ends are buried inside the endpoint spheres. While everything is opaque
 * the depth test hides that. Fade the atoms and the sphere stops writing depth,
 * so the buried stick blends straight through the ball — a ball-and-stick model
 * suddenly reads as beads threaded onto rods instead of one fused solid.
 *
 * The fix trims the cylinder against both endpoint spheres in the fragment
 * shader, leaving exactly the CSG union's outer surface. The invariant pinned
 * down here is stronger than a pixel baseline: inside the projected disc of a
 * ball, the image must be *identical* whether the sticks are drawn or not,
 * because the union's surface there is the sphere alone. The stick between the
 * two balls must of course still be there.
 *
 * Fixture is a bare C–C dimer along x so nothing else can project onto the
 * sampled pixels, and its bonds are distance-inferred — flipping the add_bond
 * node to file-declared bonds yields zero bonds on an XYZ, which is how the
 * "no sticks" reference is captured. Webapp host only: the trim lives in shared
 * renderer code that every host bundles.
 */

import { test, expect, type Frame, type Page } from "playwright/test";
import { PNG } from "pngjs";
import {
  assertDomContract,
  defaultViewerContract,
  expectViewerRegionMatch,
  getReadyState,
  stabilizeUi,
  waitForReady,
} from "./lib/setup";
import { bootHost, getHost, type HostBoot } from "./lib/host-fixture";
import {
  findNodeIdByType,
  insertNode,
  connectEdge,
  removeNode,
  setNodeParam,
} from "./lib/pipeline";
import { alignCamera, getProjectedAtoms, resetCamera } from "./lib/render-utils";
import { join } from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");

const PLATFORM = "atom-bond-junction";
const FIXTURE = "cc_dimer.xyz";
const FIXTURE_ATOMS = 2;
/** Atom opacity for every capture — enough fade to expose a buried stick. */
const ATOM_OPACITY = 0.35;
/** Viewport's own background (`src/components/Viewport.tsx`). */
const BACKGROUND = [255, 255, 255, 255];

test.describe.configure({ mode: "serial" });

let boot: HostBoot | null = null;
let addBondId = "";
let atoms: Awaited<ReturnType<typeof getProjectedAtoms>> = [];
/** Screen-space midpoint between the two atoms — where the stick must appear. */
let midX = 0;
let midY = 0;

test.beforeAll(async ({ browser }, info) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  boot = await bootHost(page, { fixture: FIXTURE, portSeed: info.workerIndex + 29 });
  await assertDomContract(boot.scope, [
    ...defaultViewerContract({ expectedAtoms: FIXTURE_ATOMS, context: boot.context }),
  ]);
  const scope = boot.scope;

  // The webapp boots by loading its caffeine_water demo plus a 100-frame XTC,
  // and dropping this fixture in replaces only the structure — the demo
  // trajectory stays wired. Since #673 frame data always wins over the
  // snapshot, so caffeine_water's frame-0 coordinates get applied to these two
  // atoms and fling them thousands of pixels off-screen (resetCamera cannot
  // recover: it fits the snapshot's bounds, not the frame's). Drop the
  // trajectory node — this spec renders a single static structure — and then
  // re-drop the fixture, because removing the node stops further frame updates
  // but leaves the coordinates a frame already wrote.
  await removeNode(scope, await findNodeIdByType(scope, "load_trajectory"));
  await (scope as Page)
    .locator('input[type="file"]')
    .first()
    .setInputFiles(join(REPO_ROOT, "tests", "fixtures", FIXTURE));
  await waitForReady(scope, { needsData: true, timeout: 30_000 });

  const replicateId = await findNodeIdByType(scope, "replicate");
  const viewportId = await findNodeIdByType(scope, "viewport");
  addBondId = await findNodeIdByType(scope, "add_bond");

  // The pivot marker draws a crosshair at the view centre, which is exactly the
  // midpoint between these two atoms — the pixel setBondsVisible settles on.
  // Turn it off so that pixel is the stick or the background, nothing else.
  await setNodeParam(scope, viewportId, { pivotMarkerVisible: false });

  // Fade the atoms. Bonds stay fully opaque: the contrast is what makes a
  // buried stick obvious inside a ball.
  const atomModifyId = await insertNode(scope, "modify");
  await setNodeParam(scope, atomModifyId, { scale: 1.0, opacity: ATOM_OPACITY });

  const before = await getReadyState(scope);
  await connectEdge(scope, replicateId, atomModifyId, "particle", "in");
  await connectEdge(scope, atomModifyId, viewportId, "out", "particle");
  await waitForReady(scope, { untilEpoch: before.renderEpoch + 1, timeout: 15_000 });

  atoms = await waitForFittedAtoms(scope);
  midX = (atoms[0].sx + atoms[1].sx) / 2;
  midY = (atoms[0].sy + atoms[1].sy) / 2;
});

/**
 * Read the projected atom positions once the camera has actually fitted them.
 *
 * `waitForReady` resolves on a rendered frame, which can precede the boot-time
 * fit: roughly one run in six the projection reports the same off-screen
 * coordinates indefinitely, and every pixel this spec samples then lands
 * nowhere. `resetCamera()` re-fits on demand — the same thing camera.spec.ts
 * does before asserting, and what the "Reset View" button does for a user — so
 * ask for the fit rather than hoping boot delivered it, then poll until it has
 * landed. The atoms are static afterwards (the frame is pinned and nothing
 * moves the camera), so one settled read serves the whole run.
 *
 * The fit lands in the standard orientation (#661), which looks roughly down
 * the x axis — and the fixture's bond runs along x, so the two balls would
 * overlap on screen and swallow the midpoint this spec samples. Turn the
 * camera onto +y afterwards: the bond then lies flat across the screen with
 * the fit's zoom kept.
 */
async function waitForFittedAtoms(
  scope: Page | Frame,
): Promise<Awaited<ReturnType<typeof getProjectedAtoms>>> {
  const box = await scope.locator('[data-testid="viewer-root"]').first().boundingBox();
  const w = box?.width ?? 0;
  const h = box?.height ?? 0;
  const deadline = Date.now() + 20_000;
  let latest: Awaited<ReturnType<typeof getProjectedAtoms>> = [];
  do {
    await resetCamera(scope);
    await alignCamera(scope, "+y");
    latest = await getProjectedAtoms(scope);
    const fitted =
      latest.length === FIXTURE_ATOMS &&
      latest.every((p) => p.sx >= 0 && p.sx <= w && p.sy >= 0 && p.sy <= h);
    if (fitted) return latest;
    await scope.waitForTimeout(200);
  } while (Date.now() < deadline);

  throw new Error(
    `camera never fitted the ${FIXTURE_ATOMS} atoms into ${w}x${h} after 20s: ` +
      JSON.stringify(latest.map((p) => [Math.round(p.sx), Math.round(p.sy)])),
  );
}

test.afterAll(async () => {
  if (boot) {
    await boot.teardown();
    boot = null;
  }
});

/**
 * Show or hide the sticks by switching where add_bond gets its connectivity,
 * and return the settled capture. The XYZ fixture declares no bonds, so "file"
 * produces none at all.
 *
 * Settles by polling the rendered midpoint between the two atoms — the pixel
 * this spec is actually about — rather than a render-epoch tick or the viewer's
 * bond counter. An epoch can be bumped by an unrelated frame before the
 * pipeline has applied, and `data-bond-count` has three writers (snapshot load,
 * pipeline bond streams, per-frame distance bonding) whose order decides which
 * value lands last. Polling the image cannot go stale, and if the stick never
 * arrives — say a future change trimmed the whole bond away — this times out
 * naming exactly that, which is a better failure than a silent pixel match.
 */
async function setBondsVisible(visible: boolean): Promise<Shot> {
  const scope = boot!.scope;
  await setNodeParam(scope, addBondId, { bondSource: visible ? "distance" : "file" });

  const deadline = Date.now() + 30_000;
  let shot: Shot;
  let mid: number[];
  do {
    await stabilizeUi(scope);
    shot = await shootViewer();
    mid = pixelAt(shot, midX, midY);
    // The viewer paints a white background, so a stick at the midpoint is the
    // only thing that can darken it.
    if (maxChannelDelta(mid, BACKGROUND) > 8 === visible) return shot;
    await scope.waitForTimeout(250);
  } while (Date.now() < deadline);

  throw new Error(
    `bonds never became ${visible ? "visible" : "hidden"}: midpoint pixel ${mid} ` +
      `after 30s (background is ${BACKGROUND})`,
  );
}

interface Shot {
  png: PNG;
  /** Screenshot pixels per CSS pixel (device scale factor). */
  scale: number;
}

/**
 * Screenshot the viewer region and note its CSS→device pixel ratio.
 *
 * `viewer-root` is the renderer's own container element, which is the frame
 * `getProjectedAtomPositions()` reports its coordinates in, so projected atoms
 * map onto these pixels directly. Screenshotting the `<canvas>` itself comes
 * back blank — its drawing buffer is not preserved.
 */
async function shootViewer(): Promise<Shot> {
  const root = boot!.scope.locator('[data-testid="viewer-root"]').first();
  const box = await root.boundingBox();
  const buf = await root.screenshot({ animations: "disabled", caret: "hide" });
  const png = PNG.sync.read(buf);
  return { png, scale: png.width / (box?.width ?? png.width) };
}

/** RGBA at a CSS-pixel coordinate of the viewer region. */
function pixelAt(shot: Shot, cssX: number, cssY: number): [number, number, number, number] {
  const x = Math.round(cssX * shot.scale);
  const y = Math.round(cssY * shot.scale);
  expect(x, "sample x inside viewer").toBeGreaterThanOrEqual(0);
  expect(x, "sample x inside viewer").toBeLessThan(shot.png.width);
  expect(y, "sample y inside viewer").toBeGreaterThanOrEqual(0);
  expect(y, "sample y inside viewer").toBeLessThan(shot.png.height);
  const i = (shot.png.width * y + x) * 4;
  return [shot.png.data[i], shot.png.data[i + 1], shot.png.data[i + 2], shot.png.data[i + 3]];
}

function maxChannelDelta(a: number[], b: number[]): number {
  return Math.max(...a.map((v, i) => Math.abs(v - b[i])));
}

test("atom-bond-junction: a faded ball hides no buried stick", async () => {
  if (!boot) test.skip(true, "boot not initialised");
  const scope = boot!.scope;

  const [a, b] = atoms;
  const dx = b.sx - a.sx;
  const dy = b.sy - a.sy;

  const withoutBonds = await setBondsVisible(false);
  const withBonds = await setBondsVisible(true);

  // Carbon's ball spans 34 % of the bond (vdW 1.7 Å × 0.3 scale ÷ 1.5 Å), so
  // every sample below sits well inside the projected disc — and there the
  // stick is entirely swallowed by the sphere, so it must not tint a pixel.
  for (const t of [0.1, 0.15, 0.2, 0.25]) {
    for (const [origin, sign] of [
      [a, 1],
      [b, -1],
    ] as const) {
      const x = origin.sx + sign * dx * t;
      const y = origin.sy + sign * dy * t;
      const clean = pixelAt(withoutBonds, x, y);
      const drawn = pixelAt(withBonds, x, y);
      expect(
        maxChannelDelta(clean, drawn),
        `stick shows through the ball at t=${t} (${clean} vs ${drawn})`,
      ).toBeLessThanOrEqual(2);
    }
  }

  // Sanity: the stick between the two balls really is drawn, so the loop above
  // cannot pass by the trim having eaten the whole bond. setBondsVisible
  // already settles on this, so it can only fail if the two captures drifted.
  const midClean = pixelAt(withoutBonds, midX, midY);
  const midDrawn = pixelAt(withBonds, midX, midY);
  expect(maxChannelDelta(midClean, midDrawn), "midpoint stick missing").toBeGreaterThan(8);
});

test("atom-bond-junction: faded ball-and-stick renders as one fused solid", async () => {
  if (!boot) test.skip(true, "boot not initialised");
  await setBondsVisible(true);
  await expectViewerRegionMatch(boot!.scope, PLATFORM, `${getHost()}-transparent-junction`);
});
