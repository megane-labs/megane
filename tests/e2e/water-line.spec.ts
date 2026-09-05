/**
 * Per-atom representation: "show the water as lines" and "hide the water".
 *
 * Caffeine dissolved in water (resname HOH). These are the two molecule-
 * selection requests the LLM benchmark targets, rendered against the real
 * pipeline so the snapshots prove the *intended* view is achievable:
 *
 *   1. water-line  — the water renders as thin lines while the caffeine keeps
 *      its default ball-and-stick look. Exercises the per-stream representation
 *      path (filter water → representation "line"): the renderer hides the water
 *      atoms/bonds from the sphere+cylinder meshes and draws that subset with
 *      the line renderer instead, while the rest stays meshed.
 *   2. water-hidden — the water is faded to opacity 0 (atoms + bonds) so only
 *      the caffeine shows. A bare filter does not remove atoms; hiding is a
 *      modify(opacity 0) on the filtered branch (mirrors resname-filter-opacity).
 *
 * Webapp host only — the React Flow store path is the deterministic way to wire
 * the graph (see licorice.spec.ts / resname-filter-opacity.spec.ts). Visually
 * inspect the baselines before committing.
 */

import { test, expect } from "playwright/test";
import {
  assertDomContract,
  defaultViewerContract,
  expectFullPageMatch,
  expectViewerRegionMatch,
  getReadyState,
  stabilizeUi,
  waitForReady,
} from "./lib/setup";
import { bootHost, getHost, type HostBoot } from "./lib/host-fixture";
import {
  connectEdge,
  findNodeIdByType,
  insertNode,
  setNodeParam,
  type Scope,
} from "./lib/pipeline";
import { getVisibleSubsystems } from "./lib/render-utils";

const PLATFORM = "water-line";
const FIXTURE = "caffeine_water.pdb";
const FIXTURE_ATOMS = 3024;

/** Remove every edge feeding `targetHandle` of `targetId` (drops a default edge). */
async function removeEdgesInto(
  scope: Scope,
  targetId: string,
  targetHandle: string,
): Promise<void> {
  await scope.evaluate(
    ({ t, h }) => {
      const w = window as Window & {
        __megane_test_pipeline_store?: {
          getState: () => {
            edges: Array<{ id: string; target: string; targetHandle?: string | null }>;
            onEdgesChange: (changes: Array<{ id: string; type: "remove" }>) => void;
          };
        };
      };
      const store = w.__megane_test_pipeline_store;
      if (!store) throw new Error("__megane_test_pipeline_store not exposed; testMode off?");
      const remove = store
        .getState()
        .edges.filter((e) => e.target === t && (e.targetHandle ?? null) === h)
        .map((e) => ({ id: e.id, type: "remove" as const }));
      if (remove.length) store.getState().onEdgesChange(remove);
    },
    { t: targetId, h: targetHandle },
  );
}

test.describe.configure({ mode: "serial" });

let boot: HostBoot | null = null;
let seed = 61;

// Each test builds a *different* graph on the default pipeline, so they must not
// share a page (a leftover representation/filter branch would bleed across).
// Boot a fresh viewer per test instead of a shared beforeAll.
test.beforeEach(async ({ browser }, info) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    (globalThis as { __MEGANE_TEST__?: boolean }).__MEGANE_TEST__ = true;
  });
  boot = await bootHost(page, { fixture: FIXTURE, portSeed: info.workerIndex + seed++ });
  await assertDomContract(boot.scope, [
    ...defaultViewerContract({ expectedAtoms: FIXTURE_ATOMS, context: boot.context }),
  ]);
});

test.afterEach(async () => {
  if (boot) {
    await boot.teardown();
    boot = null;
  }
});

