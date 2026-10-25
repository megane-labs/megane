/**
 * The bundled demo files the pipeline templates load, as URLs.
 *
 * Imported with `?url` so each host's bundler emits them as separate assets
 * (Vite for the webapp and the VSCode webview, webpack's `asset/resource` rule
 * for the JupyterLab labextension) and nothing is downloaded until a template
 * is applied. Kept apart from `templateAssets.ts`, which takes these as an
 * argument, so the loading logic stays testable without a bundler.
 */

import type { TemplateFixtureUrls } from "./templateAssets";
import caffeineWaterPdb from "../../tests/fixtures/caffeine_water.pdb?url";
import caffeineWaterXtc from "../../tests/fixtures/caffeine_water_vibration.xtc?url";
import perovskiteXyz from "../../tests/fixtures/perovskite_srtio3_3x3x3.xyz?url";
import glycineCif from "../../tests/fixtures/glycine_csd.cif?url";
import auNanoparticleXyz from "../../tests/fixtures/au_nanoparticle.xyz?url";
import proteasePdb from "../../tests/fixtures/1hsg.pdb?url";
import caffeineB3lypSdf from "../../tests/fixtures/caffeine_b3lyp.sdf?url";
import caffeineDensityCube from "../../tests/fixtures/caffeine_b3lyp_density.cube?url";
import caffeineEspCube from "../../tests/fixtures/caffeine_b3lyp_esp.cube?url";
import ubiquitinPdb from "../../tests/fixtures/1ubq.pdb?url";
import ubiquitinCgPdb from "../../tests/fixtures/1ubq_cg.pdb?url";

export const TEMPLATE_FIXTURE_URLS: TemplateFixtureUrls = {
  caffeineWaterPdb,
  caffeineWaterXtc,
  perovskiteXyz,
  glycineCif,
  auNanoparticleXyz,
  proteasePdb,
  caffeineB3lypSdf,
  caffeineDensityCube,
  caffeineEspCube,
  ubiquitinPdb,
  ubiquitinCgPdb,
};
