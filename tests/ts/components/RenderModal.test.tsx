import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import * as React from "react";

// Mock exporters before importing the component
vi.mock("three/examples/jsm/exporters/GLTFExporter.js", () => ({
  GLTFExporter: class {
    parseAsync() {
      return Promise.resolve(new ArrayBuffer(8));
    }
  },
}));

vi.mock("three/examples/jsm/exporters/OBJExporter.js", () => ({
  OBJExporter: class {
    parse() {
      return "# OBJ\n";
    }
  },
}));

// Mock gif.js dynamic import used by captureGif
vi.mock("gif.js", () => ({ default: class {} }));

// Real implementations except captureSnapshot / downloadBlob, so a test can
// hold an export open (`exporting === true`) and assert what Escape does then.
vi.mock("@/renderer/RenderCapture", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/renderer/RenderCapture")>();
  return { ...actual, captureSnapshot: vi.fn(actual.captureSnapshot), downloadBlob: vi.fn() };
});

import { RenderModal } from "@/components/RenderModal";
import { captureSnapshot } from "@/renderer/RenderCapture";
import type { MoleculeRenderer } from "@/renderer/MoleculeRenderer";

function makeCanvas(w = 800, h = 600): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  // clientWidth/clientHeight are read-only in jsdom; use defineProperty to override.
  Object.defineProperty(canvas, "clientWidth", { value: w, configurable: true });
  Object.defineProperty(canvas, "clientHeight", { value: h, configurable: true });
  return canvas;
}

function makeRendererRef(
  overrides?: Partial<MoleculeRenderer>,
): React.RefObject<MoleculeRenderer | null> {
  const renderer: Partial<MoleculeRenderer> = {
    getScene: vi.fn().mockReturnValue({ background: null }),
    getRenderer: vi.fn().mockReturnValue({
      getClearAlpha: () => 1,
      getClearColor: (target: { set: (hex: number) => unknown }) => target.set(0xffffff),
      setClearColor: vi.fn(),
    }),
    getCanvas: vi.fn().mockReturnValue(makeCanvas()),
    getLabelOverlay: vi.fn().mockReturnValue(null),
    resizeForCapture: vi.fn().mockReturnValue(() => undefined),
    renderSingleFrame: vi.fn(),
    ...overrides,
  };
  return { current: renderer as MoleculeRenderer };
}

afterEach(() => {
  cleanup();
});

