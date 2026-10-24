/**
 * React Flow marches the dashes of an animated edge with an infinite
 * `stroke-dashoffset` animation, which repaints the graph every frame for as
 * long as the editor is on screen. The graph canvas holds it still unless the
 * pointer is over the graph.
 */
import { describe, it, expect } from "vitest";
import { EDGE_ANIMATION_CSS, styleEdges } from "@/components/graph/GraphCanvas";
import { REACT_FLOW_CSS } from "@/components/graph/reactFlowCss";

describe("EDGE_ANIMATION_CSS", () => {
  it("targets the rule React Flow animates the edges with", () => {
    expect(REACT_FLOW_CSS).toMatch(
      /\.react-flow__edge\.animated path \{[^}]*animation: dashdraw[^}]*infinite/,
    );
  });

  it("pauses the dashes unless the pointer is over the graph", () => {
    expect(EDGE_ANIMATION_CSS).toContain(
      ".megane-split-editor .react-flow__edge.animated path { animation-play-state: paused; }",
    );
    expect(EDGE_ANIMATION_CSS).toContain(
      ".megane-split-editor:hover .react-flow__edge.animated path { animation-play-state: running; }",
    );
  });

  it("drops the animation for reduced motion", () => {
    expect(EDGE_ANIMATION_CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.megane-split-editor \.react-flow__edge\.animated path \{ animation: none; \}/,
    );
  });

  it("still draws every edge as an animated (dashed) edge", () => {
    const [edge] = styleEdges([{ id: "e", source: "a", target: "b" }], () => "#123456");
    expect(edge.animated).toBe(true);
    expect(edge.style).toEqual({ stroke: "#123456", strokeWidth: 2 });
  });
});
