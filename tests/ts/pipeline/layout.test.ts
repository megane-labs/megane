import { describe, it, expect } from "vitest";
import {
  getLayoutedElements,
  nodeSize,
  allNodesMeasured,
  ESTIMATED_NODE_WIDTH,
  ESTIMATED_NODE_HEIGHT,
  ESTIMATED_COLLAPSED_NODE_HEIGHT,
} from "@/pipeline/layout";
import type { Node, Edge } from "@xyflow/react";

function makeNode(id: string): Node {
  return { id, type: "default", position: { x: 0, y: 0 }, data: {} };
}

function makeEdge(source: string, target: string): Edge {
  return { id: `e-${source}-${target}`, source, target };
}

describe("getLayoutedElements", () => {
  it("returns empty arrays for empty input", () => {
    const { nodes, edges } = getLayoutedElements([], []);
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });

  it("positions a single node", () => {
    const nodes = [makeNode("a")];
    const result = getLayoutedElements(nodes, []);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].position).toBeDefined();
    expect(typeof result.nodes[0].position.x).toBe("number");
    expect(typeof result.nodes[0].position.y).toBe("number");
  });

  it("lays out a linear chain top-to-bottom", () => {
    const nodes = [makeNode("a"), makeNode("b"), makeNode("c")];
    const edges = [makeEdge("a", "b"), makeEdge("b", "c")];
    const result = getLayoutedElements(nodes, edges);

    const posA = result.nodes.find((n) => n.id === "a")!.position;
    const posB = result.nodes.find((n) => n.id === "b")!.position;
    const posC = result.nodes.find((n) => n.id === "c")!.position;

    // Each subsequent node should be below the previous
    expect(posB.y).toBeGreaterThan(posA.y);
    expect(posC.y).toBeGreaterThan(posB.y);
  });

  it("places branching nodes side by side", () => {
    const nodes = [makeNode("root"), makeNode("left"), makeNode("right")];
    const edges = [makeEdge("root", "left"), makeEdge("root", "right")];
    const result = getLayoutedElements(nodes, edges);

    const posLeft = result.nodes.find((n) => n.id === "left")!.position;
    const posRight = result.nodes.find((n) => n.id === "right")!.position;

    // Both children at same y level, different x
    expect(posLeft.y).toBe(posRight.y);
    expect(posLeft.x).not.toBe(posRight.x);
  });

  it("preserves edges unchanged", () => {
    const nodes = [makeNode("a"), makeNode("b")];
    const edges = [makeEdge("a", "b")];
    const result = getLayoutedElements(nodes, edges);
    expect(result.edges).toEqual(edges);
  });

  it("no two nodes overlap", () => {
    const nodes = [makeNode("a"), makeNode("b"), makeNode("c"), makeNode("d")];
    const edges = [makeEdge("a", "b"), makeEdge("a", "c"), makeEdge("b", "d")];
    const result = getLayoutedElements(nodes, edges);

    for (let i = 0; i < result.nodes.length; i++) {
      for (let j = i + 1; j < result.nodes.length; j++) {
        const a = result.nodes[i].position;
        const b = result.nodes[j].position;
        const samePosition = a.x === b.x && a.y === b.y;
        expect(samePosition, `nodes ${result.nodes[i].id} and ${result.nodes[j].id} overlap`).toBe(
          false,
        );
      }
    }
  });
});

function sized(
  id: string,
  width: number,
  height: number,
  data: Record<string, unknown> = {},
): Node {
  return { id, type: "default", position: { x: 0, y: 0 }, data, measured: { width, height } };
}

function overlaps(a: Node, b: Node): boolean {
  const sa = nodeSize(a);
  const sb = nodeSize(b);
  return (
    a.position.x < b.position.x + sb.width &&
    b.position.x < a.position.x + sa.width &&
    a.position.y < b.position.y + sb.height &&
    b.position.y < a.position.y + sa.height
  );
}

