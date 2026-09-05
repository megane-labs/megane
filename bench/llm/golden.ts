/**
 * Reference ("golden") renders for the LLM benchmark.
 *
 * `scorer.ts` grades the *shape* of a generated pipeline — which node types
 * exist, how they are wired, what their parameters say. It cannot see what the
 * pipeline draws, and that gap is not theoretical. Rendering the dataset's own
 * `hide-water` rubric turns up a pipeline that scores a perfect 100% while
 * showing the user the opposite of what they asked for: the rubric is satisfied
 * by a particle-only branch (`filter → modify(opacity 0) → viewport.particle`),
 * but the viewport draws bonds from a *separate* stream, so every water bond is
 * still drawn at full opacity and the solvent shell stays on screen as sticks.
 * Hiding the water actually takes a second branch through `viewport.bond`,
 * which the rubric neither requires nor rewards — and which costs the correct
 * answer points for its "extra" nodes. Measured against the shipped rubrics,
 * the static scorer ranks the broken pipeline (100.0%) *above* the correct one
 * (96.1%) on both `hide-water` and `multistep-water-transparent`.
 *
 * What did *not* survive measurement is worth recording too. The "draws it
 * twice" overlap (a filtered branch plus the unfiltered structure both wired to
 * the viewport) was tried as a counterexample and dropped: per-atom overrides
 * merge across streams (`mergeParticleOverrides`, src/pipeline/apply.ts) and
 * the raw loader stream carries none, so the filtered branch still wins. The
 * two graphs differ by 0.13% of pixels for `modify` and 0.02% for
 * `representation` — under this module's threshold, i.e. the same picture. A
 * negative control has to be a real visual defect, not one asserted from
 * reading the graph; if a node type is ever added whose overlap *is* visible,
 * it belongs below.
 *
 * So this module pins the *picture*. Each entry names a bench case, the fixture
 * it renders against, and a `pipeline` that genuinely answers the request;
 * `tests/e2e/bench-render.spec.ts` renders it and compares against a committed
 * baseline PNG. Two more fields keep that comparison honest:
 *
 *   - `equivalents` — different graphs that must produce the *same* image. A
 *     check that accepted only one graph shape would be no better than the
 *     static rubric; these prove it grades the outcome.
 *   - `counterexamples` — wrong pipelines, each of which the static rubric
 *     already accepts, that must NOT match. These are the negative controls:
 *     if one ever matches, the render check has stopped checking.
 *
 * Pipelines are authored pre-normalization. `deserializePipeline` injects an
 * `add_bond` node and default viewport edges when the graph does not already
 * reach the viewport, exactly as it does for a model's output.
 */

import type { SerializedPipeline } from "@/pipeline/types";

type Node = SerializedPipeline["nodes"][number];
type Edge = SerializedPipeline["edges"][number];

/** The solvated-caffeine fixture every visual case renders against. */
export const CAFFEINE_WATER = "caffeine_water.pdb";

/** Selects the solvent by residue name. */
const WATER = 'resname == "HOH"';
/**
 * Selects the same 3000 solvent atoms by connectivity instead of residue name:
 * molecule_id 0 is the connected component containing atom 0 (the caffeine),
 * every water gets its own id >= 1. Used as an `equivalents` entry.
 */
const WATER_BY_MOLECULE = "not molecule_id == 0";

const loader = (): Node =>
  ({
    id: "load",
    type: "load_structure",
    fileName: null,
    hasTrajectory: false,
    hasCell: false,
    position: { x: 0, y: 0 },
  }) as Node;

const viewport = (): Node =>
  ({
    id: "view",
    type: "viewport",
    perspective: true,
    cellAxesVisible: false,
    pivotMarkerVisible: false,
    position: { x: 150, y: 700 },
  }) as Node;

const addBond = (): Node =>
  ({ id: "ab", type: "add_bond", bondSource: "file", position: { x: 320, y: 180 } }) as Node;

const particleFilter = (id: string, query: string): Node =>
  ({ id, type: "filter", query, position: { x: 0, y: 320 } }) as Node;

const bondFilter = (id: string, bond_query: string): Node =>
  ({ id, type: "filter", query: "", bond_query, position: { x: 320, y: 320 } }) as Node;

const modify = (id: string, opacity: number, x = 0): Node =>
  ({ id, type: "modify", scale: 1, opacity, position: { x, y: 500 } }) as Node;

const representation = (id: string, mode: string, x = 0): Node =>
  ({ id, type: "representation", mode, position: { x, y: 500 } }) as Node;

const edge = (
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
): Edge => ({ source, sourceHandle, target, targetHandle });

const graph = (nodes: Node[], edges: Edge[]): SerializedPipeline => ({ version: 3, nodes, edges });

/**
 * Fade one selection of atoms *and its bonds* to `opacity`.
 *
 * Both branches are the point: `viewport.particle` and `viewport.bond` are
 * independent streams, so a pipeline that only fades the particles leaves the
 * selection's bond sticks on screen at full opacity.
 */
