/**
 * One block in the Flow graph, drawn with the viewer's node card
 * (`components/graph/NodeCardView`): the block's category icon, its title, a
 * line with its settings and how its last run went, a status dot, an input
 * handle on top per input and the structure it puts out at the bottom. The
 * block a Run makes the Manual structure carries an Output tag. The block is
 * edited in the pane under the graph.
 */

import { memo, useMemo } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { NodeCardView } from "../../components/graph/NodeCardView";
import { allMolecules, useLibraryStore } from "../library/store";
import { useScopedFlowStore, useScopedToolsStore } from "../BuilderStores";
import {
  STRUCTURE_COLOR,
  blockColor,
  blockIcon,
  blockSummary,
  blockTitle,
  runStatusDot,
} from "./describe";
import { OutputBadge } from "./FlowProperties";
import { blockPorts } from "./ports";
import { outputNodeId } from "./store";
import { FLOW_NODE_TYPES, IDLE_RUN, OUTPUT_HANDLE, type FlowNodeData } from "./types";

export const FlowNodeCard = memo(function FlowNodeCard({
  id,
  data,
  selected,
}: NodeProps<Node<FlowNodeData>>) {
  const params = data.params;
  const run = useScopedFlowStore((s) => s.runs[id] ?? IDLE_RUN);
  const edges = useScopedFlowStore((s) => s.edges);
  const isOutput = useScopedFlowStore((s) => outputNodeId(s) === id);
  const connection = useScopedToolsStore((s) => s.connection);
  const user = useLibraryStore((s) => s.user);
  const tool =
    params.type === "tool"
      ? (connection?.listing.tools.find((t) => t.name === params.tool) ?? null)
      : null;
  const wired = useMemo(
    () => edges.filter((e) => e.target === id).map((e) => e.targetHandle ?? ""),
    [edges, id],
  );
  const library = useMemo(() => allMolecules({ user }), [user]);
  const inputs = blockPorts(params, tool, wired).map((port) => ({
    name: port.key,
    label: port.multiple ? `${port.label} (any number)` : port.label,
    color: STRUCTURE_COLOR,
  }));

  return (
    <>
      {isOutput && (
        // The xyflow node wrapper is positioned: the tag sits on the card's top edge.
        <OutputBadge style={{ position: "absolute", top: -8, right: 10, zIndex: 1 }} />
      )}
      <NodeCardView
        testId={`builder-flow-node-${params.type}`}
        nodeId={id}
        title={blockTitle(params, tool, library)}
        summary={blockSummary(params, run, library)}
        summaryTestId="builder-flow-node-summary"
        icon={blockIcon(params)}
        color={blockColor(params)}
        inputs={inputs}
        outputs={[{ name: OUTPUT_HANDLE, label: "Structure", color: STRUCTURE_COLOR }]}
        selected={!!selected}
        error={run.status === "error"}
        status={runStatusDot(run)}
        data={{ "data-status": run.status, "data-output": isOutput ? "true" : "false" }}
      />
    </>
  );
});

/** xyflow node types of the Flow graph: every block uses the same card. */
export const flowNodeTypes = Object.fromEntries(FLOW_NODE_TYPES.map((t) => [t, FlowNodeCard]));
