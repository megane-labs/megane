/**
 * The pane under the Flow graph: the selected block, edited the way the
 * viewer's properties pane edits a pipeline node — the shared header (icon,
 * name, summary, remove), the block's errors and warnings, then its form in
 * the viewer's node-form rows. A molecule's SMILES or library entry; a tool's
 * form (the Tools menu's fields in the node-form look, minus the arguments
 * that come in on wires); the block's run; and what to do with its result.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { StoreApi } from "zustand";
import {
  NodeMessages,
  PropertiesEmpty,
  PropertiesHeader,
  PropertiesPaneView,
  type PaneMessage,
} from "../../components/graph/GraphProperties";
import { Field, FormStack, Section } from "../../components/nodes/form";
import {
  hintStyle,
  inputStyle,
  nodeButtonStyle,
  selectStyle,
} from "../../components/nodes/formStyles";
import { TabSelector } from "../../components/ui";
import { allMolecules, useLibraryStore } from "../library/store";
import type { LibraryMolecule } from "../library/types";
import type { BuilderToolInfo } from "../tools/contract";
import { initialValues, validate, type FormContext, type FormValues } from "../tools/form";
import { Fields, FieldsLookContext, NODE_FORM_LOOK } from "../tools/ToolFields";
import { ToolServerDialog } from "../tools/ToolServer";
import {
  useBuilderStoreApi,
  useFlowStoreApi,
  useScopedBuilderStore,
  useScopedFlowStore,
  useScopedToolsStore,
} from "../BuilderStores";
import type { BuilderStore } from "../store";
import { confirmDiscard, shownSnapshot } from "../store";
import {
  blockColor,
  blockIcon,
  blockName,
  blockSummary,
  blockTitle,
  runStatusColor,
  runStatusHollow,
  runStatusLabel,
  runStatusText,
} from "./describe";
import { BuiltinForm } from "./BuiltinForms";
import { incoming, type FlowDeps } from "./engine";
import { asLibraryMolecule, rowFields, toolPorts } from "./ports";
import { adoptResult, runTo } from "./shared";
import { outputNodeId, type FlowStore, type FlowNode } from "./store";
import {
  IDLE_RUN,
  type DocumentParams,
  type FlowData,
  type MoleculeParams,
  type NodeRun,
  type ToolParams,
} from "./types";

/** A full-width action of the pane, in the node-form look; `primary` is the commit. */
function actionStyle(primary: boolean, disabled: boolean): React.CSSProperties {
  return {
    ...nodeButtonStyle,
    flex: 1,
    width: "auto",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.5 : 1,
    ...(primary
      ? {
          background: "var(--megane-primary)",
          borderColor: "var(--megane-primary)",
          color: "#fff",
        }
      : {}),
  };
}

const warningTextStyle: React.CSSProperties = {
  ...hintStyle,
  color: "var(--megane-warning-text)",
};

/**
 * Make a block's result the structure shared with Manual mode (a new
 * document), and switch to Manual mode, after asking when the open document
 * has unsaved edits. Resolves to whether it did.
 */
export async function openInManual(
  builder: StoreApi<BuilderStore>,
  flow: StoreApi<FlowStore>,
  data: FlowData,
  key: string | null = null,
): Promise<boolean> {
  if (!(await confirmDiscard(builder, `Opening ${data.name} in Manual`))) return false;
  adoptResult(builder, flow, data, key);
  builder.getState().reportInfo(`Opened ${data.name} from Flow (${data.snapshot.nAtoms} atoms).`);
  flow.getState().setMode("manual");
  return true;
}

