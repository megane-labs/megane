import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { usePipelineStore } from "@/pipeline/store";
import { NodeShell } from "@/components/nodes/NodeShell";
import { NODE_TYPE_LABELS, NODE_PORTS, DATA_TYPE_COLORS } from "@/pipeline/types";
import { seedPipelineStore, renderCard } from "./_helpers";

vi.mock("@xyflow/react", () => import("./_xyflowMock"));

function shell(props: Partial<React.ComponentProps<typeof NodeShell>> = {}): React.ReactElement {
  return (
    <NodeShell id="n1" nodeType="filter" enabled {...props}>
      {props.children ?? <div data-testid="child-content">form</div>}
    </NodeShell>
  );
}

describe("NodeShell — properties mode (default)", () => {
  beforeEach(() => {
    cleanup();
    seedPipelineStore("filter", { id: "n1" });
  });

  it("renders only the form, tagged with the node id", () => {
    render(shell());
    const form = screen.getByTestId("pipeline-properties-form");
    expect(form).toHaveAttribute("data-node-id", "n1");
    expect(screen.getByTestId("child-content")).toHaveTextContent("form");
    expect(screen.queryByText(NODE_TYPE_LABELS.filter)).toBeNull();
    expect(screen.queryAllByTestId(/^handle-/)).toHaveLength(0);
  });
});

describe("NodeShell — card mode", () => {
  beforeEach(() => {
    cleanup();
    seedPipelineStore("filter", { id: "n1", params: { query: 'resname == "HOH"' } });
  });

  it("renders the title and the parameter summary but not the form", () => {
    renderCard(shell());
    expect(screen.getByText(NODE_TYPE_LABELS.filter)).toBeInTheDocument();
    expect(screen.getByTestId("pipeline-node-summary")).toHaveTextContent('resname == "HOH"');
    expect(screen.queryByTestId("child-content")).toBeNull();
  });

  it("sets data-testid, data-node-id, data-enabled and data-selected", () => {
    renderCard(shell());
    const root = screen.getByTestId("pipeline-node-filter");
    expect(root).toHaveAttribute("data-node-id", "n1");
    expect(root).toHaveAttribute("data-enabled", "true");
    expect(root).toHaveAttribute("data-selected", "false");
  });

  it("marks the selected node", () => {
    usePipelineStore.setState({
      nodes: usePipelineStore.getState().nodes.map((n) => ({ ...n, selected: true })),
    });
    renderCard(shell());
    expect(screen.getByTestId("pipeline-node-filter")).toHaveAttribute("data-selected", "true");
  });

  it("shows an Off badge and a dashed border when disabled", () => {
    renderCard(shell({ enabled: false }));
    const root = screen.getByTestId("pipeline-node-filter");
    expect(root).toHaveAttribute("data-enabled", "false");
    expect(screen.getByText("Off")).toBeInTheDocument();
    expect(root.style.border).toContain("dashed");
  });

  it("renders one Handle per input and output port from NODE_PORTS", () => {
    seedPipelineStore("viewport", { id: "v1" });
    renderCard(shell({ id: "v1", nodeType: "viewport" }));
    for (const port of NODE_PORTS.viewport.inputs) {
      expect(screen.getByTestId(`handle-target-${port.name}`)).toBeInTheDocument();
    }
    expect(screen.queryAllByTestId(/^handle-source-/)).toHaveLength(0);
  });

  it("colors handles by their port dataType and names them on hover", () => {
    renderCard(shell());
    const inHandle = screen.getByTestId("handle-target-in");
    expect(inHandle.style.background).toBe(toRgb(DATA_TYPE_COLORS.particle));
    expect(inHandle).toHaveTextContent("In");
    expect(screen.getByTestId("handle-source-out")).toBeInTheDocument();
  });

  it("grays out handles listed in disabledPorts", () => {
    seedPipelineStore("load_structure", {
      id: "ls1",
      params: { fileName: null, hasTrajectory: false, hasCell: false },
    });
    renderCard(
      shell({ id: "ls1", nodeType: "load_structure", disabledPorts: new Set(["trajectory"]) }),
    );
    expect(screen.getByTestId("handle-source-trajectory").style.background).toBe(
      "var(--megane-border-strong)",
    );
    expect(screen.getByTestId("handle-source-particle").style.background).toBe(
      toRgb(DATA_TYPE_COLORS.particle),
    );
  });

  it("alternates port-name rows when a node has many ports", () => {
    seedPipelineStore("viewport", { id: "v1" });
    renderCard(shell({ id: "v1", nodeType: "viewport" }));
    const first = screen.getByTestId("handle-target-particle").firstElementChild as HTMLElement;
    const second = screen.getByTestId("handle-target-bond").firstElementChild as HTMLElement;
    expect(first.style.top).not.toBe(second.style.top);
  });

  it("shows no status dot without errors", () => {
    renderCard(shell());
    expect(screen.queryByTestId("pipeline-node-status")).toBeNull();
  });

  it("shows a red status dot listing the messages when an error is registered", () => {
    seedPipelineStore("filter", {
      id: "n1",
      errors: [
        { severity: "warning", message: "warn" },
        { severity: "error", message: "boom" },
      ],
    });
    renderCard(shell());
    const dot = screen.getByTestId("pipeline-node-status");
    expect(dot.style.background).toBe("var(--megane-danger)");
    expect(dot).toHaveAttribute("title", "warn\nboom");
    expect(screen.getByTestId("pipeline-node-filter").style.border).toContain(
      "var(--megane-danger)",
    );
  });

  it("uses the warning color when only warnings are present", () => {
    seedPipelineStore("filter", { id: "n1", errors: [{ severity: "warning", message: "w" }] });
    renderCard(shell());
    expect(screen.getByTestId("pipeline-node-status").style.background).toBe("rgb(245, 158, 11)");
  });

  it("uses a monospace summary only for query nodes", () => {
    renderCard(shell());
    expect(screen.getByTestId("pipeline-node-summary").style.fontFamily).toContain("monospace");
    cleanup();
    seedPipelineStore("wrap", { id: "w1" });
    renderCard(shell({ id: "w1", nodeType: "wrap" }));
    expect(screen.getByTestId("pipeline-node-summary").style.fontFamily).toBe("");
  });
});

/**
 * Convert a hex color (`#rrggbb`) to the `rgb(r, g, b)` form that browsers
 * (and jsdom) emit for `style.background` reads.
 */
function toRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgb(${r}, ${g}, ${b})`;
}
