/**
 * One conversation with the LLM provider the AI settings select, and the
 * self-check repair loop on top of it.
 *
 * Nothing here knows what is being generated: the caller hands
 * {@link runGeneration} a system prompt, the skills the model may fetch, and
 * a `diagnose` function that reads a reply and says what is wrong with it.
 * The viewer's pipeline generator (`client.ts`) and the Builder's Flow
 * assistant (`builder/flow/ai/`) are both built on it, so a fix to streaming,
 * tool calling, or the demo proxy's budget reaches both.
 *
 * Supports Anthropic (with tool_use for skills) and OpenAI-compatible APIs
 * (OpenAI and the free demo proxy) with streaming.
 */

import type { AIConfig } from "./config";
import {
  buildToolDefinitions,
  buildOpenAITools,
  executeSkill,
  type PipelineSkill,
  type ToolDefinition,
  type OpenAITool,
} from "./skillLoader";

/**
 * Thrown when the backend rejects the request with HTTP 429 — i.e. the
 * shared free-demo proxy's per-IP rate limit was exceeded. The proxy enforces
 * both a per-minute and a per-day cap and returns the same 429 for either, so
 * the message stays generic rather than claiming a specific window. Carries a
 * user-facing message so the chat surfaces the real reason instead of a
 * generic "something went wrong".
 */
