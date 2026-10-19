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
  await screen.findByTestId("builder-flow-panel");
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
    expect(app().getAttribute("data-mode")).toBe("manual");
    expect(useBuilderStore.getState().source!.nAtoms).toBe(3);
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
    const saved = JSON.stringify(useFlowStore.getState().serialize());
    // jsdom's File has no text(); the browser's does.
    const file = (name: string, text: string) => ({ name, text: async () => text });

    fireEvent.click(screen.getByTestId("builder-flow-file"));
    fireEvent.click(screen.getByTestId("builder-flow-clear"));
    expect(useFlowStore.getState().nodes).toEqual([]);

    const input = screen.getByTestId("builder-flow-open-input");
    await act(async () => {
      fireEvent.change(input, { target: { files: [file("mine.json", saved)] } });
    });
    await waitFor(() => expect(useFlowStore.getState().nodes).toHaveLength(1));
    expect(useBuilderStore.getState().notice?.text).toContain("mine.json");

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
    await screen.findByTestId("builder-flow-panel");
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
    const zone = screen.getByTestId("builder-dropzone");
    fireEvent.dragOver(zone);
    expect(screen.queryByTestId("builder-drop-overlay")).toBeNull();
    fireEvent.drop(zone, { dataTransfer: { files: [new File(["x"], "x.xyz")] } });
    expect(useBuilderStore.getState().source).toBeNull();
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
