import { describe, it, expect } from "vitest";
import {
  buildEditRequest,
  compactPipeline,
  MAX_HISTORY_TURNS,
  type ChatTurn,
} from "@/ai/editContext";
import type { SerializedPipeline } from "@/pipeline/types";

const pipeline = {
  version: 3,
  nodes: [
    {
      type: "load_structure",
      id: "loader-1",
      position: { x: 10.4, y: 19.6 },
      fileName: "mol.pdb",
      hasTrajectory: false,
      hasCell: false,
      edits: [{ kind: "delete_atoms", indices: [1] }],
      enabled: true,
    },
    {
      type: "filter",
      id: "filter-1",
      position: { x: 0, y: 100 },
      query: 'element == "O"',
      bond_query: "",
      enabled: false,
    },
  ],
  edges: [{ source: "loader-1", target: "filter-1", sourceHandle: "particle", targetHandle: "in" }],
} as unknown as SerializedPipeline;

describe("compactPipeline", () => {
  it("drops edit histories and default enabled flags, and rounds positions", () => {
    const compact = compactPipeline(pipeline) as { nodes: Record<string, unknown>[] };
    expect(compact.nodes[0]).toEqual({
      type: "load_structure",
      id: "loader-1",
      position: { x: 10, y: 20 },
      fileName: "mol.pdb",
      hasTrajectory: false,
      hasCell: false,
    });
    expect(compact.nodes[1]).toMatchObject({
      id: "filter-1",
      enabled: false,
      position: { x: 0, y: 100 },
    });
  });

  it("gives a node without a position the origin", () => {
    const compact = compactPipeline({
      version: 3,
      nodes: [{ type: "viewport", id: "v" } as never],
      edges: [],
    }) as { nodes: Record<string, unknown>[] };
    expect(compact.nodes[0].position).toEqual({ x: 0, y: 0 });
  });
});

describe("buildEditRequest", () => {
  it("sends the request as-is when there is no context", () => {
    expect(
      buildEditRequest("show water", { pipeline: null, selectedNodeIds: [], history: [] }),
    ).toBe("show water");
    expect(
      buildEditRequest("show water", {
        pipeline: { version: 3, nodes: [], edges: [] },
        selectedNodeIds: [],
        history: [],
      }),
    ).toBe("show water");
  });

  it("includes the current graph and asks for a complete edited pipeline", () => {
    const msg = buildEditRequest("hide oxygen", {
      pipeline,
      selectedNodeIds: [],
      history: [],
    });
    expect(msg).toContain("## Current pipeline");
    expect(msg).toContain("output the COMPLETE updated pipeline");
    expect(msg).toContain('"id":"filter-1"');
    expect(msg).not.toContain("delete_atoms");
    expect(msg).not.toContain("Selected in the editor");
    expect(msg.endsWith("## Request\n\nhide oxygen")).toBe(true);
  });

  it("names the selected nodes", () => {
    const msg = buildEditRequest("make this blue", {
      pipeline,
      selectedNodeIds: ["filter-1", "missing"],
      history: [],
    });
    expect(msg).toContain("Selected in the editor: `filter-1` (filter).");
  });

  it("restates only the most recent turns", () => {
    const history: ChatTurn[] = Array.from({ length: MAX_HISTORY_TURNS + 2 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn ${i}`,
    }));
    const msg = buildEditRequest("next", { pipeline: null, selectedNodeIds: [], history });
    expect(msg.startsWith("## Conversation so far")).toBe(true);
    expect(msg).not.toContain("turn 0");
    expect(msg).not.toContain("turn 1\n");
    expect(msg).toContain("User: turn 2");
    expect(msg).toContain(`You: turn ${MAX_HISTORY_TURNS + 1}`);
    expect(msg).not.toContain("## Current pipeline");
  });
});
