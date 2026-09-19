import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

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
      fitView: () => {},
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
