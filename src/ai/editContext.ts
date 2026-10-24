/**
 * The context the chat sends along with each request, so the assistant edits
 * the pipeline that is in the editor instead of starting from nothing.
 *
 * Every request opens a fresh provider session (the self-check repair loop
 * needs the session to itself, and the free demo proxy caps the messages per
 * session), so continuity comes from this message rather than from a long-lived
 * conversation: it restates the recent exchanges, the current graph, and which
 * nodes the user has selected, then the request itself.
 *
 * The graph is sent compacted: a loader's structure-edit history can be long
 * and is carried over on apply anyway (see `pipeline/generatedApply.ts`), so it
 * is left out, and positions are rounded. Positions stay in, because the
 * schema the model is held to requires them and a graph shown without them
 * gets echoed back without them, costing a self-check repair round.
 */

import type { SerializedPipeline } from "../pipeline/types";

/** One finished exchange in the chat, oldest first. */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface EditContext {
  /** The pipeline in the editor right now, or null when there is none. */
  pipeline: SerializedPipeline | null;
  /** Ids of the nodes selected in the editor. */
  selectedNodeIds: string[];
  /** Earlier turns of this chat, oldest first. Only the most recent are sent. */
  history: ChatTurn[];
}

/** How many earlier turns are restated (a user turn and its reply are two). */
export const MAX_HISTORY_TURNS = 6;

/** Strip what the model does not need from the pipeline it is asked to edit. */
export function compactPipeline(pipeline: SerializedPipeline): unknown {
  return {
    version: pipeline.version,
    nodes: pipeline.nodes.map((node) => {
      const { position, enabled, ...rest } = node;
      const out: Record<string, unknown> = {
        ...rest,
        position: { x: Math.round(position?.x ?? 0), y: Math.round(position?.y ?? 0) },
      };
      if ("edits" in out) delete out.edits;
      if (enabled === false) out.enabled = false;
      return out;
    }),
    edges: pipeline.edges,
  };
}

/**
 * The section restating the most recent turns, or null when there are none.
 * Shared with the Builder's Flow assistant, whose requests carry the same.
 */
export function historySection(history: ChatTurn[]): string | null {
  const recent = history.slice(-MAX_HISTORY_TURNS);
  if (recent.length === 0) return null;
  const lines = recent.map((t) => `${t.role === "user" ? "User" : "You"}: ${t.content}`);
  return `## Conversation so far\n\n${lines.join("\n")}`;
}

/** Wrap `request` in the edit context. With no context at all it is sent as-is. */
export function buildEditRequest(request: string, ctx: EditContext): string {
  const sections: string[] = [];

  const history = historySection(ctx.history);
  if (history) sections.push(history);

  if (ctx.pipeline && ctx.pipeline.nodes.length > 0) {
    const selected = ctx.pipeline.nodes.filter((n) => ctx.selectedNodeIds.includes(n.id));
    let section =
      "## Current pipeline\n\n" +
      "The editor already holds this pipeline. Treat the request as an edit of it: " +
      "keep every node, id, edge, and parameter the request does not ask to change, " +
      "and output the COMPLETE updated pipeline (all nodes and edges, not a diff). " +
      "Only build a new pipeline from scratch when the request clearly asks for " +
      "something unrelated to this one. Files stay loaded whatever you set " +
      "`fileName` to.\n\n" +
      "```json\n" +
      JSON.stringify(compactPipeline(ctx.pipeline)) +
      "\n```";
    if (selected.length > 0) {
      const names = selected.map((n) => `\`${n.id}\` (${n.type})`).join(", ");
      section +=
        `\n\nSelected in the editor: ${names}. When the request says "this", ` +
        '"the selected node", or does not name a node, it means these.';
    }
    sections.push(section);
  }

  if (sections.length === 0) return request;
  sections.push(`## Request\n\n${request}`);
  return sections.join("\n\n");
}
