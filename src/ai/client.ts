/**
 * LLM pipeline generation for the viewer's pipeline editor: the system
 * prompt, the skills, and the self-check that decides whether a reply needs
 * a repair round. The provider conversation and the repair loop itself live
 * in `generation.ts`, shared with the Builder's Flow assistant.
 */

import type { AIConfig } from "./config";
import type { SerializedPipeline } from "../pipeline/types";
import { buildSystemPrompt } from "./prompt";
import {
  collectPipelineErrors,
  buildRepairPrompt,
  buildUnparsablePipelinePrompt,
} from "./validatePipeline";
import type { SelfCheckContext } from "./selfCheck";
import { getSkills } from "./skillLoader";
import { fencePattern, lastJSONPayload, looksLikePayload, runGeneration } from "./generation";

export {
  MAX_REPAIR_ROUNDS,
  RateLimitError,
  extractTrailingExplanation,
  looksLikePayload,
} from "./generation";

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Generate a pipeline by calling the LLM API with streaming.
 * Returns the full response text of the final round.
 *
 * When `structureSummary` is provided it is appended to the system prompt so
 * the model can reference the real elements/resnames present when building
 * filter queries.
 *
 * After each round the pipeline is checked — schema, selection-query syntax,
 * edge typing, overlapping viewport branches, and (when `checkContext` carries
 * a loaded structure) what the executor actually reports when the graph is run.
 * Anything found is fed back into the same conversation and the model is asked
 * to fix it, up to {@link MAX_REPAIR_ROUNDS} times. A response with no pipeline
 * in it is left alone, so plain-text replies are unaffected.
 *
 * `onRepairRound` fires just before each repair request goes out, so the caller
 * can discard the partial output of the round being replaced.
 */
export async function generatePipeline(
  config: AIConfig,
  userMessage: string,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
  structureSummary?: string | null,
  checkContext: SelfCheckContext = {},
  onRepairRound?: (round: number, errors: string[]) => void,
): Promise<string> {
  return runGeneration(
    config,
    {
      systemPrompt: buildSystemPrompt(structureSummary),
      skills: getSkills(),
      diagnose: (text) => diagnoseResponse(text, checkContext),
    },
    userMessage,
    onChunk,
    signal,
    onRepairRound,
  );
}

/**
 * Decide whether a response needs another round, and with what prompt.
 * Returns null when the response is acceptable as-is.
 *
 * Exported so the prompt benchmark drives the identical loop — a divergence
 * here would make its scores describe something users never run.
 *
 * There are three outcomes. A pipeline that checks out is done. A pipeline with
 * findings gets the standard repair prompt. A response that *tried* to emit a
 * pipeline (it has a code fence, closed or not, or a JSON object; see
 * `looksLikePayload`) but produced nothing parsable is the worst case (nothing
 * can be applied at all), so it is asked for the JSON again; without this it
 * would be the one failure the loop silently accepted. A reply with neither is
 * prose, e.g. the model asking which file to load, and is deliberately left
 * alone.
 */
export function diagnoseResponse(
  text: string,
  checkContext: SelfCheckContext,
): { prompt: string; errors: string[] } | null {
  const pipeline = tryExtractPipeline(text);
  if (!pipeline) {
    if (!looksLikePayload(text)) return null;
    const message = "the fenced block is not valid, complete pipeline JSON";
    return { prompt: buildUnparsablePipelinePrompt(), errors: [message] };
  }

  const errors = collectPipelineErrors(pipeline, checkContext);
  if (errors.length === 0) return null;
  return { prompt: buildRepairPrompt(errors), errors };
}

// ─── Action summary ──────────────────────────────────────────────────

/** Returns a brief user-facing description of the applied pipeline. */
export function formatActionSummary(nodeCount: number): string {
  const noun = nodeCount === 1 ? "node" : "nodes";
  return `Pipeline applied — ${nodeCount} ${noun} added to the editor.`;
}

