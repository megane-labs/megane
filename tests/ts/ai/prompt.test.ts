import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { buildSystemPrompt, renderNodeSchemaSection } from "@/ai/prompt";
import { collectPipelineErrors } from "@/ai/validatePipeline";
import type { SerializedPipeline } from "@/pipeline/types";

/** Extract the first ```json fenced block that follows a section heading. */
function exampleAfter(prompt: string, heading: string): SerializedPipeline {
  const idx = prompt.indexOf(heading);
  expect(idx).toBeGreaterThan(-1);
  const match = prompt.slice(idx).match(/```json\s*\n([\s\S]*?)```/);
  expect(match).not.toBeNull();
  return JSON.parse(match![1].trim()) as SerializedPipeline;
}

describe("buildSystemPrompt", () => {
  const prompt = buildSystemPrompt();

  it("returns a non-empty string", () => {
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("documents every supported node type", () => {
    const nodeTypes = [
      "load_structure",
      "load_trajectory",
      "load_vector",
      "load_volumetric",
      "add_bond",
      "coordination_generator",
      "filter",
      "modify",
      "replicate",
      "drawing_boundary",
      "color",
      "representation",
      "label_generator",
      "polyhedron_generator",
      "surface_mesh",
      "vector_overlay",
      "isosurface",
      "viewport",
    ];
    for (const t of nodeTypes) {
      expect(prompt).toContain(t);
    }
  });

  it("renders the node schema section byte-identically to the frozen fixture", () => {
    // The `## Node Types and Parameters` section is generated from the node
    // catalog (src/pipeline/catalog.ts). This fixture is the exact text that
    // section had when it was hand-written, so this test guarantees the
    // refactor changed nothing the LLM sees. If you intentionally reword a node
    // description/param, regenerate the fixture in the same commit.
    const fixturePath = resolve(process.cwd(), "tests/ts/ai/__fixtures__/node-schema-section.txt");
    const expected = readFileSync(fixturePath, "utf8");
    expect(renderNodeSchemaSection()).toBe(expected);
    // And the generated section must actually be spliced into the full prompt.
    expect(prompt).toContain(expected);
  });

  it("includes the schema version 3 marker", () => {
    expect(prompt).toContain('"version": 3');
  });

  it("includes a json fenced code block example", () => {
    expect(prompt).toContain("```json");
  });

  it("documents the connection rules section", () => {
    expect(prompt).toContain("Connection Rules");
  });

  it("is deterministic — two calls return identical strings", () => {
    expect(buildSystemPrompt()).toBe(buildSystemPrompt());
  });

  it("stays under the demo-proxy system-message cap (with summary headroom)", () => {
    // The demo Cloudflare Worker proxy rejects any system message longer than
    // MAX_SYSTEM_MESSAGE_LENGTH (48000) with "Missing or invalid 'messages'
    // array" — see workers/llm-proxy/src/proxy.ts. The base prompt is sent as
    // the system message and a loaded-structure summary is appended on top, so
    // the base must leave comfortable headroom. This guard catches prompt
    // growth before it silently breaks the free demo (the proxy cap and this
    // constant must be kept in sync).
    const PROXY_SYSTEM_CAP = 48000;
    const SUMMARY_HEADROOM = 8000;
    expect(buildSystemPrompt().length).toBeLessThan(PROXY_SYSTEM_CAP - SUMMARY_HEADROOM);
  });

  it("documents the atom selection query fields and operators", () => {
    expect(prompt).toContain("Atom & Bond Selection Query Language");
    for (const field of ["element", "index", "resname", "mass"]) {
      expect(prompt).toContain(field);
    }
    // String values must be quoted; warn against the unquoted form.
    expect(prompt).toContain('element == "C"');
  });

  it("documents the bond query `both` semantics", () => {
    expect(prompt).toContain("bond_query");
    expect(prompt).toContain("both");
  });

  it("warns that VMD/PyMOL idioms are unsupported", () => {
    for (const idiom of ["name CA", "chain A", "within 5 of"]) {
      expect(prompt).toContain(idiom);
    }
  });

  it("documents the selective visual property (subset) pattern", () => {
    expect(prompt).toContain("Selective Visual Property");
    // The guideline should steer the model away from double-rendering the
    // same atoms (full structure + filtered copy) into the viewport.
    expect(prompt).toContain("disjoint");
  });

  it("ships a valid selective-property example pipeline", () => {
    const pipeline = exampleAfter(prompt, "## Example: Selective Visual Property");
    // The documented example must itself pass the same schema + query
    // validators the repair round trip uses, so the model has a correct
    // template to follow.
    expect(collectPipelineErrors(pipeline)).toEqual([]);
    // Two disjoint filter branches (water vs. the rest), only one modified.
    const filters = pipeline.nodes.filter((n) => n.type === "filter");
    expect(filters).toHaveLength(2);
    expect(pipeline.nodes.filter((n) => n.type === "modify")).toHaveLength(1);
  });

  it("documents the selective representation (style one species) pattern", () => {
    expect(prompt).toContain("Selective Representation");
    // Steer the model to put the representation on a filtered branch, not the
    // whole structure — this is the caffeine-water "show the water as lines"
    // failure mode.
    expect(prompt).toContain("show the water as lines");
  });

  it("ships a valid selective-representation example with line on the water branch", () => {
    const pipeline = exampleAfter(prompt, "## Example: Selective Representation");
    expect(collectPipelineErrors(pipeline)).toEqual([]);
    // Two disjoint filter branches; the representation styles only one of them.
    const filters = pipeline.nodes.filter((n) => n.type === "filter");
    expect(filters).toHaveLength(2);
    const reps = pipeline.nodes.filter((n) => n.type === "representation");
    expect(reps).toHaveLength(1);
    expect((reps[0] as { mode?: string }).mode).toBe("line");
    // The representation must sit downstream of a filter (water branch), not on
    // the load_structure directly.
    const repId = reps[0].id;
    const feedsRep = pipeline.edges.find((e) => e.target === repId);
    expect(feedsRep).toBeDefined();
    const upstream = pipeline.nodes.find((n) => n.id === feedsRep!.source);
    expect(upstream?.type).toBe("filter");
  });

  it("documents hiding/removing a species via a modify opacity-0 branch", () => {
    expect(prompt).toContain("Hiding / removing a species");
    // A bare filter does not remove atoms; hiding is done by fading to opacity 0.
    expect(prompt).toContain("does NOT remove");
    expect(prompt).toContain("opacity");
  });

  it("ships a valid hide-species example that fades the target to opacity 0", () => {
    const pipeline = exampleAfter(prompt, "## Example: Hiding / removing a species");
    expect(collectPipelineErrors(pipeline)).toEqual([]);
    const modifies = pipeline.nodes.filter((n) => n.type === "modify");
    expect(modifies.length).toBeGreaterThanOrEqual(1);
    expect((modifies[0] as { opacity?: number }).opacity).toBe(0);
    // Two disjoint filter branches: the first selects the species to hide
    // (water), the second keeps the rest. Routing the rest through its own
    // filter — instead of re-sending the full structure — is what actually
    // hides the species (an unfiltered branch would re-draw it at full opacity).
    const filters = pipeline.nodes.filter((n) => n.type === "filter");
    expect(filters).toHaveLength(2);
    expect((filters[0] as { query?: string }).query).toContain("HOH");
    // No edge feeds the load_structure's particles straight to the viewport;
    // every particle path into the viewport goes through a filter first.
    const loaderId = pipeline.nodes.find((n) => n.type === "load_structure")!.id;
    const viewportId = pipeline.nodes.find((n) => n.type === "viewport")!.id;
    const directParticleEdge = pipeline.edges.find(
      (e) =>
        e.source === loaderId &&
        e.target === viewportId &&
        e.sourceHandle === "particle" &&
        e.targetHandle === "particle",
    );
    expect(directParticleEdge).toBeUndefined();
  });
});

describe("buildSystemPrompt with structure summary", () => {
  const summary = "- Atoms: 10 (index 0..9)\n- Elements present: C (6), H (4)";

  it("omits the structure section when no summary is given", () => {
    expect(buildSystemPrompt()).not.toContain("Currently Loaded Structure");
    expect(buildSystemPrompt(null)).not.toContain("Currently Loaded Structure");
  });

  it("appends the structure section when a summary is given", () => {
    const prompt = buildSystemPrompt(summary);
    expect(prompt).toContain("Currently Loaded Structure");
    expect(prompt).toContain(summary);
  });

  it("keeps the base schema content alongside the structure section", () => {
    const prompt = buildSystemPrompt(summary);
    expect(prompt).toContain("load_structure");
    expect(prompt).toContain('"version": 3');
  });
});
