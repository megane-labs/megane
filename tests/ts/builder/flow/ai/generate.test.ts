/** Generating a flow through the shared conversation and repair loop. */

import { describe, it, expect, vi, afterEach } from "vitest";
import { formatFlowSummary, generateFlow } from "@/builder/flow/ai/generate";
import type { FlowPromptContext } from "@/builder/flow/ai/prompt";
import type { AIConfig } from "@/ai/config";
import { LIB_WATER } from "../helpers";

const CONFIG: AIConfig = { provider: "anthropic", model: "claude-opus-5", apiKey: "sk-test" };
const CTX: FlowPromptContext = {
  library: [LIB_WATER],
  tools: null,
  hostHasTools: true,
  document: null,
};

/** An Anthropic streaming response whose text is `text`. */
function reply(text: string): Response {
  const events = [
    { event: "content_block_delta", data: { delta: { type: "text_delta", text } } },
    { event: "message_delta", data: { delta: { stop_reason: "end_turn" } } },
  ];
  const body = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
  return new Response(body, { status: 200 });
}

const fenced = (flow: unknown, sentence = "Builds it.") =>
  `\`\`\`json\n${JSON.stringify(flow)}\n\`\`\`\n${sentence}`;

const lonelySlab = {
  version: 1,
  nodes: [{ id: "n1", position: { x: 40, y: 40 }, params: { type: "slab" } }],
  edges: [],
};
const crystal = {
  version: 1,
  nodes: [{ id: "n1", position: { x: 40, y: 40 }, params: { type: "crystal" } }],
  edges: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("generateFlow", () => {
  it("sends the Flow prompt with no skills, and asks for a fix of what the check finds", async () => {
    const bodies: { system: string; tools?: unknown; messages: { content: unknown }[] }[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return reply(bodies.length === 1 ? fenced(lonelySlab) : fenced(crystal, "Builds Cu."));
    });
    vi.stubGlobal("fetch", fetchMock);
    const rounds: string[][] = [];
    const chunks: string[] = [];

    const text = await generateFlow(
      CONFIG,
      "a copper crystal",
      CTX,
      (c) => chunks.push(c),
      undefined,
      (_round, errors) => rounds.push(errors),
    );

    expect(text).toBe(fenced(crystal, "Builds Cu."));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies[0].system).toContain("Megane Builder's Flow mode");
    expect(bodies[0].tools).toBeUndefined();
    expect(bodies[0].messages[0].content).toBe("a copper crystal");
    expect(rounds).toEqual([
      ['block "n1" (slab) needs a wire into its "bulk" input (Bulk crystal).'],
    ]);
    // The repair is a turn of the same conversation.
    expect(String(bodies[1].messages[2].content)).toContain(
      "The flow you just produced has the problems",
    );
    expect(chunks.join("")).toContain("Builds Cu.");
  });

  it("leaves a reply in prose alone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply("Connect a tool server first: packing a box needs packmol.")),
    );
    const text = await generateFlow(CONFIG, "a water box", CTX, () => {});
    expect(text).toBe("Connect a tool server first: packing a box needs packmol.");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("formatFlowSummary", () => {
  it("counts the blocks", () => {
    expect(formatFlowSummary(1)).toBe(
      "Flow applied — 1 block in the graph. Run it to build the structure.",
    );
    expect(formatFlowSummary(3)).toContain("3 blocks");
  });
});
