import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/ai/skillLoader", () => ({
  getSkills: vi.fn(() => []),
  buildToolDefinitions: vi.fn(() => []),
  buildOpenAITools: vi.fn(() => []),
  executeSkill: vi.fn((_skills: unknown, name: string) =>
    name === "known_skill" ? "skill content" : null,
  ),
}));

import {
  extractPipelineJSON,
  tryExtractPipeline,
  generatePipeline,
  formatActionSummary,
  stripPipelineJSON,
  extractTrailingExplanation,
  RateLimitError,
  MAX_REPAIR_ROUNDS,
} from "@/ai/client";
import type { AIConfig } from "@/ai/config";

type SSEEvent = { event: string; data: unknown };

function makeSSEResponse(events: SSEEvent[], status = 200): Response {
  const encoder = new TextEncoder();
  const text = events
    .map((e) => {
      const data = typeof e.data === "string" ? e.data : JSON.stringify(e.data);
      return `event: ${e.event}\ndata: ${data}\n\n`;
    })
    .join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(stream, { status });
}

function makeJSONResponse(body: unknown, status = 200): Response {
  const encoder = new TextEncoder();
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(stream, { status });
}

const ANTHROPIC_CONFIG: AIConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  apiKey: "sk-test",
};

const OPENAI_CONFIG: AIConfig = {
  provider: "openai",
  model: "gpt-4o",
  apiKey: "sk-test",
};

const DEMO_CONFIG: AIConfig = {
  provider: "demo",
  model: "demo",
  apiKey: "",
};

const MINIMAL_PIPELINE_JSON = JSON.stringify({
  version: 3,
  nodes: [{ id: "v1", type: "viewport", position: { x: 0, y: 0 } }],
  edges: [],
});

describe("extractPipelineJSON", () => {
  it("parses a fenced ```json block", () => {
    const result = extractPipelineJSON(
      `Here you go:\n\`\`\`json\n${MINIMAL_PIPELINE_JSON}\n\`\`\``,
    );
    expect(result.version).toBe(3);
    expect(result.nodes).toHaveLength(1);
  });

  it("parses a fenced ``` block with no language tag", () => {
    const result = extractPipelineJSON(`\`\`\`\n${MINIMAL_PIPELINE_JSON}\n\`\`\``);
    expect(result.version).toBe(3);
  });

  it("parses raw JSON between the first { and last } when no fence is present", () => {
    const result = extractPipelineJSON(`prefix ${MINIMAL_PIPELINE_JSON} suffix`);
    expect(result.version).toBe(3);
  });

  it("throws when no JSON-like content is found", () => {
    expect(() => extractPipelineJSON("no json here")).toThrow(/No JSON found/);
  });

  it("throws when the JSON is malformed", () => {
    expect(() => extractPipelineJSON("```json\n{ not json }\n```")).toThrow(/Failed to parse JSON/);
  });

  it("throws when version is not 3", () => {
    const wrong = JSON.stringify({ version: 2, nodes: [], edges: [] });
    expect(() => extractPipelineJSON(`\`\`\`json\n${wrong}\n\`\`\``)).toThrow(
      /Unexpected pipeline version/,
    );
  });

  it("throws when nodes or edges are missing", () => {
    const noNodes = JSON.stringify({ version: 3, edges: [] });
    expect(() => extractPipelineJSON(`\`\`\`json\n${noNodes}\n\`\`\``)).toThrow(/Invalid pipeline/);

    const noEdges = JSON.stringify({ version: 3, nodes: [] });
    expect(() => extractPipelineJSON(`\`\`\`json\n${noEdges}\n\`\`\``)).toThrow(/Invalid pipeline/);
  });
});

