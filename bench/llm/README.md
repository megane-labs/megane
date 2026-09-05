# megane LLM benchmark

Evaluates the quality of megane's **LLM pipeline generator** — the feature that
turns a natural-language request (e.g. _"show a molecule with bonds"_) into a
`SerializedPipeline` JSON that the pipeline editor can apply.

It is a prompt-suite + programmatic scorer: each case pairs a realistic request
with a rubric, and the scorer grades the model's response on four dimensions.

## What it measures

| Dimension  | Weight | What it checks                                                                                                                                                                                                                                                   |
| ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **schema** | 0.35   | Structural validity — parses as a v3 pipeline, exactly one viewport, unique ids, known node types, **type-compatible edges** (reuses `canConnect`/`NODE_PORTS` from `src/pipeline/types.ts`), acyclic, every node reaches a viewport, required inputs connected. |
| **task**   | 0.35   | Task coverage — does the pipeline include the node types, connections, and size the request implies?                                                                                                                                                             |
| **params** | 0.15   | Parameter accuracy — are individual node params right (filter queries, `bondSource`, `excludedCenters`, label `source`, scale/opacity, …)?                                                                                                                       |
| **format** | 0.15   | Robustness / output-format compliance — fenced JSON-first output with a single trailing one-sentence explanation, no unclosed fences.                                                                                                                            |

A dimension with no applicable checks for a case is reported as `—` (n/a) and
excluded from that case's weighted total (the total is renormalised over the
dimensions that apply). The total per case is in `[0,1]`; the report also gives
a **pass rate** (cases ≥ 80%) and per-tag breakdowns.

## Running it (live)

The runner makes **real, paid LLM API calls**, so it is gated behind
`MEGANE_LLM_BENCH=1`. It reuses vitest as a zero-extra-dependency TS runner.

```bash
# Anthropic
MEGANE_LLM_BENCH=1 ANTHROPIC_API_KEY=sk-ant-... \
  MEGANE_LLM_PROVIDER=anthropic MEGANE_LLM_MODEL=claude-sonnet-4-20250514 \
  npx vitest run tests/ts/bench/llm.bench.test.ts

# OpenAI
MEGANE_LLM_BENCH=1 OPENAI_API_KEY=sk-... \
  MEGANE_LLM_PROVIDER=openai MEGANE_LLM_MODEL=gpt-4o \
  npx vitest run tests/ts/bench/llm.bench.test.ts

# PLaMo (Preferred Networks — OpenAI-compatible)
MEGANE_LLM_BENCH=1 PLAMO_API_KEY=... \
  MEGANE_LLM_PROVIDER=plamo MEGANE_LLM_MODEL=plamo-3.0-prime \
  npx vitest run tests/ts/bench/llm.bench.test.ts

# OpenRouter (OpenAI-compatible; vendor-prefixed model slugs)
MEGANE_LLM_BENCH=1 OPENROUTER_API_KEY=sk-or-... \
  MEGANE_LLM_PROVIDER=openrouter MEGANE_LLM_MODEL=anthropic/claude-haiku-4.5 \
  npx vitest run tests/ts/bench/llm.bench.test.ts

# Demo proxy (no key; picks the model server-side)
MEGANE_LLM_BENCH=1 MEGANE_LLM_PROVIDER=demo \
  MEGANE_LLM_PROXY_URL=https://proxy.example.com/chat \
  npx vitest run tests/ts/bench/llm.bench.test.ts
```

`npm run bench:llm` is a shortcut for the vitest command (still requires the env
vars above). Reports are written to `bench/llm/results/<provider>-<model>-<ts>.{json,md}`
and printed to stdout. The results directory is git-ignored.

## How it stays faithful to production

- The **system prompt** is the production `buildSystemPrompt()` from
  `src/ai/prompt.ts` (imported, not copied).
- The **skills** are the same markdown files under `src/ai/skills/` (read from
  disk; only the loader differs because production uses Vite's
  `import.meta.glob`).
- The **JSON extraction** mirrors `src/ai/client.ts` (prefers the last valid
  fenced pipeline), pinned by unit tests.

The providers use non-streaming requests (the benchmark only needs the final
text) but otherwise replicate the production tool round-trip behaviour.