describe("RenderModal", () => {
  it("renders nothing when open=false", () => {
    render(
      <RenderModal
        open={false}
        onClose={() => {}}
        rendererRef={makeRendererRef()}
        totalFrames={1}
        currentFrame={0}
        onSeek={() => {}}
      />,
    );
    expect(screen.queryByTestId("render-modal")).toBeNull();
  });

  it("renders the modal when open=true", () => {
    render(
      <RenderModal
        open
        onClose={() => {}}
        rendererRef={makeRendererRef()}
        totalFrames={1}
        currentFrame={0}
        onSeek={() => {}}
      />,
    );
    expect(screen.getByTestId("render-modal")).toBeTruthy();
  });

  // The modal has to claim Escape, otherwise it falls through to
  // MeganeViewer's window listener and wipes the selection behind the modal.
  it("closes on Escape and marks the event handled", () => {
    const onClose = vi.fn();
    render(
      <RenderModal
        open
        onClose={onClose}
        rendererRef={makeRendererRef()}
        totalFrames={1}
        currentFrame={0}
        onSeek={() => {}}
      />,
    );

    const ev = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    window.dispatchEvent(ev);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  // Mid-export Escape must still be swallowed — otherwise it falls through to
  // MeganeViewer and clears the selection behind a modal that stays open.
  it("swallows Escape without closing while an export is running", async () => {
    const onClose = vi.fn();
    // Never resolves: the modal stays in its exporting state.
    vi.mocked(captureSnapshot).mockReturnValue(new Promise(() => {}) as never);

    render(
      <RenderModal
        open
        onClose={onClose}
        rendererRef={makeRendererRef()}
        totalFrames={1}
        currentFrame={0}
        onSeek={() => {}}
      />,
    );

    fireEvent.click(screen.getByTestId("render-modal-export"));
    await waitFor(() =>
      expect((screen.getByTestId("render-modal-export") as HTMLButtonElement).disabled).toBe(true),
    );

    const ev = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    window.dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores keys other than Escape", () => {
    const onClose = vi.fn();
    render(
      <RenderModal
        open
        onClose={onClose}
        rendererRef={makeRendererRef()}
        totalFrames={1}
        currentFrame={0}
        onSeek={() => {}}
      />,
    );

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not listen for Escape while closed", () => {
    const onClose = vi.fn();
    render(
      <RenderModal
        open={false}
        onClose={onClose}
        rendererRef={makeRendererRef()}
        totalFrames={1}
        currentFrame={0}
        onSeek={() => {}}
      />,
    );

    const ev = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    window.dispatchEvent(ev);
    expect(onClose).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it("shows PNG, EPS and SVG format buttons in snapshot mode", () => {
    render(
      <RenderModal
        open
        onClose={() => {}}
        rendererRef={makeRendererRef()}
        totalFrames={1}
        currentFrame={0}
        onSeek={() => {}}
      />,
    );
    expect(screen.getByText("PNG")).toBeTruthy();
    expect(screen.getByText("EPS")).toBeTruthy();
    expect(screen.getByText("SVG")).toBeTruthy();
  });

  it("shows glTF and OBJ format buttons in snapshot mode", () => {
    render(
      <RenderModal
        open
        onClose={() => {}}
        rendererRef={makeRendererRef()}
        totalFrames={1}
        currentFrame={0}
        onSeek={() => {}}
      />,
    );
    expect(screen.getByText("glTF")).toBeTruthy();
    expect(screen.getByText("OBJ")).toBeTruthy();
  });

  it("hides resolution controls when glTF format is selected", () => {
    render(
      <RenderModal
        open
        onClose={() => {}}
        rendererRef={makeRendererRef()}
        totalFrames={1}
        currentFrame={0}
        onSeek={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("glTF"));
    expect(screen.queryByText("Resolution")).toBeNull();
  });

  it("hides resolution controls when OBJ format is selected", () => {
    render(
      <RenderModal
        open
        onClose={() => {}}
        rendererRef={makeRendererRef()}
        totalFrames={1}
        currentFrame={0}
        onSeek={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("OBJ"));
    expect(screen.queryByText("Resolution")).toBeNull();
  });

  it("shows resolution controls for PNG format (default)", () => {
    render(
      <RenderModal
        open
        onClose={() => {}}
        rendererRef={makeRendererRef()}
        totalFrames={1}
        currentFrame={0}
        onSeek={() => {}}
      />,
    );
    expect(screen.getByText("Resolution")).toBeTruthy();
  });

  it("shows 'Export glTF (.glb)' on the button when glTF is selected", () => {
    render(
      <RenderModal
        open
        onClose={() => {}}
        rendererRef={makeRendererRef()}
        totalFrames={1}
        currentFrame={0}
        onSeek={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("glTF"));
    expect(screen.getByText("Export glTF (.glb)")).toBeTruthy();
  });

  it("shows 'Export OBJ' on the button when OBJ is selected", () => {
    render(
      <RenderModal
        open
        onClose={() => {}}
        rendererRef={makeRendererRef()}
        totalFrames={1}
        currentFrame={0}
        onSeek={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("OBJ"));
    expect(screen.getByText("Export OBJ")).toBeTruthy();
  });

  it("shows resolution controls for SVG format", () => {
    render(
      <RenderModal
        open
        onClose={() => {}}
        rendererRef={makeRendererRef()}
        totalFrames={1}
        currentFrame={0}
        onSeek={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("SVG"));
    expect(screen.getByText("Resolution")).toBeTruthy();
  });

  it("shows 'Export SVG' on the button when SVG is selected", () => {
    render(
      <RenderModal
        open
        onClose={() => {}}
        rendererRef={makeRendererRef()}
        totalFrames={1}
        currentFrame={0}
        onSeek={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("SVG"));
    expect(screen.getByText("Export SVG")).toBeTruthy();
  });

  it("calls onClose when the backdrop is clicked", () => {
    const onClose = vi.fn();
    render(
      <RenderModal
        open
        onClose={onClose}
        rendererRef={makeRendererRef()}
        totalFrames={1}
        currentFrame={0}
        onSeek={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("render-modal-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when the modal panel itself is clicked", () => {
    const onClose = vi.fn();
    render(
      <RenderModal
        open
        onClose={onClose}
        rendererRef={makeRendererRef()}
        totalFrames={1}
        currentFrame={0}
        onSeek={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("render-modal"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("restores PNG resolution controls after switching from glTF back to PNG", () => {
    render(
      <RenderModal
        open
        onClose={() => {}}
        rendererRef={makeRendererRef()}
        totalFrames={1}
        currentFrame={0}
        onSeek={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("glTF"));
    expect(screen.queryByText("Resolution")).toBeNull();
    fireEvent.click(screen.getByText("PNG"));
    expect(screen.getByText("Resolution")).toBeTruthy();
  });
});

// The GIF export E2E (tests/e2e/lib/render-modal.ts, guarding issues #497 and
// #599) drives the modal entirely through these testids. Renaming one would
// otherwise surface as a Playwright timeout in the VSCode project — which needs
// code-server and only runs locally — so pin the contract here instead.
describe("RenderModal: animation export testids", () => {
  function renderTrajectoryModal() {
    return render(
      <RenderModal
        open
        onClose={() => {}}
        rendererRef={makeRendererRef()}
        totalFrames={5}
        currentFrame={0}
        onSeek={() => {}}
      />,
    );
  }

  it("marks the active tab and format so E2E can await the switch", () => {
    renderTrajectoryModal();

    const snapshotTab = screen.getByTestId("render-modal-tab-snapshot");
    const animationTab = screen.getByTestId("render-modal-tab-animation");
    expect(snapshotTab.getAttribute("data-active")).toBe("true");
    expect(animationTab.getAttribute("data-active")).toBe("false");

    fireEvent.click(animationTab);

    expect(screen.getByTestId("render-modal-tab-animation").getAttribute("data-active")).toBe(
      "true",
    );
    // GIF is the default animation format, and the E2E relies on that default.
    expect(screen.getByTestId("render-modal-format-gif").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("render-modal-format-mp4").getAttribute("data-active")).toBe("false");
  });

  it("exposes the resolution and frame-range inputs the GIF export drives", () => {
    renderTrajectoryModal();
    fireEvent.click(screen.getByTestId("render-modal-tab-animation"));

    const width = screen.getByTestId("render-modal-width") as HTMLInputElement;
    fireEvent.change(width, { target: { value: "160" } });
    expect((screen.getByTestId("render-modal-width") as HTMLInputElement).value).toBe("160");
    // Aspect stays locked by default, so height follows the 800×600 canvas.
    expect((screen.getByTestId("render-modal-height") as HTMLInputElement).value).toBe("120");

    const endFrame = screen.getByTestId("render-modal-end-frame") as HTMLInputElement;
    expect(endFrame.value).toBe("4");
    fireEvent.change(endFrame, { target: { value: "1" } });
    expect((screen.getByTestId("render-modal-end-frame") as HTMLInputElement).value).toBe("1");
    expect((screen.getByTestId("render-modal-start-frame") as HTMLInputElement).value).toBe("0");
  });

  it("keeps the snapshot format testids addressable", () => {
    renderTrajectoryModal();
    for (const fmt of ["png", "eps", "svg", "gltf", "obj"]) {
      expect(screen.getByTestId(`render-modal-format-${fmt}`)).toBeTruthy();
    }
  });
});
