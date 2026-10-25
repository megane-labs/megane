/**
 * The pipeline assistant end to end, with only `fetch` faked: the real
 * generator, self-check and store. A reply is read the same way when it is
 * streamed, self-checked and applied, so a repair round's fix is what ends up
 * in the editor however the model formatted it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { PipelineChatBox } from "@/components/PipelineChatBox";
import { usePipelineStore } from "@/pipeline/store";
import { useAIConfigStore } from "@/ai/config";

function pipeline(query: string) {
  return {
    version: 3,
    nodes: [
      { id: "loader-1", type: "load_structure", position: { x: 0, y: 0 }, fileName: null },
      { id: "filter-1", type: "filter", position: { x: 0, y: 200 }, query },
      { id: "modify-1", type: "modify", position: { x: 0, y: 400 }, opacity: 0.2 },
      { id: "viewport-1", type: "viewport", position: { x: 0, y: 600 } },
    ],
    edges: [
      {
        source: "loader-1",
        sourceHandle: "particle",
        target: "viewport-1",
        targetHandle: "particle",
      },
      { source: "loader-1", sourceHandle: "particle", target: "filter-1", targetHandle: "in" },
      { source: "filter-1", sourceHandle: "out", target: "modify-1", targetHandle: "in" },
      { source: "modify-1", sourceHandle: "out", target: "viewport-1", targetHandle: "particle" },
    ],
  };
}

/** An OpenAI-style stream of `text`, in small chunks. */
function sse(text: string): Response {
  const enc = new TextEncoder();
  const chunks = text.match(/[\s\S]{1,40}/g) ?? [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        const data = JSON.stringify({ choices: [{ delta: { content: c } }] });
        controller.enqueue(enc.encode(`data: ${data}\n\n`));
      }
      const end = JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] });
      controller.enqueue(enc.encode(`data: ${end}\n\ndata: [DONE]\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function replies(...texts: string[]) {
  const queue = [...texts];
  const fetchMock = vi.fn(async () => sse(queue.shift()!));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function ask(text: string) {
  render(<PipelineChatBox />);
  fireEvent.change(screen.getByTestId("pipeline-chat-input"), { target: { value: text } });
  fireEvent.click(screen.getByText("Generate"));
  await waitFor(() => expect(screen.getByTestId("pipeline-chat-input")).not.toBeDisabled(), {
    timeout: 5000,
  });
}

const query = () =>
  (
    usePipelineStore.getState().nodes.find((n) => n.id === "filter-1")?.data.params as {
      query?: string;
    }
  )?.query;
const transcript = () => screen.getByTestId("pipeline-chat-messages").textContent ?? "";

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubEnv("VITE_LLM_PROXY_URL", "");
  useAIConfigStore.setState({
    provider: "openai",
    model: "gpt-4o",
    apiKey: "sk-test",
    useOwnKey: true,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("PipelineChatBox with the real generator", () => {
  it("applies a repair round's fix that comes back as bare JSON", async () => {
    const broken = "```json\n" + JSON.stringify(pipeline("resname ===")) + "\n```\nHides water.";
    const fixed = JSON.stringify(pipeline('resname == "HOH"'), null, 2) + "\nFixed the query.";
    const fetchMock = replies(broken, fixed);
    await ask("hide the water");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(query()).toBe('resname == "HOH"');
    expect(transcript()).not.toContain('"version"');
  });

  it("self-checks a first round that comes back as bare JSON", async () => {
    const broken = JSON.stringify(pipeline("resname ===")) + "\nHides water.";
    const fixed = "```json\n" + JSON.stringify(pipeline('resname == "SOL"')) + "\n```\nFixed.";
    const fetchMock = replies(broken, fixed);
    await ask("hide the water");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(query()).toBe('resname == "SOL"');
    expect(transcript()).toContain("Fixed.");
  });

  it("applies a pipeline in a ```JSON fence without a repair round", async () => {
    const reply =
      "```JSON\n" + JSON.stringify(pipeline('resname == "WAT"')) + "\n```\nHides water.";
    const fetchMock = replies(reply);
    await ask("hide the water");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(query()).toBe('resname == "WAT"');
    expect(transcript()).toContain("Hides water.");
  });

  it("answers a question in prose instead of failing", async () => {
    replies("There is no water in this structure, so there is nothing to hide.");
    const before = usePipelineStore.getState().generatedUndoStack.length;
    await ask("what is in this file?");

    expect(transcript()).toContain(
      "There is no water in this structure, so there is nothing to hide.",
    );
    expect(transcript()).not.toContain("Something went wrong");
    expect(usePipelineStore.getState().generatedUndoStack.length).toBe(before);
  });
});