## Extending it

Add a case to `bench/llm/dataset.ts` — the scorer and runner are generic. Keep
rubrics referencing only node types/params the system prompt documents, so a
perfect model can reach 1.0. Deterministic logic (scorer, extract, skills,
dataset shape) is covered by `tests/ts/bench/bench-unit.test.ts`, which runs in
the normal `npm test` suite.

## CI: before/after prompt comparison

For PRs that change the system prompt, skills, or dataset/rubrics, add the
**`llm-eval`** label to run `.github/workflows/llm-prompt-eval.yml`. It:

1. Runs the live benchmark on the PR branch ("after") and on the PR's base
   commit ("before"), both with the same model.
2. Diffs the two `bench/llm/results/*.json` reports with
   `bench/llm/compare-results.mjs`.
3. Posts (and updates, on subsequent pushes) a PR comment with the aggregate
   and per-case score deltas, plus any cases that regressed by >= 5
   percentage points.

It makes real, paid API calls (32 generations per run: 16 cases x
before/after), so it is opt-in via the label rather than running on every PR.
The provider comes from the `MEGANE_LLM_BENCH_PROVIDER` repository variable —
`plamo` (the default; requires the `PLAMO_API_KEY` repository secret) or
`openrouter` (requires `OPENROUTER_API_KEY`). The model defaults per provider
(`plamo-3.0-prime` / `anthropic/claude-haiku-4.5`); override it with the
`MEGANE_LLM_BENCH_MODEL` repository variable (a PLaMo id from
https://docs.plamo.preferredai.jp/en/api, or an OpenRouter slug).
Because GitHub withholds secrets from `pull_request` workflows triggered by
forks, this only runs for PRs from branches within the repository.

To limit who can trigger these paid runs, the job also checks the triggering
actor against the `LLM_EVAL_ALLOWED_USERS` repository variable — a JSON array
of GitHub usernames (e.g. `["alice","bob"]`), defaulting to `["hodakamori"]`
if the variable is unset. Applying the `llm-eval` label as a user not in this
list does not run the job.

## Ground truth (what the score cannot see)

The scorer above grades the **shape** of a pipeline: which node types exist, how
they are wired, what their parameters say. It never draws anything, so it cannot
tell a pipeline that answers the request from one that draws the opposite.

Ground truth lives beside the prompt it answers — one folder per case, named
after its `dataset.ts` id:

```
bench/llm/dataset.ts                              the prompt and its rubric
bench/llm/golden/<case id>/pipeline.megane.json   a pipeline that answers it
bench/llm/golden/<case id>/expected.png           what that pipeline draws
bench/llm/golden/<case id>/meta.json              fixture, expectation, capture source
```

Adding ground truth to a case means dropping a folder named after it. There is
no registry to update: `golden.ts` discovers the directory, joins each folder to
its prompt by id, and throws if a folder names a case `dataset.ts` does not
have. **All 24 cases have all three files** — that pairing is CRITICAL RULE #12
in `CLAUDE.md` and `tests/ts/bench/golden.test.ts` fails if any piece is missing.

The pipelines are **captured, not hand-authored**: each is `store.serialize()`
taken from a graph built through the editor store — usually a
`PIPELINE_TEMPLATES` entry (`store.applyTemplate`) plus the edits the prompt
asks for, from a fresh boot per case; `meta.json` records which. Hand-rolling
them is how the first attempt went wrong three ways over — an atom field in a
`bond_query`, a `bondSource` no fixture loads, and a `molecule_id` selection that
distance-inferred bonds break — none of it obvious from reading a graph.

```
npm run build:app                 # the runner renders the built webapp
npm run test:e2e:bench-golden
```

`tests/e2e/bench-golden.spec.ts` is only the runner. It loads each reference as
serialized JSON — the same form a model emits — renders it, and compares against
that case's `expected.png`. The round trip is the point: it is what lets the
bench grade generated JSON against a reviewed picture. Nothing about a case
lives in the E2E suite, so a case can be added, re-captured or experimented on
without touching it.

Every case also carries **counterexamples**: wrong pipelines derived from its
reference by mutation, which must _not_ draw it. Without them a green run would
prove nothing — a comparison that accepts everything looks identical to one that
works. Most are generated from `meta.json`'s `answeringNodes`: delete the node
that answers the prompt and the graph still validates, still runs, and draws the
untreated view — which is exactly the failure the static rubric could not see.
A handful are hand-written where deletion is not the wrong answer: `color-by-element`
swaps the palette for a uniform colour, `crystal-polyhedra-exclude` empties the
exclusion list, and `molecule-no-bonds` — whose right answer is an _absence_ —
adds bonds back. The oldest is the bond query `water-line.spec.ts` itself shipped
until PR #690, `both resname == "HOH"`: `resname` is an atom field, so the query
threw, the branch produced nothing, and with the default bond edge already
dropped the viewport rendered no bonds at all. The caffeine lost its sticks and
the baseline recorded that as "only the caffeine shows".

The counterexample check compares each wrong pipeline against a reference render
taken **in the same page**, not against the committed PNG. Within a page the
renderer is exactly repeatable (measured: five consecutive renders of one
pipeline, byte-identical), so this isolates the pipeline difference from
anything session-dependent.

The pixel budget is **0.005 %**, not the E2E default. The caffeine is about 1 % of
the frame, so the differences that matter are small in absolute terms: measured
on this fixture a reference re-rendered against its own image differs by
0.000 %, while the closest wrong pipeline — the one that drops the caffeine's 25
sticks — differs by 0.023 %. Raise the budget and the suite stops separating
them.

To re-record an `expected.png` after an intended change, delete it and re-run —
then **look at the new image**. If a reference stops matching, re-capture
`pipeline.megane.json` from the source `meta.json` names rather than re-recording
the PNG; an image recorded from an unreviewed render is the exact failure mode
this suite exists to catch.

### Making a render mean something

A picture is ground truth only if the same pipeline draws it again. Two things
had to be pinned down before that was true, and `renderPipeline` now does both
before every capture:

- **Re-fit the camera.** `deserialize` does not re-frame the scene, and the
  Viewport keeps its zoom when a new snapshot has the same topology as the last,
  so framing is inherited from whatever ran before in the same page.
  `molecule-basic` and `color-by-element` render byte-identical pixels, yet two
  reference images captured in different batches differed by **10.9 %** — purely
  in framing.
- **Collapse the editor pane.** `MeganeViewer` reserves room for the pane by
  insetting the camera frustum (`setViewInsets(0, pipelineWidth + 12)`), so the
  pane's width is part of the projection. Collapsing takes the inset to zero and
  takes the editor out of the screenshot, which is what makes the "two pipelines
  laid out differently must score the same" rule above actually hold.

Neither is enough for every case, and the remainder is not something this
harness can fix. A handful of cases render one of exactly _two_ pictures
depending on the session, differing by 2.5–13 %. Across four independent boots
of those pipelines the store's viewport state is bit-identical (same atom count,
same position checksums, same bond count, same mesh vertex and coordinate
checksums), `__megane_test.getCameraState()` returns the same position, target
and zoom to the last float, and `getVisibleSubsystems()` agrees — and the images
still differ. Whatever flips is below the scene, in how coincident geometry
rasterises.

