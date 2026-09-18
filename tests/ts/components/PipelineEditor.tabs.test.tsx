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

  it("keeps the I/O row visible from both tabs and hides the Others row on chat", () => {
    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);

    // Editor tab: I/O + Others both rendered.
    expect(screen.getByTestId("pipeline-editor-share")).toBeTruthy();
    expect(screen.getByTestId("pipeline-editor-render")).toBeTruthy();
    expect(screen.getByTestId("pipeline-editor-others-row")).toBeTruthy();
    expect(screen.getByTestId("pipeline-editor-theme")).toBeTruthy();

    fireEvent.click(screen.getByTestId("pipeline-editor-tab-chat"));

    // Chat tab: I/O still rendered (Render/Share apply to current pipeline)
    // but the editor-side Others row is unmounted to give chat more room.
    expect(screen.getByTestId("pipeline-editor-share")).toBeTruthy();
    expect(screen.getByTestId("pipeline-editor-render")).toBeTruthy();
    expect(screen.queryByTestId("pipeline-editor-others-row")).toBeNull();
    expect(screen.queryByTestId("pipeline-editor-theme")).toBeNull();
  });

  it("editor toolbar overrides the wrap-row flex basis so it does not eat column height", () => {
    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);

    const row = screen.getByTestId("pipeline-editor-row");
    // `toolbarRowStyle.flexBasis: 100%` is meant for the `flex-wrap: wrap`
    // header parent. Inside the column-flex Editor tabpanel a 100% basis
    // would claim the whole pane height and leave the buttons floating
    // inside a tall empty band. We pin the basis to `auto` and prevent
    // shrink so the toolbar takes its content height and ReactFlow gets
    // the remaining space.
    expect(row.style.flexBasis).toBe("auto");
    expect(row.style.flexShrink).toBe("0");
  });

  it("launches the Build panel from the header instead of offering it as a tab", () => {
    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);
    // Editing the molecule is not a pipeline tab: the Editor must stay
    // visible while the edit node grows, so the panel lives outside
    // (MeganeViewer stacks it under this one) and is only toggled from here.
    expect(screen.queryByTestId("pipeline-editor-tab-build")).toBeNull();
    expect(screen.queryByTestId("build-panel")).toBeNull();
    const launcher = screen.getByTestId("pipeline-editor-build");
    expect(launcher.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(launcher);
    expect(usePipelineUIStore.getState().buildOpen).toBe(true);
    expect(screen.getByTestId("pipeline-editor-build").getAttribute("aria-pressed")).toBe("true");
    // The tab is untouched and the panel is not mounted inside this one.
    expect(usePipelineUIStore.getState().mode).not.toBe("build" as never);
    expect(screen.queryByTestId("build-panel")).toBeNull();
    fireEvent.click(screen.getByTestId("pipeline-editor-build"));
    expect(usePipelineUIStore.getState().buildOpen).toBe(false);
  });

  it("hides Pipeline-tab-only buttons (Templates) when the chat tab is active", () => {
    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);

    fireEvent.click(screen.getByTestId("pipeline-editor-tab-chat"));

    const editorPanel = document.getElementById("pipeline-tabpanel-editor")!;
    // The Templates button lives inside the Editor tabpanel which is now
    // visibility:hidden — Playwright treats it as hidden, and the DOM still
    // contains it so the canvas stays measured.
    expect(editorPanel.style.visibility).toBe("hidden");
    expect(editorPanel.contains(screen.getByTestId("pipeline-editor-templates"))).toBe(true);
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
