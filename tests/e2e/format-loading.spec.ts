/**
 * Format loading E2E (M2).
 *
 * Drives the webapp through every supported file format so a regression in
 * the WASM parser entry point is caught before it ships. We exercise the
 * structure-upload dropzone with an in-process File constructed from the
 * fixture bytes — the path the user takes when they drop a file onto the
 * sidebar. Each fixture gets its own viewer-region baseline; on first run
 * the baseline is captured automatically by `compareToBaseline`.
 *
 * Trajectory companion files are exercised separately because they require
 * a structure to be loaded first.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { test, expect } from "playwright/test";
import {
  assertDomContract,
  defaultViewerContract,
  expectViewerRegionMatch,
  getReadyState,
  waitForReady,
} from "./lib/setup";

const PLATFORM = "format-loading";
const REPO = join(fileURLToPath(import.meta.url), "..", "..", "..");
const FIXTURES = join(REPO, "tests", "fixtures");

interface StructureCase {
  name: string;
  file: string;
  mime: string;
  /** Expected atom count, or undefined to skip the strict count assertion. */
  expectedAtoms?: number;
}

const STRUCTURE_CASES: StructureCase[] = [
  { name: "pdb-1crn", file: "1crn.pdb", mime: "chemical/x-pdb", expectedAtoms: 327 },
  { name: "pdb-water-wrapped", file: "water_wrapped.pdb", mime: "chemical/x-pdb" },
  { name: "gro-water", file: "water.gro", mime: "chemical/x-gro" },
  // GRO with 8-decimal (13-column) coordinate fields: the field width must be
  // inferred from the decimal-point spacing, not assumed to be %8.3f (#695).
  {
    name: "gro-high-precision",
    file: "high_precision.gro",
    mime: "chemical/x-gro",
    expectedAtoms: 11,
  },
  { name: "xyz-perovskite", file: "perovskite_srtio3.xyz", mime: "chemical/x-xyz" },
  { name: "xyz-multiframe", file: "water_multiframe.xyz", mime: "chemical/x-xyz" },
  { name: "mol-methane", file: "methane.mol", mime: "chemical/x-mdl-molfile" },
  { name: "sdf-ethanol", file: "ethanol.sdf", mime: "chemical/x-mdl-sdfile" },
  // MOL2 with a @<TRIPOS>CRYSIN unit cell: the standard 8-field record after
  // BOND (cubic NaCl, no bonds) and the 6-field record placed right after
  // MOLECULE (hexagonal graphite). Both must render the periodic cell —
  // the parser used to drop CRYSIN, so periodic MOL2 files showed no box.
  { name: "mol2-crysin-nacl", file: "nacl_crysin.mol2", mime: "chemical/x-mol2", expectedAtoms: 8 },
  {
    name: "mol2-crysin-graphite",
    file: "graphite_crysin.mol2",
    mime: "chemical/x-mol2",
    expectedAtoms: 4,
  },
  { name: "cif-nacl", file: "nacl.cif", mime: "chemical/x-cif" },
  {
    // 10 atoms in the asymmetric unit x 4 general positions of P 1 21/n 1.
    // CIF symmetry expansion became automatic on load in 0.8.0, so the whole
    // unit cell is what reaches the renderer.
    name: "cif-glycine-csd",
    file: "glycine_csd.cif",
    mime: "chemical/x-cif",
    expectedAtoms: 40,
  },
  { name: "lammps-water", file: "water.lammps", mime: "text/plain" },
  // Offset simulation box (xlo/ylo/zlo far from 0): the cell must render
  // wrapped around the atoms (box_origin fix), not anchored at world zero.
  {
    name: "lammps-offset-box",
    file: "confined_offset.data",
    mime: "text/plain",
    expectedAtoms: 64,
  },
  // LAMMPS dump opens standalone as a multi-frame structure (frame-0 topology,
  // integer atom `type` ids used as element proxies), like a multi-frame XYZ.
  // The `.trj` alias is exercised alongside the canonical `.lammpstrj`.
  { name: "lammpstrj-water", file: "water.lammpstrj", mime: "text/plain", expectedAtoms: 3 },
  { name: "trj-water", file: "water.trj", mime: "text/plain", expectedAtoms: 3 },
  // XCrySDen: a static CRYSTAL cell and an ANIMSTEPS animation whose extra
  // frames feed the playback timeline.
  { name: "xsf-si-diamond", file: "si_diamond.xsf", mime: "text/plain", expectedAtoms: 8 },
  { name: "axsf-water-relax", file: "water_relax.axsf", mime: "text/plain", expectedAtoms: 3 },
  // CML: a 3D molecule with an explicit <bondArray>, and a crystal whose
  // fractional coordinates are converted with the <crystal> cell.
  { name: "cml-ethanol", file: "ethanol.cml", mime: "chemical/x-cml", expectedAtoms: 9 },
  { name: "cml-si-diamond", file: "si_diamond.cml", mime: "chemical/x-cml", expectedAtoms: 8 },
  // VASP is the one format dispatched by *filename* rather than extension —
  // POSCAR / CONTCAR / XDATCAR carry no extension at all. These two cases
  // therefore also cover `structureExtFromFileName`'s bare-name mapping.
  { name: "vasp-poscar", file: "POSCAR_si_diamond", mime: "text/plain", expectedAtoms: 8 },
  { name: "vasp-xdatcar", file: "XDATCAR_si_md", mime: "text/plain", expectedAtoms: 8 },
  // Molden: a static `[Atoms] (AU)` geometry (which exercises the Bohr
  // conversion) and a `[GEOMETRIES] XYZ` optimisation that becomes frames.
  { name: "molden-water", file: "water.molden", mime: "text/plain", expectedAtoms: 3 },
  { name: "molden-water-opt", file: "water_opt.molden", mime: "text/plain", expectedAtoms: 3 },
  // Jmol's `.jxyz` is plain XYZ under a second extension, with extra per-atom
  // columns after x/y/z that must not disturb the coordinate read.
  { name: "jxyz-benzene", file: "benzene.jxyz", mime: "chemical/x-xyz", expectedAtoms: 12 },
  // ASE extended XYZ: `Lattice=` + `Properties=` headers, two frames.
  { name: "extxyz-water-md", file: "water_md.extxyz", mime: "chemical/x-xyz", expectedAtoms: 3 },
  // Chem3D XML: <n> nodes carry explicit <b> bonds, so nothing is inferred.
  {
    name: "c3xml-3d-molecule",
    file: "methoxymethylamine.c3xml",
    mime: "text/xml",
    expectedAtoms: 11,
  },
  // Odyssey: the two layouts describe the same ethanol, so both cases must
  // land on 9 atoms through the one content-sniffing parser.
  {
    name: "odydata-xml-ethanol",
    file: "ethanol.xodydata",
    mime: "text/xml",
    expectedAtoms: 9,
  },
  {
    name: "odydata-text-ethanol",
    file: "ethanol.odydata",
    mime: "text/plain",
    expectedAtoms: 9,
  },
  // CASTEP magres: the [atoms] block becomes the structure and the [magres]
  // tensor block must not be mistaken for more atoms.
  { name: "magres-si-nmr", file: "si_nmr.magres", mime: "text/plain", expectedAtoms: 8 },
  // GAMESS: a truncated optimisation log whose three coordinate blocks become
  // frames, with the trailing INTERNUCLEAR DISTANCES table correctly ignored.
  { name: "gamess-water-opt", file: "water_opt.gamess", mime: "text/plain", expectedAtoms: 3 },
  // CASTEP .phonon: the header becomes the periodic structure; the q-point
  // frequency and eigenvector blocks must not be read as more atoms.
  { name: "phonon-si-gamma", file: "si_gamma.phonon", mime: "text/plain", expectedAtoms: 2 },
];

