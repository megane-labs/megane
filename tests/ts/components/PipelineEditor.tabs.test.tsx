import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  return {
    ReactFlow: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", { "data-testid": "react-flow" }, children),
    ReactFlowProvider: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", null, children),
    MiniMap: () => null,
    // The zoom controls render their extra buttons (the graph's toolbar).
    Controls: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", { "data-testid": "graph-controls" }, children),
    ControlButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
      React.createElement("button", { type: "button", ...props }, children),
    Background: () => null,
    BackgroundVariant: { Dots: "dots" },
    useReactFlow: () => ({
      screenToFlowPosition: () => ({ x: 0, y: 0 }),
      fitView: () => {},
      getZoom: () => 1,
    }),
    Handle: () => null,
    Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  };
});

vi.mock("@/components/PipelineChatBox", () => ({
  PipelineChatBox: () => <div data-testid="chat-stub">chat</div>,
}));
vi.mock("@/components/RenderModal", () => ({
  RenderModal: () => null,
}));
vi.mock("@/tour/MeganeTour", () => ({
  startTour: vi.fn(),
  startPipelineTutorial: vi.fn(),
}));
vi.mock("@/renderer/RenderCapture", () => ({
  downloadBlob: vi.fn(),
}));

import { PipelineEditor } from "@/components/PipelineEditor";
import { usePipelineUIStore } from "@/stores/usePipelineUIStore";
import { usePipelineStore } from "@/pipeline/store";

afterEach(() => {
  cleanup();
  usePipelineUIStore.setState({ mode: "editor" });
  localStorage.clear();
  sessionStorage.clear();
});

