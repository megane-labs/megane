/**
 * The assistant dock on its own, with a stand-in `run`: what its hosts
 * (`PipelineChatBox`, the Builder's `FlowChatBox`) rely on it for beyond
 * their own tests — cancelling, the settings popover, error replies, and a
 * request that may not be sent yet.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { AssistantDock, type AssistantDockProps } from "@/components/AssistantDock";
import { useAIConfigStore } from "@/ai/config";

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubEnv("VITE_LLM_PROXY_URL", "");
  useAIConfigStore.setState({
    provider: "anthropic",
    model: "claude-opus-5",
    apiKey: "sk-ant-x",
    useOwnKey: true,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  localStorage.clear();
});

function dock(props: Partial<AssistantDockProps> = {}) {
  const all: AssistantDockProps = {
    run: vi.fn(async () => ({ content: "Done." })),
    placeholder: "Ask…",
    emptyHint: "Nothing yet.",
    latestCheckpointId: null,
    onUndo: vi.fn(() => true),
    testId: "dock",
    ...props,
  };
  render(<AssistantDock {...all} />);
  return all;
}

function ask(text: string) {
  fireEvent.change(screen.getByTestId("dock-input"), { target: { value: text } });
  fireEvent.click(screen.getByTestId("dock-send"));
}

describe("AssistantDock", () => {
  it("hands the request, the history and the user's key to run", async () => {
    const props = dock();
    ask("first");
    await screen.findByText("Done.");
    ask("second");
    await screen.findAllByText("Done.");
    const calls = vi.mocked(props.run).mock.calls;
    expect(calls[0][0]).toMatchObject({
      prompt: "first",
      history: [],
      config: { provider: "anthropic", model: "claude-opus-5", apiKey: "sk-ant-x" },
    });
    expect(calls[1][0].history).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "Done." },
    ]);
    expect(screen.getByTestId("dock-history")).toBeTruthy();
  });

  it("cancels a request in progress", async () => {
    let signal: AbortSignal | undefined;
    dock({
      run: vi.fn(
        ({ signal: s }) =>
          new Promise((_resolve, reject) => {
            signal = s;
            s.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      ),
    });
    ask("slow");
    fireEvent.click(screen.getByText("Cancel"));
    expect(signal?.aborted).toBe(true);
    expect(await screen.findByText("Generation cancelled.")).toBeTruthy();
  });

  it("aborts a request in progress when it is unmounted", async () => {
    let signal: AbortSignal | undefined;
    const run = vi.fn(({ signal: s }: { signal: AbortSignal }) => {
      signal = s;
      return new Promise<never>(() => {});
    });
    render(
      <AssistantDock
        run={run}
        placeholder="Ask…"
        emptyHint="Nothing yet."
        latestCheckpointId={null}
        onUndo={() => true}
        testId="dock"
      />,
    );
    ask("go");
    expect(signal?.aborted).toBe(false);
    // Collapsing the panel (or leaving Flow mode) unmounts the dock.
    cleanup();
    expect(signal?.aborted).toBe(true);
  });

  it("shows a rate limit's own message and hides other errors' details", async () => {
    const limited = new Error("Free demo rate limit reached.");
    limited.name = "RateLimitError";
    const run = vi
      .fn()
      .mockRejectedValueOnce(limited)
      .mockRejectedValueOnce(new Error("socket hang up"));
    dock({ run });
    ask("one");
    expect(await screen.findByText("Free demo rate limit reached.")).toBeTruthy();
    ask("two");
    expect(await screen.findByText("Something went wrong. Please try again.")).toBeTruthy();
    expect(screen.queryByText(/socket/)).toBeNull();
  });

  it("starts the reply over on a repair round and keeps the checkpoint", async () => {
    dock({
      latestCheckpointId: 7,
      run: async ({ onChunk, onRestart, onCheckpoint }) => {
        onChunk("```json\n{}\n```\nOld.");
        onCheckpoint(7);
        onRestart();
        onChunk("```json\n{}\n```\nNew.");
        return { content: "New." };
      },
    });
    ask("go");
    expect(await screen.findByText("New.")).toBeTruthy();
    expect(screen.queryByText(/Old\./)).toBeNull();
    expect(screen.getByTestId("dock-undo")).toBeTruthy();
  });

  it("does not send while blocked", () => {
    const props = dock({ blockedReason: "Busy" });
    ask("go");
    expect(props.run).not.toHaveBeenCalled();
    expect(screen.getByTestId("dock-send").getAttribute("title")).toBe("Busy");
  });

  it("edits the provider, model and key in the settings popover", () => {
    dock();
    fireEvent.click(screen.getByTitle("AI Settings"));
    const [providerSelect, modelSelect] = screen.getAllByRole("combobox");
    fireEvent.change(modelSelect, { target: { value: "claude-haiku-4-5" } });
    expect(useAIConfigStore.getState().model).toBe("claude-haiku-4-5");
    fireEvent.change(providerSelect, { target: { value: "openai" } });
    expect(useAIConfigStore.getState().provider).toBe("openai");
    fireEvent.change(screen.getByPlaceholderText("sk-..."), { target: { value: "sk-new" } });
    expect(useAIConfigStore.getState().apiKey).toBe("sk-new");
  });

  it("clears the conversation and shows its empty hint", async () => {
    dock();
    ask("hello");
    await screen.findByText("Done.");
    fireEvent.click(screen.getByText("Clear"));
    expect(screen.getByText("Nothing yet.")).toBeTruthy();
  });
});