describe("extractPipelineJSON / tryExtractPipeline — multiple fences", () => {
  const TEMPLATE_PIPELINE_JSON = JSON.stringify({
    version: 3,
    nodes: [{ id: "template-viewport", type: "viewport", position: { x: 0, y: 0 } }],
    edges: [],
  });
  const CUSTOM_PIPELINE_JSON = JSON.stringify({
    version: 3,
    nodes: [
      { id: "loader-1", type: "load_structure", position: { x: 0, y: 0 } },
      { id: "viewport-1", type: "viewport", position: { x: 0, y: 310 } },
    ],
    edges: [],
  });

  it("extractPipelineJSON picks the last valid pipeline fence over an earlier template echo", () => {
    const response =
      `Here's the template:\n\`\`\`json\n${TEMPLATE_PIPELINE_JSON}\n\`\`\`\n` +
      `Customized for you:\n\`\`\`json\n${CUSTOM_PIPELINE_JSON}\n\`\`\`\nLoads your structure.`;
    const result = extractPipelineJSON(response);
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0].id).toBe("loader-1");
  });

  it("tryExtractPipeline supersedes an earlier closed fence once a later one closes", () => {
    const partial = `Here's the template:\n\`\`\`json\n${TEMPLATE_PIPELINE_JSON}\n\`\`\`\n`;
    const early = tryExtractPipeline(partial);
    expect(early?.nodes).toHaveLength(1);

    const full = `${partial}Customized for you:\n\`\`\`json\n${CUSTOM_PIPELINE_JSON}\n\`\`\``;
    const later = tryExtractPipeline(full);
    expect(later?.nodes).toHaveLength(2);
  });

  it("skips a fenced block that is not valid pipeline JSON and uses a later valid one", () => {
    const response =
      `Format example:\n\`\`\`json\n{ "version": 3, "nodes": [...] }\n\`\`\`\n` +
      `Actual pipeline:\n\`\`\`json\n${CUSTOM_PIPELINE_JSON}\n\`\`\``;
    const result = extractPipelineJSON(response);
    expect(result.nodes).toHaveLength(2);
  });
});

describe("generatePipeline (Anthropic)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streams text deltas via onChunk and returns the concatenated text", async () => {
    fetchMock.mockResolvedValueOnce(
      makeSSEResponse([
        { event: "content_block_delta", data: { delta: { type: "text_delta", text: "hello " } } },
        { event: "content_block_delta", data: { delta: { type: "text_delta", text: "world" } } },
        { event: "message_delta", data: { delta: { stop_reason: "end_turn" } } },
      ]),
    );

    const chunks: string[] = [];
    const result = await generatePipeline(ANTHROPIC_CONFIG, "user msg", (c) => chunks.push(c));

    expect(chunks).toEqual(["hello ", "world"]);
    expect(result).toBe("hello world");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.anthropic.com/v1/messages");
  });

  it("sets the required Anthropic headers", async () => {
    fetchMock.mockResolvedValueOnce(
      makeSSEResponse([{ event: "message_delta", data: { delta: { stop_reason: "end_turn" } } }]),
    );

    await generatePipeline(ANTHROPIC_CONFIG, "msg", () => {});

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("claude-sonnet-4-20250514");
    expect(body.stream).toBe(true);
    expect(body.system).toContain("Megane");
  });

  it("performs a tool-use round trip when stop_reason is tool_use", async () => {
    const { buildToolDefinitions } = await import("@/ai/skillLoader");
    (buildToolDefinitions as ReturnType<typeof vi.fn>).mockReturnValueOnce([
      { name: "known_skill", description: "x", input_schema: { type: "object", properties: {} } },
    ]);

    // First response: tool_use
    fetchMock.mockResolvedValueOnce(
      makeSSEResponse([
        {
          event: "content_block_start",
          data: { content_block: { type: "tool_use", id: "tu_1", name: "known_skill" } },
        },
        {
          event: "content_block_delta",
          data: { delta: { type: "input_json_delta", partial_json: "" } },
        },
        { event: "content_block_stop", data: {} },
        { event: "message_delta", data: { delta: { stop_reason: "tool_use" } } },
      ]),
    );
    // Second response: end_turn with text
    fetchMock.mockResolvedValueOnce(
      makeSSEResponse([
        { event: "content_block_delta", data: { delta: { type: "text_delta", text: "done" } } },
        { event: "message_delta", data: { delta: { stop_reason: "end_turn" } } },
      ]),
    );

    const result = await generatePipeline(ANTHROPIC_CONFIG, "msg", () => {});
    expect(result).toBe("done");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The second request body should include the assistant tool_use and a user tool_result.
    const secondBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(Array.isArray(secondBody.messages)).toBe(true);
    const lastTwo = secondBody.messages.slice(-2);
    expect(lastTwo[0].role).toBe("assistant");
    expect((lastTwo[0].content as { type: string }[]).some((c) => c.type === "tool_use")).toBe(
      true,
    );
    expect(lastTwo[1].role).toBe("user");
    const toolResult = (lastTwo[1].content as { type: string; content: string }[])[0];
    expect(toolResult.type).toBe("tool_result");
    expect(toolResult.content).toBe("skill content");
  });

  it("throws a generic error when the API returns a non-OK status", async () => {
    fetchMock.mockResolvedValueOnce(makeJSONResponse("server error", 500));
    await expect(generatePipeline(ANTHROPIC_CONFIG, "msg", () => {})).rejects.toThrow(
      /Request failed/,
    );
  });

  it("throws a RateLimitError when the API returns 429", async () => {
    fetchMock.mockResolvedValueOnce(makeJSONResponse("rate limited", 429));
    await expect(generatePipeline(ANTHROPIC_CONFIG, "msg", () => {})).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });
});

