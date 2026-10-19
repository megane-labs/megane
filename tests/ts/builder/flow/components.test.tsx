/**
 * Flow mode's components: the mode switch, the in-panel rail and its menus,
 * the block cards (the viewer's node card), the panel around the (mocked)
 * graph, and the pane where a block is edited.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import type { ReactNode } from "react";

const { reactFlowProps, updateNodeInternals, fitView } = vi.hoisted(() => ({
  reactFlowProps: { current: {} as Record<string, unknown> },
  updateNodeInternals: vi.fn(),
  fitView: vi.fn(),
}));

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  const React = await import("react");
  return {
    ...actual,
    ReactFlow: (props: Record<string, unknown> & { children?: ReactNode }) => {
      reactFlowProps.current = props;
      return React.createElement("div", { "data-testid": "react-flow" }, props.children);
    },
    ReactFlowProvider: ({ children }: { children?: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    useReactFlow: () => ({
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
      fitView,
    }),
    useUpdateNodeInternals: () => updateNodeInternals,
    Handle: (props: { id?: string; type?: string; children?: ReactNode }) =>
      React.createElement(
        "div",
        { "data-testid": `handle-${props.type}-${props.id}` },
        props.children,
      ),
  };
});
vi.mock("@/renderer/RenderCapture", () => ({ downloadBlob: vi.fn() }));

import { BuilderProvider, createBuilderStores, type BuilderStores } from "@/builder/BuilderStores";
import { ModeSwitch } from "@/builder/flow/ModeSwitch";
import { FlowRail, addMenuItems, flowFileMenuItems } from "@/builder/flow/FlowRail";
import { FlowNodeCard } from "@/builder/flow/FlowNodeCard";
import FlowPanel, { type FlowPanelProps } from "@/builder/flow/FlowPanel";
import { FlowProperties, openInManual } from "@/builder/flow/FlowProperties";
import { initialToolParams } from "@/builder/flow/ports";
import { IDLE_RUN, type FlowParams } from "@/builder/flow/types";
import { parseTools } from "@/builder/tools/contract";
import type { ToolConnection } from "@/builder/tools/client";
import { downloadBlob } from "@/renderer/RenderCapture";
import { TOOLS } from "../tools/fixtures";
import { fakeDeps, recorded, tools, water, waterData } from "./helpers";

const smiles = (s = "", name = ""): FlowParams => ({
  type: "molecule",
  source: "smiles",
  smiles: s,
  libraryId: "",
  name,
});

function connection(): ToolConnection {
  return {
    serverName: "fake",
    serverVersion: "1",
    listing: parseTools(TOOLS),
    call: vi.fn(async (name: string) => recorded(name)),
    close: async () => {},
  };
}

const noActions = () => ({
  onOpenFile: vi.fn(),
  onSave: vi.fn(),
  onClear: vi.fn(),
  hasBlocks: true,
  running: false,
  onRun: vi.fn(),
  onStop: vi.fn(),
});

let stores: BuilderStores;
beforeEach(() => {
  stores = createBuilderStores();
  reactFlowProps.current = {};
  updateNodeInternals.mockClear();
  fitView.mockClear();
});

const wrap = (ui: ReactNode) => render(<BuilderProvider stores={stores}>{ui}</BuilderProvider>);

function panelProps(overrides: Partial<FlowPanelProps> = {}): FlowPanelProps {
  return {
    deps: fakeDeps(),
    actions: noActions(),
    hasTools: true,
    serverOpen: false,
    onOpenServer: vi.fn(),
    onCloseServer: vi.fn(),
    collapsed: false,
    onToggleCollapse: vi.fn(),
    ...overrides,
  };
}

describe("ModeSwitch", () => {
  it("marks the mode and switches", () => {
    const onChange = vi.fn();
    render(<ModeSwitch mode="manual" onChange={onChange} />);
    expect(screen.getByTestId("builder-mode-manual").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("builder-mode-flow").getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByTestId("builder-mode-flow"));
    expect(onChange).toHaveBeenCalledWith("flow");
  });
});

describe("FlowRail menus", () => {
  it("lists the structure blocks, and the tools when the host has them", () => {
    const actions = {
      addSmiles: vi.fn(),
      addLibrary: vi.fn(),
      addDocument: vi.fn(),
      addTool: vi.fn(),
      openServer: vi.fn(),
    };
    const plain = addMenuItems(actions);
    expect(plain.filter((i) => "testId" in i).map((i) => (i as { testId: string }).testId)).toEqual(
      ["builder-flow-add-smiles", "builder-flow-add-library", "builder-flow-add-document"],
    );
    const items = addMenuItems({
      ...actions,
      tools: { status: "connected", connection: connection() },
    });
    const liquid = items.find(
      (i) => "testId" in i && i.testId === "builder-tools-button-liquid_box",
    ) as { onSelect: () => void };
    liquid.onSelect();
    expect(actions.addTool).toHaveBeenCalledWith(expect.objectContaining({ name: "liquid_box" }));
    const server = items.find((i) => "testId" in i && i.testId === "builder-tools-server") as {
      onSelect: () => void;
    };
    server.onSelect();
    expect(actions.openServer).toHaveBeenCalled();
  });

  it("disables Save and Clear without blocks", () => {
    const items = flowFileMenuItems({
      open: vi.fn(),
      save: vi.fn(),
      clear: vi.fn(),
      hasBlocks: false,
    });
    const byId = (id: string) =>
      items.find((i) => "testId" in i && i.testId === id) as { disabled?: boolean };
    expect(byId("builder-flow-save").disabled).toBe(true);
    expect(byId("builder-flow-clear").disabled).toBe(true);
    expect(byId("builder-flow-open").disabled).toBeFalsy();
  });

  it("is the viewer's panel rail: add, layout, run, stop, file, theme", () => {
    const props = { ...noActions(), addItems: [], onAutoLayout: vi.fn() };
    const { rerender } = render(<FlowRail {...props} />);
    const rail = screen.getByTestId("builder-flow-rail");
    expect(rail.getAttribute("role")).toBe("toolbar");
    fireEvent.click(screen.getByTestId("builder-flow-layout"));
    expect(props.onAutoLayout).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("builder-flow-run"));
    expect(props.onRun).toHaveBeenCalled();
    const input = screen.getByTestId("builder-flow-open-input") as HTMLInputElement;
    const click = vi.spyOn(input, "click");
    fireEvent.click(screen.getByTestId("builder-flow-file"));
    fireEvent.click(screen.getByTestId("builder-flow-open"));
    expect(click).toHaveBeenCalled();
    const file = new File(["{}"], "f.json");
    fireEvent.change(input, { target: { files: [file] } });
    expect(props.onOpenFile).toHaveBeenCalledWith(file);
    fireEvent.change(input, { target: { files: [] } });
    expect(props.onOpenFile).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("builder-flow-file"));
    fireEvent.click(screen.getByTestId("builder-flow-save"));
    expect(props.onSave).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("builder-flow-file"));
    fireEvent.click(screen.getByTestId("builder-flow-clear"));
    expect(props.onClear).toHaveBeenCalled();

    rerender(<FlowRail {...props} running />);
    fireEvent.click(screen.getByTestId("builder-flow-stop"));
    expect(props.onStop).toHaveBeenCalled();

    rerender(<FlowRail {...props} hasBlocks={false} />);
    expect((screen.getByTestId("builder-flow-run") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("builder-flow-layout") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("FlowNodeCard", () => {
  const card = (id: string, params: FlowParams, selected = false) =>
    wrap(
      <FlowNodeCard
        {...({ id, data: { params }, selected, type: params.type } as unknown as Parameters<
          typeof FlowNodeCard
        >[0])}
      />,
    );

  it("draws a molecule as a data-load node with only an output", () => {
    card("n1", smiles("CCO"), true);
    const el = screen.getByTestId("builder-flow-node-molecule");
    expect(el.getAttribute("data-status")).toBe("idle");
    expect(el.getAttribute("data-selected")).toBe("true");
    expect(el.className).toBe("megane-node-card");
    expect(screen.getByTestId("builder-flow-node-summary").textContent).toBe("SMILES CCO");
    expect(screen.getByTestId("handle-source-out")).toBeTruthy();
    expect(screen.queryByTestId(/handle-target/)).toBeNull();
    // A block that never ran has no status dot.
    expect(screen.queryByTestId("builder-flow-node-status")).toBeNull();
  });

  it("gives a tool its inputs once the server lists it, and shows a failed run", () => {
    stores.flow.setState({
      runs: { t: { ...IDLE_RUN, status: "error", error: "packmol failed" } },
      edges: [{ id: "e", source: "m", target: "t", targetHandle: "components" }],
    });
    card("t", initialToolParams(tools.solvate));
    // Not connected: the wired handle is kept so its wire stays drawn.
    expect(screen.getByTestId("handle-target-components")).toBeTruthy();
    expect(screen.getByTestId("builder-flow-node-status").getAttribute("title")).toBe(
      "packmol failed",
    );
    expect(screen.getByTestId("builder-flow-node-summary").textContent).toBe("Failed");
    act(() => stores.tools.setState({ connection: connection() }));
    expect(screen.getByTestId("handle-target-document")).toBeTruthy();
    expect(screen.getByTestId("handle-target-solvent")).toBeTruthy();
    expect(screen.getByTestId("builder-flow-node-tool").textContent).toContain("Solvate");
  });
});

describe("FlowPanel", () => {
  it("is the viewer's graph panel: rail inside, canvas, split, pane", () => {
    wrap(<FlowPanel {...panelProps()} />);
    expect(screen.getByTestId("builder-flow-panel")).toBeTruthy();
    expect(screen.getByTestId("builder-flow-rail")).toBeTruthy();
    expect(screen.getByTestId("builder-flow-graph").className).toBe("megane-split-editor");
    expect(screen.getByRole("separator")).toBeTruthy();
    expect(screen.getByTestId("builder-flow-empty-hint").textContent).toContain("Add blocks");
  });

  it("adds blocks in the middle of the view, never on top of each other", () => {
    stores.tools.setState({ status: "connected", connection: connection() });
    const onCloseServer = vi.fn();
    wrap(<FlowPanel {...panelProps({ onCloseServer })} />);
    const add = (id: string) => {
      fireEvent.click(screen.getByTestId("builder-flow-add"));
      fireEvent.click(screen.getByTestId(id));
    };
    add("builder-flow-add-smiles");
    add("builder-flow-add-library");
    add("builder-flow-add-document");
    add("builder-tools-button-liquid_box");
    const nodes = stores.flow.getState().nodes;
    expect(nodes.map((n) => n.type)).toEqual(["molecule", "molecule", "document", "tool"]);
    const ys = nodes.map((n) => n.position.y);
    expect(new Set(ys).size).toBe(4);
    expect(new Set(nodes.map((n) => n.position.x)).size).toBe(1);
    expect(onCloseServer).toHaveBeenCalled();
  });

  it("lays the blocks out and re-fits the view", () => {
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    wrap(<FlowPanel {...panelProps()} />);
    act(() => {
      const a = stores.flow.getState().addNode(smiles("O"), { x: 0, y: 0 });
      const b = stores.flow.getState().addNode(initialToolParams(tools.liquid_box), { x: 0, y: 0 });
      stores.flow
        .getState()
        .connect({ source: a, target: b, sourceHandle: "out", targetHandle: "components" }, true);
    });
    fireEvent.click(screen.getByTestId("builder-flow-layout"));
    const [a, b] = stores.flow.getState().nodes;
    expect(b.position.y).toBeGreaterThan(a.position.y);
    expect(fitView).toHaveBeenCalled();
    raf.mockRestore();
  });

  it("wires blocks through the graph's callbacks and checks every wire", () => {
    stores.tools.setState({ connection: connection() });
    wrap(<FlowPanel {...panelProps()} />);
    let m = "";
    let t = "";
    act(() => {
      m = stores.flow.getState().addNode(smiles("O"));
      t = stores.flow.getState().addNode(initialToolParams(tools.liquid_box));
    });
    const props = () =>
      reactFlowProps.current as {
        isValidConnection: (c: object) => boolean;
        onConnect: (c: object) => void;
        edges: { style: { stroke: string }; animated: boolean }[];
      };
    const c = { source: m, target: t, sourceHandle: "out", targetHandle: "components" };
    expect(props().isValidConnection(c)).toBe(true);
    expect(props().isValidConnection({ ...c, target: m })).toBe(false);
    expect(props().isValidConnection({ ...c, targetHandle: "nope" })).toBe(false);
    expect(props().isValidConnection({ ...c, target: "missing" })).toBe(false);
    act(() => props().onConnect(c));
    expect(stores.flow.getState().edges).toHaveLength(1);
    // Wires are drawn like the viewer's particle edges: animated, blue.
    expect(props().edges[0]).toMatchObject({ animated: true, style: { stroke: "#3b82f6" } });
    act(() => {
      stores.flow.getState().addNode(initialToolParams(tools.liquid_box));
    });
    expect(props().isValidConnection({ source: t, target: "n3", targetHandle: "components" })).toBe(
      true,
    );
    act(() => props().onConnect({ source: "n3", target: t, targetHandle: "nope" }));
    expect(stores.flow.getState().edges).toHaveLength(1);
    expect(updateNodeInternals).toHaveBeenCalledWith([t, "n3"]);
  });

  it("applies xyflow's changes, deleting through the store", () => {
    wrap(<FlowPanel {...panelProps()} />);
    let m = "";
    let t = "";
    act(() => {
      m = stores.flow.getState().addNode(smiles("O"));
      t = stores.flow.getState().addNode(initialToolParams(tools.liquid_box));
      stores.flow
        .getState()
        .connect({ source: m, target: t, sourceHandle: "out", targetHandle: "components" }, true);
    });
    const props = () =>
      reactFlowProps.current as {
        onNodesChange: (c: object[]) => void;
        onEdgesChange: (c: object[]) => void;
        miniMapNodeColor?: unknown;
      };
    const edgeId = stores.flow.getState().edges[0].id;
    act(() => props().onEdgesChange([{ type: "select", id: edgeId, selected: true }]));
    expect(stores.flow.getState().edges[0].selected).toBe(true);
    act(() => props().onEdgesChange([{ type: "remove", id: edgeId }]));
    expect(stores.flow.getState().edges).toEqual([]);
    act(() =>
      props().onNodesChange([
        { type: "position", id: m, position: { x: 7, y: 8 }, dragging: false },
      ]),
    );
    expect(stores.flow.getState().nodes[0].position).toEqual({ x: 7, y: 8 });
    act(() => props().onNodesChange([{ type: "remove", id: m }]));
    expect(stores.flow.getState().nodes.map((n) => n.id)).toEqual([t]);
  });

  it("shows the tool server form in the pane when asked", () => {
    wrap(<FlowPanel {...panelProps({ serverOpen: true })} />);
    expect(screen.queryByTestId("builder-flow-empty-hint")).toBeNull();
    expect(screen.getByTestId("builder-tools-connect")).toBeTruthy();
  });
});

describe("FlowProperties", () => {
  const pane = (deps = fakeDeps()) =>
    wrap(<FlowProperties deps={deps} height="40%" serverOpen={false} onCloseServer={vi.fn()} />);

  it("hints what to do when nothing is picked", () => {
    pane();
    expect(screen.getByTestId("builder-flow-empty-hint").textContent).toContain("Add blocks");
    act(() => {
      stores.flow.getState().addNode(smiles());
      stores.flow.getState().selectNode(null);
    });
    expect(screen.getByTestId("builder-flow-empty-hint").textContent).toContain("Select a block");
  });

  it("heads the pane like the viewer: icon, name, summary, remove", () => {
    pane();
    act(() => {
      stores.flow.getState().addNode(smiles("CCO"));
    });
    const header = screen.getByTestId("builder-flow-properties-header");
    expect(header.textContent).toContain("Molecule");
    expect(header.textContent).toContain("SMILES CCO");
    // No On / Off switch: a block cannot be switched off.
    expect(within(header).queryByRole("switch")).toBeNull();
    fireEvent.click(screen.getByTestId("builder-flow-delete-node"));
    expect(stores.flow.getState().nodes).toEqual([]);
  });

  it("edits a molecule's SMILES, source, library entry and name in node-form rows", () => {
    pane();
    act(() => {
      stores.flow.getState().addNode(smiles());
    });
    const params = () =>
      stores.flow.getState().nodes[0].data.params as Extract<FlowParams, { type: "molecule" }>;
    fireEvent.change(screen.getByTestId("builder-flow-molecule-smiles"), {
      target: { value: "CCO" },
    });
    fireEvent.change(screen.getByTestId("builder-flow-molecule-name"), {
      target: { value: "EtOH" },
    });
    expect(params()).toMatchObject({ smiles: "CCO", name: "EtOH" });
    fireEvent.click(screen.getByTestId("builder-flow-molecule-source-library"));
    expect(params().source).toBe("library");
    expect(params().libraryId).not.toBe("");
    const select = screen.getByTestId("builder-flow-molecule-library") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: select.options[1].value } });
    expect(params().libraryId).toBe(select.options[1].value);
    fireEvent.click(screen.getByTestId("builder-flow-molecule-source-smiles"));
    expect(params().source).toBe("smiles");
  });

  it("describes the Manual structure block", () => {
    pane();
    act(() => {
      stores.flow.getState().addNode({ type: "document" });
    });
    expect(screen.getByTestId("builder-flow-document-info").textContent).toContain("no structure");
    act(() => stores.builder.getState().openStructure(water(), null, "w.xyz"));
    expect(screen.getByTestId("builder-flow-document-info").textContent).toContain("w.xyz");
  });

  it("asks for the server of a tool block that is not connected", () => {
    pane();
    act(() => {
      stores.flow.getState().addNode(initialToolParams(tools.liquid_box));
    });
    expect(screen.getByTestId("builder-flow-properties").textContent).toContain(
      "Connect to a tool server that offers Liquid box",
    );
  });

  it("names each wire's row before anything runs, and edits rows and settings", async () => {
    stores.tools.setState({ connection: connection() });
    const deps = fakeDeps();
    pane(deps);
    let m = "";
    let l = "";
    act(() => {
      m = stores.flow.getState().addNode(smiles("O", "water"));
      l = stores.flow.getState().addNode({
        type: "molecule",
        source: "library",
        smiles: "",
        libraryId: "preset:water",
        name: "",
      });
      const t = stores.flow.getState().addNode(initialToolParams(tools.liquid_box));
      for (const src of [m, l]) {
        stores.flow
          .getState()
          .connect(
            { source: src, target: t, sourceHandle: "out", targetHandle: "components" },
            true,
          );
      }
    });
    expect(screen.getByTestId("builder-flow-tool-description").textContent).toContain("packmol");
    expect(screen.getByTestId(`builder-flow-row-name-${m}`).textContent).toBe("water");
    expect(screen.getByTestId(`builder-flow-row-name-${l}`).textContent).toBe("Water");
    const row = screen.getByTestId(`builder-flow-row-components-${m}`);
    const count = within(row).getByTestId(`builder-flow-row-field-${m}-count`);
    fireEvent.change(count, { target: { value: "42" } });
    const params = () =>
      stores.flow.getState().nodes[2].data.params as Extract<FlowParams, { type: "tool" }>;
    expect(params().rows.components[m]).toMatchObject({ count: 42 });
    expect(screen.queryByTestId("builder-flow-tool-problem")).toBeNull();
    fireEvent.change(count, { target: { value: "0" } });
    expect(screen.getByTestId("builder-flow-tool-problem").textContent).toContain(
      "Count must be at least 1",
    );
    fireEvent.change(count, { target: { value: "42" } });
    fireEvent.change(screen.getByTestId("builder-flow-field-density"), {
      target: { value: "0.8" },
    });
    expect(params().values.density).toBe(0.8);
    expect(params().values).not.toHaveProperty("components");

    await act(async () => {
      fireEvent.click(screen.getByTestId("builder-flow-run-node"));
    });
    expect(deps.calls[0].args.components).toMatchObject([{ count: 42 }, { count: 100 }]);
    const summary = screen.getByTestId("builder-flow-run-summary");
    expect(summary.getAttribute("data-status")).toBe("done");
    expect(summary.textContent).toContain("liquid_box done.");
    // After the run, a row is named by the upstream result (the run's library says "water").
    expect(screen.getByTestId(`builder-flow-row-name-${l}`).textContent).toBe("water");

    stores.flow.getState().setMode("flow");
    fireEvent.click(screen.getByTestId("builder-flow-open-manual"));
    expect(stores.flow.getState().mode).toBe("manual");
    expect(stores.builder.getState().source!.nAtoms).toBe(300);
    expect(stores.builder.getState().notice?.text).toContain("from Flow");
  });

  it("names a missing input and a single input's source, and shows errors, warnings and progress", () => {
    stores.tools.setState({ connection: connection() });
    pane();
    let t = "";
    act(() => {
      t = stores.flow.getState().addNode(initialToolParams(tools.solvate));
    });
    expect(screen.getByTestId("builder-flow-tool-problem").textContent).toContain("Connect");
    act(() => {
      const s = stores.flow.getState().addNode(smiles("O", "water"));
      stores.flow
        .getState()
        .connect({ source: s, target: t, sourceHandle: "out", targetHandle: "solvent" }, false);
      const u = stores.flow.getState().addNode(initialToolParams(tools.liquid_box));
      stores.flow
        .getState()
        .connect({ source: u, target: t, sourceHandle: "out", targetHandle: "document" }, false);
      stores.flow.setState({
        runs: {
          [s]: { ...IDLE_RUN, status: "done", data: waterData("water"), key: "k" },
          [t]: { ...IDLE_RUN, status: "running", fraction: 0.5 },
        },
      });
      stores.flow.getState().selectNode(t);
    });
    expect(screen.getByTestId("builder-flow-input-solvent").textContent).toContain("water");
    expect(screen.getByTestId("builder-flow-input-document").textContent).toContain("Liquid box");
    expect(screen.getByTestId("builder-flow-run-summary").textContent).toContain("50%");
    act(() =>
      stores.flow.setState((st) => ({
        runs: {
          ...st.runs,
          [t]: { ...IDLE_RUN, status: "error", error: "no room", warnings: ["tolerance"] },
        },
      })),
    );
    const messages = screen.getByTestId("builder-flow-messages");
    expect(messages.textContent).toContain("no room");
    expect(messages.textContent).toContain("tolerance");
  });
});

describe("openInManual", () => {
  it("replaces the document and switches modes", () => {
    stores.flow.getState().setMode("flow");
    openInManual(stores.builder, stores.flow, waterData("box"));
    expect(stores.builder.getState().fileName).toBe("box");
    expect(stores.flow.getState().mode).toBe("manual");
    expect(downloadBlob).not.toHaveBeenCalled();
  });
});
