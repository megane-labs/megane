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
import { GOLDEN_VIEWS, goldenView } from "../../../bench/llm/golden";
import { DATASET } from "../../../bench/llm/dataset";
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
    for (const v of GOLDEN_VIEWS) {
      expect(collectPipelineErrors(v.pipeline), v.id).toEqual([]);
      for (const q of bondQueries(v.pipeline)) {
        expect(validateBondQuery(q), `${v.id}: ${q}`).toEqual({ valid: true });
      }
    }
  });

  it("names only dataset cases that exist", () => {
    const ids = new Set(DATASET.map((c) => c.id));
    for (const v of GOLDEN_VIEWS) {
      expect(v.benchCases.length, `${v.id} names no bench case`).toBeGreaterThan(0);
      for (const id of v.benchCases) expect(ids, v.id).toContain(id);
    }
  });

  it("gives every view a counterexample and a stated expectation", () => {
    for (const v of GOLDEN_VIEWS) {
      expect(v.counterexamples.length, `${v.id} has no negative control`).toBeGreaterThan(0);
      expect(v.expectation.length, `${v.id} has no stated expectation`).toBeGreaterThan(0);
    }
  });

  // The defect this whole suite exists to have caught: `resname` is an atom
  // field, so `both resname == "HOH"` is not a narrower bond selection, it is a
  // broken query. water-line.spec.ts shipped it, the branch produced nothing,
  // and the baseline recorded a viewport with no bonds at all.
  it("keeps the invalid-bond-query counterexample genuinely invalid", () => {
    const hidden = goldenView("water-hidden");
    expect(hidden).toBeDefined();
    const invalid = hidden!.counterexamples.find((c) => c.label.includes("invalid bond query"));
    expect(invalid, "the invalid-bond-query counterexample is gone").toBeDefined();
    const queries = bondQueries(invalid!.pipeline);
    expect(queries).toHaveLength(1);
    expect(validateBondQuery(queries[0]).valid).toBe(false);
  });

  it("derives the particle-only counterexample by dropping the bond branch", () => {
    const hidden = goldenView("water-hidden")!;
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
    for (const v of GOLDEN_VIEWS) {
      const inverted = v.counterexamples.find((c) => c.label.startsWith("inverted selection"));
      if (!inverted) continue;
      const queries = inverted.pipeline.nodes
        .map((n) => (n as Mutable).query)
        .filter((q): q is string => typeof q === "string" && q.includes("HOH"));
      expect(queries.length, `${v.id} has no HOH selection to invert`).toBeGreaterThan(0);
      for (const q of queries) expect(q, v.id).toMatch(/^not /);
    }
  });

  it("never mutates the loaded reference", () => {
    const hidden = goldenView("water-hidden")!;
    for (const q of bondQueries(hidden.pipeline)) {
      expect(validateBondQuery(q).valid).toBe(true);
    }
  });

  it("looks up views by id", () => {
    expect(goldenView("water-hidden")?.id).toBe("water-hidden");
    expect(goldenView("nope")).toBeUndefined();
  });
});
