/**
 * Keeps `tests/fixtures/pipeline_node_contract.json` in sync with the TS
 * pipeline node definitions.
 *
 * The fixture is the bridge that lets the Python test suite
 * (`tests/python/test_pipeline_node_drift.py`) check that the Python
 * `Pipeline` builder covers every TS node type with the same default params,
 * port names and catalog `pythonClass` — without the Python CI job having to
 * run Node. This test fails whenever `defaultParams()`, `NODE_PORTS` or
 * `NODE_CATALOG[...].pythonClass` changes without the fixture being
 * regenerated.
 *
 * Regenerate with:
 *   MEGANE_UPDATE_NODE_CONTRACT=1 npx vitest run tests/ts/pipeline/nodeContractFixture.test.ts
 */
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { NODE_CATALOG } from "@/pipeline/catalog";
import { NODE_PORTS, defaultParams } from "@/pipeline/types";
import type { PipelineNodeType } from "@/pipeline/types";

const FIXTURE_PATH = resolve(__dirname, "../../fixtures/pipeline_node_contract.json");

function buildContract(): Record<string, unknown> {
  const types = (Object.keys(NODE_PORTS) as PipelineNodeType[]).sort();
  const contract: Record<string, unknown> = {};
  for (const type of types) {
    contract[type] = {
      pythonClass: NODE_CATALOG[type].pythonClass,
      params: defaultParams(type),
      inputs: NODE_PORTS[type].inputs.map((p) => p.name),
      outputs: NODE_PORTS[type].outputs.map((p) => p.name),
    };
  }
  return contract;
}

describe("pipeline node contract fixture", () => {
  it("matches defaultParams / NODE_PORTS / NODE_CATALOG.pythonClass", () => {
    const expected = buildContract();
    if (process.env.MEGANE_UPDATE_NODE_CONTRACT === "1") {
      writeFileSync(FIXTURE_PATH, JSON.stringify(expected, null, 2) + "\n");
    }
    // Compare parsed values so reformatting the JSON never fails the check.
    const actual: unknown = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    expect(
      actual,
      "tests/fixtures/pipeline_node_contract.json is stale — regenerate it with " +
        "MEGANE_UPDATE_NODE_CONTRACT=1 npx vitest run tests/ts/pipeline/nodeContractFixture.test.ts",
    ).toEqual(expected);
  });
});
