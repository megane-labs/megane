import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

type StoreNode = {
  id: string;
  type?: string;
  selected?: boolean;
  data: { params: Record<string, unknown> };
};

const { storeState } = vi.hoisted(() => ({
  storeState: {
    nodes: [] as StoreNode[],
    nodeSnapshots: {} as Record<string, unknown>,
    snapshot: null,
    atomLabels: null,
    structureFrames: null,
    structureMeta: null,
    generatedUndoStack: [] as { id: number }[],
    serialize: vi.fn(),
    applyGeneratedPipeline: vi.fn(),
    undoGeneratedPipeline: vi.fn(),
  },
}));

vi.mock("@/ai/client", () => ({
  generatePipeline: vi.fn(),
  extractPipelineJSON: vi.fn(),
  // Only resolves once a *closed* fence has streamed in, mirroring the real
  // helper that drives the early-apply path. Individual tests override this
  // with `mockImplementation` to simulate multiple, distinguishable fences.
  tryExtractPipeline: vi.fn((text: string) =>
    /```[\s\S]*?```/.test(text)
      ? { version: 3, nodes: [{ id: "a" }, { id: "b" }], edges: [] }
      : null,
  ),
  formatActionSummary: (n: number) =>
    `Pipeline applied — ${n} ${n === 1 ? "node" : "nodes"} added to the editor.`,
  // Mirrors the real helper: only the text after the *last* closed fence,
  // ignoring any preamble before the JSON.
  extractTrailingExplanation: (text: string) => {
    const lastFenceEnd = text.lastIndexOf("```");
    if (lastFenceEnd === -1) return "";
    const fenceCount = (text.match(/```/g) ?? []).length;
    if (fenceCount % 2 !== 0) return "";
    return text.slice(lastFenceEnd + 3).trim();
  },
  RateLimitError: class RateLimitError extends Error {
    constructor(message = "Free demo rate limit reached. Please wait a bit and try again.") {
      super(message);
      this.name = "RateLimitError";
    }
  },
}));
// A full StoreApi shape, not just `getState`: the component now reads the
// store through zustand's `useStore`, which subscribes via
// `subscribe` / `getState` / `getInitialState`.
vi.mock("@/pipeline/store", () => {
  const usePipelineStore = (selector: (s: typeof storeState) => unknown) => selector(storeState);
  Object.assign(usePipelineStore, {
    getState: () => storeState,
    getInitialState: () => storeState,
    setState: () => {},
    subscribe: () => () => {},
  });
  return { usePipelineStore, createPipelineStore: () => usePipelineStore };
});

import {
  PipelineChatBox,
  chatHistory,
  promptPlaceholder,
  resolveStructureContext,
  replaceTrailingAssistant,
} from "@/components/PipelineChatBox";
import { useAIConfigStore } from "@/ai/config";
import {
  generatePipeline,
  extractPipelineJSON,
  tryExtractPipeline,
  RateLimitError,
} from "@/ai/client";

function openConfigPanel() {
  fireEvent.click(screen.getByTitle("AI Settings"));
}

// jsdom does not implement scrollIntoView; the component calls it on every
// message update to keep the chat scrolled to the bottom.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

beforeEach(() => {
  useAIConfigStore.setState({
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    apiKey: "",
    useOwnKey: false,
  });
  storeState.nodes = [];
  storeState.nodeSnapshots = {};
  storeState.generatedUndoStack = [];
  storeState.serialize.mockReset();
  storeState.serialize.mockReturnValue({ version: 3, nodes: [], edges: [] });
  storeState.applyGeneratedPipeline.mockReset();
  // Mirrors the store: a checkpointed apply pushes a new top-of-stack id.
  let nextId = 1;
  storeState.applyGeneratedPipeline.mockImplementation(
    (_p: unknown, opts?: { checkpoint?: boolean }) => {
      if (!opts?.checkpoint) return null;
      const id = nextId++;
      storeState.generatedUndoStack = [...storeState.generatedUndoStack, { id }];
      return id;
    },
  );
  storeState.undoGeneratedPipeline.mockReset();
  storeState.undoGeneratedPipeline.mockImplementation(() => {
    if (storeState.generatedUndoStack.length === 0) return false;
    storeState.generatedUndoStack = storeState.generatedUndoStack.slice(0, -1);
    return true;
  });
});

describe("PipelineChatBox — use-own-key checkbox", () => {
  it("hides the checkbox and BYOK fields and shows the demo notice when no proxy is configured", () => {
    vi.stubEnv("VITE_LLM_PROXY_URL", "");
    useAIConfigStore.setState({ useOwnKey: false });
    render(<PipelineChatBox />);
    openConfigPanel();

    expect(screen.queryByText("Use my own API key")).toBeNull();
    expect(screen.queryByPlaceholderText(/sk-/)).toBeTruthy();
  });

  it("shows the checkbox and the demo notice (no API key field) when unchecked and a proxy is configured", () => {
    vi.stubEnv("VITE_LLM_PROXY_URL", "https://proxy.example.com/chat");
    useAIConfigStore.setState({ useOwnKey: false });
    render(<PipelineChatBox />);
    openConfigPanel();

    expect(screen.getByText("Use my own API key")).toBeTruthy();
    expect(screen.queryByPlaceholderText(/sk-/)).toBeNull();
    expect(screen.getByText(/shared proxy/)).toBeTruthy();
  });

  it("reveals provider/model/API key fields when the checkbox is checked", () => {
    vi.stubEnv("VITE_LLM_PROXY_URL", "https://proxy.example.com/chat");
    useAIConfigStore.setState({ useOwnKey: false });
    render(<PipelineChatBox />);
    openConfigPanel();

    fireEvent.click(screen.getByRole("checkbox"));

    expect(useAIConfigStore.getState().useOwnKey).toBe(true);
    expect(screen.getByPlaceholderText("sk-ant-...")).toBeTruthy();
    expect(screen.queryByText(/shared proxy/)).toBeNull();
  });

  it("does not offer 'demo' as a provider option in the BYOK dropdown", () => {
    vi.stubEnv("VITE_LLM_PROXY_URL", "https://proxy.example.com/chat");
    useAIConfigStore.setState({ useOwnKey: true });
    render(<PipelineChatBox />);
    openConfigPanel();

    expect(screen.queryByRole("option", { name: /demo/i })).toBeNull();
  });
});

describe("PipelineChatBox — prompt bar", () => {
  it("starts as a single line and grows with the prompt up to four rows", () => {
    vi.stubEnv("VITE_LLM_PROXY_URL", "https://proxy.example.com/chat");
    render(<PipelineChatBox />);

    const textarea = screen.getByTestId("pipeline-chat-input") as HTMLTextAreaElement;
    expect(textarea.rows).toBe(1);
    fireEvent.change(textarea, { target: { value: "a\nb\nc" } });
    expect(textarea.rows).toBe(3);
    fireEvent.change(textarea, { target: { value: "1\n2\n3\n4\n5\n6" } });
    expect(textarea.rows).toBe(4);
  });

  it("names the selected node in the placeholder", () => {
    vi.stubEnv("VITE_LLM_PROXY_URL", "https://proxy.example.com/chat");
    storeState.nodes = [
      { id: "filter-1", type: "filter", selected: true, data: { params: {} } },
      { id: "loader-1", type: "load_structure", data: { params: {} } },
    ];
    render(<PipelineChatBox />);
    expect(screen.getByTestId("pipeline-chat-input").getAttribute("placeholder")).toBe(
      "Ask AI to change Filter (filter-1)…",
    );
  });

  it("opens the conversation and the settings one at a time", () => {
    vi.stubEnv("VITE_LLM_PROXY_URL", "https://proxy.example.com/chat");
    render(<PipelineChatBox />);

    expect(screen.queryByTestId("pipeline-chat-history")).toBeNull();
    fireEvent.click(screen.getByTestId("pipeline-chat-toggle"));
    expect(screen.getByTestId("pipeline-chat-history")).toBeTruthy();
    expect(screen.getByText(/Ask the assistant to build or edit the pipeline/)).toBeTruthy();

    openConfigPanel();
    expect(screen.getByTestId("pipeline-chat-settings")).toBeTruthy();
    expect(screen.queryByTestId("pipeline-chat-history")).toBeNull();

    fireEvent.click(screen.getByTestId("pipeline-chat-toggle"));
    expect(screen.queryByTestId("pipeline-chat-settings")).toBeNull();
    expect(screen.getByTestId("pipeline-chat-history")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Hide conversation"));
    expect(screen.queryByTestId("pipeline-chat-history")).toBeNull();
  });

  it("closes the overlays on Escape", () => {
    vi.stubEnv("VITE_LLM_PROXY_URL", "https://proxy.example.com/chat");
    render(<PipelineChatBox />);
    fireEvent.click(screen.getByTestId("pipeline-chat-toggle"));
    fireEvent.keyDown(screen.getByTestId("pipeline-chat-input"), { key: "Escape" });
    expect(screen.queryByTestId("pipeline-chat-history")).toBeNull();
  });
});

describe("PipelineChatBox — submission", () => {
  beforeEach(() => {
    (generatePipeline as ReturnType<typeof vi.fn>).mockImplementation(
      async (_config, _msg, onChunk: (c: string) => void) => {
        onChunk("partial");
        return "partial";
      },
    );
  });

  it("requires an API key before submitting when using your own key", () => {
    vi.stubEnv("VITE_LLM_PROXY_URL", "");
    useAIConfigStore.setState({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      apiKey: "",
      useOwnKey: true,
    });
    render(<PipelineChatBox />);

    fireEvent.change(screen.getByTestId("pipeline-chat-input"), {
      target: { value: "build me a pipeline" },
    });
    fireEvent.click(screen.getByText("Generate"));

    // The settings popover opens on the key field; the error is in the log.
    expect(screen.getByPlaceholderText("sk-ant-...")).toBeTruthy();
    fireEvent.click(screen.getByTestId("pipeline-chat-toggle"));
    expect(screen.getByText("Please set your API key in the AI settings.")).toBeTruthy();
    expect(generatePipeline).not.toHaveBeenCalled();
  });

  it("does not submit on the Enter that confirms an IME conversion", () => {
    vi.stubEnv("VITE_LLM_PROXY_URL", "https://proxy.example.com/chat");
    useAIConfigStore.setState({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      apiKey: "",
      useOwnKey: false,
    });
    render(<PipelineChatBox />);
    const textarea = screen.getByTestId("pipeline-chat-input");
    fireEvent.change(textarea, { target: { value: "水分子を表示" } });

    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 229 });
    expect(generatePipeline).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 13 });
    expect(generatePipeline).toHaveBeenCalledTimes(1);
  });

  it("submits without requiring an API key when using the free demo", () => {
    vi.stubEnv("VITE_LLM_PROXY_URL", "https://proxy.example.com/chat");
    useAIConfigStore.setState({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      apiKey: "",
      useOwnKey: false,
    });
    render(<PipelineChatBox />);

    fireEvent.change(screen.getByTestId("pipeline-chat-input"), {
      target: { value: "build me a pipeline" },
    });
    fireEvent.click(screen.getByText("Generate"));

    expect(screen.queryByText("Please set your API key in the AI settings.")).toBeNull();
    expect(generatePipeline).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "demo" }),
      "build me a pipeline",
      expect.any(Function),
      expect.anything(),
      // structureSummary — null here since no structure is loaded in this test.
      null,
      // self-check context, empty for the same reason.
      { snapshot: null, atomLabels: null, structureFrames: null, structureMeta: null },
      expect.any(Function),
    );
  });
});

describe("resolveStructureContext", () => {
  const emptyGlobals = {
    snapshot: null,
    atomLabels: null,
    structureFrames: null,
    structureMeta: null,
  };

  it("returns empty fields when nothing is loaded", () => {
    expect(resolveStructureContext({ nodes: [], nodeSnapshots: {}, ...emptyGlobals })).toEqual(
      emptyGlobals,
    );
  });

  it("prefers the store's global structure fields", () => {
    const globalSnapshot = { nAtoms: 1 } as never;
    const ctx = resolveStructureContext({
      nodes: [{ id: "l1", type: "load_structure", data: { params: {} } }],
      nodeSnapshots: {
        l1: { snapshot: { nAtoms: 2 }, frames: null, meta: null, labels: ["HOH"] } as never,
      },
      ...emptyGlobals,
      snapshot: globalSnapshot,
    });
    expect(ctx.snapshot).toBe(globalSnapshot);
    // labels still come from the node — the global field is null.
    expect(ctx.atomLabels).toEqual(["HOH"]);
  });

  it("falls back to the load_structure node's snapshot once the globals are cleared", () => {
    // A structure opened into a loader node (or re-attached to one after the
    // assistant rebuilt the graph) lives only in that node's snapshot.
    const nodeSnapshot = { nAtoms: 3 } as never;
    const ctx = resolveStructureContext({
      nodes: [{ id: "l1", type: "load_structure", data: { params: {} } }],
      nodeSnapshots: {
        l1: { snapshot: nodeSnapshot, frames: [], meta: null, labels: ["ALA"] } as never,
      },
      ...emptyGlobals,
    });
    expect(ctx.snapshot).toBe(nodeSnapshot);
    expect(ctx.atomLabels).toEqual(["ALA"]);
    expect(ctx.structureFrames).toEqual([]);
  });
});

describe("replaceTrailingAssistant", () => {
  it("replaces the trailing assistant placeholder in place", () => {
    const result = replaceTrailingAssistant(
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "" },
      ],
      { role: "assistant", content: "done" },
    );
    expect(result).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "done" },
    ]);
  });

  it("appends when the last message is not an assistant placeholder", () => {
    const result = replaceTrailingAssistant([{ role: "user", content: "hi" }], {
      role: "error",
      content: "oops",
    });
    expect(result).toEqual([
      { role: "user", content: "hi" },
      { role: "error", content: "oops" },
    ]);
  });

  it("appends to an empty list", () => {
    expect(replaceTrailingAssistant([], { role: "assistant", content: "x" })).toEqual([
      { role: "assistant", content: "x" },
    ]);
  });
});

describe("PipelineChatBox — applying a generated pipeline", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_LLM_PROXY_URL", "https://proxy.example.com/chat");
    (generatePipeline as ReturnType<typeof vi.fn>).mockImplementation(
      async (_config, _msg, onChunk: (c: string) => void) => {
        // The model streams raw JSON; the component must not surface it.
        onChunk('```json\n{ "version": 3, "nodes": [');
        return '```json\n{ "version": 3, "nodes": [] }\n```';
      },
    );
    (extractPipelineJSON as ReturnType<typeof vi.fn>).mockReturnValue({
      version: 3,
      nodes: [{ id: "a" }, { id: "b" }],
      edges: [],
    });
    // Restore the default single-pipeline behavior; individual tests may
    // override this with their own mockImplementation.
    (tryExtractPipeline as ReturnType<typeof vi.fn>).mockImplementation((text: string) =>
      /```[\s\S]*?```/.test(text)
        ? { version: 3, nodes: [{ id: "a" }, { id: "b" }], edges: [] }
        : null,
    );
  });

  function submit(text: string) {
    fireEvent.change(screen.getByTestId("pipeline-chat-input"), {
      target: { value: text },
    });
    fireEvent.click(screen.getByText("Generate"));
  }

  it("falls back to a concise action summary when the model returns only JSON", async () => {
    render(<PipelineChatBox />);
    submit("build me a pipeline");

    expect(
      await screen.findByText(/Pipeline applied — 2 nodes added to the editor\./),
    ).toBeTruthy();
    // The raw JSON must never appear in the transcript.
    expect(screen.queryByText(/"version": 3/)).toBeNull();
    expect(storeState.applyGeneratedPipeline).toHaveBeenCalledTimes(1);
  });

  it("applies the pipeline the instant the JSON block closes, before the prose streams", async () => {
    (generatePipeline as ReturnType<typeof vi.fn>).mockImplementation(
      async (_config, _msg, onChunk: (c: string) => void) => {
        // The closed fence arrives first; the apply must fire on this chunk,
        // not only after the trailing prose finishes streaming.
        onChunk('```json\n{ "version": 3, "nodes": [] }\n```');
        expect(storeState.applyGeneratedPipeline).toHaveBeenCalledTimes(1);
        onChunk("\nLoads the structure.");
        return '```json\n{ "version": 3, "nodes": [] }\n```\nLoads the structure.';
      },
    );
    render(<PipelineChatBox />);
    submit("show it");

    expect(await screen.findByText("Loads the structure.")).toBeTruthy();
    // Applied exactly once — via the streaming early-apply, not the
    // post-stream fallback.
    expect(storeState.applyGeneratedPipeline).toHaveBeenCalledTimes(1);
  });

  it("shows the assistant's trailing prose explanation, stripping the JSON payload", async () => {
    (generatePipeline as ReturnType<typeof vi.fn>).mockImplementation(
      async (_config, _msg, onChunk: (c: string) => void) => {
        onChunk('```json\n{ "version": 3, "nodes": [] }\n```\n');
        onChunk("Loads benzene and shows it with bonds.");
        return '```json\n{ "version": 3, "nodes": [] }\n```\nLoads benzene and shows it with bonds.';
      },
    );
    render(<PipelineChatBox />);
    submit("show benzene");

    expect(await screen.findByText("Loads benzene and shows it with bonds.")).toBeTruthy();
    // Neither the JSON nor the generic summary should appear when prose exists.
    expect(screen.queryByText(/"version": 3/)).toBeNull();
    expect(screen.queryByText(/Pipeline applied/)).toBeNull();
  });

  it("ignores a preamble before the JSON so the reply never flickers back to a placeholder", async () => {
    // A skill tool round trip can stream a short preamble before the JSON.
    // The component must never surface it (showing it then reverting to
    // "Generating…" once the JSON streams is the flicker we are fixing).
    (generatePipeline as ReturnType<typeof vi.fn>).mockImplementation(
      async (_config, _msg, onChunk: (c: string) => void) => {
        onChunk("Let me fetch the molecule template.");
        onChunk('\n```json\n{ "version": 3, "nodes": [] }\n```');
        return 'Let me fetch the molecule template.\n```json\n{ "version": 3, "nodes": [] }\n```';
      },
    );
    render(<PipelineChatBox />);
    submit("show a molecule");

    // With no trailing prose, it settles on the concise action summary — and
    // the preamble is never shown at any point.
    expect(
      await screen.findByText(/Pipeline applied — 2 nodes added to the editor\./),
    ).toBeTruthy();
    expect(screen.queryByText(/fetch the molecule template/)).toBeNull();
  });

  it("applies through the store with one undo checkpoint per request", async () => {
    render(<PipelineChatBox />);
    submit("rebuild the view");

    await screen.findByText(/Pipeline applied/);
    expect(storeState.applyGeneratedPipeline).toHaveBeenCalledWith(
      { version: 3, nodes: [{ id: "a" }, { id: "b" }], edges: [] },
      { checkpoint: true },
    );
  });

  it("offers Undo on the latest applied reply and restores the previous graph", async () => {
    render(<PipelineChatBox />);
    submit("first");
    await screen.findByText(/Pipeline applied/);
    await waitFor(() => expect(screen.getByText("Generate")).toBeTruthy());
    submit("second");
    await waitFor(() => expect(screen.getAllByText(/Pipeline applied/)).toHaveLength(2));

    // Only the newest apply can be undone.
    expect(screen.getAllByTestId("pipeline-chat-undo")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("pipeline-chat-undo"));
    expect(storeState.undoGeneratedPipeline).toHaveBeenCalledTimes(1);
    expect(screen.getByText("(undone)")).toBeTruthy();

    // The previous reply's checkpoint is now on top, so it can be undone too.
    expect(screen.getAllByTestId("pipeline-chat-undo")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("pipeline-chat-undo"));
    expect(screen.getAllByText("(undone)")).toHaveLength(2);
    expect(screen.queryByTestId("pipeline-chat-undo")).toBeNull();
  });

  it("leaves the reply alone when there is nothing left to undo", async () => {
    render(<PipelineChatBox />);
    submit("first");
    await screen.findByText(/Pipeline applied/);
    storeState.undoGeneratedPipeline.mockReturnValueOnce(false);
    fireEvent.click(screen.getByTestId("pipeline-chat-undo"));
    expect(screen.queryByText("(undone)")).toBeNull();
  });

  it("hides Undo once something else replaced the checkpoint", async () => {
    render(<PipelineChatBox />);
    submit("first");
    await screen.findByText(/Pipeline applied/);
    // e.g. a new file was opened, which empties the store's undo stack.
    storeState.generatedUndoStack = [];
    fireEvent.click(screen.getByTestId("pipeline-chat-toggle"));
    fireEvent.click(screen.getByTestId("pipeline-chat-toggle"));
    expect(screen.queryByTestId("pipeline-chat-undo")).toBeNull();
  });

  it("keeps a pipeline applied before a failure undoable", async () => {
    (generatePipeline as ReturnType<typeof vi.fn>).mockImplementation(
      async (_config, _msg, onChunk: (c: string) => void) => {
        onChunk('```json\n{ "version": 3, "nodes": [] }\n```');
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      },
    );
    render(<PipelineChatBox />);
    submit("show it");

    expect(await screen.findByText("Generation cancelled.")).toBeTruthy();
    expect(screen.getByTestId("pipeline-chat-undo")).toBeTruthy();
  });

  it("sends the current graph, the selection, and earlier turns with the request", async () => {
    storeState.nodes = [
      { id: "loader-1", type: "load_structure", selected: true, data: { params: {} } },
    ];
    storeState.serialize.mockReturnValue({
      version: 3,
      nodes: [{ id: "loader-1", type: "load_structure", position: { x: 0, y: 0 } }],
      edges: [],
    });
    render(<PipelineChatBox />);
    submit("first request");
    await screen.findByText(/Pipeline applied/);
    await waitFor(() => expect(screen.getByText("Generate")).toBeTruthy());
    submit("make it bigger");
    await waitFor(() => expect(generatePipeline).toHaveBeenCalledTimes(2));

    const first = (generatePipeline as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(first).toContain("## Current pipeline");
    expect(first).toContain("Selected in the editor: `loader-1` (load_structure)");
    expect(first).not.toContain("## Conversation so far");
    expect(first.endsWith("## Request\n\nfirst request")).toBe(true);

    const second = (generatePipeline as ReturnType<typeof vi.fn>).mock.calls[1][1] as string;
    expect(second).toContain("## Conversation so far");
    expect(second).toContain("User: first request");
    expect(second).toContain("You: Pipeline applied");
    expect(second.endsWith("## Request\n\nmake it bigger")).toBe(true);
  });

  it("clears the conversation", async () => {
    render(<PipelineChatBox />);
    submit("first");
    await screen.findByText(/Pipeline applied/);
    fireEvent.click(screen.getByText("Clear"));
    expect(screen.queryByText(/Pipeline applied/)).toBeNull();
    expect(screen.getByText(/Ask the assistant to build or edit the pipeline/)).toBeTruthy();
  });

  it("shows a generic error message when generation fails", async () => {
    (generatePipeline as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Anthropic API error (429): rate limited"),
    );
    render(<PipelineChatBox />);
    submit("build me a pipeline");

    expect(await screen.findByText("Something went wrong. Please try again.")).toBeTruthy();
    // The underlying error detail must never leak into the transcript.
    expect(screen.queryByText(/429/)).toBeNull();
  });

  it("surfaces the rate-limit message verbatim when the free demo is rate limited", async () => {
    (generatePipeline as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new RateLimitError("Free demo rate limit reached. Please wait a bit and try again."),
    );
    render(<PipelineChatBox />);
    submit("build me a pipeline");

    expect(
      await screen.findByText("Free demo rate limit reached. Please wait a bit and try again."),
    ).toBeTruthy();
    expect(screen.queryByText("Something went wrong. Please try again.")).toBeNull();
  });

  it("keeps showing the finished reply once streaming settles instead of reverting to 'Generating…'", async () => {
    (generatePipeline as ReturnType<typeof vi.fn>).mockImplementation(
      async (_config, _msg, onChunk: (c: string) => void) => {
        onChunk('```json\n{ "version": 3, "nodes": [] }\n```\n');
        onChunk("Loads benzene and shows it with bonds.");
        return '```json\n{ "version": 3, "nodes": [] }\n```\nLoads benzene and shows it with bonds.';
      },
    );
    render(<PipelineChatBox />);
    submit("show benzene");

    expect(await screen.findByText("Loads benzene and shows it with bonds.")).toBeTruthy();

    // Wait for the request to settle (the Cancel button reverts to Generate).
    await waitFor(() => expect(screen.getByText("Generate")).toBeTruthy());

    // The completed message must keep its final text, not revert to the
    // streaming placeholder.
    expect(screen.getByText("Loads benzene and shows it with bonds.")).toBeTruthy();
    expect(screen.queryByText("Generating…")).toBeNull();
  });

  it("re-applies the pipeline when a later fence supersedes an earlier template echo", async () => {
    const TEMPLATE_FENCE = '```json\n{ "version": 3, "nodes": [{ "id": "t" }], "edges": [] }\n```';
    const CUSTOM_FENCE =
      '```json\n{ "version": 3, "nodes": [{ "id": "x" }, { "id": "y" }, { "id": "z" }], "edges": [] }\n```';
    const templatePipeline = { version: 3, nodes: [{ id: "t" }], edges: [] };
    const customPipeline = {
      version: 3,
      nodes: [{ id: "x" }, { id: "y" }, { id: "z" }],
      edges: [],
    };

    (tryExtractPipeline as ReturnType<typeof vi.fn>).mockImplementation((text: string) => {
      if (text.includes(CUSTOM_FENCE)) return customPipeline;
      if (text.includes(TEMPLATE_FENCE)) return templatePipeline;
      return null;
    });

    (generatePipeline as ReturnType<typeof vi.fn>).mockImplementation(
      async (_config, _msg, onChunk: (c: string) => void) => {
        onChunk(`Here's the template:\n${TEMPLATE_FENCE}\n`);
        onChunk(`Customized for you:\n${CUSTOM_FENCE}`);
        return `Here's the template:\n${TEMPLATE_FENCE}\nCustomized for you:\n${CUSTOM_FENCE}`;
      },
    );

    render(<PipelineChatBox />);
    submit("show a molecule");

    expect(
      await screen.findByText(/Pipeline applied — 3 nodes added to the editor\./),
    ).toBeTruthy();

    // Applied twice: once for the template echo, once more for the
    // customized pipeline that supersedes it.
    expect(storeState.applyGeneratedPipeline).toHaveBeenCalledTimes(2);
    // Only the first apply of the request records an undo checkpoint.
    expect(storeState.applyGeneratedPipeline).toHaveBeenNthCalledWith(1, templatePipeline, {
      checkpoint: true,
    });
    expect(storeState.applyGeneratedPipeline).toHaveBeenNthCalledWith(2, customPipeline, {
      checkpoint: false,
    });

    // The final UI reflects the second (customized) pipeline's node count,
    // not the first template's.
    expect(screen.queryByText(/Pipeline applied — 1 node added to the editor\./)).toBeNull();
  });
});

describe("chatHistory", () => {
  it("keeps finished user and assistant turns and drops errors and placeholders", () => {
    expect(
      chatHistory([
        { role: "user", content: "show water" },
        { role: "assistant", content: "Shows water." },
        { role: "user", content: "again" },
        { role: "error", content: "Something went wrong." },
        { role: "assistant", content: "" },
      ]),
    ).toEqual([
      { role: "user", content: "show water" },
      { role: "assistant", content: "Shows water." },
      { role: "user", content: "again" },
    ]);
  });
});

describe("promptPlaceholder", () => {
  it("asks for a pipeline when nothing is selected", () => {
    expect(promptPlaceholder([])).toBe("Ask AI to build or edit the pipeline…");
  });

  it("names a single selected node by its label", () => {
    expect(promptPlaceholder([{ id: "c1", type: "color" }])).toBe("Ask AI to change Color (c1)…");
  });

  it("falls back to the raw type, then to 'node'", () => {
    expect(promptPlaceholder([{ id: "x", type: "mystery" }])).toBe("Ask AI to change mystery (x)…");
    expect(promptPlaceholder([{ id: "x" }])).toBe("Ask AI to change node (x)…");
  });

  it("counts several selected nodes", () => {
    expect(
      promptPlaceholder([
        { id: "a", type: "filter" },
        { id: "b", type: "color" },
      ]),
    ).toBe("Ask AI to change the 2 selected nodes…");
  });
});
