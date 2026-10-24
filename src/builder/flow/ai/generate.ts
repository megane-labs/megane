/**
 * Generating a flow: one request to the provider the AI settings select,
 * through the conversation and repair loop the viewer's pipeline generator
 * uses (`ai/generation.ts`), with the Flow prompt and self-check.
 */

import type { AIConfig } from "../../../ai/config";
import { runGeneration } from "../../../ai/generation";
import { diagnoseFlowResponse } from "./check";
import { buildFlowSystemPrompt, type FlowPromptContext } from "./prompt";

/**
 * Send `userMessage` (already wrapped by `buildFlowEditRequest`) and return
 * the text of the last round. After each round the flow in the reply is
 * checked against what `ctx` says is there and the model is asked to fix
 * what is wrong, as for the viewer's pipelines; a reply in prose is left
 * alone. Flow mode has no skills: the blocks and examples are all in the
 * system prompt.
 */
export function generateFlow(
  config: AIConfig,
  userMessage: string,
  ctx: FlowPromptContext,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
  onRepairRound?: (round: number, errors: string[]) => void,
): Promise<string> {
  return runGeneration(
    config,
    {
      systemPrompt: buildFlowSystemPrompt(ctx),
      skills: [],
      diagnose: (text) => diagnoseFlowResponse(text, ctx),
    },
    userMessage,
    onChunk,
    signal,
    onRepairRound,
  );
}

/** The reply when the model wrote only the flow, no sentence. */
export function formatFlowSummary(blockCount: number): string {
  const noun = blockCount === 1 ? "block" : "blocks";
  return `Flow applied — ${blockCount} ${noun} in the graph. Run it to build the structure.`;
}
