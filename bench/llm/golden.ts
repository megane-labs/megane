/**
 * Ground truth for the LLM benchmark: the pipelines a correct answer produces,
 * and the pictures they must draw.
 *
 * `scorer.ts` grades the *shape* of a generated pipeline — node types, edges,
 * parameters — and never draws anything, so it cannot tell an answer from its
 * opposite. This module supplies the other half.
 *
 * The reference pipelines are not hand-authored. They are captured with
 * `store.serialize()` from the graphs `tests/e2e/water-line.spec.ts` builds
 * through the editor, and they are compared against **that spec's own committed
 * baselines**. Both halves of that matter:
 *
 *   - Hand-rolling a "correct" graph is how this file got written the first
 *     time, and it was wrong three ways over (an atom field in a `bond_query`,
 *     a `bondSource` no fixture loads, and a `molecule_id` selection that
 *     distance-inferred bonds break). Capturing the real graph removes the
 *     guesswork: what is committed under `golden/` is what the editor produced.
 *   - Each view is captured from its OWN boot. `water-line.spec.ts` runs its two
 *     tests against one shared viewer, so its "water hidden" graph still carries
 *     the previous test's water-as-lines branch — reasonable for that spec to
 *     pin, but not the answer to "hide the water", and the stream ordering
 *     `deserialize` produces renders it differently besides.
 *
 * `counterexamples` are wrong pipelines derived from each golden by mutation.
 * They are the reason a green run means anything: a comparison that accepts
 * everything is indistinguishable from one that works. The first entry under
 * `water-hidden` is the bond query the spec itself shipped until PR #690 —
 * `resname` is an atom field, so it threw, the branch produced nothing, and with
 * the default bond edge dropped the viewport drew no bonds at all. That went
 * unnoticed because the baseline recorded it.
 *
 * To regenerate `golden/*.megane.json`, reproduce water-line.spec.ts's two
 * constructions in order (water-hidden is built on top of water-line's graph —
 * one boot, serial mode) and dump `serialize()` after each.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SerializedPipeline } from "@/pipeline/types";

const HERE = dirname(fileURLToPath(import.meta.url));

function loadGolden(name: string): SerializedPipeline {
  return JSON.parse(
    readFileSync(join(HERE, "golden", `${name}.megane.json`), "utf8"),
  ) as SerializedPipeline;
}

/** Deep copy so a mutation never leaks into the loaded reference. */
function clone(p: SerializedPipeline): SerializedPipeline {
  return JSON.parse(JSON.stringify(p)) as SerializedPipeline;
}

type Node = SerializedPipeline["nodes"][number];
type Mutable = Record<string, unknown>;

/** The filter carrying a bond selection (`bond_query` set, `query` empty). */
function bondFilter(p: SerializedPipeline): Node {
  const n = p.nodes.find((x) => x.type === "filter" && (x as Mutable).bond_query);
  if (!n) throw new Error("golden has no bond filter");
  return n;
}

export interface LabelledPipeline {
  label: string;
  pipeline: SerializedPipeline;
}

export interface GoldenView {
  /** Identifier, and the stem of `golden/<id>.megane.json`. */
  id: string;
  /** Baseline under `tests/e2e/baselines/bench-golden/`, without the extension. */
  baseline: string;
  /** `bench/llm/dataset.ts` cases this view is the correct answer to. */
  benchCases: string[];
  /** What the reference image shows — the reviewable statement of "correct". */
  expectation: string;
  pipeline: SerializedPipeline;
  /** Wrong pipelines that must NOT draw the reference image. */
  counterexamples: LabelledPipeline[];
}

const WATER_LINE = loadGolden("water-line");
const WATER_HIDDEN = loadGolden("water-hidden");

/** water-hidden with its bond selection replaced. */
function withBondQuery(query: string): SerializedPipeline {
  const p = clone(WATER_HIDDEN);
  (bondFilter(p) as Mutable).bond_query = query;
  return p;
}

/** water-hidden with the bond branch removed and the raw bond stream restored. */
function particlesOnly(): SerializedPipeline {
  const p = clone(WATER_HIDDEN);
  const bf = bondFilter(p);
  const fed = p.edges.find((e) => e.source === bf.id);
  const bondModify = fed ? p.nodes.find((n) => n.id === fed.target) : undefined;
  const drop = new Set([bf.id, bondModify?.id].filter(Boolean) as string[]);
  const addBond = p.nodes.find((n) => n.type === "add_bond");
  const viewport = p.nodes.find((n) => n.type === "viewport");
  if (!addBond || !viewport) throw new Error("golden is missing add_bond/viewport");
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

/** Swap every `resname == "HOH"` atom selection for its complement. */
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

export const GOLDEN_VIEWS: GoldenView[] = [
  {
    id: "water-hidden",
    baseline: "water-hidden",
    benchCases: ["hide-water"],
    expectation:
      "Only the caffeine, in ball-and-stick — the solvent's atoms and its bonds are both gone, " +
      "and the caffeine keeps its own 25 bonds.",
    pipeline: WATER_HIDDEN,
    counterexamples: [
      {
        // What water-line.spec.ts shipped until PR #690. `resname` is an atom
        // field; the bond DSL rejects it, the branch yields nothing, and the
        // default bond edge is already dropped — so no bonds reach the viewport
        // and the caffeine loses its sticks too.
        label: 'invalid bond query: `both resname == "HOH"` drops every bond',
        pipeline: withBondQuery('both resname == "HOH"'),
      },
      {
        label: "particle-only branch leaves the solvent's bonds drawn",
        pipeline: particlesOnly(),
      },
      {
        label: "inverted selection: hides the caffeine and keeps the water",
        pipeline: invertAtomSelection(WATER_HIDDEN),
      },
    ],
  },
  {
    id: "water-line",
    baseline: "water-line",
    benchCases: ["representation-water-line"],
    expectation: "Water drawn as thin lines, caffeine left in the default ball-and-stick style.",
    pipeline: WATER_LINE,
    counterexamples: [
      {
        label: "inverted selection: draws the caffeine as lines, water as spheres",
        pipeline: invertAtomSelection(WATER_LINE),
      },
    ],
  },
];

/** Look up a view by id. */
export function goldenView(id: string): GoldenView | undefined {
  return GOLDEN_VIEWS.find((v) => v.id === id);
}
