/**
 * Ground truth for the LLM benchmark, stored beside the prompts it answers.
 *
 * `scorer.ts` grades the *shape* of a generated pipeline — node types, edges,
 * parameters — and never draws anything, so it cannot tell an answer from its
 * opposite. This module supplies the other half, and keeps it in one place per
 * case rather than scattered across the E2E suite:
 *
 *     bench/llm/dataset.ts                              the prompt and its rubric
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
 * `store.serialize()` from a graph built through the editor store, from a fresh
 * boot per case (`meta.json` records which). Writing them by hand is how the
 * first attempt went wrong three ways over — an atom field in a `bond_query`, a
 * `bondSource` no fixture loads, and a `molecule_id` selection that
 * distance-inferred bonds break.
 *
 * `counterexamples` are wrong pipelines derived from each reference by mutation.
 * They are why a green run means anything: a comparison that accepts everything
 * is indistinguishable from one that works. Most are generated from
 * `answeringNodes` — delete the node that answers the prompt and the graph still
 * runs, still validates, and draws the untreated view. That is precisely the
 * failure the static rubric could not see, and it was not hypothetical: before
 * PR #691 the rubrics scored a pipeline whose only `filter` fed nothing at full
 * marks.
 *
 * ## What the images do and do not prove
 *
 * `expected.png` is the picture the reference pipeline draws *in the bench
 * harness* — `applyPipeline` in `render.ts`, which mirrors `PipelineChatBox`
 * step for step. That matters, because the harness only re-attaches the loaded
 * structure across `deserialize`; trajectory frames, volumetric grids and
 * `fileVectors` are ephemeral store state that a `SerializedPipeline` does not
 * carry, so `load_trajectory` and `load_vector` draw nothing after a round trip
 * (the product behaves the same way — see `imageDiscriminates` below).
 *
 * Each case's `imageStability` records what three independent boots of the same
 * pipeline actually produced. Most render byte-identically. A handful do not,
 * and the reason is not in the pipeline: across four independent boots of those
 * cases the store's viewport state is bit-identical (same atom count, same
 * position checksums, same bond count, same mesh vertex and coordinate
 * checksums), `__megane_test.getCameraState()` returns the same position, target
 * and zoom to the last float, and `getVisibleSubsystems()` agrees — and the
 * images still differ by a few percent of pixels, flipping between exactly two
 * renderings. Whatever varies is below the scene, in how coincident geometry
 * rasterises. Those cases keep their image for review but set
 * `imageStability.asserted: false`; the runner still renders them and still
 * requires their counterexamples to differ, comparing renders taken in the same
 * page, where the renderer is exactly repeatable.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE_PORTS, type PipelineNodeType, type SerializedPipeline } from "@/pipeline/types";
import { DATASET } from "./dataset";

/** Root of the per-case ground truth. */
export const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "golden");

type Mutable = Record<string, unknown>;
type SerializedNode = SerializedPipeline["nodes"][number];

/** What repeated renders of the same pipeline actually produced. */
export interface ImageStability {
  /** Independent boots the reference was rendered in. */
  boots: number;
  /** Worst pairwise pixel difference between those renders. */
  worstDiffPercent: number;
  /** Whether the runner may assert the committed image pixel-for-pixel. */
  asserted: boolean;
  /** Why not, when `asserted` is false. */
  note?: string;
}

