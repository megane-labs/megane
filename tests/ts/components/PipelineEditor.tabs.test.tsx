import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  return {
    ReactFlow: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", { "data-testid": "react-flow" }, children),
    ReactFlowProvider: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", null, children),
    MiniMap: () => null,
    Controls: () => null,
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

afterEach(() => {
  cleanup();
  usePipelineUIStore.setState({ mode: "editor", pendingNotice: null });
  localStorage.clear();
  sessionStorage.clear();
});

describe("PipelineEditor — tab switching", () => {
  beforeEach(() => {
    usePipelineUIStore.setState({ mode: "editor", pendingNotice: null });
  });

  it("renders both tab buttons with the editor selected by default", () => {
    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);

    const editorTab = screen.getByTestId("pipeline-editor-tab-editor");
    const chatTab = screen.getByTestId("pipeline-editor-tab-chat");
    expect(editorTab.getAttribute("aria-selected")).toBe("true");
    expect(chatTab.getAttribute("aria-selected")).toBe("false");

    expect(screen.getByTestId("pipeline-editor-templates")).toBeTruthy();
    expect(screen.getByTestId("react-flow")).toBeTruthy();
  });

  it("hides the editor pane and reveals the chat pane when the chat tab is clicked", () => {
    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);

    fireEvent.click(screen.getByTestId("pipeline-editor-tab-chat"));

    expect(usePipelineUIStore.getState().mode).toBe("chat");
    expect(screen.getByTestId("pipeline-editor-tab-chat").getAttribute("aria-selected")).toBe(
      "true",
    );

    // Both panes share the same area; we toggle visibility (not display) so
    // the editor stays laid out and ReactFlow keeps real dimensions.
    const editorPanel = document.getElementById("pipeline-tabpanel-editor");
    const chatPanel = document.getElementById("pipeline-tabpanel-chat");
    expect(editorPanel?.style.visibility).toBe("hidden");
    expect(editorPanel?.getAttribute("aria-hidden")).toBe("true");
    expect(chatPanel?.style.visibility).toBe("visible");
    expect(chatPanel?.getAttribute("aria-hidden")).toBe("false");
  });

  it("keeps every rail action available from every tab", () => {
    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);

    const ids = [
      "pipeline-editor-add",
      "pipeline-editor-templates",
      "pipeline-editor-layout",
      "pipeline-editor-file",
      "pipeline-editor-render",
      "pipeline-editor-guide",
      "pipeline-editor-tutorial",
      "pipeline-editor-theme",
    ];
    for (const id of ids) expect(screen.getByTestId(id)).toBeTruthy();

    fireEvent.click(screen.getByTestId("pipeline-editor-tab-chat"));

    // The rail is outside the tab panels, so switching tabs hides none of it.
    const rail = screen.getByTestId("pipeline-rail");
    for (const id of ids) expect(rail.contains(screen.getByTestId(id))).toBe(true);
    for (const panel of ["editor", "inspector", "chat"]) {
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
      "Chat",
    ]);
  });

  it("shows the Editor tab when a template is applied from another tab", () => {
    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);
    fireEvent.click(screen.getByTestId("pipeline-editor-tab-chat"));

    fireEvent.click(screen.getByTestId("pipeline-editor-templates"));
    fireEvent.click(screen.getByTestId("pipeline-template-molecule"));

    expect(usePipelineUIStore.getState().mode).toBe("editor");
    expect(screen.getByTestId("pipeline-editor-tab-editor").getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("shows the Editor tab when a node is added or the graph laid out from another tab", () => {
    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);

    fireEvent.click(screen.getByTestId("pipeline-editor-tab-inspector"));
    fireEvent.click(screen.getByTestId("pipeline-editor-add"));
    fireEvent.click(screen.getByTestId("pipeline-add-filter"));
    expect(usePipelineUIStore.getState().mode).toBe("editor");

    fireEvent.click(screen.getByTestId("pipeline-editor-tab-chat"));
    fireEvent.click(screen.getByTestId("pipeline-editor-layout"));
    expect(usePipelineUIStore.getState().mode).toBe("editor");
  });

  it("stays on the chat tab when a pipeline is applied so the reply stays visible", () => {
    usePipelineUIStore.setState({ mode: "chat", pendingNotice: null });
    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);

    expect(screen.getByTestId("pipeline-editor-tab-chat").getAttribute("aria-selected")).toBe(
      "true",
    );

    act(() => {
      usePipelineUIStore.getState().markPipelineApplied();
    });

    // The tab does not change — the assistant's explanation remains in view.
    expect(usePipelineUIStore.getState().mode).toBe("chat");
    expect(screen.getByTestId("pipeline-editor-tab-chat").getAttribute("aria-selected")).toBe(
      "true",
    );
    // A one-shot notice is still stamped (consumed by the editor pane when the
    // user switches to it), but the editor-only banner is not shown on chat.
    expect(usePipelineUIStore.getState().pendingNotice).toMatchObject({ kind: "applied" });
    expect(screen.queryByTestId("pipeline-editor-applied-notice")).toBeNull();
  });
});
