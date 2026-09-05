/**
 * Guards the ground truth in `bench/llm/golden.ts`.
 *
 * `tests/e2e/bench-golden.spec.ts` renders each reference pipeline and asserts
 * the counterexamples do not draw its picture. These tests pin the properties
 * that make that suite meaningful without booting a browser: the references are
 * pipelines megane accepts, the counterexamples are the specific mistakes they
 * are named for, and the views still point at dataset cases that exist.
 */

import { describe, it, expect } from "vitest";
import { GOLDEN_CASES, GOLDEN_DIR, goldenCase } from "../../../bench/llm/golden";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DATASET } from "../../../bench/llm/dataset";
import { scoreResponse, type Rubric } from "../../../bench/llm/scorer";
import { collectPipelineErrors } from "@/ai/validatePipeline";
import { validateBondQuery } from "@/pipeline/selection";
import type { SerializedPipeline } from "@/pipeline/types";

type Mutable = Record<string, unknown>;

const bondQueries = (p: SerializedPipeline): string[] =>
  p.nodes
    .map((n) => (n as Mutable).bond_query)
    .filter((q): q is string => typeof q === "string" && q.length > 0);

const edgesInto = (p: SerializedPipeline, type: string, handle: string) =>
  p.edges.filter((e) => {
    const target = p.nodes.find((n) => n.id === e.target);
    return target?.type === type && e.targetHandle === handle;
  });