/**
 * Strip the pipeline JSON from an LLM response, returning just the surrounding
 * natural-language text. Used to show the assistant's explanation in the chat
 * without the machine-readable payload.
 *
 * The system prompt puts the fenced JSON block first and the one-sentence
 * explanation immediately after it, so we remove any *closed* ```` ```json ````
 * fence wherever it sits and return the remaining prose. While the JSON is
 * still streaming (an unclosed fence, or a bare `{` with no fence yet) there is
 * no prose to show, so we return an empty string and let the caller fall back
 * to a "Generating…" placeholder — this guarantees a half-written payload is
 * never surfaced to the user.
 */
export function stripPipelineJSON(text: string): string {
  const withoutFence = text.replace(fencePattern(), "").trim();
  if (withoutFence !== text.trim()) {
    return withoutFence;
  }
  // No closed fence: the JSON is still streaming (or arrived unfenced). Surface
  // nothing rather than a partial object.
  if (text.includes("```") || text.includes("{")) {
    return "";
  }
  return text.trim();
}

// ─── JSON extraction ─────────────────────────────────────────────────

/** Narrow a parsed value to a SerializedPipeline (version 3, nodes/edges arrays). */
function isSerializedPipeline(value: unknown): value is SerializedPipeline {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.version === 3 && Array.isArray(v.nodes) && Array.isArray(v.edges);
}

/**
 * The *last* pipeline payload in `text`, fenced (any label) or bare, or `null`
 * if there is none (see `lastJSONPayload`).
 *
 * The system prompt asks for the pipeline JSON first and a one-sentence
 * explanation last, but a less precise model can stream an earlier fence
 * (e.g. echoing a fetched skill template) that also happens to be valid
 * pipeline JSON. Preferring the *last* valid payload picks the model's final
 * answer over any earlier preamble/template echo.
 */
function findLastValidPipeline(text: string): SerializedPipeline | null {
  return lastJSONPayload(text, isSerializedPipeline)?.value ?? null;
}

/**
 * Extract a SerializedPipeline JSON from the LLM response text.
 * Prefers the last payload that validates as a pipeline (see
 * {@link findLastValidPipeline}); falls back to the first ```` ``` ````
 * fenced block (or raw `{...}` extraction) for precise error reporting when
 * no fence holds valid pipeline JSON.
 */
export function extractPipelineJSON(response: string): SerializedPipeline {
  const fromFence = findLastValidPipeline(response);
  if (fromFence) return fromFence;

  // Try fenced code block first
  const fenceMatch = fencePattern().exec(response);
  let jsonStr: string;

  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  } else {
    // Fallback: find first { to last }
    const start = response.indexOf("{");
    const end = response.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("No JSON found in the response. Please try again.");
    }
    jsonStr = response.slice(start, end + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`Failed to parse JSON: ${(e as Error).message}`);
  }

  const pipeline = parsed as SerializedPipeline;
  if (pipeline.version !== 3) {
    throw new Error(`Unexpected pipeline version: ${pipeline.version}`);
  }
  if (!Array.isArray(pipeline.nodes) || !Array.isArray(pipeline.edges)) {
    throw new Error("Invalid pipeline: missing nodes or edges array.");
  }

  return pipeline;
}

/**
 * Try to extract a complete pipeline from a partial streaming buffer, returning
 * the parsed pipeline as soon as a complete payload (a closed fence, or a bare
 * object whose last brace has arrived) validates (see
 * {@link findLastValidPipeline}), or `null` otherwise.
 * Unlike {@link extractPipelineJSON} this never throws on incomplete or
 * invalid input, so it is safe to call on every streamed chunk to apply (or
 * re-apply, once a later payload validates) the graph without waiting for the
 * trailing one-sentence explanation. The chat box, the self-check
 * (`diagnoseResponse`) and the final apply all read a reply through it, so
 * they agree on what the reply holds.
 */
export function tryExtractPipeline(partial: string): SerializedPipeline | null {
  return findLastValidPipeline(partial);
}
