/**
 * Generate the docs "LLM Benchmark" pages from the benchmark's own ground truth.
 *
 * Single source of truth: `bench/llm/dataset.ts` (the prompts and rubrics) plus
 * `bench/llm/golden/<case id>/` (the pipeline that answers each prompt, the
 * picture it draws, and the metadata that says where both came from). CRITICAL
 * RULE #12 requires those three to be added together; this script is what makes
 * the docs show them together, so a case that drifts shows up as a broken page
 * rather than as prose nobody re-read.
 *
 * Output — all of it gitignored and regenerated in CI, exactly like the TypeDoc,
 * Python API and Node Reference pages:
 *
 *   docs/docs/bench/index.md          what the benchmark measures and how
 *   docs/docs/bench/cases.md          one section per case: prompt, image, JSON
 *   docs/public/bench/<case id>.png   the reference image, halved for the page
 *
 * Run via `npm run api:bench` from `docs/`.
 */
import { build } from "esbuild";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN_DIR = join(REPO_ROOT, "bench", "llm", "golden");
const OUT_DIR = join(REPO_ROOT, "docs", "docs", "bench");
const IMAGE_DIR = join(REPO_ROOT, "docs", "public", "bench");

/** Bundle `dataset.ts` and import it, the way `generate-node-reference.mjs` does. */
async function loadDataset() {
  const result = await build({
    stdin: {
      contents: `export { DATASET } from "./bench/llm/dataset.ts";`,
      resolveDir: REPO_ROOT,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const dir = await mkdtemp(join(tmpdir(), "megane-bench-"));
  const file = join(dir, "dataset.mjs");
  await writeFile(file, result.outputFiles[0].text);
  try {
    return (await import(pathToFileURL(file).href)).DATASET;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Read every ground-truth folder, keyed by case id. */
async function loadGolden() {
  const entries = await readdir(GOLDEN_DIR, { withFileTypes: true });
  const cases = new Map();
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const dir = join(GOLDEN_DIR, entry.name);
    cases.set(entry.name, {
      caseId: entry.name,
      meta: JSON.parse(await readFile(join(dir, "meta.json"), "utf8")),
      pipeline: JSON.parse(await readFile(join(dir, "pipeline.megane.json"), "utf8")),
      image: join(dir, "expected.png"),
    });
  }
  return cases;
}

/**
 * Halve a reference image for the docs page.
 *
 * The references are 1280x800 and there are two dozen of them on one page;
 * shipping them at full size is 7.7 MB of PNG for a reader who wants to see
 * what "hide the water" looks like. A 2x2 box filter keeps the molecule legible
 * at a quarter of the bytes. The full-resolution image stays in the repo — it
 * is the thing the suite asserts against, and this is a picture of it.
 */
function halve(srcPath, destPath) {
  const src = PNG.sync.read(readFileSync(srcPath));
  const w = src.width >> 1;
  const h = src.height >> 1;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = (y * w + x) << 2;
      for (let c = 0; c < 4; c++) {
        const a = src.data[(((y * 2) * src.width + x * 2) << 2) + c];
        const b = src.data[(((y * 2) * src.width + x * 2 + 1) << 2) + c];
        const e = src.data[((((y * 2 + 1) * src.width) + x * 2) << 2) + c];
        const f = src.data[((((y * 2 + 1) * src.width) + x * 2 + 1) << 2) + c];
        out.data[d + c] = (a + b + e + f + 2) >> 2;
      }
    }
  }
  return writeFile(destPath, PNG.sync.write(out));
}

/** Escape characters that would break a Markdown table cell. */
function cell(text) {
  return String(text).replace(/[\\|]/g, "\\$&");
}

/** A one-line summary of what a pipeline is made of. */
function shape(pipeline) {
  const counts = new Map();
  for (const node of pipeline.nodes) counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([type, n]) => (n > 1 ? `\`${type}\` ×${n}` : `\`${type}\``))
    .join(", ");
}

function renderCase(bench, golden) {
  const { meta, pipeline, caseId } = golden;
  const lines = [];
  lines.push(`## ${caseId} {#${caseId}}`);
  lines.push("");
  lines.push(`> ${bench.prompt}`);
  lines.push("");
  lines.push(`**Fixture:** \`${meta.fixture}\` · **Tags:** ${bench.tags.map((t) => `\`${t}\``).join(", ")}`);
  lines.push("");
  lines.push(`![${caseId}](/bench/${caseId}.png)`);
  lines.push("");
  lines.push(`*${meta.expectation}*`);
  lines.push("");

  const notes = [];
  if (meta.imageDiscriminates === false) {
    notes.push(
      `**This picture cannot grade the prompt.** ${meta.discriminationNote}. The rubric is the only check available for this case.`,
    );
  }
  if (!meta.imageStability.asserted && meta.imageStability.boots > 0) {
    notes.push(
      `**The runner does not assert this image.** Over ${meta.imageStability.boots} independent boots the same pipeline produced renders differing by up to ${meta.imageStability.worstDiffPercent}% of pixels: ${meta.imageStability.note}.`,
    );
  }
  for (const note of notes) {
    lines.push(`:::caution`);
    lines.push(note);
    lines.push(`:::`);
    lines.push("");
  }

  lines.push(`**Nodes:** ${shape(pipeline)}`);
  lines.push("");
  lines.push(`<details>`);
  lines.push(`<summary>Reference pipeline (<code>pipeline.megane.json</code>)</summary>`);
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(pipeline, null, 2));
  lines.push("```");
  lines.push("");
  lines.push(`</details>`);
  lines.push("");
  lines.push(`<details>`);
  lines.push(`<summary>Where this pipeline came from</summary>`);
  lines.push("");
  lines.push(meta.capturedFrom);
  lines.push("");
  lines.push(`</details>`);
  lines.push("");
  return lines.join("\n");
}

