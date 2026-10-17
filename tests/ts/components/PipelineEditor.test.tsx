import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const fitViewMock = vi.hoisted(() => vi.fn());

// Mock heavy children that depend on Three.js / WebGL / WASM so the editor
// chrome (toolbar, theme button, dropdowns) renders cleanly under jsdom.
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
      fitView: fitViewMock,
      getZoom: () => 1,
    }),
    Handle: () => null,
    Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  };
});

vi.mock("@/components/PipelineChatBox", () => ({
  PipelineChatBox: () => null,
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

const shareCurrentPipelineMock = vi.fn();
vi.mock("@/pipeline/shareLink", async () => {
  const actual =
    await vi.importActual<typeof import("@/pipeline/shareLink")>("@/pipeline/shareLink");
  return {
    ...actual,
    shareCurrentPipeline: (...args: Parameters<typeof actual.shareCurrentPipeline>) =>
      shareCurrentPipelineMock(...args),
  };
});

import { PipelineEditor } from "@/components/PipelineEditor";
import { useThemeStore } from "@/stores/useThemeStore";
import { usePipelineUIStore } from "@/stores/usePipelineUIStore";
import { usePipelineStore } from "@/pipeline/store";
import { defaultParams } from "@/pipeline/types";

beforeEach(() => {
  // The editor toolbar (theme button, dropdowns) is hidden on the Chat tab,
  // which is now the default. These tests exercise the editor chrome, so pin
  // the panel to the Editor tab.
  usePipelineUIStore.setState({ mode: "editor", pendingNotice: null });
});

afterEach(() => {
  cleanup();
  // Reset the theme store between tests.
  useThemeStore.setState({ theme: "system", resolvedTheme: "light" });
});

describe("PipelineEditor — theme button", () => {
  it("renders the theme cycle button with the current label", () => {
    useThemeStore.setState({ theme: "light", resolvedTheme: "light" });

    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);

    const themeBtn = screen.getByTestId("pipeline-editor-theme");
    expect(themeBtn.textContent).toContain("Light");
    expect(themeBtn.getAttribute("aria-label")).toContain("Light");
  });

  // The parent mirrors this width to size the renderer's frustum inset. The
  // panel's own width is local state that resets on unmount, so it has to
  // announce itself on mount or the mirror goes stale across a remount.
  it("reports its default width on mount", () => {
    const onWidthChange = vi.fn();
    render(
      <PipelineEditor
        collapsed={false}
        onToggleCollapse={() => {}}
        onWidthChange={onWidthChange}
      />,
    );
    expect(onWidthChange).toHaveBeenCalledWith(480);
  });

  it("re-announces its width after an unmount/remount cycle", () => {
    const onWidthChange = vi.fn();
    const { unmount } = render(
      <PipelineEditor
        collapsed={false}
        onToggleCollapse={() => {}}
        onWidthChange={onWidthChange}
      />,
    );
    unmount();
    onWidthChange.mockClear();

    render(
      <PipelineEditor
        collapsed={false}
        onToggleCollapse={() => {}}
        onWidthChange={onWidthChange}
      />,
    );
    expect(onWidthChange).toHaveBeenCalledWith(480);
  });

  it("cycles light → dark → system → light when clicked", () => {
    useThemeStore.setState({ theme: "light", resolvedTheme: "light" });

    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);
    const themeBtn = screen.getByTestId("pipeline-editor-theme");

    fireEvent.click(themeBtn);
    expect(useThemeStore.getState().theme).toBe("dark");

    fireEvent.click(themeBtn);
    expect(useThemeStore.getState().theme).toBe("system");

    fireEvent.click(themeBtn);
    expect(useThemeStore.getState().theme).toBe("light");
  });

  it("renders 'Auto' label when theme is system", () => {
    useThemeStore.setState({ theme: "system", resolvedTheme: "light" });
    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);
    const themeBtn = screen.getByTestId("pipeline-editor-theme");
    expect(themeBtn.textContent).toContain("Auto");
  });
});

