/**
 * The selected block's settings, under the Flow graph: a molecule's SMILES
 * or library entry, a tool's form (the same controls as the Tools menu's
 * form, minus the arguments that come in on wires), the block's last run,
 * and what can be done with its result.
 */

import { useMemo } from "react";
import type { StoreApi } from "zustand";
import { allMolecules, useLibraryStore } from "../library/store";
import type { BuilderToolInfo } from "../tools/contract";
import { initialValues, validate, type FormContext, type FormValues } from "../tools/form";
import { Fields } from "../tools/ToolDialog";
import {
  buttonStyle,
  hintStyle,
  inputStyle,
  rowStyle,
  sectionStyle,
  sectionTitleStyle,
  segmentGroupStyle,
  segmentStyle,
} from "../styles";
import {
  useBuilderStoreApi,
  useFlowStoreApi,
  useScopedBuilderStore,
  useScopedFlowStore,
  useScopedToolsStore,
} from "../BuilderStores";
import type { BuilderStore } from "../store";
import { shownSnapshot } from "../store";
import { blockTitle, runStatusColor, runStatusText } from "./describe";
import { incoming, type FlowDeps } from "./engine";
import { asLibraryMolecule, rowFields, toolPorts } from "./ports";
import type { FlowStore, FlowNode } from "./store";
import {
  IDLE_RUN,
  type DocumentParams,
  type FlowData,
  type MoleculeParams,
  type NodeRun,
  type ToolParams,
} from "./types";

const labelStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 3 };
const labelTextStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600 };

/** Put a block's result into Manual mode as a new document, and switch to it. */
export function openInManual(
  builder: StoreApi<BuilderStore>,
  flow: StoreApi<FlowStore>,
  data: FlowData,
): void {
  builder.getState().openStructure(data.snapshot, data.labels, data.name);
  builder.getState().reportInfo(`Opened ${data.name} from Flow (${data.snapshot.nAtoms} atoms).`);
  flow.getState().setMode("manual");
}

function MoleculeForm({ id, params }: { id: string; params: MoleculeParams }) {
  const updateParams = useScopedFlowStore((s) => s.updateParams);
  const user = useLibraryStore((s) => s.user);
  const library = useMemo(() => allMolecules({ user }), [user]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={segmentGroupStyle} role="radiogroup" aria-label="Molecule source">
        {(
          [
            ["smiles", "SMILES"],
            ["library", "Library"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={params.source === value}
            data-testid={`builder-flow-molecule-source-${value}`}
            style={segmentStyle(params.source === value)}
            onClick={() =>
              updateParams(id, {
                source: value,
                libraryId: params.libraryId || (library[0]?.id ?? ""),
              })
            }
          >
            {label}
          </button>
        ))}
      </div>
      {params.source === "smiles" ? (
        <label style={labelStyle}>
          <span style={labelTextStyle}>SMILES</span>
          <input
            data-testid="builder-flow-molecule-smiles"
            style={inputStyle}
            value={params.smiles}
            placeholder="e.g. CCO"
            spellCheck={false}
            onChange={(e) => updateParams(id, { smiles: e.target.value })}
          />
          <span style={{ ...hintStyle, fontSize: 11 }}>
            Embedded in 3D by RDKit (hydrogens added, MMFF94s) when the flow runs.
          </span>
        </label>
      ) : (
        <label style={labelStyle}>
          <span style={labelTextStyle}>Library molecule</span>
          <select
            data-testid="builder-flow-molecule-library"
            style={inputStyle}
            value={params.libraryId}
            onChange={(e) => updateParams(id, { libraryId: e.target.value })}
          >
            {library.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.formula})
              </option>
            ))}
          </select>
        </label>
      )}
      <label style={labelStyle}>
        <span style={labelTextStyle}>Name (optional)</span>
        <input
          data-testid="builder-flow-molecule-name"
          style={inputStyle}
          value={params.name}
          placeholder={params.source === "smiles" ? params.smiles || "molecule" : "library name"}
          onChange={(e) => updateParams(id, { name: e.target.value })}
        />
        <span style={{ ...hintStyle, fontSize: 11 }}>
          Tools use it as the residue name of the copies they make.
        </span>
      </label>
    </div>
  );
}

function DocumentForm(_: { params: DocumentParams }) {
  const source = useScopedBuilderStore((s) => s.source);
  const result = useScopedBuilderStore((s) => s.result);
  const showOriginal = useScopedBuilderStore((s) => s.showOriginal);
  const fileName = useScopedBuilderStore((s) => s.fileName);
  const shown = shownSnapshot({ source, result, showOriginal });
  return (
    <div style={hintStyle} data-testid="builder-flow-document-info">
      {shown
        ? `Uses ${fileName ?? "the structure"} as it is in Manual mode (${shown.nAtoms} atoms) when the flow runs.`
        : "Manual mode has no structure open. Open or build one there first."}
    </div>
  );
}