function renderIndex(dataset, golden) {
  const rows = dataset.map((bench) => {
    const g = golden.get(bench.id);
    const status = !g
      ? "no ground truth"
      : g.meta.imageDiscriminates === false
        ? "rubric only"
        : g.meta.imageStability.asserted
          ? "asserted"
          : "recorded, not asserted";
    return `| [\`${bench.id}\`](./cases#${bench.id}) | ${cell(bench.prompt)} | ${cell(g?.meta.fixture ?? "—")} | ${status} |`;
  });

  return `---
title: LLM Benchmark
---

# LLM Benchmark

megane can build a pipeline from a natural-language request. \`bench/llm/\` is
how that gets measured: a fixed set of prompts, a rubric per prompt, and — for
every one of them — a reference pipeline and the picture it draws.

## Why a picture

The scorer grades the **shape** of a generated pipeline: which node types exist,
how they are wired, what their parameters say. It never draws anything, so on
its own it cannot tell an answer from its opposite. Two examples it could not
see:

- A bare \`filter\` **selects**; it does not change what is drawn. Selecting 8
  carbons and selecting 1006 oxygens+nitrogens produce pictures that differ from
  each other by **0.002 %** of pixels — the same view, both scoring full marks.
- Atoms and bonds are independent viewport streams. A pipeline that fades a
  molecule's atoms and leaves its bonds at full opacity looks, to a shape-only
  rubric, exactly like one that fades both.

So each case carries a rendered reference, and each reference carries at least
one **counterexample**: a named wrong pipeline that must *not* draw the same
picture. A comparison that accepts everything is indistinguishable from one that
works.

## What a case is made of

Every case is a prompt, a pipeline, and an image, stored together:

\`\`\`
bench/llm/dataset.ts                              the prompt and its rubric
bench/llm/golden/<case id>/pipeline.megane.json   a pipeline that answers it
bench/llm/golden/<case id>/expected.png           what that pipeline draws
bench/llm/golden/<case id>/meta.json              fixture, expectation, capture source
\`\`\`

The folder name **is** the case id. Nothing registers a case: the loader
discovers the directory and fails loudly if a folder names a prompt that does
not exist, and the unit tests fail if any of the three files is missing.

The pipelines are **captured, not written**. Each one is \`store.serialize()\`
taken from a graph built in the editor, from a fresh boot. Hand-authoring them
is how the first attempt shipped a bond query megane rejects (\`resname\` is not a
bond field), a \`bondSource\` no fixture loads, and a parameter that lives on a
different node type — each of which scored full marks against the rubric while
drawing nothing.

## What the images do and do not prove

A picture is ground truth only if the same pipeline draws it again, so each
case records what repeated renders actually produced:

- **asserted** — the reference reproduced byte-for-byte across independent
  boots, and the runner compares against it pixel-for-pixel.
- **recorded, not asserted** — the same pipeline produced one of two renders
  depending on the session. Across independent boots the store's viewport state
  is bit-identical (same atom count, same position checksums, same bond count,
  same mesh vertex and coordinate checksums), the camera returns the same
  position, target and zoom to the last float, and the visible subsystems agree
   — so what flips is below the scene, in how coincident geometry rasterises.
  The image is kept for review; widening the pixel budget until it passed would
  make the suite green without making it true. The counterexamples are still
  checked, against a reference rendered in the same page.
- **rubric only** — no pipeline can draw a different picture for this prompt. A
  \`SerializedPipeline\` does not carry trajectory frames or loaded force vectors,
  and applying one clears them, so \`load_trajectory\` and \`load_vector\` draw
  nothing after the round trip. The product behaves the same way, so grading
  against a picture it cannot produce would be grading the wrong thing.

## Running it

\`\`\`bash
npm run build:app            # the runner renders the built webapp
npx playwright test --project=bench-golden
\`\`\`

The runner renders whatever ground truth it finds and asserts both directions:
the reference draws its picture, and the counterexamples do not. Scoring a real
model against the rubrics is separate and opt-in — the \`llm-eval\` label runs
\`.github/workflows/llm-prompt-eval.yml\`, which makes real, paid API calls and
posts a before/after comparison on the pull request.

## The cases

| case | prompt | fixture | image |
| --- | --- | --- | --- |
${rows.join("\n")}
`;
}

