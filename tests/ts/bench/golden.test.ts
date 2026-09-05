/**
 * Guards the premise of `tests/e2e/bench-render.spec.ts`.
 *
 * That spec renders every entry in `GOLDEN_RENDERS` and asserts the
 * counterexamples do not draw the reference picture. It only means something if
 * the counterexamples are pipelines the *static* scorer already waves through —
 * a wrong pipeline the rubric rejects on its own needs no render check to catch
 * it. These tests pin that relationship so it cannot rot silently when a rubric
 * is tightened or a case renamed.
 */

import { describe, it, expect } from "vitest";
import { GOLDEN_RENDERS, goldenFor } from "../../../bench/llm/golden";
import { DATASET } from "../../../bench/llm/dataset";
import { scoreResponse, type Rubric } from "../../../bench/llm/scorer";
import type { SerializedPipeline } from "@/pipeline/types";

/** Score a pipeline the way the benchmark scores a model response. */
function staticScore(pipeline: SerializedPipeline, rubric: Rubric): number {
  const response = "```json\n" + JSON.stringify(pipeline) + "\n```\n\nDone.";
  return scoreResponse(response, rubric).total;
}

function rubricFor(caseId: string): Rubric {
  const bench = DATASET.find((c) => c.id === caseId);
  if (!bench) throw new Error(`no dataset case ${caseId}`);
  return bench.rubric;
}

describe("bench golden renders", () => {
  it("names only cases that exist in the dataset", () => {
    const ids = new Set(DATASET.map((c) => c.id));
    for (const g of GOLDEN_RENDERS) {
      expect(ids, `golden references unknown case "${g.caseId}"`).toContain(g.caseId);
    }
  });

  it("shares one fixture, as the spec's single boot assumes", () => {
    expect(new Set(GOLDEN_RENDERS.map((g) => g.fixture)).size).toBe(1);
  });

  it("gives every case at least one counterexample and a stated expectation", () => {
    for (const g of GOLDEN_RENDERS) {
      expect(g.counterexamples.length, `${g.caseId} has no negative control`).toBeGreaterThan(0);
      expect(g.expectation.length, `${g.caseId} has no stated expectation`).toBeGreaterThan(0);
    }
  });

  // The reason the render check exists. On `hide-water` and
  // `multistep-water-transparent` the wrong pipeline scores a perfect 100%
  // while the genuinely correct one scores 96.1%, because the rubric rewards
  // the exact node/edge shape it anticipated and the correct answer needs an
  // extra branch through `viewport.bond` to actually hide the solvent. The
  // static scorer therefore ranks the broken pipeline *above* the correct one.
  it("keeps every counterexample invisible to the static scorer", () => {
    for (const g of GOLDEN_RENDERS) {
      const rubric = rubricFor(g.caseId);
      const golden = staticScore(g.pipeline, rubric);
      const best = Math.max(...g.counterexamples.map((c) => staticScore(c.pipeline, rubric)));
      expect(
        best,
        `${g.caseId}: every counterexample now scores below the golden (${golden.toFixed(3)}), ` +
          `so the static rubric already rejects them and the render check adds nothing here. ` +
          `Replace them with pipelines the rubric still accepts.`,
      ).toBeGreaterThanOrEqual(golden);
    }
  });

  it("looks up goldens by case id", () => {
    expect(goldenFor("hide-water")?.caseId).toBe("hide-water");
    expect(goldenFor("no-such-case")).toBeUndefined();
  });
});