async function dropStructure(
  page: import("playwright/test").Page,
  fixture: StructureCase,
): Promise<void> {
  const bytes = readFileSync(join(FIXTURES, fixture.file));
  // Hidden file input on the LoadStructure node (the seeded graph mounts
  // this node by default).
  const input = page.locator('[data-testid="load-structure-input"]').first();
  await input.setInputFiles({
    name: fixture.file,
    mimeType: fixture.mime,
    buffer: bytes,
  });
}

test.describe("format loading: webapp drag-drop", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?test=1", { waitUntil: "domcontentloaded" });
    await waitForReady(page);
  });

  for (const c of STRUCTURE_CASES) {
    test(`loads ${c.name}`, async ({ page }) => {
      const before = await getReadyState(page);
      await dropStructure(page, c);
      // The renderer publishes a new epoch as soon as the snapshot rebinds.
      await waitForReady(page, { untilEpoch: before.renderEpoch + 1 });

      const contract = defaultViewerContract({ context: "webapp" });
      if (c.expectedAtoms !== undefined) {
        contract[0].attrs = {
          ...(contract[0].attrs ?? {}),
          "data-atom-count": String(c.expectedAtoms),
        };
      }
      await assertDomContract(page, contract);

      const atomAttr = await page
        .locator('[data-testid="megane-viewer"]')
        .getAttribute("data-atom-count");
      expect(Number(atomAttr)).toBeGreaterThan(0);

      // The pipeline editor's LoadStructure node header must display the
      // file the user actually opened — guards against the
      // `caffeine_water.pdb` ghost-name regression that PR-A2 fixed.
      await expect(page.locator('[data-testid="load-structure-filename"]').first()).toHaveText(
        c.file,
      );

      await expectViewerRegionMatch(page, PLATFORM, `${c.name}-viewer`);
    });
  }
});

test.describe("format loading: trajectory companion", () => {
  test("loads caffeine_water + xtc", async ({ page }) => {
    await page.goto("/?test=1", { waitUntil: "domcontentloaded" });
    await waitForReady(page);

    // Default load already includes caffeine_water + .xtc. waitForReady
    // returns once the structure snapshot is bound, but the bundled XTC is
    // fetched in a follow-up Promise and the playback provider is wired
    // through a useEffect — so totalFrames lands a few microtasks later.
    // Poll the attribute until the trajectory makes it through the
    // pipeline rather than reading once and racing the load.
    await expect
      .poll(
        async () =>
          Number(
            (await page
              .locator('[data-testid="megane-viewer"]')
              .getAttribute("data-total-frames")) ?? 0,
          ),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(1);

    await assertDomContract(page, [
      ...defaultViewerContract({ context: "webapp" }),
      { testid: "timeline-root", visible: true },
      { testid: "playback-seekbar", visible: true, enabled: true },
    ]);

    // Pipeline must reflect the actually-loaded files — not the seed
    // graph's literal defaults. After demo init both should display the
    // bundled file basenames, but updating via openFile / applyResult is
    // what guarantees the names track real loads going forward.
    await expect(page.locator('[data-testid="load-structure-filename"]').first()).toHaveText(
      "caffeine_water.pdb",
    );
    await expect(page.locator('[data-testid="load-trajectory-filename"]').first()).toHaveText(
      "caffeine_water_vibration.xtc",
    );
  });
});