interface GoldenMeta {
  /** Fixture under `tests/fixtures/` the reference renders against. */
  fixture: string;
  /** What the image shows — the reviewable statement of "correct". */
  expectation: string;
  /** Where the pipeline was captured from, so it can be re-captured. */
  capturedFrom: string;
  /** Measured reproducibility of `expected.png`. */
  imageStability: ImageStability;
  /**
   * Node types whose removal turns the reference into a pipeline that answers
   * nothing. Each yields a counterexample.
   */
  answeringNodes?: PipelineNodeType[];
  /**
   * False when no pipeline can draw a different picture for this prompt, so the
   * image grades nothing. Set only with the measurement that shows it.
   */
  imageDiscriminates?: boolean;
  /** Why the image cannot discriminate, when `imageDiscriminates` is false. */
  discriminationNote?: string;
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
  /** Absolute path to the image `pipeline` draws. */
  expectedImage: string;
  /** Wrong pipelines that must NOT draw the same picture as `pipeline`. */
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

/** The port names a node type carries on each side, for rewiring. */
function passThroughPorts(type: PipelineNodeType): { input: string; output: string } | null {
  const ports = NODE_PORTS[type];
  for (const out of ports.outputs) {
    const match = ports.inputs.find((i) => i.dataType === out.dataType);
    if (match) return { input: match.name, output: out.name };
  }
  return null;
}

/**
 * Delete every node of `type`, leaving a graph that still runs.
 *
 * A node that passes a stream through (filter, modify, replicate,
 * representation, colour) is bypassed — whatever fed it now feeds whatever it
 * fed — so the stream still reaches the Viewport, untouched. A node that
 * *generates* a channel from a particle stream (add_bond, label_generator,
 * polyhedron_generator, surface_mesh, isosurface) has no matching input to
 * splice, so it simply goes away along with the channel it produced.
 *
 * This is the "did nothing" pipeline: valid, executable, and wrong.
 */
function without(base: SerializedPipeline, type: PipelineNodeType): SerializedPipeline {
  const p = clone(base);
  const doomed = p.nodes.filter((n) => n.type === type);
  if (doomed.length === 0) throw new Error(`reference has no ${type} node to remove`);
  const ports = passThroughPorts(type);

  for (const node of doomed) {
    if (ports) {
      const feed = p.edges.find((e) => e.target === node.id && e.targetHandle === ports.input);
      const consumers = p.edges.filter(
        (e) => e.source === node.id && e.sourceHandle === ports.output,
      );
      if (feed) {
        for (const c of consumers) {
          p.edges.push({
            source: feed.source,
            sourceHandle: feed.sourceHandle,
            target: c.target,
            targetHandle: c.targetHandle,
          });
        }
      }
    }
    p.edges = p.edges.filter((e) => e.source !== node.id && e.target !== node.id);
  }
  p.nodes = p.nodes.filter((n) => n.type !== type);
  return p;
}

/** Overwrite a parameter on every node of `type`. */
function withParam(
  base: SerializedPipeline,
  type: PipelineNodeType,
  patch: Mutable,
): SerializedPipeline {
  const p = clone(base);
  const hits = p.nodes.filter((n) => n.type === type);
  if (hits.length === 0) throw new Error(`reference has no ${type} node to edit`);
  for (const n of hits) Object.assign(n as Mutable, patch);
  return p;
}

/**
 * Per-case wrong pipelines that the generic `answeringNodes` rule cannot
 * express — because the right answer is an *absence* (molecule-no-bonds), or
 * because deleting the answering node happens to reproduce the reference
 * exactly (colour-by-element: `byElement` is already megane's default palette,
 * measured at 0.000% against a pipeline with no colour node at all).
 */
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
  "multistep-water-transparent": (ref) => [
    {
      label: "particle-only branch leaves the solvent's bonds fully opaque",
      pipeline: particlesOnly(ref),
    },
    {
      label: "inverted selection: fades the caffeine and leaves the water solid",
      pipeline: invertAtomSelection(ref),
    },
  ],
  "representation-water-line": (ref) => [
    {
      label: "inverted selection: draws the caffeine as lines, water as spheres",
      pipeline: invertAtomSelection(ref),
    },
  ],
  "color-by-element": (ref) => [
    {
      // Deleting the colour node is not a counterexample here: byElement *is*
      // megane's default palette, so the graph without it draws the identical
      // picture (measured 0.000%). A uniform colour is the wrong answer that
      // actually looks wrong.
      label: "uniform colour instead of the element palette",
      pipeline: withParam(ref, "color", { mode: "uniform", uniformColor: "#ff8800" }),
    },
  ],
  "molecule-no-bonds": (ref) => {
    // The right answer is an absence, so the wrong one has to *add* something.
    const p = clone(ref);
    const viewport = p.nodes.find((n) => n.type === "viewport");
    const feed = p.edges.find((e) => e.target === viewport?.id && e.targetHandle === "particle");
    if (!viewport || !feed) throw new Error("reference is missing viewport/particle feed");
    p.nodes.push({
      id: "ce-addbond",
      type: "add_bond",
      bondSource: "structure",
      position: { x: 0, y: 0 },
    } as unknown as SerializedNode);
    p.edges.push(
      {
        source: feed.source,
        sourceHandle: feed.sourceHandle,
        target: "ce-addbond",
        targetHandle: "particle",
      },
      { source: "ce-addbond", sourceHandle: "bond", target: viewport.id, targetHandle: "bond" },
    );
    return [{ label: "bonds drawn after all", pipeline: p }];
  },
};

function counterexamplesFor(caseId: string, meta: GoldenMeta, ref: SerializedPipeline) {
  const bespoke = COUNTEREXAMPLES[caseId]?.(ref) ?? [];
  const generic = (meta.answeringNodes ?? []).map((type) => ({
    label: `no ${type} node: the graph runs and answers nothing`,
    pipeline: without(ref, type),
  }));
  return [...bespoke, ...generic];
}

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
    counterexamples: counterexamplesFor(caseId, meta, pipeline),
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