export class RateLimitError extends Error {
  constructor(
    message = "Free demo rate limit reached. Please wait a bit and try again, or add your own API key in settings.",
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

// ─── Types for Anthropic SSE parsing ─────────────────────────────────

interface ToolUseAccumulator {
  id: string;
  name: string;
  inputJson: string;
}

interface AnthropicStreamResult {
  text: string;
  stopReason: string;
  toolUses: ToolUseAccumulator[];
}

// ─── Sessions ────────────────────────────────────────────────────────

/**
 * How many times the model may be asked to repair its own output before we
 * stop and hand back whatever it last produced. Each round is a full request,
 * so this bounds both latency and cost; two is enough for the failures the
 * self-check finds in practice (a mistyped edge or an overlapping branch is
 * fixed in one, and a second round covers a fix that introduces a new problem).
 */
export const MAX_REPAIR_ROUNDS = 2;

/**
 * Message budget the demo proxy enforces (`MAX_MESSAGES` in
 * `workers/llm-proxy/src/proxy.ts`); exceeding it makes the proxy reject the
 * request outright. A repair round costs two slots (the assistant reply plus
 * the repair prompt) and the model may spend two more on a skill round trip,
 * so the session stops repairing while fewer than four remain.
 */
const DEMO_MAX_MESSAGES = 12;

/**
 * One ongoing conversation with a provider.
 *
 * `send` appends a user message, drives the skill tool-use loop, records the
 * assistant's reply, and returns its text — so a repair round is simply a
 * second `send` on the same session, and the model still has its own JSON, the
 * skill templates it fetched, and the original request in view. (The previous
 * implementation restarted the conversation for the repair pass and had to
 * paste the broken pipeline back in, which threw away everything else.)
 */
interface GenerationSession {
  send(message: string, onChunk: (text: string) => void, signal?: AbortSignal): Promise<string>;
  /** False when another round would exceed the provider's message budget. */
  hasRoomForAnotherRound(): boolean;
}

/** Open a session against whichever provider the config selects. */
function createSession(
  config: AIConfig,
  systemPrompt: string,
  skills: PipelineSkill[],
): GenerationSession {
  if (config.provider === "anthropic") {
    const tools = buildToolDefinitions(skills);
    const messages: AnthropicMessage[] = [];
    return {
      send: (message, onChunk, signal) => {
        messages.push({ role: "user", content: message });
        return streamAnthropicWithSkills(
          config,
          systemPrompt,
          messages,
          skills,
          tools,
          onChunk,
          signal,
        );
      },
      hasRoomForAnotherRound: () => true,
    };
  }

  // OpenAI-compatible providers (and the PLaMo/OpenRouter-backed demo proxy)
  // speak the OpenAI tool-calling protocol, so the model fetches skill
  // templates on demand via function calls — the same on-demand behaviour
  // as the Anthropic path, no inlining required.
  const tools = buildOpenAITools(skills);
  const isDemo = config.provider === "demo";
  const messages: OpenAIChatMessage[] = [{ role: "system", content: systemPrompt }];
  const send: OpenAISender = isDemo ? demoProxySender() : openAISender(config);

  return {
    send: (message, onChunk, signal) => {
      messages.push({ role: "user", content: message });
      return streamOpenAICompatWithSkills(
        send,
        // The demo proxy chooses the model server-side.
        isDemo ? undefined : config.model,
        messages,
        skills,
        tools,
        onChunk,
        signal,
      );
    },
    hasRoomForAnotherRound: () => !isDemo || messages.length + 4 <= DEMO_MAX_MESSAGES,
  };
}

/** What one kind of generation brings to {@link runGeneration}. */
export interface GenerationSpec {
  systemPrompt: string;
  /** Skills the model may fetch with a tool call; empty for none. */
  skills: PipelineSkill[];
  /**
   * Read a reply and decide whether it needs another round: null when it is
   * acceptable as-is, else the follow-up prompt and the findings it lists.
   */
  diagnose: (text: string) => { prompt: string; errors: string[] } | null;
}

/**
 * Send `userMessage`, then repair: after each round the reply goes through
 * `spec.diagnose`, and whatever it finds is fed back into the same
 * conversation, up to {@link MAX_REPAIR_ROUNDS} times (fewer when the demo
 * proxy's message budget runs out). Returns the full text of the last round.
 *
 * `onRepairRound` fires just before each repair request goes out, so the caller
 * can discard the partial output of the round being replaced.
 */
export async function runGeneration(
  config: AIConfig,
  spec: GenerationSpec,
  userMessage: string,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
  onRepairRound?: (round: number, errors: string[]) => void,
): Promise<string> {
  const session = createSession(config, spec.systemPrompt, spec.skills);

  let text = await session.send(userMessage, onChunk, signal);

  for (let round = 1; round <= MAX_REPAIR_ROUNDS; round++) {
    const findings = spec.diagnose(text);
    if (!findings) break;
    if (!session.hasRoomForAnotherRound()) break;
    onRepairRound?.(round, findings.errors);
    text = await session.send(findings.prompt, onChunk, signal);
  }

  return text;
}

/** True when `text` contains a closed ```` ``` ```` fence pair. */
export function hasClosedFence(text: string): boolean {
  return /```(?:json)?\s*\n?[\s\S]*?```/.test(text);
}

// ─── Anthropic with tool_use ─────────────────────────────────────────

/** One entry in an Anthropic `messages` array (string or content blocks). */
interface AnthropicMessage {
  role: string;
  content: unknown;
}

/**
 * Output ceiling for the Anthropic path. It has to cover the model's reasoning
 * as well as the pipeline JSON: the default model thinks adaptively, and
 * thinking tokens are billed against `max_tokens`, so a ceiling sized for the
 * JSON alone truncates the answer mid-object. The demo proxy sets its own.
 */
const ANTHROPIC_MAX_TOKENS = 16000;

/**
 * Stream an Anthropic API call, handling tool_use for skills.
 * If Claude calls a skill tool, we execute it locally and send
 * the result back in a follow-up request.
 *
 * `messages` is the session's live history and is appended to in place: the
 * tool round trips are recorded as they happen and the final assistant reply is
 * added before returning, so a later repair round continues this conversation.
 */
async function streamAnthropicWithSkills(
  config: AIConfig,
  systemPrompt: string,
  messages: AnthropicMessage[],
  skills: PipelineSkill[],
  tools: ToolDefinition[],
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  // Allow up to 3 tool-use round trips to prevent infinite loops
  for (let turn = 0; turn < 4; turn++) {
    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system: systemPrompt,
      messages,
      stream: true,
    };

    // Only include tools if we have skills defined
    if (tools.length > 0) {
      body.tools = tools;
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      await response.text(); // consume body so the connection is released
      if (response.status === 429) throw new RateLimitError();
      throw new Error("Request failed. Please try again.");
    }

    const result = await readAnthropicSSE(response, onChunk);

    // If the model stopped with end_turn (text response), we're done — record
    // the reply so a repair round sees the pipeline it is being asked to fix.
    if (result.stopReason !== "tool_use") {
      messages.push({ role: "assistant", content: result.text });
      return result.text;
    }

    // Model wants to use tools — build the assistant message content blocks
    const assistantContent: unknown[] = [];
    if (result.text) {
      assistantContent.push({ type: "text", text: result.text });
    }
    for (const tu of result.toolUses) {
      let parsedInput = {};
      try {
        if (tu.inputJson) {
          parsedInput = JSON.parse(tu.inputJson);
        }
      } catch {
        // empty input is fine for skills with no parameters
      }
      assistantContent.push({
        type: "tool_use",
        id: tu.id,
        name: tu.name,
        input: parsedInput,
      });
    }
    messages.push({ role: "assistant", content: assistantContent });

    // Execute each tool and build tool_result messages
    const toolResults: unknown[] = [];
    for (const tu of result.toolUses) {
      const skillResult = executeSkill(skills, tu.name);
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: skillResult ?? `Unknown skill: ${tu.name}`,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  throw new Error("Too many tool-use rounds. Please try again.");
}

/**
 * Read Anthropic SSE stream, tracking both text deltas and tool_use blocks.
 */
async function readAnthropicSSE(
  response: Response,
  onChunk: (text: string) => void,
): Promise<AnthropicStreamResult> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";

  let text = "";
  let stopReason = "end_turn";
  const toolUses: ToolUseAccumulator[] = [];
  let activeToolUse: ToolUseAccumulator | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        const data = line.slice(6);
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        if (currentEvent === "content_block_start") {
          const block = parsed.content_block as Record<string, unknown> | undefined;
          if (block?.type === "tool_use") {
            activeToolUse = {
              id: block.id as string,
              name: block.name as string,
              inputJson: "",
            };
            toolUses.push(activeToolUse);
          }
        } else if (currentEvent === "content_block_delta") {
          const delta = parsed.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta") {
            const chunk = delta.text as string;
            text += chunk;
            onChunk(chunk);
          } else if (delta?.type === "input_json_delta" && activeToolUse) {
            activeToolUse.inputJson += delta.partial_json as string;
          }
        } else if (currentEvent === "content_block_stop") {
          activeToolUse = null;
        } else if (currentEvent === "message_delta") {
          const delta = parsed.delta as Record<string, unknown> | undefined;
          if (delta?.stop_reason) {
            stopReason = delta.stop_reason as string;
          }
        }
      } else if (line === "") {
        currentEvent = "";
      }
    }
  }

  return { text, stopReason, toolUses };
}