function renderCases(dataset, golden) {
  const sections = [];
  for (const bench of dataset) {
    const g = golden.get(bench.id);
    if (!g) continue;
    sections.push(renderCase(bench, g));
  }
  return `---
title: Benchmark Cases
---

# Benchmark Cases

Every prompt in the benchmark, with the pipeline that answers it and the picture
that pipeline draws. See [LLM Benchmark](./) for how these are captured and
what the images prove.

${sections.join("\n")}`;
}

async function main() {
  const dataset = await loadDataset();
  const golden = await loadGolden();

  const missing = dataset.filter((c) => !golden.has(c.id)).map((c) => c.id);
  const orphaned = [...golden.keys()].filter((id) => !dataset.some((c) => c.id === id));
  if (orphaned.length) {
    throw new Error(
      `bench/llm/golden/ has folders naming no dataset case: ${orphaned.join(", ")}`,
    );
  }

  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(IMAGE_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, "index.md"), renderIndex(dataset, golden));
  await writeFile(join(OUT_DIR, "cases.md"), renderCases(dataset, golden));
  for (const g of golden.values()) {
    if (!existsSync(g.image)) throw new Error(`${g.caseId} has no expected.png`);
    await halve(g.image, join(IMAGE_DIR, `${g.caseId}.png`));
  }

  const note = missing.length ? ` (${missing.length} without ground truth: ${missing.join(", ")})` : "";
  // eslint-disable-next-line no-console
  console.log(`Generated docs/docs/bench/ for ${golden.size} of ${dataset.length} cases${note}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
