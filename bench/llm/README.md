# megane LLM benchmark

Evaluates the quality of megane's **LLM pipeline generator** — the feature that
turns a natural-language request (e.g. _"show a molecule with bonds"_) into a
`SerializedPipeline` JSON that the pipeline editor can apply.

It is a prompt-suite + programmatic scorer: each case pairs a realistic request
with a rubric, and the scorer grades the model's response on four dimensions.

## What it measures

| Dimension | Weight | What it checks |
|---|---|---|
| **schema** | 0.35 | Structural validity — parses as a v3 pipeline, exactly one viewport, unique ids, known node types, **type-compatible edges** (reuses `canConnect`/`NODE_PORTS` from `src/pipeline/types.ts`), acyclic, every node reaches a viewport, required inputs connected. |
| **task** | 0.35 | Task coverage — does the pipeline include the node types, connections, and size the request implies? |
| **params** | 0.15 | Parameter accuracy — are individual node params right (filter queries, `bondSource`, `excludedCenters`, label `source`, scale/opacity, …)? |
| **format** | 0.15 | Robustness / output-format compliance — fenced JSON-first output with a single trailing one-sentence explanation, no unclosed fences. |

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

`bench/llm/golden/` holds the other half — the pipelines a correct answer
produces, as `SerializedPipeline` JSON, for the dataset's two molecule-selection
requests:

| file | answers | shows |
| --- | --- | --- |
| `water-hidden.megane.json` | `hide-water` | only the caffeine, in ball-and-stick |
| `water-line.megane.json` | `representation-water-line` | water as thin lines, caffeine untouched |

These are **captured, not hand-authored**. Each is `store.serialize()` taken from
the graph `tests/e2e/water-line.spec.ts` builds through the editor, from a fresh
boot per view. Hand-rolling them is how the first attempt went wrong three ways
over — an atom field in a `bond_query`, a `bondSource` no fixture loads, and a
`molecule_id` selection that distance-inferred bonds break — none of which is
obvious from reading a graph.

```
npm run build:app                 # the spec renders the built webapp
npm run test:e2e:bench-golden
```

`tests/e2e/bench-golden.spec.ts` loads each reference as serialized JSON — the
same form a model emits — renders it, and compares against
`tests/e2e/baselines/bench-golden/`. That round trip is the point: it is what
lets the bench grade generated JSON against a reviewed image.

Every view also carries **counterexamples**: wrong pipelines derived from the
reference by mutation, which must *not* draw it. Without them a green run would
prove nothing — a comparison that accepts everything looks identical to one that
works. The first is the bond query `water-line.spec.ts` itself shipped until
PR #690, `both resname == "HOH"`: `resname` is an atom field, so the query threw,
the branch produced nothing, and with the default bond edge already dropped the
viewport rendered no bonds at all. The caffeine lost its sticks and the baseline
recorded that as "only the caffeine shows".

The pixel budget is **0.005 %**, not the E2E default. The caffeine is about 1 % of
the frame, so the differences that matter are small in absolute terms: measured
on this fixture a reference re-rendered against its own baseline differs by
0.000 %, while the closest wrong pipeline — the one that drops the caffeine's 25
sticks — differs by 0.023 %. Raise the budget and the suite stops separating
them.

To re-record a baseline after an intended change, delete the PNG (or set
`MEGANE_E2E_UPDATE=1`) and re-run — then **look at the new image**. If a
reference stops matching, re-capture `golden/*.megane.json` from the spec rather
than re-recording the PNG; a reference recorded from an unreviewed render is the
exact failure mode this suite exists to catch. The project is not part of
`test:e2e:ci:webapp`; wiring it in also needs `tests/e2e/baselines-ci/bench-golden/`
recorded by the "E2E update baselines" workflow.
