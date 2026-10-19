/**
 * Compact node card for the split pipeline editor: category icon, title and a
 * one-line parameter summary. The node's form is edited in the properties
 * pane, so the card carries no controls of its own. The card itself is the
 * shared `NodeCardView` (`components/graph/`), which megane Builder's Flow
 * mode draws its blocks with too; this maps the pipeline store onto it.
 */

import type { PipelineNodeType, NodeError } from "../../pipeline/types";
import {
  NODE_TYPE_LABELS,
  NODE_PORTS,
  DATA_TYPE_COLORS,
  NODE_CATEGORY,
  NODE_CATEGORY_COLORS,
} from "../../pipeline/types";
import { summarizeNodeParams } from "../../pipeline/nodeSummary";
import { useScopedPipelineStore } from "../../stores/MeganeProvider";
import { NodeCardView, type CardPort } from "../graph/NodeCardView";
import { CATEGORY_ICONS } from "./categoryIcons";

export { NODE_CARD_CSS, NODE_CARD_WIDTH } from "../graph/NodeCardView";

const EMPTY_ERRORS: NodeError[] = [];

const QUERY_TYPES: ReadonlySet<PipelineNodeType> = new Set(["filter"]);

export function NodeCard({
  id,
  nodeType,
  enabled,
  disabledPorts,
}: {
  id: string;
  nodeType: PipelineNodeType;
  enabled: boolean;
  disabledPorts?: Set<string>;
}) {
  const node = useScopedPipelineStore((s) => s.nodes.find((n) => n.id === id));
  const errors = useScopedPipelineStore((s) => s.nodeErrors[id] ?? EMPTY_ERRORS);
  const ports = NODE_PORTS[nodeType];
  const category = NODE_CATEGORY[nodeType];
  const summary = node ? summarizeNodeParams(node.data.params) : "";
  const toCardPort = (port: (typeof ports.inputs)[number]): CardPort => ({
    name: port.name,
    label: port.label,
    color: DATA_TYPE_COLORS[port.dataType],
    disabled: disabledPorts?.has(port.name) ?? false,
  });

  const hasError = errors.some((e) => e.severity === "error");
  const statusColor = hasError ? "var(--megane-danger)" : errors.length > 0 ? "#f59e0b" : null;

  return (
    <NodeCardView
      testId={`pipeline-node-${nodeType}`}
      nodeId={id}
      title={NODE_TYPE_LABELS[nodeType]}
      summary={summary}
      monoSummary={QUERY_TYPES.has(nodeType)}
      summaryTestId="pipeline-node-summary"
      icon={CATEGORY_ICONS[category]}
      color={NODE_CATEGORY_COLORS[category]}
      inputs={ports.inputs.map(toCardPort)}
      outputs={ports.outputs.map(toCardPort)}
      enabled={enabled}
      selected={node?.selected === true}
      error={hasError}
      status={
        statusColor
          ? {
              color: statusColor,
              title: errors.map((e) => e.message).join("\n"),
              testId: "pipeline-node-status",
            }
          : null
      }
    />
  );
}
