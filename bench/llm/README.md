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