describe("generatePipeline (OpenAI)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streams content deltas and returns concatenated text", async () => {
    fetchMock.mockResolvedValueOnce(
      makeSSEResponse([
        { event: "", data: { choices: [{ delta: { content: "hi " } }] } },
        { event: "", data: { choices: [{ delta: { content: "there" } }] } },
        { event: "", data: "[DONE]" },
      ]),
    );

    const chunks: string[] = [];
    const result = await generatePipeline(OPENAI_CONFIG, "msg", (c) => chunks.push(c));
    expect(chunks).toEqual(["hi ", "there"]);
    expect(result).toBe("hi there");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("sets the OpenAI Authorization header and body", async () => {
    fetchMock.mockResolvedValueOnce(makeSSEResponse([{ event: "", data: "[DONE]" }]));
    await generatePipeline(OPENAI_CONFIG, "msg", () => {});

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("gpt-4o");
    expect(body.stream).toBe(true);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toBe("msg");
  });

  it("ignores unparseable SSE data lines", async () => {
    fetchMock.mockResolvedValueOnce(
      makeSSEResponse([
        { event: "", data: "not json" },
        { event: "", data: { choices: [{ delta: { content: "ok" } }] } },
        { event: "", data: "[DONE]" },
      ]),
    );
    const result = await generatePipeline(OPENAI_CONFIG, "msg", () => {});
    expect(result).toBe("ok");
  });

  it("throws a generic error when OpenAI returns a non-OK status", async () => {
    fetchMock.mockResolvedValueOnce(makeJSONResponse("bad request", 400));
    await expect(generatePipeline(OPENAI_CONFIG, "msg", () => {})).rejects.toThrow(
      /Request failed/,
    );
  });

  it("includes the skill tools in the request body when skills are present", async () => {
    const skillLoader = await import("@/ai/skillLoader");
    vi.mocked(skillLoader.buildOpenAITools).mockReturnValueOnce([
      {
        type: "function",
        function: {
          name: "known_skill",
          description: "d",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
    fetchMock.mockResolvedValueOnce(makeSSEResponse([{ event: "", data: "[DONE]" }]));

    await generatePipeline(OPENAI_CONFIG, "msg", () => {});

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.tools[0].function.name).toBe("known_skill");
  });

  it("runs a tool-call round trip and feeds the skill result back", async () => {
    // 1st response: the model asks to call a skill function.
    fetchMock.mockResolvedValueOnce(
      makeSSEResponse([
        {
          event: "",
          data: {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      type: "function",
                      function: { name: "known_skill", arguments: "" },
                    },
                  ],
                },
              },
            ],
          },
        },
        { event: "", data: { choices: [{ delta: {}, finish_reason: "tool_calls" }] } },
        { event: "", data: "[DONE]" },
      ]),
    );
    // 2nd response: the final text answer.
    fetchMock.mockResolvedValueOnce(
      makeSSEResponse([
        { event: "", data: { choices: [{ delta: { content: "final" } }] } },
        { event: "", data: { choices: [{ delta: {}, finish_reason: "stop" }] } },
        { event: "", data: "[DONE]" },
      ]),
    );

    const result = await generatePipeline(OPENAI_CONFIG, "msg", () => {});
    expect(result).toBe("final");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const secondBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    const assistantMsg = secondBody.messages.find((m: { role: string }) => m.role === "assistant");
    expect(assistantMsg.tool_calls[0].function.name).toBe("known_skill");
    const toolMsg = secondBody.messages.find((m: { role: string }) => m.role === "tool");
    expect(toolMsg.content).toBe("skill content");
    expect(toolMsg.tool_call_id).toBe("call_1");
  });

  it("throws after too many tool-call rounds", async () => {
    // Always respond with a tool call so the loop never terminates. Build a
    // fresh Response each call since a stream body can only be read once.
    fetchMock.mockImplementation(async () =>
      makeSSEResponse([
        {
          event: "",
          data: {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      type: "function",
                      function: { name: "known_skill", arguments: "" },
                    },
                  ],
                },
              },
            ],
          },
        },
        { event: "", data: { choices: [{ delta: {}, finish_reason: "tool_calls" }] } },
        { event: "", data: "[DONE]" },
      ]),
    );

    await expect(generatePipeline(OPENAI_CONFIG, "msg", () => {})).rejects.toThrow(
      /Too many tool-use rounds/,
    );
  });
});

