import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { usePipelineStore } from "@/pipeline/store";
import { NodeShell } from "@/components/nodes/NodeShell";
import { NODE_TYPE_LABELS, NODE_PORTS, DATA_TYPE_COLORS } from "@/pipeline/types";
import { seedPipelineStore } from "./_helpers";

vi.mock("@xyflow/react", () => import("./_xyflowMock"));

describe("NodeShell", () => {
  beforeEach(() => {
    cleanup();
    seedPipelineStore("filter", { id: "n1" });
  });

  it("renders the human-readable title for the node type", () => {
    render(
      <NodeShell id="n1" nodeType="filter" enabled>
        <div>body</div>
      </NodeShell>,
    );
    expect(screen.getByText(NODE_TYPE_LABELS.filter)).toBeInTheDocument();
  });

  it("forwards children into the body", () => {
    render(
      <NodeShell id="n1" nodeType="filter" enabled>
        <div data-testid="child-content">hello</div>
      </NodeShell>,
    );
    expect(screen.getByTestId("child-content")).toHaveTextContent("hello");
  });

  it("sets data-testid, data-node-id, data-enabled attributes", () => {
    render(
      <NodeShell id="n1" nodeType="filter" enabled>
        <div />
      </NodeShell>,
    );
    const root = screen.getByTestId("pipeline-node-filter");
    expect(root).toHaveAttribute("data-node-id", "n1");
    expect(root).toHaveAttribute("data-enabled", "true");
  });

  it("reflects disabled state in data-enabled", () => {
    render(
      <NodeShell id="n1" nodeType="filter" enabled={false}>
        <div />
      </NodeShell>,
    );
    expect(screen.getByTestId("pipeline-node-filter")).toHaveAttribute("data-enabled", "false");
  });

  it("renders one Handle per input and output port from NODE_PORTS", () => {
    seedPipelineStore("viewport", { id: "v1" });
    render(
      <NodeShell id="v1" nodeType="viewport" enabled>
        <div />
      </NodeShell>,
    );
    const ports = NODE_PORTS.viewport;
    for (const port of ports.inputs) {
      expect(screen.getByTestId(`handle-target-${port.name}`)).toBeInTheDocument();
    }
    expect(ports.outputs).toHaveLength(0);
    expect(screen.queryAllByTestId(/^handle-source-/)).toHaveLength(0);
  });

  it("renders source/target handles correctly for filter (1 in, 1 out)", () => {
    render(
      <NodeShell id="n1" nodeType="filter" enabled>
        <div />
      </NodeShell>,
    );
    expect(screen.getByTestId("handle-target-in")).toBeInTheDocument();
    expect(screen.getByTestId("handle-source-out")).toBeInTheDocument();
  });

  it("colors handles by their port dataType", () => {
    render(
      <NodeShell id="n1" nodeType="filter" enabled>
        <div />
      </NodeShell>,
    );
    const inHandle = screen.getByTestId("handle-target-in");
    expect(inHandle.style.background).toBe(toRgb(DATA_TYPE_COLORS.particle));
  });

  it("grays out handles listed in disabledPorts", () => {
    seedPipelineStore("load_structure", {
      id: "ls1",
      params: { fileName: null, hasTrajectory: false, hasCell: false },
    });
    render(
      <NodeShell
        id="ls1"
        nodeType="load_structure"
        enabled
        disabledPorts={new Set(["trajectory", "cell"])}
      >
        <div />
      </NodeShell>,
    );
    const trajectoryHandle = screen.getByTestId("handle-source-trajectory");
    const particleHandle = screen.getByTestId("handle-source-particle");
    expect(trajectoryHandle.style.background).toBe("var(--megane-border-strong)");
    expect(particleHandle.style.background).toBe(toRgb(DATA_TYPE_COLORS.particle));
  });

  it("clicking the enable toggle invokes toggleNode(id)", () => {
    const toggleNode = vi.fn();
    usePipelineStore.setState({ toggleNode });
    render(
      <NodeShell id="n1" nodeType="filter" enabled>
        <div />
      </NodeShell>,
    );
    const toggle = screen.getByTitle("Disable node");
    fireEvent.click(toggle);
    expect(toggleNode).toHaveBeenCalledTimes(1);
    expect(toggleNode).toHaveBeenCalledWith("n1");
  });

  it("toggle title flips between Disable and Enable based on enabled flag", () => {
    const { rerender } = render(
      <NodeShell id="n1" nodeType="filter" enabled>
        <div />
      </NodeShell>,
    );
    expect(screen.getByTitle("Disable node")).toBeInTheDocument();
    rerender(
      <NodeShell id="n1" nodeType="filter" enabled={false}>
        <div />
      </NodeShell>,
    );
    expect(screen.getByTitle("Enable node")).toBeInTheDocument();
  });

  it("renders a delete button that calls removeNode(id)", () => {
    const removeNode = vi.fn();
    usePipelineStore.setState({ removeNode });
    render(
      <NodeShell id="n1" nodeType="filter" enabled>
        <div />
      </NodeShell>,
    );
    const deleteBtn = screen.getByTitle("Remove node");
    fireEvent.click(deleteBtn);
    expect(removeNode).toHaveBeenCalledWith("n1");
  });

  it("hides the delete button for the viewport node type", () => {
    seedPipelineStore("viewport", { id: "v1" });
    render(
      <NodeShell id="v1" nodeType="viewport" enabled>
        <div />
      </NodeShell>,
    );
    expect(screen.queryByTitle("Remove node")).toBeNull();
  });

  it("shows no error indicator when nodeErrors is empty", () => {
    render(
      <NodeShell id="n1" nodeType="filter" enabled>
        <div />
      </NodeShell>,
    );
    // The error indicator renders a literal "!" character; absence asserted by text.
    expect(screen.queryByText("!")).toBeNull();
  });

  it("shows error indicator when an error is registered for this node id", () => {
    seedPipelineStore("filter", {
      id: "n1",
      errors: [{ severity: "error", message: "Invalid query" }],
    });
    render(
      <NodeShell id="n1" nodeType="filter" enabled>
        <div />
      </NodeShell>,
    );
    expect(screen.getByText("!")).toBeInTheDocument();
  });

  it("error indicator tooltip toggles on hover", () => {
    seedPipelineStore("filter", {
      id: "n1",
      errors: [{ severity: "error", message: "Invalid query" }],
    });
    render(
      <NodeShell id="n1" nodeType="filter" enabled>
        <div />
      </NodeShell>,
    );
    expect(screen.queryByText("Invalid query")).toBeNull();
    const indicator = screen.getByText("!");
    fireEvent.mouseEnter(indicator);
    expect(screen.getByText("Invalid query")).toBeInTheDocument();
    fireEvent.mouseLeave(indicator);
    expect(screen.queryByText("Invalid query")).toBeNull();
  });

  it("error indicator uses warning color when only warnings are present", () => {
    seedPipelineStore("filter", {
      id: "n1",
      errors: [{ severity: "warning", message: "Just a warning" }],
    });
    render(
      <NodeShell id="n1" nodeType="filter" enabled>
        <div />
      </NodeShell>,
    );
    const indicator = screen.getByText("!");
    // Amber #f59e0b → rgb(245, 158, 11)
    expect(indicator.style.color).toBe("rgb(245, 158, 11)");
  });

  it("error indicator uses error color when any severity is error", () => {
    seedPipelineStore("filter", {
      id: "n1",
      errors: [
        { severity: "warning", message: "warn" },
        { severity: "error", message: "boom" },
      ],
    });
    render(
      <NodeShell id="n1" nodeType="filter" enabled>
        <div />
      </NodeShell>,
    );
    const indicator = screen.getByText("!");
    // The theme's danger red, so it follows dark mode.
    expect(indicator.style.color).toBe("var(--megane-danger)");
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
