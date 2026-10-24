/**
 * Flow mode's AI assistant: the request it sends, applying the flow the model
 * streams back into the Flow store, prose replies, Undo, and waiting for a run.
 * The provider call (`generateFlow`) is mocked; the store is real.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";

const { fitView } = vi.hoisted(() => ({ fitView: vi.fn() }));
vi.mock("@xyflow/react", () => ({ useReactFlow: () => ({ fitView }) }));
vi.mock("@/builder/flow/ai/generate", async () => {
  const actual = await vi.importActual<typeof import("@/builder/flow/ai/generate")>(
    "@/builder/flow/ai/generate",
  );
  return { ...actual, generateFlow: vi.fn() };
});

import { FlowChatBox, flowPromptPlaceholder } from "@/builder/flow/FlowChatBox";
import { generateFlow } from "@/builder/flow/ai/generate";
import type { FlowPromptContext } from "@/builder/flow/ai/prompt";
import { BuilderProvider, createBuilderStores, type BuilderStores } from "@/builder/BuilderStores";
import type { FlowNode } from "@/builder/flow/store";
import { parseTools } from "@/builder/tools/contract";
import type { ToolConnection } from "@/builder/tools/client";
import { useAIConfigStore } from "@/ai/config";
import { TOOLS } from "../tools/fixtures";
import { fakeDeps, waterData } from "./helpers";

type Generate = (
  config: unknown,
  message: string,
  ctx: FlowPromptContext,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
  onRepairRound?: (round: number, errors: string[]) => void,
) => Promise<string>;
const mockGenerate = (impl: Generate) => vi.mocked(generateFlow).mockImplementation(impl);

const CRYSTAL = {
  version: 1,
  nodes: [
    {
      id: "n1",
      position: { x: 40, y: 40 },
      params: { type: "crystal", structure: "rocksalt", elements: ["Na", "Cl", ""], a: 5.64 },
    },
    { id: "n2", position: { x: 40, y: 190 }, params: { type: "supercell", repeat: [3, 3, 3] } },
  ],
  edges: [{ source: "n1", target: "n2", targetHandle: "structure" }],
};
const fence = (flow: unknown) => `\`\`\`json\n${JSON.stringify(flow)}\n\`\`\``;

let stores: BuilderStores;

beforeEach(() => {
  stores = createBuilderStores();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubEnv("VITE_LLM_PROXY_URL", "https://proxy.example.com/chat");
  useAIConfigStore.setState({ useOwnKey: false });
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function renderBox(deps = fakeDeps(), hasTools = true) {
  return render(
    <BuilderProvider stores={stores}>
      <FlowChatBox deps={deps} hasTools={hasTools} />
    </BuilderProvider>,
  );
}

function ask(text: string) {
  fireEvent.change(screen.getByTestId("builder-flow-chat-input"), { target: { value: text } });
  fireEvent.click(screen.getByTestId("builder-flow-chat-send"));
}

describe("flowPromptPlaceholder", () => {
  const node = (id: string, params: FlowNode["data"]["params"]): FlowNode => ({
    id,
    position: { x: 0, y: 0 },
    data: { params },
  });

  it("names the selected block", () => {
    expect(flowPromptPlaceholder([])).toBe("Ask AI to build or edit the flow…");
    expect(flowPromptPlaceholder([node("n2", { type: "supercell", repeat: [2, 2, 2] })])).toBe(
      "Ask AI to change Supercell (n2)…",
    );
    expect(
      flowPromptPlaceholder([node("a", { type: "document" }), node("b", { type: "document" })]),
    ).toBe("Ask AI to change the 2 selected blocks…");
  });
});

describe("FlowChatBox", () => {
  it("applies the flow the moment its JSON closes, as one Undo step", async () => {
    mockGenerate(async (_c, _m, _ctx, onChunk) => {
      onChunk(fence(CRYSTAL));
      // Applied before the sentence streams.
      expect(stores.flow.getState().nodes.map((n) => n.id)).toEqual(["n1", "n2"]);
      onChunk("\nRepeats rocksalt NaCl 3 × 3 × 3.");
      return `${fence(CRYSTAL)}\nRepeats rocksalt NaCl 3 × 3 × 3.`;
    });
    renderBox();
    ask("a 3x3x3 NaCl supercell");

    expect(await screen.findByText("Repeats rocksalt NaCl 3 × 3 × 3.")).toBeTruthy();
    const s = stores.flow.getState();
    expect(s.nodes[0].data.params).toMatchObject({ type: "crystal", cubic: true });
    expect(s.edges).toHaveLength(1);
    expect(s.past).toHaveLength(1);
    expect(fitView).toHaveBeenCalled();
    // The raw JSON never shows.
    expect(screen.queryByText(/"version":1/)).toBeNull();

    fireEvent.click(screen.getByTestId("builder-flow-chat-undo"));
    expect(stores.flow.getState().nodes).toHaveLength(0);
    expect(screen.getByText("(undone)")).toBeTruthy();
  });

  it("sends the flow, the selection, the library, tools and the Manual structure", async () => {
    stores.flow.getState().load(CRYSTAL as never);
    stores.flow.getState().selectNode("n2");
    const connection: ToolConnection = {
      serverName: "fake",
      serverVersion: "1",
      listing: parseTools(TOOLS),
      call: vi.fn(),
      close: async () => {},
    };
    stores.tools.setState({ connection });
    const doc = { data: { ...waterData("slab.cif") }, key: "d1" };
    mockGenerate(async () => "Sure.");
    renderBox(fakeDeps({ document: () => doc }));

    expect(screen.getByTestId("builder-flow-chat-input").getAttribute("placeholder")).toBe(
      "Ask AI to change Supercell (n2)…",
    );
    ask("make this 4");
    await screen.findByText("Sure.");

    const [config, message, ctx] = vi.mocked(generateFlow).mock.calls[0];
    expect(config).toMatchObject({ provider: "demo" });
    expect(message).toContain("## Current flow");
    expect(message).toContain("Selected in the graph: `n2` (supercell).");
    expect(message).toContain("make this 4");
    expect(ctx.tools?.map((t) => t.name)).toEqual(connection.listing.tools.map((t) => t.name));
    expect(ctx.library.map((m) => m.id)).toEqual(["preset:water"]);
    expect(ctx.document).toEqual({ name: "slab.cif", atoms: 3, cell: false });
    expect(ctx.hostHasTools).toBe(true);
  });

  it("fills in a tool block's defaults once applied", async () => {
    const connection: ToolConnection = {
      serverName: "fake",
      serverVersion: "1",
      listing: parseTools(TOOLS),
      call: vi.fn(),
      close: async () => {},
    };
    stores.tools.setState({ connection });
    const box = {
      version: 1,
      nodes: [
        {
          id: "n1",
          position: { x: 40, y: 40 },
          params: { type: "molecule", source: "library", libraryId: "preset:water" },
        },
        {
          id: "n2",
          position: { x: 40, y: 190 },
          params: { type: "tool", tool: "liquid_box", values: { density: 0.9 } },
        },
      ],
      edges: [{ source: "n1", target: "n2", targetHandle: "components" }],
    };
    mockGenerate(async (_c, _m, _ctx, onChunk) => {
      onChunk(fence(box));
      return fence(box);
    });
    renderBox();
    ask("a water box");

    expect(await screen.findByText(/Flow applied — 2 blocks in the graph/)).toBeTruthy();
    const tool = stores.flow.getState().nodes[1].data.params as { values: Record<string, unknown> };
    expect(tool.values.density).toBe(0.9);
    expect(tool.values.tolerance).toBe(2);
  });

  it("replaces a round's flow with the repair's, inside the same Undo step", async () => {
    const lonely = { version: 1, nodes: [CRYSTAL.nodes[1]], edges: [] };
    mockGenerate(async (_c, _m, _ctx, onChunk, _s, onRepairRound) => {
      onChunk(`${fence(lonely)}\nRepeats it.`);
      onRepairRound?.(1, ["needs a wire"]);
      onChunk(`${fence(CRYSTAL)}\nRepeats NaCl.`);
      return `${fence(CRYSTAL)}\nRepeats NaCl.`;
    });
    renderBox();
    ask("supercell");

    expect(await screen.findByText("Repeats NaCl.")).toBeTruthy();
    expect(screen.queryByText(/Repeats it\./)).toBeNull();
    expect(stores.flow.getState().nodes).toHaveLength(2);
    expect(stores.flow.getState().past).toHaveLength(1);
  });

  it("shows a reply in prose as it is and changes nothing", async () => {
    mockGenerate(async () => "Connect a tool server first: a water box needs packmol.");
    renderBox();
    ask("a water box");
    expect(
      await screen.findByText("Connect a tool server first: a water box needs packmol."),
    ).toBeTruthy();
    expect(stores.flow.getState().nodes).toHaveLength(0);
    expect(screen.queryByTestId("builder-flow-chat-undo")).toBeNull();
  });

  it("reports a reply whose block is not a flow it can hold", async () => {
    mockGenerate(
      async () =>
        '```json\n{"version":1,"nodes":[{"id":"a","params":{"type":"warp"}}],"edges":[]}\n```',
    );
    renderBox();
    ask("something");
    expect(await screen.findByText("Something went wrong. Please try again.")).toBeTruthy();
    expect(stores.flow.getState().nodes).toHaveLength(0);
  });

  it("waits while a run is in progress", async () => {
    renderBox();
    act(() => stores.flow.setState({ running: new AbortController() }));
    fireEvent.change(screen.getByTestId("builder-flow-chat-input"), { target: { value: "go" } });
    const send = screen.getByTestId("builder-flow-chat-send");
    expect(send.hasAttribute("disabled")).toBe(true);
    expect(send.getAttribute("title")).toMatch(/Wait for the run to finish/);
    fireEvent.keyDown(screen.getByTestId("builder-flow-chat-input"), { key: "Enter" });
    expect(generateFlow).not.toHaveBeenCalled();

    act(() => stores.flow.setState({ running: null }));
    await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
  });

  it("offers Undo only while the assistant's change is the last one", async () => {
    mockGenerate(async (_c, _m, _ctx, onChunk) => {
      onChunk(fence(CRYSTAL));
      return fence(CRYSTAL);
    });
    renderBox();
    ask("NaCl");
    await screen.findByText(/Flow applied/);
    expect(screen.getByTestId("builder-flow-chat-undo")).toBeTruthy();

    act(() => stores.flow.getState().updateParams("n2", { repeat: [1, 1, 1] } as never));
    expect(screen.queryByTestId("builder-flow-chat-undo")).toBeNull();
  });
});
