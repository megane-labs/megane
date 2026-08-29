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

import { test, expect } from "playwright/test";
import { PNG } from "pngjs";
import {
  assertDomContract,
  defaultViewerContract,
  expectViewerRegionMatch,
  getReadyState,
  pinFrame,
  stabilizeUi,
  waitForReady,
} from "./lib/setup";
import { bootHost, getHost, type HostBoot } from "./lib/host-fixture";
import { findNodeIdByType, insertNode, connectEdge, setNodeParam } from "./lib/pipeline";
import { getProjectedAtoms } from "./lib/render-utils";

const PLATFORM = "atom-bond-junction";
const FIXTURE = "cc_dimer.xyz";
const FIXTURE_ATOMS = 2;
/** Atom opacity for every capture — enough fade to expose a buried stick. */
const ATOM_OPACITY = 0.35;

test.describe.configure({ mode: "serial" });

let boot: HostBoot | null = null;
let addBondId = "";

test.beforeAll(async ({ browser }, info) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  boot = await bootHost(page, { fixture: FIXTURE, portSeed: info.workerIndex + 29 });
  await assertDomContract(boot.scope, [
    ...defaultViewerContract({ expectedAtoms: FIXTURE_ATOMS, context: boot.context }),
  ]);
  // The webapp boots with a 100-frame demo trajectory attached; pin frame 0 so
  // captures don't race its asynchronous first apply (see camera.spec.ts).
  await pinFrame(boot.scope, 0);

  const scope = boot.scope;
  const replicateId = await findNodeIdByType(scope, "replicate");
  const viewportId = await findNodeIdByType(scope, "viewport");
  addBondId = await findNodeIdByType(scope, "add_bond");

  // Fade the atoms. Bonds stay fully opaque: the contrast is what makes a
  // buried stick obvious inside a ball.
  const atomModifyId = await insertNode(scope, "modify");
  await setNodeParam(scope, atomModifyId, { scale: 1.0, opacity: ATOM_OPACITY });

  const before = await getReadyState(scope);
  await connectEdge(scope, replicateId, atomModifyId, "particle", "in");
  await connectEdge(scope, atomModifyId, viewportId, "out", "particle");
  await waitForReady(scope, { untilEpoch: before.renderEpoch + 1, timeout: 15_000 });
});

test.afterAll(async () => {
  if (boot) {
    await boot.teardown();
    boot = null;
  }
});

/**
 * Show or hide the sticks by switching where add_bond gets its connectivity.
 * The XYZ fixture declares no bonds, so "file" produces none at all.
 *
 * Waits on the viewer's own bond count rather than a render-epoch tick: under
 * load an unrelated frame can bump the epoch before the pipeline has applied,
 * and a capture taken then would silently compare two identical images.
 */
async function setBondsVisible(visible: boolean): Promise<void> {
  const scope = boot!.scope;
  await setNodeParam(scope, addBondId, { bondSource: visible ? "distance" : "file" });
  await scope
    .locator(`[data-bond-count="${visible ? 1 : 0}"]`)
    .first()
    .waitFor({ state: "attached", timeout: 15_000 });
  const after = await getReadyState(scope);
  await waitForReady(scope, { untilEpoch: after.renderEpoch + 1, timeout: 15_000 });
  await stabilizeUi(scope);
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

  const atoms = await getProjectedAtoms(scope);
  expect(atoms).toHaveLength(2);
  const [a, b] = atoms;
  const dx = b.sx - a.sx;
  const dy = b.sy - a.sy;

  await setBondsVisible(false);
  const withoutBonds = await shootViewer();

  await setBondsVisible(true);
  const withBonds = await shootViewer();

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

  // Sanity: the stick between the two balls is still drawn. Without this the
  // loop above would also pass if the trim had eaten the whole bond.
  const midClean = pixelAt(withoutBonds, a.sx + dx * 0.5, a.sy + dy * 0.5);
  const midDrawn = pixelAt(withBonds, a.sx + dx * 0.5, a.sy + dy * 0.5);
  expect(maxChannelDelta(midClean, midDrawn), "midpoint stick missing").toBeGreaterThan(8);
});

test("atom-bond-junction: faded ball-and-stick renders as one fused solid", async () => {
  if (!boot) test.skip(true, "boot not initialised");
  await setBondsVisible(true);
  await expectViewerRegionMatch(boot!.scope, PLATFORM, `${getHost()}-transparent-junction`);
});