describe("generatePipeline (demo proxy)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("throws when no proxy URL is configured for this build", async () => {
    vi.stubEnv("VITE_LLM_PROXY_URL", "");
    await expect(generatePipeline(DEMO_CONFIG, "msg", () => {})).rejects.toThrow(
      /free demo is not available/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to the proxy URL without an Authorization header and streams the reply", async () => {
    vi.stubEnv("VITE_LLM_PROXY_URL", "https://proxy.example.com/chat");
    fetchMock.mockResolvedValueOnce(
      makeSSEResponse([
        { event: "", data: { choices: [{ delta: { content: "hi " } }] } },
        { event: "", data: { choices: [{ delta: { content: "there" } }] } },
        { event: "", data: "[DONE]" },
      ]),
    );

    const chunks: string[] = [];
    const result = await generatePipeline(DEMO_CONFIG, "msg", (c) => chunks.push(c));

    expect(chunks).toEqual(["hi ", "there"]);
    expect(result).toBe("hi there");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://proxy.example.com/chat");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body as string);
    expect(body.messages).toEqual([
      { role: "system", content: expect.stringContaining("Megane") },
      { role: "user", content: "msg" },
    ]);
    expect(body.model).toBeUndefined();
  });

  it("runs the tool-call round trip through the proxy without a model field", async () => {
    vi.stubEnv("VITE_LLM_PROXY_URL", "https://proxy.example.com/chat");
    fetchMock.mockResolvedValueOnce(
      makeSSEResponse([
        {
          event: "",
          data: {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      type: "function",
                      function: { name: "known_skill", arguments: "" },
                    },
                  ],
                },
              },
            ],
          },
        },
        { event: "", data: { choices: [{ delta: {}, finish_reason: "tool_calls" }] } },
        { event: "", data: "[DONE]" },
      ]),
    );
    fetchMock.mockResolvedValueOnce(
      makeSSEResponse([
        { event: "", data: { choices: [{ delta: { content: "done" } }] } },
        { event: "", data: { choices: [{ delta: {}, finish_reason: "stop" }] } },
        { event: "", data: "[DONE]" },
      ]),
    );

    const result = await generatePipeline(DEMO_CONFIG, "msg", () => {});
    expect(result).toBe("done");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe("https://proxy.example.com/chat");
      const body = JSON.parse((call[1] as RequestInit).body as string);
      expect(body.model).toBeUndefined(); // proxy chooses the model server-side
    }
    const secondBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(secondBody.messages.find((m: { role: string }) => m.role === "tool").content).toBe(
      "skill content",
    );
  });

  it("throws a generic error when the proxy returns a non-OK status", async () => {
    vi.stubEnv("VITE_LLM_PROXY_URL", "https://proxy.example.com/chat");
    fetchMock.mockResolvedValueOnce(makeJSONResponse("server error", 500));

    await expect(generatePipeline(DEMO_CONFIG, "msg", () => {})).rejects.toThrow(/Request failed/);
  });

  it("throws a RateLimitError when the proxy returns 429 (daily limit hit)", async () => {
    vi.stubEnv("VITE_LLM_PROXY_URL", "https://proxy.example.com/chat");
    fetchMock.mockResolvedValueOnce(makeJSONResponse("rate limit exceeded", 429));

    await expect(generatePipeline(DEMO_CONFIG, "msg", () => {})).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });
});

