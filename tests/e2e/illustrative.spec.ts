/**
 * Illustrative representation coverage (Mol* parity).
 *
 * Wires `load_structure → color → representation → viewport` and switches both
 * new nodes to "illustrative", reproducing Mol*'s illustrative preset: spacefill
 * spheres at the full van der Waals radius, flat unlit shading with a dark
 * silhouette outline, and carbon tinted by chain while other elements keep their
 * CPK colors. Bonds are hidden because the touching spheres already swallow them.
 *
 * Ubiquitin is the fixture because it is the case the mode exists for: a protein
 * with backbone carbon and per-chain identity, where the Goodsell-style body
 * color and the CPK heteroatoms are both visible.
 *
 * The viewer-region baseline locks down the visual delta against the default
 * ball-and-stick view — the spheres are ~3.3× larger and unlit, so the diff is
 * large and obvious; visually inspect `webapp-illustrative-viewer.png` before
 * committing it.
 *
 * The onboarding tour is suppressed up-front (globalThis.__MEGANE_TEST__) so the
 * welcome modal can't overlay the capture — the webapp `?test=1` path alone does
 * not gate the tour, only the renderer's testMode.
 *
 * Webapp host only, for the same reason as licorice.spec.ts: the React Flow
 * store path (`__megane_test_pipeline_store`) is the deterministic way to flip
 * node params, and widget hosts build their pipeline via set_pipeline() instead.
 */

import { test } from "playwright/test";
import {
  assertDomContract,
  defaultViewerContract,
  expectFullPageMatch,
  expectViewerRegionMatch,
  getReadyState,
  pinFrame,
  stabilizeUi,
  waitForReady,
} from "./lib/setup";
import { bootHost, getHost, type HostBoot } from "./lib/host-fixture";
import { connectEdge, findNodeIdByType, insertNode, setNodeParam } from "./lib/pipeline";

const PLATFORM = "illustrative";
const FIXTURE = "1ubq.pdb";
const FIXTURE_ATOMS = 660;

test.describe.configure({ mode: "serial" });

let boot: HostBoot | null = null;

test.beforeAll(async ({ browser }, info) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    (globalThis as { __MEGANE_TEST__?: boolean }).__MEGANE_TEST__ = true;
  });
  boot = await bootHost(page, { fixture: FIXTURE, portSeed: info.workerIndex + 61 });
  await assertDomContract(boot.scope, [
    ...defaultViewerContract({ expectedAtoms: FIXTURE_ATOMS, context: boot.context }),
  ]);
  // Pin the displayed frame before any capture so a lazily applied frame 0
  // cannot race the screenshot.
  await pinFrame(boot.scope, 0);
});

test.afterAll(async () => {
  if (boot) {
    await boot.teardown();
    boot = null;
  }
});

test("illustrative: spacefill spheres render flat with an outline and no bonds", async () => {
  if (!boot) test.skip(true, "boot not initialised");
  const scope = boot!.scope;

  const loaderId = await findNodeIdByType(scope, "load_structure");
  const viewportId = await findNodeIdByType(scope, "viewport");
  const colorId = await insertNode(scope, "color");
  const repId = await insertNode(scope, "representation");
  await connectEdge(scope, loaderId, colorId, "particle", "in");
  await connectEdge(scope, colorId, repId, "out", "in");
  await connectEdge(scope, repId, viewportId, "out", "particle");

  const before = await getReadyState(scope);
  await setNodeParam(scope, colorId, { mode: "illustrative" });
  await setNodeParam(scope, repId, { mode: "illustrative" });
  await waitForReady(scope, { untilEpoch: before.renderEpoch + 1, timeout: 10_000 }).catch(() => {
    /* mode flip may not bump the epoch if it re-renders synchronously */
  });

  // Re-pin after the re-render: re-executing the pipeline re-applies the base
  // snapshot and the trajectory frame lands asynchronously again.
  await pinFrame(scope, 0);
  await stabilizeUi(scope);
  await expectFullPageMatch(boot!.scope, PLATFORM, `${getHost()}-illustrative`);
  await expectViewerRegionMatch(boot!.scope, PLATFORM, `${getHost()}-illustrative-viewer`);
});

/**
 * Regression for the Modify node's scale being dropped by the Color node.
 *
 * The illustrative preset always pairs `color` with `representation`, and the
 * color pass reloads the atom mesh to reset it to base CPK before painting the
 * new overrides on. That reload used to zero the per-atom scale buffer, so a
 * `modify` node downstream appeared to do nothing and the spacefill spheres
 * could not be shrunk at all. `MoleculeRenderer.restoreAtomPerAtomState` now
 * pushes the overrides back after the reload.
 *
 * Runs on the same host boot as the test above, which leaves both nodes already
 * set to "illustrative" — this only appends the Modify node and drops the
 * scale, so the baseline differs from the preceding one purely by sphere size.
 */
test("illustrative: the Modify node still shrinks the spheres through a Color node", async () => {
  if (!boot) test.skip(true, "boot not initialised");
  const scope = boot!.scope;

  const repId = await findNodeIdByType(scope, "representation");
  const viewportId = await findNodeIdByType(scope, "viewport");
  const modifyId = await insertNode(scope, "modify");
  await connectEdge(scope, repId, modifyId, "out", "in");
  await connectEdge(scope, modifyId, viewportId, "out", "particle");

  const before = await getReadyState(scope);
  await setNodeParam(scope, modifyId, { scale: 0.5 });
  await waitForReady(scope, { untilEpoch: before.renderEpoch + 1, timeout: 10_000 }).catch(() => {
    /* a param change may re-render synchronously without bumping the epoch */
  });

  await pinFrame(scope, 0);
  await stabilizeUi(scope);
  await expectViewerRegionMatch(boot!.scope, PLATFORM, `${getHost()}-illustrative-scaled-viewer`);
});
