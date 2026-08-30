import { describe, it, expect } from "vitest";
import {
  collectQueryErrors,
  collectPipelineErrors,
  buildRepairPrompt,
  buildUnparsablePipelinePrompt,
  MAX_REPORTED_ERRORS,
} from "@/ai/validatePipeline";
import type { SerializedPipeline } from "@/pipeline/types";

function pipeline(nodes: SerializedPipeline["nodes"]): SerializedPipeline {
  return { version: 3, nodes, edges: [] };
}

describe("collectQueryErrors", () => {
  it("returns no errors for valid filter queries", () => {
    const p = pipeline([
      { id: "f1", type: "filter", position: { x: 0, y: 0 }, query: 'element == "C"' },
      { id: "f2", type: "filter", position: { x: 0, y: 0 }, query: "index >= 1 and index <= 9" },
    ] as SerializedPipeline["nodes"]);
    expect(collectQueryErrors(p)).toEqual([]);
  });

  it("treats empty / all / none queries as valid", () => {
    const p = pipeline([
      { id: "f1", type: "filter", position: { x: 0, y: 0 }, query: "" },
      { id: "f2", type: "filter", position: { x: 0, y: 0 }, query: "all" },
      { id: "f3", type: "filter", position: { x: 0, y: 0 }, query: "none" },
    ] as SerializedPipeline["nodes"]);
    expect(collectQueryErrors(p)).toEqual([]);
  });

  it("flags an invalid atom query and names the node", () => {
    const p = pipeline([
      { id: "bad", type: "filter", position: { x: 0, y: 0 }, query: "chain A" },
    ] as SerializedPipeline["nodes"]);
    const errors = collectQueryErrors(p);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('node "bad"');
    expect(errors[0]).toContain("chain A");
  });

  it("flags an invalid bond query", () => {
    const p = pipeline([
      {
        id: "b1",
        type: "filter",
        position: { x: 0, y: 0 },
        query: "all",
        bond_query: "within 5 of foo",
      },
    ] as SerializedPipeline["nodes"]);
    const errors = collectQueryErrors(p);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bond_query");
  });

  it("ignores non-filter nodes", () => {
    const p = pipeline([
      { id: "v1", type: "viewport", position: { x: 0, y: 0 } },
      { id: "l1", type: "load_structure", position: { x: 0, y: 0 } },
    ] as SerializedPipeline["nodes"]);
    expect(collectQueryErrors(p)).toEqual([]);
  });

  it("collects multiple errors across nodes", () => {
    const p = pipeline([
      { id: "f1", type: "filter", position: { x: 0, y: 0 }, query: "protein" },
      { id: "f2", type: "filter", position: { x: 0, y: 0 }, query: "name CA" },
    ] as SerializedPipeline["nodes"]);
    expect(collectQueryErrors(p)).toHaveLength(2);
  });
});

describe("collectPipelineErrors", () => {
  it("returns no errors for a fully wired pipeline with valid queries", () => {
    const p = pipeline([
      { id: "l1", type: "load_structure", position: { x: 0, y: 0 } },
      { id: "f1", type: "filter", position: { x: 0, y: 155 }, query: 'element == "C"' },
      { id: "v1", type: "viewport", position: { x: 0, y: 310 } },
    ] as SerializedPipeline["nodes"]);
    p.edges = [
      { source: "l1", target: "f1", sourceHandle: "particle", targetHandle: "in" },
      { source: "f1", target: "v1", sourceHandle: "out", targetHandle: "particle" },
    ];
    expect(collectPipelineErrors(p)).toEqual([]);
  });

  it("reports the self-check findings that survive the schema and query gates", () => {
    // Schema-clean, queries valid — but the filter has nothing upstream.
    const p = pipeline([
      { id: "f1", type: "filter", position: { x: 0, y: 0 }, query: 'element == "C"' },
      { id: "v1", type: "viewport", position: { x: 0, y: 310 } },
    ] as SerializedPipeline["nodes"]);
    p.edges = [{ source: "f1", target: "v1", sourceHandle: "out", targetHandle: "particle" }];
    expect(collectPipelineErrors(p)).toEqual(['node "f1": No input connected']);
  });

  it("combines schema errors and query errors", () => {
    // No viewport (schema error) AND an invalid query (query error).
    const p = pipeline([
      { id: "f1", type: "filter", position: { x: 0, y: 0 }, query: "chain A" },
    ] as SerializedPipeline["nodes"]);
    const errors = collectPipelineErrors(p);
    expect(errors.some((e) => e.includes("viewport"))).toBe(true);
    expect(errors.some((e) => e.includes("chain A"))).toBe(true);
  });
});

describe("buildRepairPrompt", () => {
  it("lists every finding and asks for a corrected pipeline", () => {
    const msg = buildRepairPrompt(['node "f1": bad', 'node "f2": worse']);
    expect(msg).toContain('node "f1": bad');
    expect(msg).toContain('node "f2": worse');
    expect(msg).toContain("has the problems listed below");
    expect(msg).toContain("fix them all");
  });

  it("does not restate the broken pipeline — it is already in the conversation", () => {
    const msg = buildRepairPrompt(['node "f1": bad']);
    // The skeleton below is the only JSON in the message; the actual nodes and
    // edges the model produced are never pasted back in.
    expect(msg).not.toContain('"position"');
    expect(msg).not.toContain('"load_structure"');
  });

  it("pins the output shape with a literal skeleton", () => {
    // Prose alone let repair rounds come back as bare JSON, which cost format
    // score in the prompt benchmark.
    const msg = buildRepairPrompt(['node "f1": bad']);
    expect(msg).toContain("```json");
    expect(msg).toContain('{ "version": 3, "nodes": [...], "edges": [...] }');
    expect(msg).toContain("then one short");
  });

  it("uses the same skeleton when the JSON could not be parsed", () => {
    const msg = buildUnparsablePipelinePrompt();
    expect(msg).toContain("not a usable pipeline");
    expect(msg).toContain("```json");
    expect(msg).toContain('{ "version": 3, "nodes": [...], "edges": [...] }');
  });

  it("caps the finding list and says how many were omitted", () => {
    const errors = Array.from({ length: MAX_REPORTED_ERRORS + 3 }, (_, i) => `problem ${i}`);
    const msg = buildRepairPrompt(errors);
    expect(msg).toContain(`problem ${MAX_REPORTED_ERRORS - 1}`);
    expect(msg).not.toContain(`problem ${MAX_REPORTED_ERRORS}`);
    expect(msg).toContain("and 3 more");
  });
});