describe("PipelineEditor — tab switching", () => {
  beforeEach(() => {
    usePipelineUIStore.setState({ mode: "editor" });
  });

  it("renders both tab buttons with the editor selected by default", () => {
    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);

    const editorTab = screen.getByTestId("pipeline-editor-tab-editor");
    const inspectorTab = screen.getByTestId("pipeline-editor-tab-inspector");
    expect(editorTab.getAttribute("aria-selected")).toBe("true");
    expect(inspectorTab.getAttribute("aria-selected")).toBe("false");

    expect(screen.getByTestId("pipeline-editor-templates")).toBeTruthy();
    expect(screen.getByTestId("react-flow")).toBeTruthy();
  });

  it("docks the assistant inside the editor pane, between the graph and the properties", () => {
    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);

    expect(screen.queryByTestId("pipeline-editor-tab-chat")).toBeNull();
    expect(document.getElementById("pipeline-tabpanel-chat")).toBeNull();

    const editorPanel = document.getElementById("pipeline-tabpanel-editor")!;
    const chat = screen.getByTestId("chat-stub");
    expect(editorPanel.contains(chat)).toBe(true);
    const flow = screen.getByTestId("react-flow");
    const properties = screen.getByTestId("pipeline-properties");
    // DOCUMENT_POSITION_FOLLOWING: the chat comes after the graph and before
    // the properties pane.
    expect(flow.compareDocumentPosition(chat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      chat.compareDocumentPosition(properties) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("hides the editor pane (and the assistant in it) when the inspector tab is clicked", () => {
    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);

    fireEvent.click(screen.getByTestId("pipeline-editor-tab-inspector"));

    expect(usePipelineUIStore.getState().mode).toBe("inspector");
    // Both panes share the same area; we toggle visibility (not display) so
    // the editor stays laid out and ReactFlow keeps real dimensions.
    const editorPanel = document.getElementById("pipeline-tabpanel-editor");
    const inspectorPanel = document.getElementById("pipeline-tabpanel-inspector");
    expect(editorPanel?.style.visibility).toBe("hidden");
    expect(editorPanel?.getAttribute("aria-hidden")).toBe("true");
    expect(inspectorPanel?.style.visibility).toBe("visible");
    expect(inspectorPanel?.getAttribute("aria-hidden")).toBe("false");
  });

  it("keeps every rail action available from every tab", () => {
    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);

    const ids = [
      "pipeline-editor-add",
      "pipeline-editor-templates",
      "pipeline-editor-file",
      "pipeline-editor-render",
      "pipeline-editor-guide",
      "pipeline-editor-tutorial",
      "pipeline-editor-theme",
    ];
    for (const id of ids) expect(screen.getByTestId(id)).toBeTruthy();

    fireEvent.click(screen.getByTestId("pipeline-editor-tab-inspector"));

    // The rail is outside the tab panels, so switching tabs hides none of it.
    const rail = screen.getByTestId("pipeline-rail");
    for (const id of ids) expect(rail.contains(screen.getByTestId(id))).toBe(true);
    for (const panel of ["editor", "inspector"]) {
      expect(document.getElementById(`pipeline-tabpanel-${panel}`)!.contains(rail)).toBe(false);
    }
  });

  it("names the current tab beside the panel title", () => {
    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);
    expect(screen.getByTestId("panel-pipeline-subtitle")).toHaveTextContent("Editor");
    fireEvent.click(screen.getByTestId("pipeline-editor-tab-inspector"));
    expect(screen.getByTestId("panel-pipeline-subtitle")).toHaveTextContent("Inspector");
  });

  it("offers neither a Build tab nor a Build launcher: the Build panel is a peer of this one", () => {
    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);
    // Editing the molecule is not a pipeline concern: the Build panel is its
    // own CollapsiblePanel (MeganeViewer stacks it under this one) with its
    // own stub, so nothing here toggles it or mounts it.
    expect(screen.queryByTestId("pipeline-editor-tab-build")).toBeNull();
    expect(screen.queryByTestId("pipeline-editor-build")).toBeNull();
    expect(screen.queryByTestId("build-panel")).toBeNull();
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("aria-label"))).toEqual([
      "Editor",
      "Inspector",
    ]);
  });

  it("shows the Editor tab when a template is applied from another tab", () => {
    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);
    fireEvent.click(screen.getByTestId("pipeline-editor-tab-inspector"));

    fireEvent.click(screen.getByTestId("pipeline-editor-templates"));
    fireEvent.click(screen.getByTestId("pipeline-template-molecule"));

    expect(usePipelineUIStore.getState().mode).toBe("editor");
    expect(screen.getByTestId("pipeline-editor-tab-editor").getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("shows the Editor tab when a node is added from another tab", () => {
    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);

    fireEvent.click(screen.getByTestId("pipeline-editor-tab-inspector"));
    fireEvent.click(screen.getByTestId("pipeline-editor-add"));
    fireEvent.click(screen.getByTestId("pipeline-add-filter"));
    expect(usePipelineUIStore.getState().mode).toBe("editor");
  });

  it("puts Auto Layout in the Editor's graph toolbar, not on the rail", () => {
    const original = usePipelineStore.getState().autoLayout;
    const autoLayout = vi.fn();
    usePipelineStore.setState({ autoLayout });
    try {
      render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);

      const button = screen.getByTestId("pipeline-editor-layout");
      expect(button.getAttribute("title")).toBe("Auto Layout");
      expect(button.getAttribute("aria-label")).toBe("Auto Layout");
      // It is an action on the graph: it sits with the zoom controls inside
      // the Editor tab, and the rail (the panel's navigation) no longer has it.
      expect(screen.getByTestId("graph-controls").contains(button)).toBe(true);
      expect(document.getElementById("pipeline-tabpanel-editor")!.contains(button)).toBe(true);
      expect(screen.getByTestId("pipeline-rail").contains(button)).toBe(false);

      fireEvent.click(button);
      expect(autoLayout).toHaveBeenCalledTimes(1);
      expect(usePipelineUIStore.getState().mode).toBe("editor");
    } finally {
      usePipelineStore.setState({ autoLayout: original });
    }
  });
});