function fadeSelection(
  particleQuery: string,
  bondQuery: string,
  opacity: number,
): SerializedPipeline {
  return graph(
    [
      loader(),
      particleFilter("fp", particleQuery),
      modify("mp", opacity, 0),
      addBond(),
      bondFilter("fb", bondQuery),
      modify("mb", opacity, 320),
      viewport(),
    ],
    [
      edge("load", "particle", "fp", "in"),
      edge("fp", "out", "mp", "in"),
      edge("mp", "out", "view", "particle"),
      edge("load", "particle", "ab", "particle"),
      edge("ab", "bond", "fb", "in"),
      edge("fb", "out", "mb", "in"),
      edge("mb", "out", "view", "bond"),
    ],
  );
}

/** The particle-only shape the static rubric is satisfied by. */
function fadeParticlesOnly(query: string, opacity: number): SerializedPipeline {
  return graph(
    [loader(), particleFilter("fp", query), modify("mp", opacity), viewport()],
    [
      edge("load", "particle", "fp", "in"),
      edge("fp", "out", "mp", "in"),
      edge("mp", "out", "view", "particle"),
    ],
  );
}

/** A pipeline paired with a human-readable reason it is in the list. */
export interface LabelledPipeline {
  label: string;
  pipeline: SerializedPipeline;
}

export interface GoldenRender {
  /** The `bench/llm/dataset.ts` case this is the reference answer for. */
  caseId: string;
  /** Fixture filename under `tests/fixtures/`. */
  fixture: string;
  /** What the baseline image shows — the reviewable statement of "correct". */
  expectation: string;
  /** The pipeline the baseline PNG is rendered from. */
  pipeline: SerializedPipeline;
  /** Different graphs that must render identically to `pipeline`. */
  equivalents: LabelledPipeline[];
  /** Wrong graphs that must NOT render identically to `pipeline`. */
  counterexamples: LabelledPipeline[];
}

export const GOLDEN_RENDERS: GoldenRender[] = [
  {
    caseId: "hide-water",
    fixture: CAFFEINE_WATER,
    expectation: "Only the caffeine molecule is drawn — no water atoms and no water bonds.",
    pipeline: fadeSelection(WATER, WATER, 0),
    equivalents: [
      {
        label: "selects the solvent by connectivity instead of residue name",
        pipeline: fadeSelection(WATER_BY_MOLECULE, WATER_BY_MOLECULE, 0),
      },
    ],
    counterexamples: [
      {
        // Exactly what the `hide-water` rubric asks for, and it scores 100%.
        // The water's bonds come from the injected AddBond node straight off
        // the loader, so the solvent shell is still drawn as sticks.
        label: "rubric-conformant particle-only branch leaves the water bonds drawn",
        pipeline: fadeParticlesOnly(WATER, 0),
      },
      {
        // Structurally identical to the golden, visually its opposite.
        label: "inverted selection: hides the caffeine and keeps the water",
        pipeline: fadeSelection("not " + WATER, "not " + WATER, 0),
      },
    ],
  },

  {
    caseId: "multistep-water-transparent",
    fixture: CAFFEINE_WATER,
    expectation: "Caffeine fully opaque, water (atoms and bonds) faded to 20%.",
    pipeline: fadeSelection(WATER, WATER, 0.2),
    equivalents: [],
    counterexamples: [
      {
        label: "particle-only branch leaves the water bonds fully opaque",
        pipeline: fadeParticlesOnly(WATER, 0.2),
      },
      {
        // Passes the rubric's "modify.opacity is below 1" parameter check by
        // fading the whole structure, caffeine included.
        label: "fades everything instead of only the solvent",
        pipeline: graph(
          [loader(), modify("mp", 0.2), viewport()],
          [edge("load", "particle", "mp", "in"), edge("mp", "out", "view", "particle")],
        ),
      },
      {
        // Hidden, not faded — the neighbouring `hide-water` answer.
        label: "hides the water outright instead of fading it",
        pipeline: fadeSelection(WATER, WATER, 0),
      },
    ],
  },

  {
    caseId: "representation-water-line",
    fixture: CAFFEINE_WATER,
    expectation: "Water drawn as thin lines, caffeine left in the default sphere-and-stick style.",
    pipeline: graph(
      [loader(), particleFilter("fp", WATER), representation("rp", "line"), viewport()],
      [
        edge("load", "particle", "fp", "in"),
        edge("fp", "out", "rp", "in"),
        edge("rp", "out", "view", "particle"),
      ],
    ),
    equivalents: [],
    counterexamples: [
      {
        // Line style on the solute instead of the solvent. Every rubric check
        // still passes — a filter node with the right query exists, and a
        // representation node with mode "line" exists — but the picture is the
        // request read backwards.
        label: "inverted selection: draws the caffeine as lines, water as spheres",
        pipeline: graph(
          [
            loader(),
            particleFilter("fp", "not " + WATER),
            representation("rp", "line"),
            viewport(),
          ],
          [
            edge("load", "particle", "fp", "in"),
            edge("fp", "out", "rp", "in"),
            edge("rp", "out", "view", "particle"),
          ],
        ),
      },
    ],
  },
];

/** Look up a golden by bench case id. */
export function goldenFor(caseId: string): GoldenRender | undefined {
  return GOLDEN_RENDERS.find((g) => g.caseId === caseId);
}
