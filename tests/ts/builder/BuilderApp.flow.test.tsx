/**
 * megane Builder's Flow mode inside the app: the mode switch swaps the left
 * rails and the right panels, the (mocked) view shows the picked block's
 * result and stops editing, and the rail's Add / Flow / Run actions reach the
 * Flow store.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const { viewportProps, embedSketch, parseStructureText, downloadBlob } = vi.hoisted(() => ({
  viewportProps: { current: null as Record<string, unknown> | null },
  embedSketch: vi.fn(async () => ({ molblock: "MOL" })),
  parseStructureText: vi.fn(),
  downloadBlob: vi.fn(),
}));

vi.mock("@/components/Viewport", async () => {
  const React = await import("react");
  return {
    Viewport: (props: Record<string, unknown>) => {
      viewportProps.current = props;
      React.useEffect(() => {
        (props.onRendererReady as ((r: unknown) => void) | undefined)?.({
          setViewInsets: vi.fn(),
          resetCamera: vi.fn(),
          resetView: vi.fn(),
          alignCameraToAxis: vi.fn(),
          setBackgroundColor: vi.fn(),
        });
      }, []);
      return React.createElement("div", { "data-testid": "viewport-stub" });
    },
  };
});
vi.mock("@/components/Tooltip", () => ({ Tooltip: () => null }));
vi.mock("@/pipeline/apply", () => ({ applyViewportState: vi.fn() }));
vi.mock("@/builder/library/embed", () => ({
  embedSketch,
  canEmbed: () => true,
  setRDKitWasmSource: vi.fn(),
}));
vi.mock("@/parsers/structure", () => ({ parseStructureText, parseStructureFile: vi.fn() }));
vi.mock("@/renderer/RenderCapture", () => ({ downloadBlob }));
vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  const React = await import("react");
  return {
    ...actual,
    ReactFlow: ({ children }: { children?: ReactNode }) =>
      React.createElement("div", { "data-testid": "react-flow" }, children),
    ReactFlowProvider: ({ children }: { children?: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    useReactFlow: () => ({
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
      fitView: () => {},
    }),
    useUpdateNodeInternals: () => () => {},
  };
});

import { BuilderApp } from "@/builder/BuilderApp";
import { useBuilderStore } from "@/builder/store";
import { useFlowStore } from "@/builder/flow/store";
import { useToolsStore } from "@/builder/tools/store";
import { parseTools } from "@/builder/tools/contract";
import { TOOLS } from "./tools/fixtures";
import { water } from "./flow/helpers";

const app = () => screen.getByTestId("megane-builder");
const addBlock = (id: string) => {
  fireEvent.click(screen.getByTestId("builder-flow-add"));
  fireEvent.click(screen.getByTestId(id));
};

beforeEach(() => {
  localStorage.clear();
  downloadBlob.mockClear();
  useFlowStore.getState().clear();
  useFlowStore.setState({ mode: "manual" });
  useBuilderStore.setState({
    source: null,
    sourceLabels: null,
    fileName: null,
    edits: [],
    redoStack: [],
    result: null,
    preview: null,
    showOriginal: false,
    notice: null,
    tool: "select",
    selected: [],
  });
  useToolsStore.setState({ connection: null, status: "idle" });
  parseStructureText.mockResolvedValue({ snapshot: water() });
});

async function enterFlow() {
  render(<BuilderApp />);
  fireEvent.click(screen.getByTestId("builder-mode-flow"));
  // The panel is lazy: its first import can take a while on a loaded machine.
  await screen.findByTestId("builder-flow-panel", {}, { timeout: 5000 });
}

describe("Builder Flow mode", () => {
  it("swaps the rails and panels, and stops editing in the view", async () => {
    await enterFlow();
    expect(app().getAttribute("data-mode")).toBe("flow");
    expect(screen.getByTestId("builder-flow-rail")).toBeTruthy();
    expect(screen.queryByTestId("builder-tool-rail")).toBeNull();
    expect(screen.queryByTestId("builder-operations-rail")).toBeNull();
    expect(screen.queryByTestId("builder-sidebar")).toBeNull();
    expect(screen.queryByTestId("builder-welcome")).toBeNull();
    expect(screen.getByTestId("builder-status-flow").textContent).toContain("Add blocks");
    expect(viewportProps.current!.buildActive).toBe(false);
    expect(viewportProps.current!.buildHandlers).toBeNull();

    fireEvent.click(screen.getByTestId("builder-mode-manual"));
    expect(screen.getByTestId("builder-tool-rail")).toBeTruthy();
    expect(viewportProps.current!.buildActive).toBe(true);
  });

  it("builds a molecule from SMILES and shows it, then opens it in Manual", async () => {
    await enterFlow();
    addBlock("builder-flow-add-smiles");
    fireEvent.change(screen.getByTestId("builder-flow-molecule-smiles"), {
      target: { value: "O" },
    });
    expect(viewportProps.current!.snapshot).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId("builder-flow-run"));
    });
    expect(embedSketch).toHaveBeenCalledWith("O");
    await waitFor(() => expect(viewportProps.current!.snapshot).not.toBeNull());
    expect(screen.getByTestId("builder-status-flow").textContent).toContain("showing O");
    expect(screen.getByTestId("builder-file-name").textContent).toContain("O");

    fireEvent.click(screen.getByTestId("builder-flow-open-manual"));
    await waitFor(() => expect(app().getAttribute("data-mode")).toBe("manual"));
    expect(useBuilderStore.getState().source!.nAtoms).toBe(3);
  });

  it("shares one structure with Manual mode both ways", async () => {
    const shownPositions = () =>
      (viewportProps.current!.snapshot as { positions: Float32Array } | null)?.positions;
    useBuilderStore.getState().openStructure(water(), null, "slab");
    await enterFlow();
    // The structure open in Manual mode is what Flow mode shows with no block picked.
    expect(shownPositions()).toEqual(useBuilderStore.getState().source!.positions);
    expect(screen.getByTestId("builder-status-flow").textContent).toContain("showing slab");

    // A Manual structure block reads it, and goes stale when it changes.
    addBlock("builder-flow-add-document");
    const doc = useFlowStore.getState().nodes[0].id;
    await act(async () => {
      fireEvent.click(screen.getByTestId("builder-flow-run"));
    });
    await waitFor(() => expect(useFlowStore.getState().runs[doc]?.status).toBe("done"));
    act(() => useBuilderStore.getState().pushOp({ op: "delete_atoms", atoms: [0] }));
    expect(useFlowStore.getState().runs[doc].status).toBe("stale");

    // Run makes the flow's result the structure Manual mode edits, asking
    // first because the document has an unsaved edit.
    act(() => useFlowStore.getState().clear());
    addBlock("builder-flow-add-smiles");
    fireEvent.change(screen.getByTestId("builder-flow-molecule-smiles"), {
      target: { value: "O" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("builder-flow-run"));
    });
    await screen.findByTestId("builder-confirm");
    await act(async () => {
      fireEvent.click(screen.getByTestId("builder-confirm-ok"));
    });
    await waitFor(() => expect(useBuilderStore.getState().fileName).toBe("O"));
    act(() => useFlowStore.getState().selectNode(null));
    expect(screen.getByTestId("builder-status-flow").textContent).toContain("showing O");
    expect(shownPositions()).toEqual(useBuilderStore.getState().source!.positions);
    fireEvent.click(screen.getByTestId("builder-mode-manual"));
    expect(useBuilderStore.getState().source!.nAtoms).toBe(3);
    expect(shownPositions()).toEqual(useBuilderStore.getState().source!.positions);
  });

  it("adds library, Manual-structure and tool blocks from the Add menu", async () => {
    await enterFlow();
    addBlock("builder-flow-add-library");
    addBlock("builder-flow-add-document");
    act(() =>
      useToolsStore.setState({
        status: "connected",
        connection: {
          serverName: "fake",
          serverVersion: null,
          listing: parseTools(TOOLS),
          call: vi.fn(),
          close: async () => {},
        },
      }),
    );
    addBlock("builder-tools-button-liquid_box");
    expect(useFlowStore.getState().nodes.map((n) => n.type)).toEqual([
      "molecule",
      "document",
      "tool",
    ]);
    expect(screen.getByTestId("builder-flow-properties-header").textContent).toContain(
      "Liquid box",
    );

    addBlock("builder-tools-server");
    expect(screen.queryByTestId("builder-flow-properties")).toBeNull();
    expect(screen.getByTestId("builder-tools-disconnect")).toBeTruthy();
  });

  it("saves, opens and clears a flow", async () => {
    await enterFlow();
    addBlock("builder-flow-add-smiles");
    fireEvent.click(screen.getByTestId("builder-flow-file"));
    fireEvent.click(screen.getByTestId("builder-flow-save"));
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), "builder.megane-flow.json");
    expect(useBuilderStore.getState().notice?.text).toBe("Saved builder.megane-flow.json");
    const saved = JSON.stringify(useFlowStore.getState().serialize());
    // jsdom's File has no text(); the browser's does.
    const file = (name: string, text: string) => ({ name, text: async () => text });

    // Clearing a flow with blocks asks first.
    fireEvent.click(screen.getByTestId("builder-flow-file"));
    fireEvent.click(screen.getByTestId("builder-flow-clear"));
    await screen.findByTestId("builder-confirm");
    await act(async () => {
      fireEvent.click(screen.getByTestId("builder-confirm-ok"));
    });
    expect(useFlowStore.getState().nodes).toEqual([]);

    const input = screen.getByTestId("builder-flow-open-input");
    await act(async () => {
      fireEvent.change(input, { target: { files: [file("mine.json", saved)] } });
    });
    await waitFor(() => expect(useFlowStore.getState().nodes).toHaveLength(1));
    expect(useBuilderStore.getState().notice?.text).toContain("mine.json");
    // Save suggests the name it was opened under.
    fireEvent.click(screen.getByTestId("builder-flow-file"));
    fireEvent.click(screen.getByTestId("builder-flow-save"));
    expect(downloadBlob).toHaveBeenLastCalledWith(expect.any(Blob), "mine.megane-flow.json");

    // Opening another flow over this one asks first; Cancel keeps it.
    await act(async () => {
      fireEvent.change(input, { target: { files: [file("other.json", saved)] } });
    });
    await screen.findByTestId("builder-confirm");
    await act(async () => {
      fireEvent.click(screen.getByTestId("builder-confirm-cancel"));
    });
    expect(useFlowStore.getState().fileName).toBe("mine.json");

    await act(async () => {
      fireEvent.change(input, { target: { files: [file("bad.json", "nope")] } });
    });
    await waitFor(() => expect(useBuilderStore.getState().notice?.level).toBe("error"));
    expect(useBuilderStore.getState().notice?.text).toContain("bad.json");
  });

  it("saves a flow where the host saves files, and leaves tools out on a host without them", async () => {
    const save = vi
      .fn()
      .mockResolvedValueOnce("Saved builder.megane-flow.json")
      .mockRejectedValueOnce(new Error("disk full"));
    render(<BuilderApp host={{ save, tools: false }} />);
    fireEvent.click(screen.getByTestId("builder-mode-flow"));
    // The panel is lazy: its first import can take a while on a loaded machine.
    await screen.findByTestId("builder-flow-panel", {}, { timeout: 5000 });
    fireEvent.click(screen.getByTestId("builder-flow-add"));
    expect(screen.queryByTestId("builder-tools-server")).toBeNull();
    fireEvent.click(screen.getByTestId("builder-flow-add-document"));

    const saveFlow = async () => {
      fireEvent.click(screen.getByTestId("builder-flow-file"));
      await act(async () => {
        fireEvent.click(screen.getByTestId("builder-flow-save"));
      });
    };
    await saveFlow();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ name: "builder.megane-flow.json", format: "flow" }),
    );
    expect(JSON.parse(save.mock.calls[0][0].text).nodes[0].params.type).toBe("document");
    expect(downloadBlob).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(useBuilderStore.getState().notice?.text).toBe("Saved builder.megane-flow.json"),
    );
    await saveFlow();
    await waitFor(() => expect(useBuilderStore.getState().notice?.text).toContain("disk full"));
  });

  it("leaves the keys, drops and atom menus to Manual mode", async () => {
    await enterFlow();
    fireEvent.keyDown(window, { key: "a" });
    expect(useBuilderStore.getState().tool).toBe("select");
    act(() =>
      (viewportProps.current!.onAtomRightClick as (a: number, x: number, y: number) => void)(
        0,
        1,
        1,
      ),
    );
    expect(screen.queryByTestId("builder-atom-menu")).toBeNull();
    // A drop in Flow mode takes a flow file; a structure file is Manual mode's.
    const zone = screen.getByTestId("builder-dropzone");
    fireEvent.dragOver(zone);
    expect(screen.getByTestId("builder-drop-overlay").textContent).toBe(
      "Drop a flow file (.json) to open it",
    );
    fireEvent.drop(zone, { dataTransfer: { files: [new File(["x"], "x.xyz")] } });
    expect(screen.queryByTestId("builder-drop-overlay")).toBeNull();
    expect(useBuilderStore.getState().source).toBeNull();
    expect(useBuilderStore.getState().notice?.text).toBe(
      "Switch to Manual mode to open a structure file.",
    );
    const flow = JSON.stringify(useFlowStore.getState().serialize());
    // jsdom's File has no text(); the browser's does.
    const graph = { name: "graph.megane-flow.json", text: async () => flow };
    fireEvent.drop(zone, { dataTransfer: { files: [graph] } });
    await waitFor(() =>
      expect(useBuilderStore.getState().notice?.text).toBe(
        "Opened the flow graph.megane-flow.json.",
      ),
    );
  });

  it("keeps the flow and the mode for the next visit", async () => {
    await enterFlow();
    addBlock("builder-flow-add-smiles");
    const kept = JSON.parse(localStorage.getItem("megane.builder.flow.v1")!);
    expect(kept.mode).toBe("flow");
    expect(kept.flow.nodes).toHaveLength(1);
    // Undo from the rail takes the block away again.
    fireEvent.click(screen.getByTestId("builder-flow-undo"));
    expect(useFlowStore.getState().nodes).toEqual([]);
  });

  it("says Stopping… while a stopped run ends", async () => {
    await enterFlow();
    act(() => useFlowStore.setState({ running: new AbortController(), stopping: true }));
    expect(screen.getByTestId("builder-status-flow").textContent).toContain("Stopping…");
    act(() => useFlowStore.setState({ running: null, stopping: false }));
  });

  it("names the running block, and stops", async () => {
    await enterFlow();
    addBlock("builder-flow-add-smiles");
    fireEvent.change(screen.getByTestId("builder-flow-molecule-smiles"), {
      target: { value: "CCO" },
    });
    let release: (v: unknown) => void = () => {};
    embedSketch.mockImplementationOnce(() => new Promise((r) => (release = r)));
    act(() => fireEvent.click(screen.getByTestId("builder-flow-run")));
    await waitFor(() =>
      expect(screen.getByTestId("builder-status-flow").textContent).toContain("Running Molecule"),
    );
    fireEvent.click(screen.getByTestId("builder-flow-stop"));
    await act(async () => release({ molblock: "MOL" }));
    await waitFor(() => expect(useFlowStore.getState().running).toBeNull());
  });
});