test("water-line: water renders as lines while caffeine stays ball-and-stick", async () => {
  if (!boot) test.skip(true, "boot not initialised");
  const scope = boot!.scope;

  // Tap the particle stream just before the viewport and add a water → line
  // branch. The default full particle/bond streams stay wired (caffeine keeps
  // its mesh look); the renderer hides the water subset from the meshes and
  // draws it with the line renderer.
  const replicateId = await findNodeIdByType(scope, "replicate");
  const viewportId = await findNodeIdByType(scope, "viewport");
  const filterWater = await insertNode(scope, "filter");
  const repr = await insertNode(scope, "representation");

  await setNodeParam(scope, filterWater, { query: 'resname == "HOH"' });
  await setNodeParam(scope, repr, { mode: "line" });

  const before = await getReadyState(scope);
  await connectEdge(scope, replicateId, filterWater, "particle", "in");
  await connectEdge(scope, filterWater, repr, "out", "in");
  await connectEdge(scope, repr, viewportId, "out", "particle");
  await waitForReady(scope, { untilEpoch: before.renderEpoch + 1, timeout: 10_000 }).catch(() => {
    /* re-render may be synchronous */
  });

  const subsystems = await getVisibleSubsystems(scope);
  expect(subsystems.line).toBe(true);
  expect(subsystems.atoms).toBe(true);

  await stabilizeUi(scope);
  await expectFullPageMatch(boot!.scope, PLATFORM, `${getHost()}-water-line`);
  await expectViewerRegionMatch(boot!.scope, PLATFORM, `${getHost()}-water-line-viewer`);
});

test("water-hidden: fading water to opacity 0 leaves only the caffeine", async () => {
  if (!boot) test.skip(true, "boot not initialised");
  const scope = boot!.scope;

  const replicateId = await findNodeIdByType(scope, "replicate");
  const addBondId = await findNodeIdByType(scope, "add_bond");
  const viewportId = await findNodeIdByType(scope, "viewport");

  // Particle: fade the water atoms to opacity 0; caffeine stays via the default
  // full stream (merge keeps any non-1.0 override → water atoms vanish).
  const filterWater = await insertNode(scope, "filter");
  const hideWater = await insertNode(scope, "modify");
  await setNodeParam(scope, filterWater, { query: 'resname == "HOH"' });
  await setNodeParam(scope, hideWater, { scale: 1.0, opacity: 0.0 });

  // Bonds: route the single bond stream through a water-bond fade so no water
  // cylinders linger. Drop the default add_bond → viewport bond edge first so
  // this faded stream is the one the viewport renders.
  const filterWaterBonds = await insertNode(scope, "filter");
  const hideWaterBonds = await insertNode(scope, "modify");
  // `resname` is an ATOM field. The bond DSL only knows bond_index / atom_index
  // / element / molecule_id, so `both resname == "HOH"` threw "Unknown
  // identifier" and this branch produced nothing — and because the default
  // add_bond → viewport.bond edge is dropped just below, the viewport ended up
  // with *no* bonds at all. The caffeine lost its sticks and the baseline
  // recorded that as the "water hidden" reference. The caffeine is atoms 0-23
  // and every water follows, so `both atom_index >= 24` names the solvent's own
  // bonds; `both` keeps caffeine-water contacts out of the selection.
  await setNodeParam(scope, filterWaterBonds, { bond_query: "both atom_index >= 24" });
  await setNodeParam(scope, hideWaterBonds, { scale: 1.0, opacity: 0.0 });

  const before = await getReadyState(scope);
  await connectEdge(scope, replicateId, filterWater, "particle", "in");
  await connectEdge(scope, filterWater, hideWater, "out", "in");
  await connectEdge(scope, hideWater, viewportId, "out", "particle");

  await removeEdgesInto(scope, viewportId, "bond");
  await connectEdge(scope, addBondId, filterWaterBonds, "bond", "in");
  await connectEdge(scope, filterWaterBonds, hideWaterBonds, "out", "in");
  await connectEdge(scope, hideWaterBonds, viewportId, "out", "bond");
  await waitForReady(scope, { untilEpoch: before.renderEpoch + 1, timeout: 10_000 }).catch(() => {
    /* re-render may be synchronous */
  });

  await stabilizeUi(scope);
  await expectFullPageMatch(boot!.scope, PLATFORM, `${getHost()}-water-hidden`);
  await expectViewerRegionMatch(boot!.scope, PLATFORM, `${getHost()}-water-hidden-viewer`);
});