describe("PipelineEditor — collapsed state", () => {
  it("renders only the collapsed toggle when collapsed", () => {
    render(<PipelineEditor collapsed={true} onToggleCollapse={() => {}} />);
    expect(screen.queryByTestId("pipeline-editor-theme")).toBeNull();
    expect(screen.getByTestId("panel-pipeline-toggle")).toBeTruthy();
  });
});

describe("PipelineEditor — Share button opens dialog", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let alertSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    shareCurrentPipelineMock.mockReset();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    alertSpy.mockRestore();
  });

  it("opens the share dialog with the URL when shareCurrentPipeline resolves", async () => {
    shareCurrentPipelineMock.mockResolvedValue({
      url: "http://example.test/#pipeline=abc",
      tooLong: false,
    });

    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);
    fireEvent.click(screen.getByTestId("pipeline-editor-share"));

    const input = await screen.findByTestId("share-dialog-url-input");
    expect((input as HTMLInputElement).value).toBe("http://example.test/#pipeline=abc");
    expect(screen.queryByTestId("share-dialog-warning")).toBeNull();
  });

  it("renders the tooLong warning and disables Copy when the pipeline is too long", async () => {
    shareCurrentPipelineMock.mockResolvedValue({
      url: "http://example.test/#pipeline=zzz",
      tooLong: true,
    });

    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);
    fireEvent.click(screen.getByTestId("pipeline-editor-share"));

    expect(await screen.findByTestId("share-dialog-warning")).toBeTruthy();
    const copyBtn = screen.getByTestId("share-dialog-copy") as HTMLButtonElement;
    expect(copyBtn.disabled).toBe(true);
  });

  it("alerts and skips the dialog when shareCurrentPipeline rejects", async () => {
    shareCurrentPipelineMock.mockRejectedValue(new Error("boom"));

    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);
    fireEvent.click(screen.getByTestId("pipeline-editor-share"));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalled();
    });
    expect(alertSpy.mock.calls[0][0]).toContain("Share failed");
    expect(screen.queryByTestId("share-dialog")).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});

describe("PipelineEditor — layout", () => {
  const measuredNode = (id: string, y: number) => ({
    id,
    type: "filter",
    position: { x: 0, y },
    measured: { width: 340, height: 120 },
    data: { params: defaultParams("filter"), enabled: true },
  });

  beforeEach(() => {
    fitViewMock.mockClear();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-lays out a pending graph once every node is measured, then fits", () => {
    usePipelineStore.setState({
      nodes: [measuredNode("a", 0), measuredNode("b", 0)],
      edges: [{ id: "e", source: "a", target: "b", sourceHandle: "out", targetHandle: "in" }],
      layoutPending: true,
    });
    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);
    const state = usePipelineStore.getState();
    expect(state.layoutPending).toBe(false);
    const a = state.nodes.find((n) => n.id === "a")!;
    const b = state.nodes.find((n) => n.id === "b")!;
    expect(b.position.y).toBeGreaterThan(a.position.y + 120);
    expect(fitViewMock).toHaveBeenCalled();
  });

  it("waits while some node is still unmeasured", () => {
    usePipelineStore.setState({
      nodes: [measuredNode("a", 0), { ...measuredNode("b", 0), measured: undefined }],
      edges: [],
      layoutPending: true,
    });
    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);
    expect(usePipelineStore.getState().layoutPending).toBe(true);
    expect(usePipelineStore.getState().nodes[1].position).toEqual({ x: 0, y: 0 });
  });
});

