/**
 * Live generation for the Flow benchmark: the production Flow system prompt
 * (`buildFlowSystemPrompt`) and self-check (`diagnoseFlowResponse`), built for
 * the case's environment exactly as `FlowChatBox` builds them, driven through
 * the pipeline benchmark's provider transports and repair loop
 * (`generateLive`), so both benchmarks talk to the same providers the same
 * way.
 */

import { diagnoseFlowResponse } from "@/builder/flow/ai/check";
import { buildFlowEditRequest, buildFlowSystemPrompt } from "@/builder/flow/ai/prompt";
import {
  generateLive,
  type FetchLike,
  type GenerationStats,
  type ProviderConfig,
} from "../llm/providers";
import type { FlowEnvironment } from "./environment";
import type { FlowBenchCase } from "./types";

/** The message a case sends: its request, wrapped in the flow it edits, as the chat sends it. */
export function flowRequest(c: FlowBenchCase): string {
  return buildFlowEditRequest(c.prompt, {
    flow: c.setup.flow ?? null,
    selectedNodeIds: c.setup.selected ?? [],
    history: [],
  });
}

/** The assistant's reply to `c`, after the self-check's repair rounds. */
export function generateFlowLive(
  config: ProviderConfig,
  c: FlowBenchCase,
  env: FlowEnvironment,
  fetchImpl: FetchLike = fetch,
  stats?: GenerationStats,
): Promise<string> {
  return generateLive(
    config,
    {
      system: buildFlowSystemPrompt(env.prompt),
      skills: [],
      diagnose: (text) => diagnoseFlowResponse(text, env.prompt),
    },
    flowRequest(c),
    fetchImpl,
    stats,
  );
}