`meta.json` records the result per case as `imageStability`: how many
independent boots the reference was rendered in, the worst pairwise difference
between them, and whether the runner may assert the committed image. A case that
does not reproduce keeps its image for review with `asserted: false` and a note
saying what was measured — its counterexamples are still checked, against a
reference rendered in the same page. Silently widening the pixel budget to
absorb an unstable render would turn the suite green without making it true.

Two cases carry `imageDiscriminates: false`. `molecule-trajectory` and
`vectors-forces` depend on data a `SerializedPipeline` does not carry —
trajectory frames and `fileVectors` — which `deserialize` clears, so
`load_trajectory` and `load_vector` draw nothing after the round trip. The
product drops them the same way (`PipelineChatBox` re-attaches only the loaded
structure), so no pipeline can draw a different picture for those prompts:
`vectors-forces` renders byte-identically to `molecule-basic`. Their rubrics are
the only grading available, and the metadata says so rather than implying the
image is doing work.

### What rendering the answers turned up

Building a picture for every prompt surfaced things a rubric cannot see. They
are recorded here because anyone extending the bench will hit them:

- **Particle streams merge; bond streams concatenate.** Two branches into
  `viewport.particle` are merged per atom and any non-1.0 opacity wins, so a
  fade-the-complement branch works beside a full-opacity base. Two branches into
  `viewport.bond` are _appended_ — the bond count doubles and nothing is hidden —
  so a bond selection has to be routed through the filter rather than added
  beside the raw `add_bond` edge.
