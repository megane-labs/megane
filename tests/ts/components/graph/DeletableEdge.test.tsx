import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  return {
    BaseEdge: ({ id, style }: { id: string; style?: React.CSSProperties }) =>
      React.createElement("path", {
        "data-testid": `base-edge-${id}`,
        "data-stroke-width": String(style?.strokeWidth ?? ""),
      }),
    EdgeLabelRenderer: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    getBezierPath: () => ["M0 0", 40, 60],
  };
});

import {
  DeletableEdge,
  EDGE_INTERACTION_WIDTH,
  EdgeActionsContext,
  edgeTypes,
} from "@/components/graph/DeletableEdge";

function edgeProps(overrides: Record<string, unknown> = {}) {
  return {
    id: "e1",
    source: "a",
    target: "b",
    sourceX: 0,
    sourceY: 0,
    targetX: 100,
    targetY: 100,
    sourcePosition: "right",
    targetPosition: "left",
    style: { stroke: "#f00", strokeWidth: 2 },
    selected: false,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

let removeEdge: ReturnType<typeof vi.fn>;

function renderEdge(overrides: Record<string, unknown> = {}) {
  return render(
    <EdgeActionsContext.Provider
      value={{ remove: removeEdge, testIdPrefix: "pipeline-edge-delete-" }}
    >
      <svg>
        <DeletableEdge {...edgeProps(overrides)} />
      </svg>
    </EdgeActionsContext.Provider>,
  );
}

const deleteButton = () => screen.queryByTestId("pipeline-edge-delete-e1");

describe("DeletableEdge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    removeEdge = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("is registered as the 'deletable' edge type", () => {
    expect(edgeTypes.deletable).toBe(DeletableEdge);
    expect(EDGE_INTERACTION_WIDTH).toBeGreaterThan(2);
  });

  it("hides the delete button until hovered", () => {
    renderEdge();
    expect(deleteButton()).toBeNull();
    expect(screen.getByTestId("base-edge-e1").getAttribute("data-stroke-width")).toBe("2");

    fireEvent.mouseEnter(screen.getByTestId("base-edge-e1").parentElement!);
    expect(deleteButton()).not.toBeNull();
    // The hovered edge is drawn thicker.
    expect(screen.getByTestId("base-edge-e1").getAttribute("data-stroke-width")).toBe("3.5");
  });

  it("places the button at the edge midpoint", () => {
    renderEdge({ selected: true });
    expect(deleteButton()!.style.transform).toContain("translate(40px, 60px)");
  });

  it("shows the delete button while the edge is selected", () => {
    renderEdge({ selected: true });
    expect(deleteButton()).not.toBeNull();
  });

  it("keeps the button while the pointer moves from the edge onto it", () => {
    renderEdge();
    const g = screen.getByTestId("base-edge-e1").parentElement!;
    fireEvent.mouseEnter(g);
    fireEvent.mouseLeave(g);
    fireEvent.mouseEnter(deleteButton()!);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(deleteButton()).not.toBeNull();

    fireEvent.mouseLeave(deleteButton()!);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(deleteButton()).toBeNull();
  });

  it("removes the edge when the button is clicked", () => {
    renderEdge({ selected: true });
    fireEvent.click(deleteButton()!);
    expect(removeEdge).toHaveBeenCalledWith("e1");
  });

  it("falls back to a 2px stroke when no width is styled", () => {
    renderEdge({ style: undefined, selected: true });
    expect(screen.getByTestId("base-edge-e1").getAttribute("data-stroke-width")).toBe("3.5");
  });

  it("clears a pending hide timer on unmount", () => {
    const { unmount } = renderEdge();
    const g = screen.getByTestId("base-edge-e1").parentElement!;
    fireEvent.mouseEnter(g);
    fireEvent.mouseLeave(g);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("has no delete button outside an editor that provides edge actions", () => {
    render(
      <svg>
        <DeletableEdge {...edgeProps({ selected: true })} />
      </svg>,
    );
    expect(deleteButton()).toBeNull();
  });
});
