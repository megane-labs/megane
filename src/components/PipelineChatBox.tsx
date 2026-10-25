/**
 * The AI assistant, docked under the pipeline editor's graph (the dock
 * itself is `AssistantDock`, shared with the Builder's Flow panel).
 *
 * Each request is sent with the pipeline currently in the editor, the nodes
 * selected in it, and the recent exchanges (see `ai/editContext.ts`), so the
 * assistant edits the graph instead of replacing it. The result is installed
 * with `applyGeneratedPipeline`, which keeps the loaded files attached and
 * records an undo checkpoint; the reply it produced offers "Undo" while that
 * checkpoint is the latest one.
 */

import { useCallback } from "react";
import { buildEditRequest } from "../ai/editContext";
import { summarizeStructure } from "../ai/structureSummary";
import type { SelfCheckContext } from "../ai/selfCheck";
import type { NodeSnapshotData } from "../pipeline/execute";
import type { PipelineNodeType, SerializedPipeline } from "../pipeline/types";
import { NODE_TYPE_LABELS } from "../pipeline/types";
import type { Frame, Snapshot, TrajectoryMeta } from "../types";
import { useScopedPipelineStore, usePipelineStoreApi } from "../stores/MeganeProvider";
import {
  AssistantDock,
  throwIfAborted,
  type AssistantRequest,
  type AssistantReply,
} from "./AssistantDock";

export { chatHistory, replaceTrailingAssistant, type ChatMessage } from "./AssistantDock";

/** The pipeline-store fields {@link resolveStructureContext} reads. */
interface StructureStateSlice {
  nodes: Array<{ id: string; type?: string; data: { params: unknown } }>;
  nodeSnapshots: Record<string, NodeSnapshotData>;
  snapshot: Snapshot | null;
  structureFrames: Frame[] | null;
  structureMeta: TrajectoryMeta | null;
}

/**
 * Resolve the structures the user currently has on screen, for the prompt's
 * structure summary and for running the generated pipeline during the
 * self-check.
 *
 * The store's global `snapshot` field is the primary structure, but a
 * structure opened into a loader node lives in that node's snapshot instead
 * (and so does one re-attached after the assistant rebuilt the graph with new
 * node ids). Falling back to the first `load_structure` node's snapshot keeps
 * both the summary and the self-check working either way.
 *
 * Every loader's own structure goes along too (`nodeSnapshots`, `loaderIds`),
 * so the self-check runs each generated loader against the structure it will
 * hold, as the store does, residue labels included.
 */
export function resolveStructureContext(state: StructureStateSlice): SelfCheckContext {
  const loaderIds = state.nodes.filter((n) => n.type === "load_structure").map((n) => n.id);
  const fallback = loaderIds.length > 0 ? (state.nodeSnapshots[loaderIds[0]] ?? null) : null;
  return {
    snapshot: state.snapshot ?? fallback?.snapshot ?? null,
    structureFrames: state.structureFrames ?? fallback?.frames ?? null,
    structureMeta: state.structureMeta ?? fallback?.meta ?? null,
    nodeSnapshots: state.nodeSnapshots,
    loaderIds,
  };
}

/** The labels the structure summary describes: the primary loader's residue labels. */
export function summaryLabels(ctx: SelfCheckContext): string[] | null {
  const primary = ctx.loaderIds?.[0];
  return (primary ? ctx.nodeSnapshots?.[primary]?.labels : null) ?? null;
}

/** Placeholder for the prompt bar, naming the selected node when there is one. */
export function promptPlaceholder(selected: { id: string; type?: string }[]): string {
  if (selected.length === 1) {
    const type = selected[0].type as PipelineNodeType | undefined;
    const label = (type && NODE_TYPE_LABELS[type]) || type || "node";
    return `Ask AI to change ${label} (${selected[0].id})…`;
  }
  if (selected.length > 1) return `Ask AI to change the ${selected.length} selected nodes…`;
  return "Ask AI to build or edit the pipeline…";
}

