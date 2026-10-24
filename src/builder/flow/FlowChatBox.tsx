/**
 * The AI assistant of Flow mode, docked under the Flow graph as the viewer's
 * is under its pipeline graph (the dock is the shared `AssistantDock`).
 *
 * Each request is sent with the flow in the graph, the blocks selected in it,
 * and the recent exchanges, so a follow-up edits the flow instead of
 * replacing it; the system prompt describes every block, the library
 * molecules, the Manual structure and the connected server's tools
 * (`ai/prompt.ts`). The model's flow is checked before it is accepted and
 * sent back for repair when something is wrong with it (`ai/check.ts`).
 *
 * The flow is applied the moment its JSON block closes, with the store's
 * `applyGenerated`: blocks the new flow keeps keep their results, and the
 * whole request is one Undo step, which the reply offers while it is the
 * last change. The assistant builds the graph; the user runs it. A request
 * waits while a run is in progress, since applying stops a run.
 */

import { useCallback } from "react";
import { useReactFlow } from "@xyflow/react";
import { extractTrailingExplanation, hasClosedFence } from "../../ai/generation";
import {
  AssistantDock,
  type AssistantReply,
  type AssistantRequest,
} from "../../components/AssistantDock";
import { FIT_VIEW_OPTIONS } from "../../components/graph/GraphCanvas";
import { useFlowStoreApi, useScopedFlowStore, useToolsStoreApi } from "../BuilderStores";
import { prepareGeneratedFlow, tryExtractFlow, type RawFlow } from "./ai/check";
import { formatFlowSummary, generateFlow } from "./ai/generate";
import { buildFlowEditRequest, type FlowPromptContext } from "./ai/prompt";
import type { FlowDeps } from "./engine";
import type { FlowNode } from "./store";
import { blockTitle } from "./titles";

/** Placeholder for the prompt bar, naming the selected block when there is one. */
export function flowPromptPlaceholder(selected: FlowNode[]): string {
  if (selected.length === 1) {
    return `Ask AI to change ${blockTitle(selected[0].data.params, null)} (${selected[0].id})…`;
  }
  if (selected.length > 1) return `Ask AI to change the ${selected.length} selected blocks…`;
  return "Ask AI to build or edit the flow…";
}

export interface FlowChatBoxProps {
  deps: FlowDeps;
  /** The host reaches tool servers (one may still not be connected). */
  hasTools: boolean;
}

export function FlowChatBox({ deps, hasTools }: FlowChatBoxProps) {
  const flowApi = useFlowStoreApi();
  const toolsApi = useToolsStoreApi();
  const { fitView } = useReactFlow();
  // A string selector, so dragging a block does not re-render the dock.
  const placeholder = useScopedFlowStore((s) =>
    flowPromptPlaceholder(s.nodes.filter((n) => n.selected)),
  );
  const latestCheckpointId = useScopedFlowStore(
    (s) => s.past[s.past.length - 1]?.generated ?? null,
  );
  const running = useScopedFlowStore((s) => !!s.running);

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
      const state = flowApi.getState();
      const connection = toolsApi.getState().connection;
      const doc = state.readDocument(deps.document());
      const ctx: FlowPromptContext = {
        library: deps.library(),
        tools: connection?.listing.tools ?? null,
        hostHasTools: hasTools,
        document: doc
          ? { name: doc.data.name, atoms: doc.data.snapshot.nAtoms, cell: !!doc.data.snapshot.box }
          : null,
      };
      const request = buildFlowEditRequest(prompt, {
        flow: state.nodes.length > 0 ? state.serialize() : null,
        selectedNodeIds: state.nodes.filter((n) => n.selected).map((n) => n.id),
        history,
      });

      // The first apply of a request records the Undo step; a later flow that
      // supersedes it (a repair round's fix) replaces the graph within it.
      let appliedJSON: string | null = null;
      let appliedCount = 0;
      const apply = (raw: RawFlow) => {
        const flow = prepareGeneratedFlow(raw, ctx);
        if (!flow) return;
        const json = JSON.stringify(flow);
        if (json === appliedJSON) return;
        const id = flowApi.getState().applyGenerated(flow, { checkpoint: appliedJSON === null });
        if (appliedJSON === null) onCheckpoint(id);
        appliedJSON = json;
        appliedCount = flow.nodes.length;
        // A tool block takes the tool's defaults for the settings it leaves out.
        if (connection) {
          flowApi
            .getState()
            .completeTools((name) => connection.listing.tools.find((t) => t.name === name) ?? null);
        }
        window.requestAnimationFrame(() => {
          void fitView({ ...FIT_VIEW_OPTIONS, duration: 300 });
        });
      };

      let buffer = "";
      const full = await generateFlow(
        config,
        request,
        ctx,
        (chunk) => {
          buffer += chunk;
          onChunk(chunk);
          const candidate = tryExtractFlow(buffer);
          if (candidate) apply(candidate);
        },
        signal,
        () => {
          // A repair round replaces this one's flow and sentence.
          buffer = "";
          onRestart();
        },
      );
      const last = tryExtractFlow(full);
      if (last) apply(last);

      if (appliedJSON === null) {
        // No flow: an answer in prose (a tool server is needed, say) is the reply.
        if (!hasClosedFence(full) && full.trim()) return { content: full.trim() };
        throw new Error("The reply held no flow.");
      }
      const explanation = extractTrailingExplanation(full);
      return explanation
        ? { content: explanation }
        : { content: formatFlowSummary(appliedCount), summary: true };
    },
    [flowApi, toolsApi, deps, hasTools, fitView],
  );

  const onUndo = useCallback(() => {
    const { past, undoGenerated } = flowApi.getState();
    const id = past[past.length - 1]?.generated;
    return id !== undefined && undoGenerated(id);
  }, [flowApi]);

  return (
    <AssistantDock
      run={run}
      placeholder={placeholder}
      emptyHint="Ask the assistant to build or edit the flow. It sees the blocks above, the ones you have selected, and the tools of the connected server; Run builds what it makes."
      latestCheckpointId={latestCheckpointId}
      onUndo={onUndo}
      blockedReason={running ? "Wait for the run to finish (or stop it) first" : null}
      testId="builder-flow-chat"
    />
  );
}
