/**
 * megane Builder embedded in a host (VS Code, JupyterLab, the Jupyter widget):
 * Save goes to the host instead of a download, the Tools menu can be left out,
 * the keyboard shortcuts stay inside the Builder, and `mountBuilder` /
 * `openStructureFile` are how hosts put it on a page and hand it a file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";

const { rendererStub, exportSnapshot, snapshotToText, parseStructureFile } = vi.hoisted(() => ({
  rendererStub: {
    setViewInsets: vi.fn(),
    resetCamera: vi.fn(),
    resetView: vi.fn(),
    alignCameraToAxis: vi.fn(),
    setBackgroundColor: vi.fn(),
  },
  exportSnapshot: vi.fn(async () => "x.xyz"),
  snapshotToText: vi.fn(async (_s: unknown, format: string) => `TEXT-${format}`),
  parseStructureFile: vi.fn(),
}));

vi.mock("@/components/Viewport", async () => {
  const React = await import("react");
  return {
    Viewport: (props: Record<string, unknown>) => {
      React.useEffect(() => {
        (props.onRendererReady as ((r: unknown) => void) | undefined)?.(rendererStub);
      }, []);
      return React.createElement("div", { "data-testid": "viewport-stub" });
    },
  };
});
vi.mock("@/components/Tooltip", () => ({ Tooltip: () => null }));
vi.mock("@/pipeline/apply", () => ({ applyViewportState: vi.fn() }));
vi.mock("@/export/structureExport", async () => {
  const actual = await vi.importActual<typeof import("@/export/structureExport")>(
    "@/export/structureExport",
  );
  return { ...actual, exportSnapshot, snapshotToText };
});
vi.mock("@/parsers/structure", () => ({ parseStructureFile }));

import { BuilderApp } from "@/builder/BuilderApp";
import { useBuilderStore } from "@/builder/store";
import { hostHasTools, WEB_HOST, type BuilderHost } from "@/builder/host";
import { inScope } from "@/builder/shortcuts";
import { mountBuilder } from "@/builder/mount";
import { openStructureFile } from "@/builder/open";
import KetcherUnavailable, { KETCHER_UNAVAILABLE } from "@/builder/library/KetcherUnavailable";
import type { Snapshot } from "@/types";

function water(): Snapshot {
  return {
    nAtoms: 3,
    nBonds: 2,
    nFileBonds: 2,
    positions: new Float32Array([0, 0, 0, 0.757, 0.586, 0, -0.757, 0.586, 0]),
    elements: new Uint8Array([8, 1, 1]),
    bonds: new Uint32Array([0, 1, 0, 2]),
    bondOrders: null,
    box: null,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

const parsedWater = () => ({
  snapshot: water(),
  labels: ["HOH", "HOH", "HOH"],
  frames: [],
  meta: null,
  vectorChannels: [],
  scalarChannels: [],
  warnings: [],
});

const save = (format: string) => {
  fireEvent.click(screen.getByTestId("builder-file"));
  fireEvent.click(screen.getByTestId(`builder-save-${format}`));
};

beforeEach(() => {
  localStorage.clear();
  useBuilderStore.getState().closeDocument();
  useBuilderStore.setState({ tool: "select", handlers: null });
  exportSnapshot.mockClear();
  snapshotToText.mockClear();
  parseStructureFile.mockReset();
});

afterEach(() => cleanup());

describe("host", () => {
  it("the web host has every part on", () => {
    expect(hostHasTools(WEB_HOST)).toBe(true);
    expect(hostHasTools({ tools: false })).toBe(false);
  });

  it("inScope: everything without a scope, only inside it with one", () => {
    const outer = document.createElement("div");
    const inner = document.createElement("span");
    outer.appendChild(inner);
    const elsewhere = document.createElement("p");
    expect(inScope(elsewhere, undefined)).toBe(true);
    expect(inScope(inner, outer)).toBe(true);
    expect(inScope(elsewhere, outer)).toBe(false);
    expect(inScope(inner, null)).toBe(false);
    expect(inScope(null, outer)).toBe(false);
  });
});

describe("BuilderApp in a host", () => {
  it("Save hands the file to the host and shows what it said", async () => {
    const hostSave = vi.fn(async () => "Saved /work/water.pdb");
    useBuilderStore.getState().openStructure(water(), ["HOH", "HOH", "HOH"], "water.xyz");
    render(<BuilderApp host={{ save: hostSave }} />);
    save("pdb");
    await waitFor(() => expect(hostSave).toHaveBeenCalledTimes(1));
    expect(hostSave).toHaveBeenCalledWith({ name: "water.pdb", text: "TEXT-pdb", format: "pdb" });
    expect(exportSnapshot).not.toHaveBeenCalled();
    expect(snapshotToText.mock.calls[0][2]).toEqual(["HOH", "HOH", "HOH"]);
    await waitFor(() =>
      expect(screen.getByTestId("builder-notice").textContent).toContain("Saved /work/water.pdb"),
    );
  });

  it("a cancelled save says nothing; a failed one says why", async () => {
    const hostSave = vi.fn<NonNullable<BuilderHost["save"]>>(async () => null);
    useBuilderStore.getState().openStructure(water(), null, "water.xyz");
    render(<BuilderApp host={{ save: hostSave }} />);
    save("xyz");
    await waitFor(() => expect(hostSave).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("builder-notice")).toBeNull();

    hostSave.mockRejectedValueOnce(new Error("disk full"));
    save("mol");
    await waitFor(() =>
      expect(screen.getByTestId("builder-notice").textContent).toContain(
        "Could not save: disk full",
      ),
    );
    expect(screen.getByTestId("builder-notice").getAttribute("data-level")).toBe("error");
  });

  it("without a host save, Save downloads as before", async () => {
    useBuilderStore.getState().openStructure(water(), null, "water.xyz");
    render(<BuilderApp />);
    save("xyz");
    await waitFor(() => expect(exportSnapshot).toHaveBeenCalledTimes(1));
  });

  it("tools: false leaves the Tools menu out", () => {
    const { unmount } = render(<BuilderApp />);
    expect(screen.queryByTestId("builder-tools")).not.toBeNull();
    unmount();
    render(<BuilderApp host={{ tools: false }} />);
    expect(screen.queryByTestId("builder-tools")).toBeNull();
    expect(screen.getByTestId("builder-structure")).toBeTruthy();
  });

  it("scoped shortcuts act only while the focus is inside the Builder", () => {
    useBuilderStore.getState().openStructure(water(), null, "water.xyz");
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    render(<BuilderApp host={{ scopeShortcuts: true }} />);
    const root = screen.getByTestId("megane-builder");
    expect(root.getAttribute("tabindex")).toBe("-1");

    fireEvent.keyDown(outside, { key: "d" });
    expect(useBuilderStore.getState().tool).toBe("select");

    // A press anywhere in the Builder gives it the focus.
    fireEvent.pointerDown(screen.getByTestId("viewport-stub"));
    expect(document.activeElement).toBe(root);
    fireEvent.keyDown(root, { key: "d" });
    expect(useBuilderStore.getState().tool).toBe("delete");
    outside.remove();
  });

  it("unscoped shortcuts work from anywhere, and the root is not focusable", () => {
    useBuilderStore.getState().openStructure(water(), null, "water.xyz");
    render(<BuilderApp />);
    expect(screen.getByTestId("megane-builder").getAttribute("tabindex")).toBeNull();
    fireEvent.keyDown(window, { key: "b" });
    expect(useBuilderStore.getState().tool).toBe("bond");
  });
});

describe("openStructureFile", () => {
  it("opens a parsed file as the document", async () => {
    parseStructureFile.mockResolvedValue(parsedWater());
    expect(await openStructureFile(new File(["x"], "water.pdb"))).toBe(true);
    const s = useBuilderStore.getState();
    expect(s.fileName).toBe("water.pdb");
    expect(s.sourceLabels).toEqual(["HOH", "HOH", "HOH"]);
  });

  it("reports a file that does not parse and keeps the document", async () => {
    useBuilderStore.getState().openStructure(water(), null, "kept.xyz");
    parseStructureFile.mockRejectedValue(new Error("bad header"));
    expect(await openStructureFile(new File(["x"], "broken.pdb"))).toBe(false);
    const s = useBuilderStore.getState();
    expect(s.fileName).toBe("kept.xyz");
    expect(s.notice).toEqual({ level: "error", text: "Could not open broken.pdb: bad header" });
  });
});

describe("mountBuilder", () => {
  it("renders the app into an element, opens files, and unmounts once", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    let mounted!: ReturnType<typeof mountBuilder>;
    act(() => {
      mounted = mountBuilder(el, { tools: false });
    });
    expect(el.querySelector('[data-testid="megane-builder"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="builder-tools"]')).toBeNull();

    parseStructureFile.mockResolvedValue(parsedWater());
    await act(async () => {
      expect(await mounted.open(new File(["x"], "water.pdb"))).toBe(true);
    });
    expect(
      el.querySelector('[data-testid="megane-builder"]')!.getAttribute("data-atom-count"),
    ).toBe("3");

    act(() => mounted.dispose());
    expect(el.querySelector('[data-testid="megane-builder"]')).toBeNull();
    act(() => mounted.dispose());
    el.remove();
  });
});

describe("store.closeDocument", () => {
  it("returns to the empty start screen", () => {
    const s = useBuilderStore.getState();
    s.openStructure(water(), null, "water.xyz");
    s.setSelected([0]);
    useBuilderStore.getState().closeDocument();
    const after = useBuilderStore.getState();
    expect(after.source).toBeNull();
    expect(after.result).toBeNull();
    expect(after.fileName).toBeNull();
    expect(after.edits).toEqual([]);
    expect(after.selected).toEqual([]);
  });
});

describe("KetcherUnavailable", () => {
  it("throws, which the sketch dialog turns into its paste fallback", () => {
    expect(() => KetcherUnavailable()).toThrow(KETCHER_UNAVAILABLE);
  });
});