function MoleculeForm({
  id,
  params,
  library,
}: {
  id: string;
  params: MoleculeParams;
  library: LibraryMolecule[];
}) {
  const updateParams = useScopedFlowStore((s) => s.updateParams);
  return (
    <FormStack>
      <Field label="Source" group>
        <TabSelector<MoleculeParams["source"]>
          size="compact"
          ariaLabel="Molecule source"
          options={[
            { value: "smiles", label: "SMILES" },
            { value: "library", label: "Library" },
          ]}
          value={params.source}
          testIdFor={(v) => `builder-flow-molecule-source-${v}`}
          onChange={(value) =>
            updateParams(id, {
              source: value,
              libraryId: params.libraryId || (library[0]?.id ?? ""),
            })
          }
        />
      </Field>
      {params.source === "smiles" ? (
        <Field label="SMILES">
          <input
            data-testid="builder-flow-molecule-smiles"
            style={inputStyle}
            value={params.smiles}
            placeholder="e.g. CCO"
            spellCheck={false}
            onChange={(e) => updateParams(id, { smiles: e.target.value })}
          />
        </Field>
      ) : (
        <Field label="Molecule">
          <select
            data-testid="builder-flow-molecule-library"
            style={selectStyle}
            value={params.libraryId}
            onChange={(e) => updateParams(id, { libraryId: e.target.value })}
          >
            {!library.some((m) => m.id === params.libraryId) && (
              <option value={params.libraryId} disabled>
                Missing molecule — choose one
              </option>
            )}
            {library.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.formula})
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Name">
        <input
          data-testid="builder-flow-molecule-name"
          style={inputStyle}
          value={params.name}
          placeholder={params.source === "smiles" ? params.smiles || "optional" : "optional"}
          onChange={(e) => updateParams(id, { name: e.target.value })}
        />
      </Field>
      <span style={hintStyle}>
        {params.source === "smiles"
          ? "Embedded in 3D by RDKit (hydrogens added, MMFF94s) when the flow runs. "
          : ""}
        Tools use the name as the residue name of the copies they make.
      </span>
    </FormStack>
  );
}

function DocumentForm({ deps }: { params: DocumentParams; deps: FlowDeps }) {
  const source = useScopedBuilderStore((s) => s.source);
  const result = useScopedBuilderStore((s) => s.result);
  const showOriginal = useScopedBuilderStore((s) => s.showOriginal);
  const fileName = useScopedBuilderStore((s) => s.fileName);
  const pinned = useScopedFlowStore((s) => s.pinnedDocument);
  const shown = shownSnapshot({ source, result, showOriginal });
  // While the document is still the flow's own result, the block reads the one before it.
  const doc = shown ? deps.document() : null;
  const base = doc && pinned && doc.key === pinned.adoptedDocKey ? pinned.base : null;
  return (
    <div style={hintStyle} data-testid="builder-flow-document-info">
      {base
        ? `Uses ${base.data.name} as it was before Run replaced it with this flow's result (${base.data.snapshot.nAtoms} atoms), so running again builds the same model. Edit the structure in Manual mode to use it instead.`
        : shown
          ? `Uses ${fileName ?? "the structure"} as it is in Manual mode (${shown.nAtoms} atoms) when the flow runs.`
          : "Manual mode has no structure open. Open or build one there first."}
    </div>
  );
}

function ToolForm({
  node,
  params,
  tool,
  library,
  hasTools,
  onOpenServer,
}: {
  node: FlowNode;
  params: ToolParams;
  tool: BuilderToolInfo | null;
  library: LibraryMolecule[];
  hasTools: boolean;
  onOpenServer?: () => void;
}) {
  const updateParams = useScopedFlowStore((s) => s.updateParams);
  const nodes = useScopedFlowStore((s) => s.nodes);
  const edges = useScopedFlowStore((s) => s.edges);
  const runs = useScopedFlowStore((s) => s.runs);
  const connection = useScopedToolsStore((s) => s.connection);
  const sources = useMemo(() => incoming({ nodes, edges }, node.id), [nodes, edges, node.id]);

  if (!tool) {
    const name = params.label || params.tool;
    if (!hasTools) {
      return (
        <div style={warningTextStyle} data-testid="builder-flow-tool-missing">
          {`${name} runs on a tool server, which this Builder cannot reach. Open the flow in the megane web app or VS Code with a tool server to run it, or remove the block.`}
        </div>
      );
    }
    return (
      <div
        data-testid="builder-flow-tool-missing"
        style={{ display: "flex", flexDirection: "column", gap: 8 }}
      >
        <span style={warningTextStyle}>
          {`Connect to a tool server that offers ${name} (Add › Tool server…) to edit or run this block.`}
        </span>
        {onOpenServer && (
          <button
            type="button"
            data-testid="builder-flow-tool-connect"
            style={actionStyle(false, false)}
            onClick={onOpenServer}
          >
            Tool server…
          </button>
        )}
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
  /** What an upstream block's structure is called: its result's name, else its own. */
  const nameOf = (src: string) => {
    const n = nodes.find((x) => x.id === src);
    if (runs[src]?.data) return runs[src]!.data!.name;
    if (!n) return src;
    const p = n.data.params;
    const t =
      p.type === "tool" ? (connection?.listing.tools.find((x) => x.name === p.tool) ?? null) : null;
    return blockName(p, t, library);
  };
  const missing = ports.filter((p) => p.required && (sources[p.key]?.length ?? 0) === 0);
  // The settings, then each wire's row (a component's count).
  const invalid =
    validate(fields, values, ctx) ??
    ports
      .filter((p) => p.multiple)
      .flatMap((port) => {
        const columns = rowFields(tool, port);
        return (sources[port.key] ?? []).map((src) =>
          validate(
            columns,
            { ...initialValues(columns, ctx), ...(params.rows[port.key]?.[src] ?? {}) },
            ctx,
          ),
        );
      })
      .find((p) => p !== null) ??
    null;

  return (
    <FieldsLookContext.Provider value={NODE_FORM_LOOK}>
      <FormStack>
        <div style={hintStyle} data-testid="builder-flow-tool-description">
          {tool.tooltip}
        </div>
        {problem && (
          <div role="alert" style={{ ...hintStyle, color: "var(--megane-danger-text)" }}>
            {problem}
          </div>
        )}
        {ports.length > 0 && (
          <Section title="Inputs">
            {ports.map((port) => {
              const ids = sources[port.key] ?? [];
              const columns = port.multiple ? rowFields(tool, port) : [];
              return (
                <div
                  key={port.key}
                  data-testid={`builder-flow-input-${port.key}`}
                  style={{ display: "flex", flexDirection: "column", gap: 6 }}
                >
                  {ids.length === 0 ? (
                    <Field label={port.label}>
                      <span style={hintStyle}>
                        {`Wire a block to the “${port.label}” input${port.multiple ? " (one row per wire)" : ""}.`}
                      </span>
                    </Field>
                  ) : port.multiple ? (
                    ids.map((src) => (
                      <div
                        key={src}
                        data-testid={`builder-flow-row-${port.key}-${src}`}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 8,
                          padding: 10,
                          borderRadius: 8,
                          border: "1px dashed var(--megane-border-strong)",
                        }}
                      >
                        <Field label={port.label}>
                          <span
                            data-testid={`builder-flow-row-name-${src}`}
                            style={{ fontSize: 12, fontWeight: 600, color: "var(--megane-text)" }}
                          >
                            {nameOf(src)}
                          </span>
                        </Field>
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
                    <Field label={port.label}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--megane-text)" }}>
                        {nameOf(ids[0])}
                      </span>
                    </Field>
                  )}
                </div>
              );
            })}
          </Section>
        )}
        {fields.length > 0 && (
          <Section title="Settings">
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
          </Section>
        )}
        {(missing.length > 0 || invalid) && (
          <div data-testid="builder-flow-tool-problem" style={warningTextStyle}>
            {missing.length > 0
              ? `Connect ${missing.map((p) => p.label).join(", ")} before running.`
              : invalid}
          </div>
        )}
      </FormStack>
    </FieldsLookContext.Provider>
  );
}

/** Seconds since `since` (ms), ticking once a second; null without a start. */
function useElapsed(since: number | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [since]);
  return since === undefined ? null : Math.max(0, Math.floor((now - since) / 1000));
}

/** The sliding bar of a run whose progress is not known. */
const INDETERMINATE_CSS = `@keyframes megane-flow-indeterminate {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(250%); }
}`;

/** The block's run: its status, a progress bar while it runs, the tool's own summary. */
function RunSummary({ run }: { run: NodeRun }) {
  const elapsed = useElapsed(run.status === "running" ? run.startedAt : undefined);
  if (run.status === "idle") return null;
  const color = runStatusColor(run);
  const known = run.fraction !== null;
  return (
    <div
      data-testid="builder-flow-run-summary"
      data-status={run.status}
      style={{ display: "flex", flexDirection: "column", gap: 4 }}
    >
      <span style={{ ...hintStyle, display: "flex", alignItems: "center", gap: 6 }}>
        <span
          role="img"
          aria-label={runStatusLabel(run)}
          title={runStatusLabel(run)}
          style={{
            width: 8,
            height: 8,
            boxSizing: "border-box",
            borderRadius: "50%",
            flexShrink: 0,
            ...(runStatusHollow(run) ? { border: `2px solid ${color}` } : { background: color }),
          }}
        />
        {runStatusText(run)}
        {elapsed !== null && (
          <span data-testid="builder-flow-run-elapsed" style={{ marginLeft: "auto" }}>
            {`${elapsed} s`}
          </span>
        )}
      </span>
      {run.status === "running" && (
        <div
          role="progressbar"
          aria-label="Block progress"
          aria-valuemin={0}
          aria-valuemax={100}
          {...(known ? { "aria-valuenow": Math.round(run.fraction! * 100) } : {})}
          data-testid="builder-flow-progress"
          data-indeterminate={known ? "false" : "true"}
          style={{
            height: 6,
            borderRadius: 3,
            background: "var(--megane-border)",
            overflow: "hidden",
          }}
        >
          {!known && <style>{INDETERMINATE_CSS}</style>}
          <div
            style={{
              height: "100%",
              background: "var(--megane-primary)",
              ...(known
                ? { width: `${Math.round(run.fraction! * 100)}%`, transition: "width 200ms" }
                : {
                    width: "40%",
                    animation: "megane-flow-indeterminate 1.2s ease-in-out infinite",
                  }),
            }}
          />
        </div>
      )}
      {run.summary && run.status !== "error" && <span style={hintStyle}>{run.summary}</span>}
    </div>
  );
}

/** The note that this block is the one Run makes the Manual structure. */
function OutputNote() {
  return (
    <div
      data-testid="builder-flow-output-note"
      style={{
        ...hintStyle,
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "8px 14px",
        borderBottom: "1px solid var(--megane-border)",
      }}
    >
      <OutputBadge />
      <span>Run makes this block&apos;s result the structure Manual mode edits.</span>
    </div>
  );
}

/** The "Output" tag of the block a Run adopts (on its card and in the pane). */
export function OutputBadge({ style }: { style?: React.CSSProperties }) {
  return (
    <span
      data-testid="builder-flow-output-badge"
      title="Output: Run makes this block's result the structure Manual mode edits"
      style={{
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: "#fff",
        background: "var(--megane-primary, #3b82f6)",
        borderRadius: 4,
        padding: "1px 5px",
        lineHeight: "14px",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      Output
    </span>
  );
}

/** The run's error and warnings, under the header. */
function runMessages(run: NodeRun): PaneMessage[] {
  const out: PaneMessage[] = [];
  if (run.status === "error" && run.error) out.push({ severity: "error", message: run.error });
  for (const w of run.warnings) out.push({ severity: "warning", message: w });
  return out;
}

export interface FlowPropertiesProps {
  deps: FlowDeps;
  /** CSS height of the pane (its share of the editor). */
  height: string;
  /** Show the tool server form instead of the selected block. */
  serverOpen: boolean;
  onCloseServer: () => void;
  /** The host reaches tool servers (else a tool block says it cannot run here). Default true. */
  hasTools?: boolean;
  /** Show the tool server form (from a tool block whose server is not connected). */
  onOpenServer?: () => void;
}

export function FlowProperties({
  deps,
  height,
  serverOpen,
  onCloseServer,
  hasTools = true,
  onOpenServer,
}: FlowPropertiesProps) {
  const nodes = useScopedFlowStore((s) => s.nodes);
  const runs = useScopedFlowStore((s) => s.runs);
  const running = useScopedFlowStore((s) => s.running);
  const outputId = useScopedFlowStore(outputNodeId);
  const removeNode = useScopedFlowStore((s) => s.removeNode);
  const connection = useScopedToolsStore((s) => s.connection);
  const edits = useScopedBuilderStore((s) => s.edits);
  const user = useLibraryStore((s) => s.user);
  const library = useMemo(() => allMolecules({ user }), [user]);
  const builderApi = useBuilderStoreApi();
  const flowApi = useFlowStoreApi();
  const node = nodes.find((n) => n.selected);

  let head: ReactNode = null;
  let body: ReactNode = null;
  if (serverOpen) {
    body = <ToolServerDialog onClose={onCloseServer} />;
  } else if (node) {
    const params = node.data.params;
    const tool =
      params.type === "tool"
        ? (connection?.listing.tools.find((t) => t.name === params.tool) ?? null)
        : null;
    const nodeRun = runs[node.id] ?? IDLE_RUN;
    const data = nodeRun.status === "done" || nodeRun.status === "stale" ? nodeRun.data : null;
    const messages = runMessages(nodeRun);
    head = (
      <>
        <PropertiesHeader
          testId="builder-flow-properties-header"
          icon={blockIcon(params)}
          color={blockColor(params)}
          title={blockTitle(params, tool, library)}
          summary={blockSummary(params, nodeRun, library)}
          onRemove={() => removeNode(node.id)}
          removeDisabled={!!running}
          removeTestId="builder-flow-delete-node"
        />
        {node.id === outputId && <OutputNote />}
        {messages.length > 0 && <NodeMessages messages={messages} testId="builder-flow-messages" />}
      </>
    );
    body = (
      <div
        data-testid="builder-flow-properties"
        data-node-id={node.id}
        style={{ display: "flex", flexDirection: "column", gap: 14 }}
      >
        {params.type === "molecule" && (
          <MoleculeForm id={node.id} params={params} library={library} />
        )}
        {params.type === "document" && <DocumentForm params={params} deps={deps} />}
        {params.type === "tool" && (
          <ToolForm
            node={node}
            params={params}
            tool={tool}
            library={library}
            hasTools={hasTools}
            onOpenServer={onOpenServer}
          />
        )}
        <BuiltinForm id={node.id} params={params} />
        <RunSummary run={nodeRun} />
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            data-testid="builder-flow-run-node"
            style={actionStyle(false, !!running)}
            disabled={!!running}
            title="Run this block and the blocks it needs"
            onClick={() => void runTo(builderApi, flowApi, deps, node.id)}
          >
            Run to here
          </button>
          <button
            type="button"
            data-testid="builder-flow-open-manual"
            style={actionStyle(true, !data || !!running)}
            disabled={!data || !!running}
            title={
              edits.length > 0
                ? "Open this result in Manual mode; it replaces the open structure and its history"
                : "Open this result in Manual mode to edit or save it"
            }
            onClick={() => data && void openInManual(builderApi, flowApi, data, nodeRun.key)}
          >
            Open in Manual
          </button>
        </div>
      </div>
    );
  }

  return (
    <PropertiesPaneView
      testId="builder-flow-pane"
      bodyTestId="builder-flow-pane-body"
      height={height}
      bodyVisible={body !== null}
      scrollKey={serverOpen ? "server" : (node?.id ?? null)}
      head={head}
      empty={
        <PropertiesEmpty
          testId="builder-flow-empty-hint"
          text={
            nodes.length === 0
              ? "Add blocks with + on the rail, wire each block's output (bottom) to an input (top) of the next, then press Run. The last block no wire leaves is the output (tagged Output): Run makes its result the structure Manual mode edits."
              : "Select a block to edit it and see its result. Run builds every block and makes the output block's result (the one tagged Output: the last block no wire leaves) the structure Manual mode edits; with no block selected, the 3D view shows that structure."
          }
        />
      }
    >
      {body}
    </PropertiesPaneView>
  );
}