describe("generatePipeline — structure summary + query repair", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Fully wired pipelines (loader -> filter -> viewport) so the filter query is
  // the only variable the self-check reacts to. A bare filter with no upstream
  // would trip the "No input connected" check instead.
  function filterPipeline(query: string): string {
    return JSON.stringify({
      version: 3,
      nodes: [
        { id: "l1", type: "load_structure", position: { x: 0, y: 0 } },
        { id: "f1", type: "filter", position: { x: 0, y: 155 }, query },
        { id: "v1", type: "viewport", position: { x: 0, y: 310 } },
      ],
      edges: [
        { source: "l1", target: "f1", sourceHandle: "particle", targetHandle: "in" },
        { source: "f1", target: "v1", sourceHandle: "out", targetHandle: "particle" },
      ],
    });
  }
  const VALID_FILTER_PIPELINE = filterPipeline('element == "C"');
  const INVALID_FILTER_PIPELINE = filterPipeline("chain A");
  // Structurally invalid: references an unknown node type and has no viewport.
  const INVALID_SCHEMA_PIPELINE = JSON.stringify({
    version: 3,
    nodes: [{ id: "x1", type: "not_a_real_node", position: { x: 0, y: 0 } }],
    edges: [],
  });
  // Schema-clean but semantically wrong: the loader feeds the viewport directly
  // *and* through a filter, so the filtered atoms are drawn twice.
  const OVERLAPPING_PIPELINE = JSON.stringify({
    version: 3,
    nodes: [
      { id: "l1", type: "load_structure", position: { x: 0, y: 0 } },
      { id: "f1", type: "filter", position: { x: 0, y: 155 }, query: 'element == "C"' },
      { id: "v1", type: "viewport", position: { x: 0, y: 310 } },
    ],
    edges: [
      { source: "l1", target: "f1", sourceHandle: "particle", targetHandle: "in" },
      { source: "f1", target: "v1", sourceHandle: "out", targetHandle: "particle" },
      { source: "l1", target: "v1", sourceHandle: "particle", targetHandle: "particle" },
    ],
  });

  function anthropicTextResponse(text: string): Response {
    return makeSSEResponse([
      { event: "content_block_delta", data: { delta: { type: "text_delta", text } } },
      { event: "message_delta", data: { delta: { stop_reason: "end_turn" } } },
    ]);
  }

  it("appends the structure summary to the system prompt", async () => {
    fetchMock.mockResolvedValueOnce(anthropicTextResponse("hi"));
    await generatePipeline(
      ANTHROPIC_CONFIG,
      "msg",
      () => {},
      undefined,
      "STRUCTURE_SUMMARY_MARKER",
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.system).toContain("STRUCTURE_SUMMARY_MARKER");
    expect(body.system).toContain("Currently Loaded Structure");
  });

  it("does not repair when the generated filter queries are valid", async () => {
    fetchMock.mockResolvedValueOnce(
      anthropicTextResponse("```json\n" + VALID_FILTER_PIPELINE + "\n```\nDone."),
    );
    const result = await generatePipeline(ANTHROPIC_CONFIG, "show carbons", () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toContain("Done.");
  });

  it("runs one repair round trip when a filter query is invalid", async () => {
    fetchMock.mockResolvedValueOnce(
      anthropicTextResponse("```json\n" + INVALID_FILTER_PIPELINE + "\n```\nHere."),
    );
    fetchMock.mockResolvedValueOnce(
      anthropicTextResponse("```json\n" + VALID_FILTER_PIPELINE + "\n```\nFixed."),
    );

    const result = await generatePipeline(ANTHROPIC_CONFIG, "show chain A", () => {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The repair request's user message should reference the invalid query.
    const repairBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    const userMsg = repairBody.messages[repairBody.messages.length - 1];
    expect(userMsg.role).toBe("user");
    expect(userMsg.content).toContain("has the problems listed below");
    expect(userMsg.content).toContain("chain A");
    expect(result).toContain("Fixed.");
  });

  it("repairs inside the same conversation instead of restarting it", async () => {
    fetchMock.mockResolvedValueOnce(
      anthropicTextResponse("```json\n" + INVALID_FILTER_PIPELINE + "\n```\nHere."),
    );
    fetchMock.mockResolvedValueOnce(
      anthropicTextResponse("```json\n" + VALID_FILTER_PIPELINE + "\n```\nFixed."),
    );

    await generatePipeline(ANTHROPIC_CONFIG, "show chain A", () => {});
    const repairBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    // original request, the assistant's broken answer, then the repair prompt.
    expect(repairBody.messages).toHaveLength(3);
    expect(repairBody.messages[0]).toEqual({ role: "user", content: "show chain A" });
    expect(repairBody.messages[1].role).toBe("assistant");
    expect(repairBody.messages[1].content).toContain("chain A");
    expect(repairBody.messages[2].role).toBe("user");
  });

  it("runs one repair round trip when the pipeline structure is invalid", async () => {
    fetchMock.mockResolvedValueOnce(
      anthropicTextResponse("```json\n" + INVALID_SCHEMA_PIPELINE + "\n```\nHere."),
    );
    fetchMock.mockResolvedValueOnce(
      anthropicTextResponse("```json\n" + VALID_FILTER_PIPELINE + "\n```\nFixed."),
    );

    const result = await generatePipeline(ANTHROPIC_CONFIG, "build something", () => {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const repairBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    const userMsg = repairBody.messages[repairBody.messages.length - 1];
    expect(userMsg.content).toContain("not_a_real_node");
    expect(userMsg.content).toContain("viewport");
    expect(result).toContain("Fixed.");
  });

  it("repairs a schema-clean pipeline that draws the same atoms twice", async () => {
    fetchMock.mockResolvedValueOnce(
      anthropicTextResponse("```json\n" + OVERLAPPING_PIPELINE + "\n```\nHere."),
    );
    fetchMock.mockResolvedValueOnce(
      anthropicTextResponse("```json\n" + VALID_FILTER_PIPELINE + "\n```\nFixed."),
    );

    const result = await generatePipeline(ANTHROPIC_CONFIG, "show carbons", () => {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const repairBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    const userMsg = repairBody.messages[repairBody.messages.length - 1];
    expect(userMsg.content).toContain("drawn twice");
    expect(result).toContain("Fixed.");
  });

  it("stops after MAX_REPAIR_ROUNDS even if the repairs stay invalid", async () => {
    // Build a fresh Response each call — a stream body can only be read once.
    fetchMock.mockImplementation(async () =>
      anthropicTextResponse("```json\n" + INVALID_FILTER_PIPELINE + "\n```\nStill bad."),
    );
    const onRepairRound = vi.fn();
    const result = await generatePipeline(
      ANTHROPIC_CONFIG,
      "show chain A",
      () => {},
      undefined,
      null,
      {},
      onRepairRound,
    );
    // One initial generation plus MAX_REPAIR_ROUNDS repairs; no further attempts.
    expect(fetchMock).toHaveBeenCalledTimes(1 + MAX_REPAIR_ROUNDS);
    expect(onRepairRound).toHaveBeenCalledTimes(MAX_REPAIR_ROUNDS);
    expect(result).toContain("Still bad.");
  });

  it("does not repair a response that carries no pipeline", async () => {
    fetchMock.mockResolvedValueOnce(anthropicTextResponse("I need a structure first."));
    const result = await generatePipeline(ANTHROPIC_CONFIG, "hi", () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toContain("I need a structure first.");
  });

  it("stops repairing on the demo proxy before the message budget runs out", async () => {
    fetchMock.mockImplementation(async () =>
      makeJSONResponse(
        "data: " +
          JSON.stringify({
            choices: [
              {
                delta: { content: "```json\n" + INVALID_FILTER_PIPELINE + "\n```\nBad." },
                finish_reason: "stop",
              },
            ],
          }) +
          "\n\n",
      ),
    );
    vi.stubEnv("VITE_LLM_PROXY_URL", "https://proxy.example/chat");
    await generatePipeline(DEMO_CONFIG, "show chain A", () => {});
    // The demo session's history stays inside the proxy's 12-message cap.
    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse((call[1] as RequestInit).body as string);
      expect(body.messages.length).toBeLessThanOrEqual(12);
    }
    vi.unstubAllEnvs();
  });
});

describe("formatActionSummary", () => {
  it("returns singular phrasing for a single node", () => {
    expect(formatActionSummary(1)).toBe("Pipeline applied — 1 node added to the editor.");
  });

  it("returns plural phrasing for multiple nodes", () => {
    expect(formatActionSummary(3)).toBe("Pipeline applied — 3 nodes added to the editor.");
  });

  it("returns plural phrasing for zero nodes", () => {
    expect(formatActionSummary(0)).toBe("Pipeline applied — 0 nodes added to the editor.");
  });
});

describe("stripPipelineJSON", () => {
  it("returns the prose that follows a fenced json block (JSON-first format)", () => {
    expect(
      stripPipelineJSON('```json\n{ "version": 3 }\n```\n\nLoads benzene and shows bonds.'),
    ).toBe("Loads benzene and shows bonds.");
  });

  it("still strips a fenced block that comes after the prose", () => {
    expect(
      stripPipelineJSON('Loads benzene and shows bonds.\n```json\n{ "version": 3 }\n```'),
    ).toBe("Loads benzene and shows bonds.");
  });

  it("returns an empty string while the JSON is still streaming (unclosed fence)", () => {
    expect(stripPipelineJSON('```json\n{ "version": 3, "nodes": [')).toBe("");
  });

  it("returns an empty string for an unfenced partial object", () => {
    expect(stripPipelineJSON('{ "version": 3, "nodes": [')).toBe("");
  });

  it("returns an empty string when the response is only a fenced JSON block", () => {
    expect(stripPipelineJSON('```json\n{ "version": 3 }\n```')).toBe("");
  });

  it("returns the whole trimmed text when there is no JSON", () => {
    expect(stripPipelineJSON("  just a sentence.  ")).toBe("just a sentence.");
  });
});

describe("extractTrailingExplanation", () => {
  it("returns the sentence after a closed fenced json block", () => {
    expect(
      extractTrailingExplanation(
        '```json\n{ "version": 3 }\n```\n\nLoads benzene and shows bonds.',
      ),
    ).toBe("Loads benzene and shows bonds.");
  });

  it("ignores a preamble that precedes the json (no flicker from tool round trips)", () => {
    expect(
      extractTrailingExplanation(
        'Let me fetch the molecule template.\n```json\n{ "version": 3 }\n```\nDone — shows the molecule.',
      ),
    ).toBe("Done — shows the molecule.");
  });

  it("returns an empty string while the JSON is still streaming (unclosed fence)", () => {
    expect(extractTrailingExplanation('```json\n{ "version": 3, "nodes": [')).toBe("");
  });

  it("returns an empty string when the response is only a closed fenced block", () => {
    expect(extractTrailingExplanation('```json\n{ "version": 3 }\n```')).toBe("");
  });

  it("returns an empty string when no fence is present yet", () => {
    expect(extractTrailingExplanation("Let me think about this request")).toBe("");
  });
});

describe("tryExtractPipeline", () => {
  it("returns null while the fence is still open (JSON streaming)", () => {
    expect(tryExtractPipeline('```json\n{ "version": 3, "nodes": [')).toBeNull();
  });

  it("returns null when no fence is present at all", () => {
    expect(tryExtractPipeline(`prefix ${MINIMAL_PIPELINE_JSON} suffix`)).toBeNull();
  });

  it("returns the parsed pipeline once a closed fence has arrived", () => {
    const result = tryExtractPipeline(`\`\`\`json\n${MINIMAL_PIPELINE_JSON}\n\`\`\``);
    expect(result?.version).toBe(3);
    expect(result?.nodes).toHaveLength(1);
  });

  it("returns null when a closed fence holds invalid JSON instead of throwing", () => {
    expect(tryExtractPipeline("```json\n{ not json }\n```")).toBeNull();
  });

  it("returns null when the fenced JSON has the wrong version", () => {
    const wrong = JSON.stringify({ version: 2, nodes: [], edges: [] });
    expect(tryExtractPipeline(`\`\`\`json\n${wrong}\n\`\`\``)).toBeNull();
  });
});
