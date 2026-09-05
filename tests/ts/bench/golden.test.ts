/**
 * Guards the premise of `tests/e2e/bench-render.spec.ts`.
 *
 * That spec renders every entry in `GOLDEN_RENDERS` and asserts the
 * counterexamples do not draw the reference picture. These tests pin the
 * relationship between the two scorers so neither can rot silently: the static
 * rubric must rank the correct pipeline first (it did not, until the rubrics
 * required the bond branch), and at least one counterexample must remain that
 * only the pixel comparison can catch — otherwise the render check is
 * ceremony.
 */

import { describe, it, expect } from "vitest";
import { GOLDEN_RENDERS, goldenFor } from "../../../bench/llm/golden";
import { DATASET } from "../../../bench/llm/dataset";
import { scoreResponse, type Rubric } from "../../../bench/llm/scorer";
import { collectPipelineErrors } from "@/ai/validatePipeline";
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
  // The guard that caught the first draft of these goldens: `bond_query` has no
  // `resname` field, so `resname == "HOH"` on a bond filter is not a narrower
  // selection — it is a broken query, and the reference image it produced hid
  // the caffeine's bonds along with the water's.
  it("runs every pipeline through the production validators", () => {
    for (const g of GOLDEN_RENDERS) {
      const all = [
        { label: "golden", pipeline: g.pipeline },
        ...g.equivalents,
        ...g.counterexamples,
      ];
      for (const { label, pipeline } of all) {
        expect(collectPipelineErrors(pipeline), `${g.caseId} / ${label}`).toEqual([]);
      }
    }
  });

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

  // The rubrics require the bond branch, so the static scorer now ranks the
  // correct pipeline first. That ordering is the thing worth pinning: it is
  // what a rubric edit is most likely to break silently.
  it("never lets a counterexample outscore its golden", () => {
    for (const g of GOLDEN_RENDERS) {
      const rubric = rubricFor(g.caseId);
      const golden = staticScore(g.pipeline, rubric);
      for (const c of g.counterexamples) {
        expect(
          staticScore(c.pipeline, rubric),
          `${g.caseId}: "${c.label}" scores above the golden (${golden.toFixed(3)}). ` +
            `The rubric is rewarding a pipeline that draws the wrong picture.`,
        ).toBeLessThanOrEqual(golden);
      }
    }
  });

  it("scores every golden at or above the benchmark's own pass threshold", () => {
    for (const g of GOLDEN_RENDERS) {
      expect(
        staticScore(g.pipeline, rubricFor(g.caseId)),
        `${g.caseId}: the rubric rejects the pipeline that actually answers the prompt`,
      ).toBeGreaterThanOrEqual(0.8);
    }
  });

  // What the render check is for. Tightening the rubrics fixed the ordering but
  // not the blind spot: a rubric matches `resname == "HOH"` inside
  // `not resname == "HOH"` just as happily, so "hide the water" and "hide the
  // caffeine" are indistinguishable to it. Both inverted counterexamples still
  // tie their golden at 100%. If that ever stops being true for every case, the
  // pixel comparison has no signal the static scorer lacks and this file should
  // say so out loud rather than leave a suite that quietly tests nothing.
  it("keeps at least one counterexample the static scorer cannot separate from its golden", () => {
    const tied = GOLDEN_RENDERS.filter((g) => {
      const rubric = rubricFor(g.caseId);
      const golden = staticScore(g.pipeline, rubric);
      return g.counterexamples.some((c) => staticScore(c.pipeline, rubric) >= golden);
    });
    expect(
      tied.map((g) => g.caseId),
      "every counterexample is now caught by the static rubric alone, so the " +
        "render comparison adds nothing — replace them with pipelines it still accepts",
    ).not.toHaveLength(0);
  });

  it("looks up goldens by case id", () => {
    expect(goldenFor("hide-water")?.caseId).toBe("hide-water");
    expect(goldenFor("no-such-case")).toBeUndefined();
  });
});