// ─── OpenAI-compatible tool calling (OpenAI API + demo proxy) ────────

interface OpenAIToolCallAccumulator {
  index: number;
  id: string;
  name: string;
  argsJson: string;
}

interface OpenAIStreamResult {
  text: string;
  finishReason: string;
  toolCalls: OpenAIToolCallAccumulator[];
}

/** Sends one request body and returns the raw streaming Response. */
type OpenAISender = (body: Record<string, unknown>, signal?: AbortSignal) => Promise<Response>;

interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
}

/**
 * Drive an OpenAI-compatible chat completion with the skill functions,
 * handling the tool-call round trip: when the model emits tool_calls we
 * run each skill locally and feed the result back, just like the Anthropic
 * path. `model` is omitted for the demo proxy, which picks it server-side.
 *
 * `messages` is the session's live history (system prompt first) and is
 * appended to in place, so a later repair round continues this conversation.
 */
async function streamOpenAICompatWithSkills(
  send: OpenAISender,
  model: string | undefined,
  messages: OpenAIChatMessage[],
  skills: PipelineSkill[],
  tools: OpenAITool[],
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  // Allow up to 3 tool-call round trips to prevent infinite loops.
  for (let turn = 0; turn < 4; turn++) {
    const body: Record<string, unknown> = { messages, stream: true };
    if (model) body.model = model;
    if (tools.length > 0) body.tools = tools;

    const response = await send(body, signal);
    if (!response.ok) {
      await response.text(); // consume body so the connection is released
      if (response.status === 429) throw new RateLimitError();
      throw new Error("Request failed. Please try again.");
    }

    const result = await readOpenAISSE(response, onChunk);

    if (result.finishReason !== "tool_calls" || result.toolCalls.length === 0) {
      // Record the reply so a repair round sees the pipeline it must fix.
      messages.push({ role: "assistant", content: result.text });
      return result.text;
    }

    // Echo the assistant's tool_calls back, then answer each one.
    messages.push({
      role: "assistant",
      content: result.text || null,
      tool_calls: result.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.argsJson || "{}" },
      })),
    });

    for (const tc of result.toolCalls) {
      const skillResult = executeSkill(skills, tc.name);
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: skillResult ?? `Unknown skill: ${tc.name}`,
      });
    }
  }

  throw new Error("Too many tool-use rounds. Please try again.");
}

