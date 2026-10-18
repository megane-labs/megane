import { describe, it, expect } from "vitest";
import { edges, exactNode, node } from "@/pipeline/graphFactory";
import { defaultParams } from "@/pipeline/types";

describe("graphFactory.node", () => {
  it("fills defaultParams when there are no overrides", () => {
    expect(node("v", "viewport")).toEqual({
      id: "v",
      type: "viewport",
      position: { x: 0, y: 0 },
      data: { params: defaultParams("viewport"), enabled: true },
    });
  });

  it("merges overrides over the defaults, keeping the default key order", () => {
    const n = node("m", "modify", { opacity: 0 });
    expect(n.data.params).toEqual({ type: "modify", scale: 1, opacity: 0 });
    expect(Object.keys(n.data.params)).toEqual(Object.keys(defaultParams("modify")));
  });

  it("appends override keys the defaults do not carry", () => {
    const n = node("iso", "isosurface", { colorRange: [-1, 1] });
    expect(Object.keys(n.data.params).at(-1)).toBe("colorRange");
  });

  it("never lets an override change the node type", () => {
    const n = node("w", "wrap", { type: "filter" } as never);
    expect(n.type).toBe("wrap");
    expect(n.data.params.type).toBe("wrap");
  });
});

describe("graphFactory.exactNode", () => {
  it("uses the params verbatim, without defaults", () => {
    const params = { type: "filter" as const, query: 'element == "C"' };
    const n = exactNode("f", params);
    expect(n.type).toBe("filter");
    expect(n.data.params).toBe(params);
    expect(n.data.params).not.toHaveProperty("bond_query");
  });
});

describe("graphFactory.edges", () => {
  it("numbers edges e1..eN and reuses the handle for both ends when given one", () => {
    expect(edges(["a", "b", "particle"], ["b", "c", "out", "in"])).toEqual([
      { id: "e1", source: "a", target: "b", sourceHandle: "particle", targetHandle: "particle" },
      { id: "e2", source: "b", target: "c", sourceHandle: "out", targetHandle: "in" },
    ]);
  });

  it("returns an empty list for no specs", () => {
    expect(edges()).toEqual([]);
  });
});
