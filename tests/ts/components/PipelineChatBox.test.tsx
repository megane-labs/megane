import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

type LoaderNode = { id: string; type?: string; data: { params: Record<string, unknown> } };

const { storeState } = vi.hoisted(() => ({
  storeState: {
    nodes: [] as LoaderNode[],
    nodeSnapshots: {} as Record<string, unknown>,
    deserialize: vi.fn(),
    autoLayout: vi.fn(),
    setNodeSnapshot: vi.fn(),
    updateNodeParams: vi.fn(),
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
vi.mock("@/stores/usePipelineUIStore", () => {
  const uiState = { markPipelineApplied: vi.fn() };
  const usePipelineUIStore = (selector: (s: typeof uiState) => unknown) => selector(uiState);
  Object.assign(usePipelineUIStore, {
    getState: () => uiState,
    getInitialState: () => uiState,
    setState: () => {},
    subscribe: () => () => {},
  });
  return { usePipelineUIStore, createPipelineUIStore: () => usePipelineUIStore };
});

import {
  PipelineChatBox,
  captureLoadedStructure,
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
  storeState.deserialize.mockReset();
  storeState.autoLayout.mockReset();
  storeState.setNodeSnapshot.mockReset();
  storeState.updateNodeParams.mockReset();
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

describe("PipelineChatBox — input box", () => {
  it("renders the prompt textarea five rows tall by default", () => {
    vi.stubEnv("VITE_LLM_PROXY_URL", "https://proxy.example.com/chat");
    render(<PipelineChatBox />);

    const textarea = screen.getByPlaceholderText(
      "Describe the pipeline you want...",
    ) as HTMLTextAreaElement;
    expect(textarea.rows).toBe(5);
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

    fireEvent.change(screen.getByPlaceholderText("Describe the pipeline you want..."), {
      target: { value: "build me a pipeline" },
    });
    fireEvent.click(screen.getByText("Generate"));

    expect(screen.getByText("Please set your API key in the config panel.")).toBeTruthy();
    expect(generatePipeline).not.toHaveBeenCalled();
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

    fireEvent.change(screen.getByPlaceholderText("Describe the pipeline you want..."), {
      target: { value: "build me a pipeline" },
    });
    fireEvent.click(screen.getByText("Generate"));

    expect(screen.queryByText("Please set your API key in the config panel.")).toBeNull();
    expect(generatePipeline).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "demo" }),
      "build me a pipeline",
      expect.any(Function),
      expect.anything(),
      // structureSummary — null here since no structure is loaded in this test.
      null,
    );
  });
});

describe("captureLoadedStructure", () => {
  const snap = { snapshot: {}, frames: null, meta: null, labels: null } as never;

  it("returns null when there is no load_structure node", () => {
    expect(captureLoadedStructure([], {})).toBeNull();
    expect(
      captureLoadedStructure([{ id: "v1", type: "viewport", data: { params: {} } }], { v1: snap }),
    ).toBeNull();
  });

  it("returns null when the load_structure node has no snapshot loaded", () => {
    expect(
      captureLoadedStructure(
        [{ id: "l1", type: "load_structure", data: { params: { fileName: "a.pdb" } } }],
        {},
      ),
    ).toBeNull();
  });

  it("captures the snapshot and file params of the first loaded structure", () => {
    const result = captureLoadedStructure(
      [
        {
          id: "l1",
          type: "load_structure",
          data: { params: { fileName: "a.pdb", hasTrajectory: true, hasCell: true } },
        },
      ],
      { l1: snap },
    );
    expect(result).toEqual({
      snapshot: snap,
      fileName: "a.pdb",
      hasTrajectory: true,
      hasCell: true,
    });
  });

  it("defaults missing file params to null/false", () => {
    const result = captureLoadedStructure(
      [{ id: "l1", type: "load_structure", data: { params: {} } }],
      { l1: snap },
    );
    expect(result).toEqual({
      snapshot: snap,
      fileName: null,
      hasTrajectory: false,
      hasCell: false,
    });
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
    fireEvent.change(screen.getByPlaceholderText("Describe the pipeline you want..."), {
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
    expect(storeState.deserialize).toHaveBeenCalledTimes(1);
  });

  it("applies the pipeline the instant the JSON block closes, before the prose streams", async () => {
    (generatePipeline as ReturnType<typeof vi.fn>).mockImplementation(
      async (_config, _msg, onChunk: (c: string) => void) => {
        // The closed fence arrives first; deserialize must fire on this chunk,
        // not only after the trailing prose finishes streaming.
        onChunk('```json\n{ "version": 3, "nodes": [] }\n```');
        expect(storeState.deserialize).toHaveBeenCalledTimes(1);
        onChunk("\nLoads the structure.");
        return '```json\n{ "version": 3, "nodes": [] }\n```\nLoads the structure.';
      },
    );
    render(<PipelineChatBox />);
    submit("show it");

    expect(await screen.findByText("Loads the structure.")).toBeTruthy();
    // Applied exactly once — via the streaming early-apply, not the
    // post-stream fallback.
    expect(storeState.deserialize).toHaveBeenCalledTimes(1);
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

  it("re-applies the previously loaded structure to the new load_structure node", async () => {
    const snap = { snapshot: {}, frames: null, meta: null, labels: null };
    storeState.nodes = [
      {
        id: "old-loader",
        type: "load_structure",
        data: { params: { fileName: "mol.pdb", hasTrajectory: true, hasCell: true } },
      },
    ];
    storeState.nodeSnapshots = { "old-loader": snap };
    // deserialize installs the AI's fresh graph with a new loader id.
    storeState.deserialize.mockImplementation(() => {
      storeState.nodes = [
        { id: "new-loader", type: "load_structure", data: { params: { fileName: null } } },
      ];
      storeState.nodeSnapshots = {};
    });

    render(<PipelineChatBox />);
    submit("rebuild the view");

    await screen.findByText(/Pipeline applied/);
    expect(storeState.setNodeSnapshot).toHaveBeenCalledWith("new-loader", snap);
    expect(storeState.updateNodeParams).toHaveBeenCalledWith("new-loader", {
      fileName: "mol.pdb",
      hasTrajectory: true,
      hasCell: true,
    });
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
    expect(storeState.deserialize).toHaveBeenCalledTimes(2);
    expect(storeState.deserialize).toHaveBeenNthCalledWith(1, templatePipeline);
    expect(storeState.deserialize).toHaveBeenNthCalledWith(2, customPipeline);

    // The final UI reflects the second (customized) pipeline's node count,
    // not the first template's.
    expect(screen.queryByText(/Pipeline applied — 1 node added to the editor\./)).toBeNull();
  });
});
