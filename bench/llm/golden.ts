/**
 * Ground truth for the LLM benchmark, stored beside the prompts it answers.
 *
 * `scorer.ts` grades the *shape* of a generated pipeline — node types, edges,
 * parameters — and never draws anything, so it cannot tell an answer from its
 * opposite. This module supplies the other half, and keeps it in one place per
 * case rather than scattered across the E2E suite:
 *
 *     bench/llm/dataset.ts                        the prompt and its rubric
 *     bench/llm/golden/<case id>/pipeline.megane.json   a pipeline that answers it
 *     bench/llm/golden/<case id>/expected.png           what that pipeline draws
 *     bench/llm/golden/<case id>/meta.json              fixture + what to look for
 *
 * The directory name IS the `dataset.ts` case id, so adding ground truth to a
 * case means dropping a folder named after it — no registry to update, and
 * nothing to keep in sync by hand. `GOLDEN_CASES` joins the two halves and fails
 * loudly if a folder names a case that does not exist.
 *
 * The reference pipelines are captured, not hand-authored: each is
 * `store.serialize()` from the graph `tests/e2e/water-line.spec.ts` builds
 * through the editor, from a fresh boot per case (`meta.json` records which).
 * Writing them by hand is how the first attempt went wrong three ways over — an
 * atom field in a `bond_query`, a `bondSource` no fixture loads, and a
 * `molecule_id` selection that distance-inferred bonds break. A fresh boot also
 * keeps "hide the water" from inheriting the other case's water-as-lines branch.
 *
 * `counterexamples` are wrong pipelines derived from each reference by mutation.
 * They are why a green run means anything: a comparison that accepts everything
 * is indistinguishable from one that works.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SerializedPipeline } from "@/pipeline/types";
import { DATASET } from "./dataset";

/** Root of the per-case ground truth. */
export const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "golden");

type Mutable = Record<string, unknown>;

interface GoldenMeta {
  /** Fixture under `tests/fixtures/` the reference renders against. */
  fixture: string;
  /** What the image shows — the reviewable statement of "correct". */
  expectation: string;
  /** Where the pipeline was captured from, so it can be re-captured. */
  capturedFrom: string;
}

export interface LabelledPipeline {
  label: string;
  pipeline: SerializedPipeline;
}

export interface GoldenCase extends GoldenMeta {
  /** `dataset.ts` case id, and the folder name. */
  caseId: string;
  /** The request this pipeline answers, from `dataset.ts`. */
  prompt: string;
  /** A pipeline that genuinely answers `prompt`. */
  pipeline: SerializedPipeline;
  /** Absolute path to the image `pipeline` must draw. */
  expectedImage: string;
  /** Wrong pipelines that must NOT draw `expectedImage`. */
  counterexamples: LabelledPipeline[];
}

function clone(p: SerializedPipeline): SerializedPipeline {
  return JSON.parse(JSON.stringify(p)) as SerializedPipeline;
}

/** The filter carrying a bond selection (`bond_query` set). */
function bondFilter(p: SerializedPipeline) {
  const n = p.nodes.find((x) => x.type === "filter" && (x as Mutable).bond_query);
  if (!n) throw new Error("reference has no bond filter");
  return n;
}

/** Replace the bond selection. */
function withBondQuery(base: SerializedPipeline, query: string): SerializedPipeline {
  const p = clone(base);
  (bondFilter(p) as Mutable).bond_query = query;
  return p;
}

/** Drop the bond branch and wire the raw AddBond stream back to the viewport. */
function particlesOnly(base: SerializedPipeline): SerializedPipeline {
  const p = clone(base);
  const bf = bondFilter(p);
  const fed = p.edges.find((e) => e.source === bf.id);
  const bondModify = fed ? p.nodes.find((n) => n.id === fed.target) : undefined;
  const drop = new Set([bf.id, bondModify?.id].filter(Boolean) as string[]);
  const addBond = p.nodes.find((n) => n.type === "add_bond");
  const viewport = p.nodes.find((n) => n.type === "viewport");
  if (!addBond || !viewport) throw new Error("reference is missing add_bond/viewport");
  p.nodes = p.nodes.filter((n) => !drop.has(n.id));
  p.edges = p.edges.filter((e) => !drop.has(e.source) && !drop.has(e.target));
  p.edges.push({
    source: addBond.id,
    sourceHandle: "bond",
    target: viewport.id,
    targetHandle: "bond",
  });
  return p;
}

/** Swap every solvent selection for its complement. */
function invertAtomSelection(base: SerializedPipeline): SerializedPipeline {
  const p = clone(base);
  for (const n of p.nodes) {
    const q = (n as Mutable).query;
    if (typeof q === "string" && q.includes("HOH")) {
      (n as Mutable).query = q.startsWith("not ") ? q.slice(4) : `not ${q}`;
    }
  }
  return p;
}

/** Per-case wrong pipelines, derived from the captured reference. */
const COUNTEREXAMPLES: Record<string, (ref: SerializedPipeline) => LabelledPipeline[]> = {
  "hide-water": (ref) => [
    {
      // The bond query water-line.spec.ts shipped until PR #690. `resname` is an
      // atom field; the bond DSL rejects it, the branch produced nothing, and
      // with the default bond edge dropped the viewport drew no bonds at all —
      // the caffeine lost its sticks and the baseline recorded that.
      label: 'invalid bond query: `both resname == "HOH"` drops every bond',
      pipeline: withBondQuery(ref, 'both resname == "HOH"'),
    },
    {
      label: "particle-only branch leaves the solvent's bonds drawn",
      pipeline: particlesOnly(ref),
    },
    {
      label: "inverted selection: hides the caffeine and keeps the water",
      pipeline: invertAtomSelection(ref),
    },
  ],
  "representation-water-line": (ref) => [
    {
      label: "inverted selection: draws the caffeine as lines, water as spheres",
      pipeline: invertAtomSelection(ref),
    },
  ],
};

function loadCase(caseId: string): GoldenCase {
  const dir = join(GOLDEN_DIR, caseId);
  const bench = DATASET.find((c) => c.id === caseId);
  if (!bench) {
    throw new Error(
      `bench/llm/golden/${caseId}/ names no case in dataset.ts — the folder name is ` +
        `the case id, so ground truth and prompt cannot drift apart`,
    );
  }
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as GoldenMeta;
  const pipeline = JSON.parse(
    readFileSync(join(dir, "pipeline.megane.json"), "utf8"),
  ) as SerializedPipeline;
  return {
    ...meta,
    caseId,
    prompt: bench.prompt,
    pipeline,
    expectedImage: join(dir, "expected.png"),
    counterexamples: COUNTEREXAMPLES[caseId]?.(pipeline) ?? [],
  };
}

/** Every case with ground truth, discovered from the directory. */
export const GOLDEN_CASES: GoldenCase[] = readdirSync(GOLDEN_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()
  .map(loadCase);

/** Look up ground truth by dataset case id. */
export function goldenCase(caseId: string): GoldenCase | undefined {
  return GOLDEN_CASES.find((c) => c.caseId === caseId);
}