describe("PipelineEditor — properties pane", () => {
  const node = (id: string, type: "filter" | "wrap" | "viewport", selected = false) => ({
    id,
    type,
    position: { x: 0, y: 0 },
    selected,
    data: { params: defaultParams(type), enabled: true },
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks for a selection when no node is selected", () => {
    usePipelineStore.setState({ nodes: [node("f1", "filter")], edges: [], layoutPending: false });
    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);
    expect(screen.getByTestId("pipeline-properties-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("pipeline-properties-header")).toBeNull();
  });

  it("shows the selected node's header and only its form", () => {
    usePipelineStore.setState({
      nodes: [node("f1", "filter"), node("w1", "wrap", true)],
      edges: [],
      layoutPending: false,
    });
    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);
    const header = screen.getByTestId("pipeline-properties-header");
    expect(header).toHaveTextContent("Wrap / Unwrap");
    expect(header).toHaveTextContent("none");
    // Every form stays mounted; only the selected one is displayed.
    const forms = screen.getAllByTestId("pipeline-properties-form");
    expect(forms).toHaveLength(2);
    const shown = forms.filter((f) => f.parentElement!.style.display !== "none");
    expect(shown.map((f) => f.getAttribute("data-node-id"))).toEqual(["w1"]);
  });

  it("toggles and removes the selected node from the header", () => {
    usePipelineStore.setState({
      nodes: [node("w1", "wrap", true)],
      edges: [],
      layoutPending: false,
    });
    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);
    const toggle = screen.getByRole("switch");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    expect(usePipelineStore.getState().nodes[0].data.enabled).toBe(false);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByTitle("Remove node"));
    expect(usePipelineStore.getState().nodes).toHaveLength(0);
  });

  it("offers no remove button for the viewport", () => {
    usePipelineStore.setState({
      nodes: [node("v1", "viewport", true)],
      edges: [],
      layoutPending: false,
    });
    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);
    expect(screen.getByTestId("pipeline-properties-header")).toHaveTextContent("Viewport");
    expect(screen.queryByTitle("Remove node")).toBeNull();
  });

  it("selects a node added from the Add Node menu", () => {
    usePipelineStore.setState({
      nodes: [node("w1", "wrap", true)],
      edges: [],
      layoutPending: false,
    });
    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);
    fireEvent.click(screen.getByTitle("Add Node"));
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    const nodes = usePipelineStore.getState().nodes;
    const added = nodes.find((n) => n.type === "filter")!;
    expect(added.selected).toBe(true);
    expect(nodes.find((n) => n.id === "w1")!.selected).toBe(false);
    expect(screen.getByTestId("pipeline-properties-header")).toHaveTextContent("Filter");
  });

  it("resizes the pane by dragging the separator", () => {
    usePipelineStore.setState({
      nodes: [node("w1", "wrap", true)],
      edges: [],
      layoutPending: false,
    });
    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);
    const separator = screen.getByRole("separator");
    const pane = screen.getByTestId("pipeline-properties");
    expect(pane.style.flex).toContain("34%");
    vi.spyOn(separator.parentElement!, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 1000,
      height: 1000,
      left: 0,
      right: 400,
      width: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.mouseDown(separator);
    fireEvent.mouseMove(document, { clientY: 500 });
    expect(pane.style.flex).toContain("50%");
    // Clamped to 70% however far it is dragged.
    fireEvent.mouseMove(document, { clientY: 0 });
    expect(pane.style.flex).toContain("70%");
    fireEvent.mouseUp(document);
    fireEvent.mouseMove(document, { clientY: 900 });
    expect(pane.style.flex).toContain("70%");
  });

  it("ignores a drag when the column has no height", () => {
    usePipelineStore.setState({
      nodes: [node("w1", "wrap", true)],
      edges: [],
      layoutPending: false,
    });
    render(<PipelineEditor collapsed={false} onToggleCollapse={() => {}} />);
    fireEvent.mouseDown(screen.getByRole("separator"));
    fireEvent.mouseMove(document, { clientY: 300 });
    expect(screen.getByTestId("pipeline-properties").style.flex).toContain("34%");
  });
});