- **The cartoon representation ignores upstream filters.** It is built from the
  primary structure snapshot, not from the particle stream, so no `filter` in
  front of it narrows the ribbon. This is why `filter-residue` cannot be answered
  on the `protein` template and is built the way `filter-carbon` is.
- **The bond DSL has no `resname`.** `BOND_FIELDS` is `bond_index`,
  `atom_index`, `element`, `molecule_id`, and `both` takes a field rather than a
  parenthesised expression. "Only the alanines, bonds included" therefore has to
  be spelled with atom-index ranges — `filter-residue` uses 1UBQ's Ala28
  (211–215) and Ala46 (358–362).
- **An assistant edit drops the loaded trajectory and forces.**
  `PipelineChatBox` re-attaches only the structure snapshot across
  `deserialize`, so frames and `fileVectors` are lost while the loader keeps
  `hasTrajectory: true`. The harness mirrors this deliberately — grading against
  a picture the product cannot produce would be grading the wrong thing — and it
  is why `molecule-trajectory` and `vectors-forces` carry
  `imageDiscriminates: false`.
- **A node whose parameters fail to parse contributes nothing rather than
  failing.** An earlier `filter-residue` reference carried a `bond_query` the DSL
  rejects and still drew a plausible picture. The runner now asserts the store's
  `nodeErrors` is empty for every reference.

### Rubric corrections found by rendering

Auditing all 24 cases against the real renderer turned up rubrics that graded a
pipeline which does not produce the requested view. Seven were corrected:

| cases                                                                                                     | what the rubric accepted                                                                                                                                                                                                  | fix                                                                                                   |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `filter-carbon`, `filter-residue`, `filter-oxygen-nitrogen`, `filter-carbon-ja`, `multistep-filter-bonds` | `load_structure → filter → viewport`, at full marks. A bare filter _selects_; it does not change what is drawn — selecting 8 carbons and selecting 1006 oxygens+nitrogens differ from each other by **0.002 %** of pixels | require the selection to feed a node that changes the drawing (`modify`, `color` or `representation`) |
| `hide-water`, `multistep-water-transparent`                                                               | the particle branch alone, leaving the solvent's bonds drawn at full opacity                                                                                                                                              | require the bond branch, with a `bond_query` on a field that exists                                   |

`ConnectionReq.targetType` accepts a list so the first fix can require that a
selection is _used_ without dictating which node uses it. Pinning one shape is
how a rubric ends up scoring a correct pipeline below a broken one: before this,
`hide-water` gave the working answer 96.1 % and the broken one 100 %.

An eighth was found while capturing the images:

| case                        | what the rubric accepted                                                                                                                                                                                                                                                                       | fix                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `crystal-polyhedra-exclude` | `polyhedron_generator.excludedCenters` contains 22. That parameter does not exist on Polyhedron Generator — `excludedCenters` belongs to `CoordinationGeneratorParams`, the node that searches for centre/ligand pairs — so the check could not pass for _any_ pipeline, correct ones included | check `coordination_generator.excludedCenters`, and require the node |

Two earlier notes are **superseded by measurement**:

- `color-by-element` was recorded as rendering identically to the default view.
  It does not. Captured through the harness on `caffeine_water.pdb`, the
  reference and the same graph with the colour node deleted differ, so the case
  does have a visual signal and carries a counterexample like every other.
- `crystal-distance-bonds` and `crystal-polyhedra` were recorded as
  "could not be settled here". They are settled now:
  `tests/fixtures/perovskite_srtio3_3x3x3.xyz` is the perovskite the earlier note
  said was missing, and both cases carry a reference and a counterexample.