describe("bench ground truth", () => {
  it("captures references megane's own validators accept", () => {
    for (const v of GOLDEN_CASES) {
      expect(collectPipelineErrors(v.pipeline), v.caseId).toEqual([]);
      for (const q of bondQueries(v.pipeline)) {
        expect(validateBondQuery(q), `${v.caseId}: ${q}`).toEqual({ valid: true });
      }
    }
  });

  // The folder name IS the case id, so this is what keeps the prompt and its
  // ground truth from drifting apart. `golden.ts` throws on a folder that names
  // no case; this pins the other direction — the pairing is complete.
  it("pairs every ground-truth folder with its prompt and files", () => {
    const ids = new Set(DATASET.map((c) => c.id));
    for (const v of GOLDEN_CASES) {
      expect(ids, `${v.caseId} is not a dataset case`).toContain(v.caseId);
      expect(v.prompt.length, `${v.caseId} carries no prompt`).toBeGreaterThan(0);
      for (const f of ["pipeline.megane.json", "expected.png", "meta.json"]) {
        expect(existsSync(join(GOLDEN_DIR, v.caseId, f)), `${v.caseId}/${f}`).toBe(true);
      }
      expect(v.fixture.length, `${v.caseId} names no fixture`).toBeGreaterThan(0);
      expect(v.capturedFrom.length, `${v.caseId} does not say where it came from`).toBeGreaterThan(
        0,
      );
    }
  });

  it("gives every view a counterexample and a stated expectation", () => {
    for (const v of GOLDEN_CASES) {
      expect(v.counterexamples.length, `${v.caseId} has no negative control`).toBeGreaterThan(0);
      expect(v.expectation.length, `${v.caseId} has no stated expectation`).toBeGreaterThan(0);
    }
  });

  // The defect this whole suite exists to have caught: `resname` is an atom
  // field, so `both resname == "HOH"` is not a narrower bond selection, it is a
  // broken query. water-line.spec.ts shipped it, the branch produced nothing,
  // and the baseline recorded a viewport with no bonds at all.
  it("keeps the invalid-bond-query counterexample genuinely invalid", () => {
    const hidden = goldenCase("hide-water");
    expect(hidden).toBeDefined();
    const invalid = hidden!.counterexamples.find((c) => c.label.includes("invalid bond query"));
    expect(invalid, "the invalid-bond-query counterexample is gone").toBeDefined();
    const queries = bondQueries(invalid!.pipeline);
    expect(queries).toHaveLength(1);
    expect(validateBondQuery(queries[0]).valid).toBe(false);
  });

  it("derives the particle-only counterexample by dropping the bond branch", () => {
    const hidden = goldenCase("hide-water")!;
    const particleOnly = hidden.counterexamples.find((c) => c.label.startsWith("particle-only"))!;
    // No bond selection survives, and the raw AddBond stream is wired straight
    // to the viewport again — which is what leaves the solvent's bonds drawn.
    expect(bondQueries(particleOnly.pipeline)).toEqual([]);
    const bondEdges = edgesInto(particleOnly.pipeline, "viewport", "bond");
    expect(bondEdges).toHaveLength(1);
    const source = particleOnly.pipeline.nodes.find((n) => n.id === bondEdges[0].source);
    expect(source?.type).toBe("add_bond");
    // The reference routes that stream through a filter instead.
    const goldenBondEdges = edgesInto(hidden.pipeline, "viewport", "bond");
    expect(goldenBondEdges).toHaveLength(1);
    expect(hidden.pipeline.nodes.find((n) => n.id === goldenBondEdges[0].source)?.type).toBe(
      "modify",
    );
  });

  it("inverts every solvent selection in the inverted counterexamples", () => {
    for (const v of GOLDEN_CASES) {
      const inverted = v.counterexamples.find((c) => c.label.startsWith("inverted selection"));
      if (!inverted) continue;
      const queries = inverted.pipeline.nodes
        .map((n) => (n as Mutable).query)
        .filter((q): q is string => typeof q === "string" && q.includes("HOH"));
      expect(queries.length, `${v.caseId} has no HOH selection to invert`).toBeGreaterThan(0);
      for (const q of queries) expect(q, v.caseId).toMatch(/^not /);
    }
  });

  it("never mutates the loaded reference", () => {
    const hidden = goldenCase("hide-water")!;
    for (const q of bondQueries(hidden.pipeline)) {
      expect(validateBondQuery(q).valid).toBe(true);
    }
  });

  const rubricFor = (id: string): Rubric => {
    const c = DATASET.find((x) => x.id === id);
    if (!c) throw new Error(`no dataset case ${id}`);
    return c.rubric;
  };
  const score = (p: SerializedPipeline, r: Rubric) =>
    scoreResponse("```json\n" + JSON.stringify(p) + "\n```\n\nDone.", r).total;

  /** loader -> filter(query) -> viewport: a selection nothing acts on. */
  const bareFilter = (query: string): SerializedPipeline =>
    ({
      version: 3,
      nodes: [
        {
          id: "l",
          type: "load_structure",
          fileName: null,
          hasTrajectory: false,
          hasCell: false,
          position: { x: 0, y: 0 },
        },
        { id: "f", type: "filter", query, position: { x: 0, y: 300 } },
        {
          id: "v",
          type: "viewport",
          perspective: true,
          cellAxesVisible: false,
          pivotMarkerVisible: false,
          position: { x: 0, y: 600 },
        },
      ],
      edges: [
        { source: "l", sourceHandle: "particle", target: "f", targetHandle: "in" },
        { source: "f", sourceHandle: "out", target: "v", targetHandle: "particle" },
      ],
    }) as unknown as SerializedPipeline;

  /** The same selection, with a modify that actually hides the complement. */
  const filterAndHide = (query: string): SerializedPipeline => {
    const p = bareFilter(query);
    p.nodes.push({
      id: "m",
      type: "modify",
      scale: 1,
      opacity: 0,
      position: { x: 0, y: 450 },
    } as unknown as SerializedPipeline["nodes"][number]);
    p.edges = [
      p.edges[0],
      { source: "f", sourceHandle: "out", target: "m", targetHandle: "in" },
      { source: "m", sourceHandle: "out", target: "v", targetHandle: "particle" },
    ];
    return p;
  };

  // A bare filter selects; it does not change what is drawn. Measured on
  // caffeine_water.pdb, selecting 8 carbons and selecting 1006 oxygens+nitrogens
  // differ from each other by 0.002% of pixels — the same picture. The rubric
  // cannot see that, but it can stop *preferring* it: what these cases graded
  // before was a pipeline that renders the default view, at full marks.
  it("scores a selection nothing acts on below one that does", () => {
    const cases: Array<[string, string]> = [
      ["filter-carbon", 'element == "C"'],
      ["filter-residue", 'resname == "ALA"'],
      ["filter-oxygen-nitrogen", 'element == "O" or element == "N"'],
      ["filter-carbon-ja", 'element == "C"'],
    ];
    for (const [id, query] of cases) {
      const r = rubricFor(id);
      const noop = score(bareFilter(query), r);
      const acts = score(filterAndHide(query), r);
      expect(
        noop,
        `${id}: a bare filter still scores as well as a pipeline that acts`,
      ).toBeLessThan(acts);
    }
  });

  // The other half: the tightened rubrics must still accept the pipeline that
  // genuinely answers the request. `water-hidden` is captured from the editor
  // and pinned pixel-for-pixel by tests/e2e/bench-golden.spec.ts.
  it("accepts the captured reference for the case it answers", () => {
    for (const v of GOLDEN_CASES) {
      expect(
        score(v.pipeline, rubricFor(v.caseId)),
        `${v.caseId}: the rubric rejects the reference pipeline the editor produced`,
      ).toBeGreaterThanOrEqual(0.8);
    }
  });

  it("looks up ground truth by case id", () => {
    expect(goldenCase("hide-water")?.caseId).toBe("hide-water");
    expect(goldenCase("nope")).toBeUndefined();
  });
});
