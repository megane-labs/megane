/**
 * Regression — isosurface colour survives a low opacity setting.
 *
 * The bug: a transparent surface is composited as `surface·α + background·(1−α)`,
 * so the chroma reaching the frame buffer scaled linearly with the opacity
 * slider. Against the white default background an orbital's + and − lobes both
 * converged on the same pale grey well before the surface was faint enough to
 * see through — "opacity を下げるとグレーっぽくなり、色の差がほとんどわからない".
 *
 * The fix (src/renderer/surfaceMaterial.ts) shades surfaces with a view-space
 * light rig, firms up the silhouette with a Fresnel alpha term, fades the white
 * specular with the surface, and compensates the α-scaling of chroma directly.
 *
 * This spec asserts the property rather than a pixel baseline: render a π-like
 * MO with a blue + lobe and a red − lobe, and check that at 20 % opacity the
 * surface is still visibly coloured and the two lobes are still far apart in
 * RGB. It reads the WebGL drawing buffer directly (the renderer is created with
 * preserveDrawingBuffer) so no UI chrome enters the measurement — the pipeline
 * panel and the playback bar overlay the viewer element, so a Playwright
 * element screenshot would include them.
 */

import { test, expect } from "playwright/test";
import type { Page } from "playwright/test";
import { waitForReady, getReadyState, stabilizeUi } from "./lib/setup";
import { bootHost, type HostBoot } from "./lib/host-fixture";
import { connectEdge, findNodeIdByType, insertNode, setNodeParam } from "./lib/pipeline";

const STRUCTURE_FIXTURE = "cc_dimer.xyz";
const CUBE_FIXTURE = "tests/fixtures/cc_dimer_pi_mo.cube";
const ISO_LEVEL = 0.06;

interface LobeStats {
  /** Mean max−min channel spread over every rendered (non-background) pixel. */
  chroma: number;
  /** Mean RGB of the pixels that read blue / red. */
  blue: [number, number, number] | null;
  red: [number, number, number] | null;
  /** Euclidean RGB distance between the two lobe means. */
  separation: number;
  /** Fraction of the drawing buffer the surface covers. */
  coverage: number;
}

/** Read the 3D drawing buffer and summarise the rendered surface. */
async function measureSurface(page: Page): Promise<LobeStats> {
  return await page.evaluate(() => {
    const root = document.querySelector('[data-testid="viewer-root"]');
    if (!root) throw new Error("viewer-root not found");
    const gl = [...root.querySelectorAll("canvas")].find((c) => !!c.getContext("webgl2"));
    if (!gl) throw new Error("no WebGL canvas inside viewer-root");

    const copy = document.createElement("canvas");
    copy.width = gl.width;
    copy.height = gl.height;
    const ctx = copy.getContext("2d")!;
    ctx.drawImage(gl, 0, 0);
    const d = ctx.getImageData(0, 0, copy.width, copy.height).data;

    let n = 0;
    let chroma = 0;
    const blue = [0, 0, 0];
    const red = [0, 0, 0];
    let nBlue = 0;
    let nRed = 0;

    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255;
      const g = d[i + 1] / 255;
      const b = d[i + 2] / 255;
      // Background is white; the dimer's carbons are near-black.
      if (r > 0.99 && g > 0.99 && b > 0.99) continue;
      if (r < 0.25 && g < 0.25 && b < 0.25) continue;
      n++;
      chroma += Math.max(r, g, b) - Math.min(r, g, b);
      if (b - r > 0.08) {
        blue[0] += r;
        blue[1] += g;
        blue[2] += b;
        nBlue++;
      } else if (r - b > 0.08) {
        red[0] += r;
        red[1] += g;
        red[2] += b;
        nRed++;
      }
    }

    const meanBlue = nBlue ? (blue.map((v) => v / nBlue) as [number, number, number]) : null;
    const meanRed = nRed ? (red.map((v) => v / nRed) as [number, number, number]) : null;
    return {
      chroma: n ? chroma / n : 0,
      blue: meanBlue,
      red: meanRed,
      separation:
        meanBlue && meanRed
          ? Math.hypot(meanBlue[0] - meanRed[0], meanBlue[1] - meanRed[1], meanBlue[2] - meanRed[2])
          : 0,
      coverage: n / (copy.width * copy.height),
    };
  });
}