function ToolForm({
  node,
  params,
  tool,
}: {
  node: FlowNode;
  params: ToolParams;
  tool: BuilderToolInfo | null;
}) {
  const updateParams = useScopedFlowStore((s) => s.updateParams);
  const nodes = useScopedFlowStore((s) => s.nodes);
  const edges = useScopedFlowStore((s) => s.edges);
  const runs = useScopedFlowStore((s) => s.runs);
  const sources = useMemo(() => incoming({ nodes, edges }, node.id), [nodes, edges, node.id]);

  if (!tool) {
    return (
      <div style={{ ...hintStyle, color: "var(--megane-warning-text, #b45309)" }}>
        {`Connect to a tool server that offers ${params.label || params.tool} (Add › Tool server…) to edit or run this block.`}
      </div>
    );
  }
  const { ports, fields, problem } = toolPorts(tool);
  const upstream: Record<string, FlowData> = {};
  for (const ids of Object.values(sources)) {
    for (const src of ids) {
      const data = runs[src]?.data;
      if (data) upstream[src] = data;
    }
  }
  const docPort = ports.find((p) => p.kind === "document");
  const docId = docPort ? sources[docPort.key]?.[0] : undefined;
  const ctx: FormContext = {
    library: Object.entries(upstream).map(([src, d]) => asLibraryMolecule(src, d)),
    shown: docId ? (upstream[docId]?.snapshot ?? null) : null,
    selected: [],
  };
  const values: FormValues = { ...params.values };
  for (const port of ports) {
    if (!port.multiple && port.kind === "molecule") values[port.key] = sources[port.key]?.[0] ?? "";
  }
  const nameOf = (src: string) => {
    const n = nodes.find((x) => x.id === src);
    return runs[src]?.data?.name ?? (n ? blockTitle(n.data.params, null) : src);
  };
  const missing = ports.filter((p) => p.required && (sources[p.key]?.length ?? 0) === 0);
  const invalid = validate(fields, values, ctx);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={hintStyle} data-testid="builder-flow-tool-description">
        {tool.tooltip}
      </div>
      {problem && (
        <div role="alert" style={{ ...hintStyle, color: "var(--megane-danger-text, #b91c1c)" }}>
          {problem}
        </div>
      )}
      {ports.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={sectionTitleStyle}>Inputs</span>
          {ports.map((port) => {
            const ids = sources[port.key] ?? [];
            const columns = port.multiple ? rowFields(tool, port) : [];
            return (
              <div
                key={port.key}
                data-testid={`builder-flow-input-${port.key}`}
                style={{ display: "flex", flexDirection: "column", gap: 4 }}
              >
                <span style={labelTextStyle}>
                  {port.label}
                  <span style={{ ...hintStyle, fontWeight: 400 }}>
                    {port.multiple ? " · one row per wire" : ""}
                  </span>
                </span>
                {ids.length === 0 ? (
                  <span style={hintStyle}>
                    {`Wire a block's output to the “${port.label}” input on top of this block.`}
                  </span>
                ) : port.multiple ? (
                  ids.map((src) => (
                    <div
                      key={src}
                      data-testid={`builder-flow-row-${port.key}-${src}`}
                      style={{ ...sectionStyle, padding: 8, gap: 6 }}
                    >
                      <span style={{ fontSize: 12 }}>{nameOf(src)}</span>
                      <Fields
                        fields={columns}
                        values={{
                          ...initialValues(columns, ctx),
                          ...(params.rows[port.key]?.[src] ?? {}),
                        }}
                        onChange={(row) =>
                          updateParams(node.id, {
                            rows: {
                              ...params.rows,
                              [port.key]: { ...params.rows[port.key], [src]: row },
                            },
                          })
                        }
                        ctx={ctx}
                        testPrefix={`builder-flow-row-field-${src}`}
                      />
                    </div>
                  ))
                ) : (
                  <span style={hintStyle}>{nameOf(ids[0])}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {fields.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={sectionTitleStyle}>Settings</span>
          <Fields
            fields={fields}
            values={values}
            onChange={(next) => {
              const kept: FormValues = {};
              for (const f of fields) if (f.key in next) kept[f.key] = next[f.key];
              updateParams(node.id, { values: kept });
            }}
            ctx={ctx}
            testPrefix="builder-flow-field"
          />
        </div>
      )}
      {(missing.length > 0 || (invalid && Object.keys(upstream).length > 0)) && (
        <div
          data-testid="builder-flow-tool-problem"
          style={{ ...hintStyle, color: "var(--megane-warning-text, #b45309)" }}
        >
          {missing.length > 0
            ? `Connect ${missing.map((p) => p.label).join(", ")} before running.`
            : invalid}
        </div>
      )}
    </div>
  );
}

function RunSummary({ run }: { run: NodeRun }) {
  if (run.status === "idle") return null;
  return (
    <div
      data-testid="builder-flow-run-summary"
      data-status={run.status}
      style={{ display: "flex", flexDirection: "column", gap: 4 }}
    >
      <span
        role={run.status === "error" ? "alert" : undefined}
        style={{
          ...hintStyle,
          display: "flex",
          alignItems: "center",
          gap: 6,
          color:
            run.status === "error"
              ? "var(--megane-danger-text, #b91c1c)"
              : "var(--megane-text-secondary, #64748b)",
        }}
      >
        <span
          aria-hidden="true"
          style={{ width: 8, height: 8, borderRadius: "50%", background: runStatusColor(run) }}
        />
        {runStatusText(run)}
      </span>
      {run.status === "running" && (
        <div
          style={{
            height: 6,
            borderRadius: 3,
            background: "var(--megane-border, rgba(226,232,240,0.8))",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${Math.round((run.fraction ?? 0.05) * 100)}%`,
              background: "var(--megane-primary)",
              transition: "width 200ms",
            }}
          />
        </div>
      )}
      {run.summary && run.status !== "error" && <span style={hintStyle}>{run.summary}</span>}
      {run.warnings.map((w, k) => (
        <span key={k} style={{ ...hintStyle, color: "var(--megane-warning-text, #b45309)" }}>
          {w}
        </span>
      ))}
    </div>
  );
}

export interface FlowPropertiesProps {
  deps: FlowDeps;
}

/** The pane under the graph: the selected block, or a hint when none is. */
export function FlowProperties({ deps }: FlowPropertiesProps) {
  const nodes = useScopedFlowStore((s) => s.nodes);
  const runs = useScopedFlowStore((s) => s.runs);
  const running = useScopedFlowStore((s) => s.running);
  const run = useScopedFlowStore((s) => s.run);
  const removeNode = useScopedFlowStore((s) => s.removeNode);
  const connection = useScopedToolsStore((s) => s.connection);
  const edits = useScopedBuilderStore((s) => s.edits);
  const builderApi = useBuilderStoreApi();
  const flowApi = useFlowStoreApi();
  const node = nodes.find((n) => n.selected);

  if (!node) {
    return (
      <div style={{ ...hintStyle, padding: 4 }} data-testid="builder-flow-empty-hint">
        {nodes.length === 0
          ? "Add blocks from the Add menu on the left, wire each block's output (bottom) to an input (top) of the next, then press Run."
          : "Pick a block to edit it. Run builds every block; the 3D view shows the picked block's result."}
      </div>
    );
  }
  const params = node.data.params;
  const tool =
    params.type === "tool"
      ? (connection?.listing.tools.find((t) => t.name === params.tool) ?? null)
      : null;
  const nodeRun = runs[node.id] ?? IDLE_RUN;
  const data = nodeRun.status === "done" || nodeRun.status === "stale" ? nodeRun.data : null;

  return (
    <div
      data-testid="builder-flow-properties"
      data-node-id={node.id}
      style={{ display: "flex", flexDirection: "column", gap: 10 }}
    >
      <div style={{ ...rowStyle, justifyContent: "space-between" }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{blockTitle(params, tool)}</span>
        <button
          type="button"
          data-testid="builder-flow-delete-node"
          style={buttonStyle("danger", !!running)}
          disabled={!!running}
          onClick={() => removeNode(node.id)}
        >
          Delete
        </button>
      </div>
      {params.type === "molecule" && <MoleculeForm id={node.id} params={params} />}
      {params.type === "document" && <DocumentForm params={params} />}
      {params.type === "tool" && <ToolForm node={node} params={params} tool={tool} />}
      <RunSummary run={nodeRun} />
      <div style={{ ...rowStyle, justifyContent: "flex-end" }}>
        <button
          type="button"
          data-testid="builder-flow-run-node"
          style={buttonStyle("default", !!running)}
          disabled={!!running}
          title="Run this block and the blocks it needs"
          onClick={() => void run(deps, [node.id])}
        >
          Run to here
        </button>
        <button
          type="button"
          data-testid="builder-flow-open-manual"
          style={buttonStyle("primary", !data || !!running)}
          disabled={!data || !!running}
          title={
            edits.length > 0
              ? "Open this result in Manual mode; it replaces the open structure and its history"
              : "Open this result in Manual mode to edit or save it"
          }
          onClick={() => data && openInManual(builderApi, flowApi, data)}
        >
          Open in Manual
        </button>
      </div>
    </div>
  );
}
