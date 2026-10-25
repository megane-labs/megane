/**
 * Pipeline JSON extraction for the LLM benchmark.
 *
 * This is a faithful port of the pure extraction helpers in
 * `src/ai/client.ts` (`findLastValidPipeline`, `extractPipelineJSON`,
 * `tryExtractPipeline`, `stripPipelineJSON`, `extractTrailingExplanation`).
 * The production helpers live in a module that pulls in Vite-only APIs
 * (`import.meta.glob` via the skill loader) and browser streaming, so they
 * cannot be imported under a plain Node/vitest runner. We re-implement only
 * the IO-free parts here and pin the behaviour with unit tests so the
 * benchmark scores the *real* extraction contract, not a looser one.
 */

import type { SerializedPipeline } from "@/pipeline/types";

/** Narrow a parsed value to a SerializedPipeline (version 3, nodes/edges arrays). */
export function isSerializedPipeline(value: unknown): value is SerializedPipeline {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.version === 3 && Array.isArray(v.nodes) && Array.isArray(v.edges);
}

/**
 * Scan every closed fence pair and return the parsed pipeline from the *last*
 * one that validates as a SerializedPipeline, or `null` if none do. Mirrors the
 * production `findLastValidPipeline`, which prefers the model's final answer
 * over any earlier template/preamble echo.
 */
export function findLastValidPipeline(text: string): SerializedPipeline | null {
  // Any language label in any case (```json, ```JSON, ```jsonc, none), as in
  // production's `fencePattern`.
  const fenceRe = /```[^\S\n]*[\w.+-]*[^\S\n]*\n?([\s\S]*?)```/g;
  let result: SerializedPipeline | null = null;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (isSerializedPipeline(parsed)) {
        result = parsed;
      }
    } catch {
      // Not JSON (or not a pipeline) — skip this fence.
    }
  }
  return result;
}

/** Result of a tolerant extraction attempt against a full model response. */
export interface ExtractionResult {
  /** The parsed pipeline, or null when nothing valid was found. */
  pipeline: SerializedPipeline | null;
  /** How the pipeline (if any) was recovered. Drives the format dimension. */
  source: "fenced" | "bare" | "none";
  /** Number of closed fenced blocks (any language) in the response. */
  fenceCount: number;
  /** Whether a fenced block was left unclosed (odd number of ``` markers). */
  hasUnclosedFence: boolean;
}

/**
 * Tolerant extraction used by the benchmark. Unlike the production
 * `extractPipelineJSON` (which throws for precise UI error reporting), this
 * never throws — a malformed response simply scores zero on schema/format.
 * It records *how* the pipeline was recovered so the format dimension can
 * reward fenced output over a bare `{...}` fallback.
 */
export function extractPipeline(response: string): ExtractionResult {
  const markerCount = (response.match(/```/g) ?? []).length;
  const hasUnclosedFence = markerCount % 2 !== 0;
  const fenceCount = Math.floor(markerCount / 2);

  const fromFence = findLastValidPipeline(response);
  if (fromFence) {
    return { pipeline: fromFence, source: "fenced", fenceCount, hasUnclosedFence };
  }

  // Fallback: first `{` to last `}` (matches the production fallback path).
  const start = response.indexOf("{");
  const end = response.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(response.slice(start, end + 1));
      if (isSerializedPipeline(parsed)) {
        return { pipeline: parsed, source: "bare", fenceCount, hasUnclosedFence };
      }
    } catch {
      // fall through
    }
  }

  return { pipeline: null, source: "none", fenceCount, hasUnclosedFence };
}

/**
 * Return only the natural-language explanation that follows the *last* closed
 * fence, or an empty string when no fence has closed yet. Mirrors the
 * production `extractTrailingExplanation`.
 */
export function extractTrailingExplanation(text: string): string {
  const lastFenceEnd = text.lastIndexOf("```");
  if (lastFenceEnd === -1) return "";
  const fenceCount = (text.match(/```/g) ?? []).length;
  if (fenceCount % 2 !== 0) return "";
  return text.slice(lastFenceEnd + 3).trim();
}