/**
 * Read an OpenAI-compatible SSE stream, accumulating text deltas and any
 * streamed tool_calls (whose `arguments` arrive as fragments keyed by index).
 */
async function readOpenAISSE(
  response: Response,
  onChunk: (text: string) => void,
): Promise<OpenAIStreamResult> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let finishReason = "stop";
  const toolCallsByIndex = new Map<number, OpenAIToolCallAccumulator>();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }

      const choice = (parsed.choices as Array<Record<string, unknown>> | undefined)?.[0];
      if (!choice) continue;

      const delta = choice.delta as Record<string, unknown> | undefined;
      if (typeof delta?.content === "string" && delta.content) {
        text += delta.content;
        onChunk(delta.content);
      }

      const deltaToolCalls = delta?.tool_calls as Array<Record<string, unknown>> | undefined;
      if (deltaToolCalls) {
        for (const tc of deltaToolCalls) {
          const idx = typeof tc.index === "number" ? tc.index : 0;
          let acc = toolCallsByIndex.get(idx);
          if (!acc) {
            acc = { index: idx, id: "", name: "", argsJson: "" };
            toolCallsByIndex.set(idx, acc);
          }
          if (typeof tc.id === "string") acc.id = tc.id;
          const fn = tc.function as Record<string, unknown> | undefined;
          if (typeof fn?.name === "string") acc.name += fn.name;
          if (typeof fn?.arguments === "string") acc.argsJson += fn.arguments;
        }
      }

      if (typeof choice.finish_reason === "string") {
        finishReason = choice.finish_reason;
      }
    }
  }

  const toolCalls = [...toolCallsByIndex.values()].sort((a, b) => a.index - b.index);
  return { text, finishReason, toolCalls };
}

/** Post directly to the OpenAI chat-completions endpoint with the user's key. */
function openAISender(config: AIConfig): OpenAISender {
  return (body, signal) =>
    fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
}

// ─── Demo proxy (no API key required) ────────────────────────────────

/**
 * Post to the docs-demo Cloudflare Worker proxy. The proxy holds its own
 * provider API keys (PLaMo and/or OpenRouter), picks the provider and model
 * server-side, and speaks the OpenAI tool-calling protocol, so the same skill
 * round trip works end to end.
 */
function demoProxySender(): OpenAISender {
  return (body, signal) => {
    const proxyUrl = import.meta.env.VITE_LLM_PROXY_URL;
    if (!proxyUrl) {
      return Promise.reject(new Error("The free demo is not available in this build."));
    }
    return fetch(proxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  };
}

// ─── Reading a reply ─────────────────────────────────────────────────

/**
 * Return only the natural-language explanation that follows the *last* closed
 * ```` ```json ```` fence, or an empty string when no fence has closed yet.
 *
 * Unlike `stripPipelineJSON` (`client.ts`), this deliberately ignores any prose that
 * appears *before* the fence — during a skill tool round trip the model often
 * streams a short preamble before emitting the JSON, and surfacing it would
 * make the chat flicker (preamble shown, then reverting to a placeholder once
 * the JSON starts streaming). The system prompt puts the JSON first and the
 * one-sentence explanation immediately after it, so the trailing text is the
 * only thing worth showing. Because that text only ever grows as it streams,
 * the displayed reply is monotonic — it never jumps back to "Generating…".
 */
export function extractTrailingExplanation(text: string): string {
  const lastFenceEnd = text.lastIndexOf("```");
  if (lastFenceEnd === -1) return "";
  // A single ``` means a fence has opened but not closed yet — still streaming
  // the JSON, so there is no trailing explanation to show.
  const fenceCount = (text.match(/```/g) ?? []).length;
  if (fenceCount % 2 !== 0) return "";
  return text.slice(lastFenceEnd + 3).trim();
}

/**
 * The parsed JSON of the *last* closed ```` ``` ```` fence in `text` that
 * `accept` takes, or null when none does.
 *
 * A less precise model can stream an earlier fence (e.g. echoing a fetched
 * skill template) that also parses, so the last acceptable one — the model's
 * final answer — wins.
 */
export function lastFencedJSON<T>(text: string, accept: (value: unknown) => value is T): T | null {
  const fenceRe = /```(?:json)?\s*\n?([\s\S]*?)```/g;
  let result: T | null = null;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(text)) !== null) {
    try {
      const parsed: unknown = JSON.parse(match[1].trim());
      if (accept(parsed)) result = parsed;
    } catch {
      // Not JSON — skip this fence.
    }
  }
  return result;
}