test.describe.configure({ mode: "serial" });

let boot: HostBoot | null = null;

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  boot = await bootHost(page, { fixture: STRUCTURE_FIXTURE });
});

test.afterAll(async () => {
  if (boot) {
    await boot.teardown();
    boot = null;
  }
});

test("isosurface-opacity: a blue/red dual-contour MO stays blue and red at 20% opacity", async () => {
  if (!boot) test.skip(true, "boot not initialised");
  const page = boot!.scope as Page;

  // The Load Volumetric node's file input only exists once the editor tab is
  // mounted; the Chat tab is the default.
  await page.locator('[data-testid="pipeline-editor-tab-editor"]').click();

  const viewportId = await findNodeIdByType(page, "viewport");
  const volumetricId = await insertNode(page, "load_volumetric");
  const isosurfaceId = await insertNode(page, "isosurface");

  // Parse the CUBE through the real loader path, same as a user drop.
  await page.locator('[data-testid="load-volumetric-input"]').first().setInputFiles(CUBE_FIXTURE);
  await expect(page.locator('[data-testid="load-volumetric-error"]')).toHaveCount(0);

  await setNodeParam(page, isosurfaceId, {
    isoLevel: ISO_LEVEL,
    color: "#0033ff",
    negativeColor: "#ff3300",
    showNegative: true,
    opacity: 1.0,
  });

  let before = await getReadyState(page);
  await connectEdge(page, volumetricId, isosurfaceId, "volumetric", "volumetric");
  await connectEdge(page, isosurfaceId, viewportId, "mesh", "mesh");
  await waitForReady(page, { untilEpoch: before.renderEpoch + 1, timeout: 15_000 });
  await stabilizeUi(page);

  const opaque = await measureSurface(page);

  // Sanity: both lobes are actually on screen.
  expect(opaque.coverage, "isosurface should cover part of the viewport").toBeGreaterThan(0.02);
  expect(opaque.blue, "positive lobe should render blue").not.toBeNull();
  expect(opaque.red, "negative lobe should render red").not.toBeNull();

  // Drop to 20 % opacity — the setting the bug report was about.
  before = await getReadyState(page);
  await setNodeParam(page, isosurfaceId, { opacity: 0.2 });
  await waitForReady(page, { untilEpoch: before.renderEpoch + 1, timeout: 15_000 });
  await stabilizeUi(page);

  const faded = await measureSurface(page);

  // Transparency still has to do its job: the faded surface must be lighter.
  expect(
    faded.blue![0] + faded.blue![1] + faded.blue![2],
    "20 % surface should be lighter than an opaque one",
  ).toBeGreaterThan(opaque.blue![0] + opaque.blue![1] + opaque.blue![2]);

  // …but it must still read as coloured, not grey.
  expect(
    faded.chroma,
    `faded surface lost its colour (chroma ${faded.chroma.toFixed(3)} vs opaque ${opaque.chroma.toFixed(3)})`,
  ).toBeGreaterThan(0.25);

  // And keep most of the chroma it had when opaque.
  expect(
    faded.chroma / opaque.chroma,
    `chroma retention ${(faded.chroma / opaque.chroma).toFixed(2)}`,
  ).toBeGreaterThan(0.6);

  // The two lobes must stay clearly distinguishable.
  expect(faded.blue, "positive lobe should still be blue at 20 %").not.toBeNull();
  expect(faded.red, "negative lobe should still be red at 20 %").not.toBeNull();
  expect(
    faded.separation,
    `lobes converged on the same colour (separation ${faded.separation.toFixed(3)})`,
  ).toBeGreaterThan(0.45);
});
