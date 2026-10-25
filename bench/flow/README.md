# Megane Builder Flow benchmark

Grades the **Flow assistant** of Megane Builder — the prompt bar under the Flow
graph that turns a request (_"lay a 3 × 3 grid of water on Au(100)"_) into
blocks and wires — the way `bench/llm/` grades the viewer's pipeline
generator. Each case is a request, the Builder it is made in, and a rubric.

What sets it apart: every flow the assistant writes is **run**. The reply goes
through the production prompt, self-check and repair loop, the resulting flow
through the production engine (`runFlow`) — crystals, slabs and placement in
TypeScript, SMILES and polymers embedded by the same `megane-rdkit`
WebAssembly build the Builder uses, now in Node — and the structure its output
block builds is checked. A graph can be well-formed and wired exactly as asked
and still build carbon monoxide as methanol; only running it shows that.

## What it measures

| Dimension  | Weight | What it checks                                                                                                                                                                                         |
| ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **schema** | 0.20   | The reply holds a flow the Builder can hold; the production self-check (`collectFlowErrors`) finds nothing; one output block, which every block feeds.                                                 |
| **task**   | 0.25   | The blocks, tools and wires the request implies are there; for an edit, the blocks it did not ask to touch are kept (same id, same type).                                                              |
| **params** | 0.15   | Settings the request pins (Miller indices, layers, a grid, repeat counts, a lattice constant); for an edit, untouched blocks keep their settings.                                                      |
| **result** | 0.30   | The output block builds a structure, and it is the right one: atoms of which elements, how many, a unit cell, bonds per element pair, placed molecules that do not overlap; for a tool, what it asked. |
| **format** | 0.10   | Fenced JSON first, then one short sentence. A case whose right answer is prose (a packed box with no tool server connected) checks for prose instead.                                                  |

A dimension with no checks is n/a and left out of the total, which is
renormalised over the rest. The report gives the mean total, the pass rate
(cases ≥ 80 %), how many flows build at all, and per-dimension, per-tag and
per-case results — with what each flow built, or why it did not.

Everything is graded on the flow **as the Builder would apply it**: settings
the model left out take the blocks' defaults (`prepareGeneratedFlow`), exactly
as `FlowChatBox` installs it.

## The environment

`environment.ts` builds what a case's Builder has, in Node, from production
code wherever possible:

- the library is the Builder's preset molecules;
- with `setup.tools`, the tool listing is the reference tool server's recorded
  `tools/list` (`tests/fixtures/builder-tools/`), and a call is answered with
  that server's recorded result for the tool — there is no packmol here, so
  what the call _asked_ for (the molecules, counts, density, the structure to
  solvate) is what the result checks grade;
- with `setup.document`, a structure is open in Manual mode (built by the
  Builder's crystal code);
- with `setup.flow`, a flow is already in the graph and the request edits it,
  wrapped by the production `buildFlowEditRequest`, selection included.

Only two things differ from the browser: RDKit runs in-process rather than in
a Web Worker, and its mol block is read by a small V2000 reader rather than
the WASM MOL parser.

## Ground truth

`golden.ts` holds, for every case, a **reference** answer and
**counterexamples**. References are built through the Flow store's actions
(`addNode`, `connect`, `updateParams`, `load`) — what the editor does — and
serialized, never written as JSON by hand. `tests/ts/bench/flow-bench.test.ts`
runs in the normal `npm test` suite (no network) and fails unless:

- every case has an entry, and nothing else does;
- every reference **scores 1.0 when its flow is run** — so a perfect model can
  reach it, and every expected atom count is one the engine really produces;
- every counterexample scores below 1.0, and for every case that expects a
  flow at least one fails on **what it builds** (methanol for CO, PVA for PEO,
  nine waters stacked on a slab cell with room for one, the slab cut from a new
  crystal instead of the open structure, the edit that also changed the grid,
  …).

A rubric that passes everything is indistinguishable from one that works; the
counterexamples are what show this one does not.

## Running it (live)

It makes **real, paid LLM API calls**, behind the same switch and provider
variables as the pipeline benchmark:

```bash
MEGANE_LLM_BENCH=1 ANTHROPIC_API_KEY=sk-ant-... \
  MEGANE_LLM_PROVIDER=anthropic MEGANE_LLM_MODEL=claude-haiku-4-5 \
  npm run bench:flow

# OpenRouter, a subset of cases
MEGANE_LLM_BENCH=1 OPENROUTER_API_KEY=sk-or-... MEGANE_LLM_PROVIDER=openrouter \
  MEGANE_LLM_BENCH_CASES=adsorb-co-pt111,tool-liquid-mixture npm run bench:flow
```

Providers: `anthropic`, `openai`, `plamo`, `openrouter`, `demo` (see
`bench/llm/README.md`). Reports go to `bench/flow/results/` (git-ignored) as
JSON and Markdown and are printed. The JSON has the pipeline benchmark's shape,
plus each case's remaining self-check findings, what its flow built and why a
run failed.

## CI

Add the **`llm-eval-flow`** label to a PR to run
`.github/workflows/llm-flow-eval.yml`: it scores the PR branch and its base
with the same model, diffs the two reports with `bench/llm/compare-results.mjs`
and posts the comparison as a PR comment (updated on later pushes). When the
base has no Flow benchmark yet, the comment reports the branch alone. It can
also be started from **Actions → LLM Flow Eval** on any branch, optionally
with a comma-separated list of case ids; that run reports in the job summary
and the uploaded artifact.

It uses the pipeline benchmark's repository settings — the
`MEGANE_LLM_BENCH_PROVIDER` / `MEGANE_LLM_BENCH_MODEL` variables, the matching
`OPENROUTER_API_KEY` / `PLAMO_API_KEY` / `ANTHROPIC_API_KEY` secret, and the
`LLM_EVAL_ALLOWED_USERS` allowlist — and, like it, runs only for PRs from
branches of this repository. A run is 20 generations per side plus one per
repair round.

## Extending it

Add a case to `dataset.ts` and its reference and counterexamples to
`golden.ts` — the test fails until both exist and the reference scores 1.0.
Prefer result checks (what is built) over parameter checks (how it is spelled):
there are many right ways to write a flow and far fewer right structures.