export function PipelineChatBox() {
  const pipelineApi = usePipelineStoreApi();
  // A string selector, so dragging a node does not re-render the dock.
  const placeholder = useScopedPipelineStore((s) =>
    promptPlaceholder(s.nodes.filter((n) => n.selected && n.type)),
  );
  const latestCheckpointId = useScopedPipelineStore(
    (s) => s.generatedUndoStack[s.generatedUndoStack.length - 1]?.id ?? null,
  );

  const run = useCallback(
    async ({
      prompt,
      history,
      config,
      signal,
      onChunk,
      onRestart,
      onCheckpoint,
    }: AssistantRequest): Promise<AssistantReply> => {
      // Everything the assistant needs to edit what is on screen: the graph,
      // the selection, and what was asked and answered before this request.
      const state = pipelineApi.getState();
      const request = buildEditRequest(prompt, {
        pipeline: state.serialize(),
        selectedNodeIds: state.nodes.filter((n) => n.selected).map((n) => n.id),
        history,
      });

      // Apply a generated pipeline. The first apply of a request records an
      // undo checkpoint; a later fence that supersedes it (a template echoed
      // before the model's final pipeline, or a repair round's fix) replaces
      // the graph again without stacking a second one. `appliedJSON` doubles
      // as the "have we applied yet?" guard.
      let appliedNodeCount = -1;
      let appliedJSON: string | null = null;
      const applyPipeline = (pipeline: SerializedPipeline) => {
        // Nothing lands once the request was cancelled or the dock went away.
        if (signal.aborted) return;
        const id = pipelineApi
          .getState()
          .applyGeneratedPipeline(pipeline, { checkpoint: appliedJSON === null });
        if (appliedJSON === null) onCheckpoint(id);
        appliedNodeCount = pipeline.nodes.length;
        appliedJSON = JSON.stringify(pipeline);
      };

      // Describe the currently loaded structure so the model can build filter
      // queries from the real elements/resnames present rather than guessing —
      // and so the self-check can run the generated pipeline against it.
      const checkContext = resolveStructureContext(state);
      const structureSummary = summarizeStructure(
        checkContext.snapshot ?? null,
        summaryLabels(checkContext),
      );

      // The generator (system prompt, skills, self-check) is only needed once
      // something is asked, so it loads with the first request rather than
      // with the page; the request itself takes far longer than the import.
      const {
        generatePipeline,
        tryExtractPipeline,
        looksLikePayload,
        formatActionSummary,
        extractTrailingExplanation,
      } = await import("../ai/client");

      let streamBuffer = "";
      const fullResponse = await generatePipeline(
        config,
        request,
        (chunk) => {
          streamBuffer += chunk;
          onChunk(chunk);
          // Apply (or re-apply) the graph as soon as a complete JSON payload
          // has streamed in. The model emits the JSON first, so the graph and
          // the viewport update without waiting for the trailing explanation.
          // This reads the reply exactly as the self-check does, so a repair
          // round's fix is applied however the model formatted it.
          const candidate = tryExtractPipeline(streamBuffer);
          if (candidate) {
            const candidateJSON = JSON.stringify(candidate);
            if (candidateJSON !== appliedJSON) {
              applyPipeline(candidate);
            }
          }
        },
        signal,
        structureSummary,
        checkContext,
        () => {
          // A repair round is starting: the round being replaced has already
          // streamed its JSON and explanation into the buffer, and leaving them
          // there would splice the old explanation onto the new one. Start the
          // placeholder over so the user sees the corrected answer only.
          streamBuffer = "";
          onRestart();
        },
      );

      throwIfAborted(signal);

      // The final round's pipeline may only be complete in the final text (or
      // have arrived after a tool round trip), so apply it now if streaming
      // has not.
      const final = tryExtractPipeline(fullResponse);
      if (final && JSON.stringify(final) !== appliedJSON) applyPipeline(final);

      if (appliedJSON === null) {
        // No pipeline: an answer in prose (what is in this file, which file to
        // open) is the reply. A fence or JSON object that holds no pipeline is
        // not prose.
        if (!looksLikePayload(fullResponse) && fullResponse.trim()) {
          return { content: fullResponse.trim() };
        }
        throw new Error("The reply held no pipeline.");
      }

      // Show the assistant's own explanation (the sentence that follows the
      // JSON payload); fall back to a generic summary if the model returned
      // only JSON with no prose.
      const explanation = extractTrailingExplanation(fullResponse);
      return explanation
        ? { content: explanation }
        : { content: formatActionSummary(appliedNodeCount), summary: true };
    },
    [pipelineApi],
  );

  const onUndo = useCallback(() => pipelineApi.getState().undoGeneratedPipeline(), [pipelineApi]);

  return (
    <AssistantDock
      run={run}
      placeholder={placeholder}
      emptyHint="Ask the assistant to build or edit the pipeline. It sees the graph above and the nodes you have selected."
      latestCheckpointId={latestCheckpointId}
      onUndo={onUndo}
      testId="pipeline-chat"
    />
  );
}