describe("getLayoutedElements — node sizes", () => {
  it("leaves no gap wider than the rank separation under a short node", () => {
    const nodes = [sized("a", 340, 100), sized("b", 340, 100)];
    const result = getLayoutedElements(nodes, [makeEdge("a", "b")]);
    const a = result.nodes.find((n) => n.id === "a")!;
    const b = result.nodes.find((n) => n.id === "b")!;
    // The old layout assumed a fixed 280px height, leaving ~260px of air.
    expect(b.position.y - (a.position.y + 100)).toBeLessThanOrEqual(80);
    expect(b.position.y).toBeGreaterThan(a.position.y + 100);
  });

  it("never overlaps measured nodes of mixed widths and heights", () => {
    const nodes = [
      sized("root", 340, 138),
      sized("wide", 420, 237),
      sized("narrow", 340, 171),
      sized("tall", 340, 268),
      sized("sink", 340, 176),
    ];
    const edges = [
      makeEdge("root", "wide"),
      makeEdge("root", "narrow"),
      makeEdge("root", "tall"),
      makeEdge("wide", "sink"),
      makeEdge("narrow", "sink"),
      makeEdge("tall", "sink"),
    ];
    const result = getLayoutedElements(nodes, edges);
    for (let i = 0; i < result.nodes.length; i++) {
      for (let j = i + 1; j < result.nodes.length; j++) {
        expect(
          overlaps(result.nodes[i], result.nodes[j]),
          `${result.nodes[i].id} overlaps ${result.nodes[j].id}`,
        ).toBe(false);
      }
    }
  });

  it("keeps three or more siblings in one row instead of wrapping", () => {
    const nodes = [
      sized("r", 340, 100),
      sized("a", 340, 100),
      sized("b", 340, 100),
      sized("c", 340, 100),
    ];
    const edges = [makeEdge("r", "a"), makeEdge("r", "b"), makeEdge("r", "c")];
    const ys = new Set(
      getLayoutedElements(nodes, edges)
        .nodes.filter((n) => n.id !== "r")
        .map((n) => n.position.y),
    );
    expect(ys.size).toBe(1);
  });

  it("top-aligns nodes of different heights within a rank", () => {
    const nodes = [sized("r", 340, 100), sized("short", 340, 80), sized("tall", 340, 260)];
    const edges = [makeEdge("r", "short"), makeEdge("r", "tall")];
    const result = getLayoutedElements(nodes, edges);
    const short = result.nodes.find((n) => n.id === "short")!;
    const tall = result.nodes.find((n) => n.id === "tall")!;
    expect(short.position.y).toBe(tall.position.y);
  });

  it("keeps a single child straight under its parent", () => {
    const nodes = [sized("a", 340, 100), sized("b", 340, 100)];
    const result = getLayoutedElements(nodes, [makeEdge("a", "b")]);
    expect(result.nodes[0].position.x).toBe(result.nodes[1].position.x);
  });

  it("ignores edges that point at nodes outside the graph", () => {
    const nodes = [sized("a", 340, 100), sized("b", 340, 100)];
    const result = getLayoutedElements(nodes, [makeEdge("a", "b"), makeEdge("a", "ghost")]);
    expect(result.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(result.nodes[1].position.y).toBeGreaterThan(result.nodes[0].position.y);
  });
});

describe("nodeSize", () => {
  it("prefers the measured size", () => {
    expect(nodeSize(sized("a", 200, 90))).toEqual({ width: 200, height: 90 });
  });

  it("falls back to explicit width/height", () => {
    expect(nodeSize({ ...makeNode("a"), width: 300, height: 120 })).toEqual({
      width: 300,
      height: 120,
    });
  });

  it("estimates an unmeasured node, smaller when collapsed", () => {
    expect(nodeSize(makeNode("a"))).toEqual({
      width: ESTIMATED_NODE_WIDTH,
      height: ESTIMATED_NODE_HEIGHT,
    });
    expect(nodeSize({ ...makeNode("a"), data: { collapsed: true } })).toEqual({
      width: ESTIMATED_NODE_WIDTH,
      height: ESTIMATED_COLLAPSED_NODE_HEIGHT,
    });
  });
});

describe("allNodesMeasured", () => {
  it("is true only when every node has a measured width and height", () => {
    expect(allNodesMeasured([])).toBe(true);
    expect(allNodesMeasured([sized("a", 1, 1), sized("b", 1, 1)])).toBe(true);
    expect(allNodesMeasured([sized("a", 1, 1), makeNode("b")])).toBe(false);
    expect(allNodesMeasured([{ ...makeNode("a"), measured: { width: 10 } }])).toBe(false);
  });
});
