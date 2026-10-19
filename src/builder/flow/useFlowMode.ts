/**
 * Everything `BuilderApp` needs from Flow mode, in one hook: the mode, what
 * the 3D view shows while in Flow mode, the actions the Flow panel's rail
 * runs (Run, Stop, the flow file), and the status line. Keeps the app's own
 * body about layout.
 *
 * It also keeps the structure shared with Manual mode in step (`shared.ts`):
 * Run makes the flow's result the Manual document, the view shows that
 * document while no block is picked, and a change to the document marks the
 * *Manual structure* blocks that read it stale.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { downloadBlob } from "../../renderer/RenderCapture";
import { hostHasTools, type BuilderHost } from "../host";
import {
  useBuilderStoreApi,
  useFlowStoreApi,
  useScopedBuilderStore,
  useScopedFlowStore,
  useScopedToolsStore,
} from "../BuilderStores";
import { shownSnapshot, UNTITLED } from "../store";
import { useFlowDeps } from "./deps";
import { blockTitle } from "./describe";
import type { FlowDeps } from "./engine";
import type { FlowActions } from "./FlowRail";
import { runAndShare } from "./shared";
import { flowViewData, parseSerializedFlow, type FlowView } from "./store";
import type { FlowData, FlowMode } from "./types";

/** File name a saved flow gets. */
export const FLOW_FILE_NAME = "builder.megane-flow.json";

export interface FlowModeState {
  mode: FlowMode;
  setMode: (mode: FlowMode) => void;
  /** What the 3D view shows in Flow mode (`id` null: the shared structure), or null. */
  view: FlowView | null;
  /** Run, Stop and the flow file, for the Flow panel's rail. */
  actions: FlowActions;
  deps: FlowDeps;
  /** The host reaches tool servers: the Add menu lists their tools. */
  hasTools: boolean;
  /** The tool server form is open under the graph. */
  serverOpen: boolean;
  openServer: () => void;
  closeServer: () => void;
  /** The status line in Flow mode. */
  status: string;
}

/**
 * Flow mode for the Builder on `host`: Save writes a flow where the host saves
 * structures (or downloads it), and the Add menu lists tools where the host
 * has them.
 */
export function useFlowMode(host: BuilderHost): FlowModeState {
  const hasTools = hostHasTools(host);
  const flowApi = useFlowStoreApi();
  const builderApi = useBuilderStoreApi();
  const mode = useScopedFlowStore((s) => s.mode);
  const setMode = useScopedFlowStore((s) => s.setMode);
  const nodes = useScopedFlowStore((s) => s.nodes);
  const runs = useScopedFlowStore((s) => s.runs);
  const viewNodeId = useScopedFlowStore((s) => s.viewNodeId);
  const running = useScopedFlowStore((s) => s.running);
  const toolsConnection = useScopedToolsStore((s) => s.connection);
  const source = useScopedBuilderStore((s) => s.source);
  const result = useScopedBuilderStore((s) => s.result);
  const showOriginal = useScopedBuilderStore((s) => s.showOriginal);
  const fileName = useScopedBuilderStore((s) => s.fileName);
  const sourceLabels = useScopedBuilderStore((s) => s.sourceLabels);
  const deps = useFlowDeps();
  const [serverOpen, setServerOpen] = useState(false);

  // The structure shared with Manual mode, as the Manual structure block reads it.
  const docSnapshot = useMemo(
    () => shownSnapshot({ source, result, showOriginal }),
    [source, result, showOriginal],
  );
  const document = useMemo<FlowData | null>(
    () =>
      docSnapshot
        ? { name: fileName ?? UNTITLED, snapshot: docSnapshot, labels: sourceLabels }
        : null,
    [docSnapshot, fileName, sourceLabels],
  );
  useEffect(() => {
    flowApi.getState().documentChanged(deps.document()?.key ?? null);
  }, [docSnapshot, deps, flowApi]);

  const view = useMemo(
    () => flowViewData({ nodes, runs, viewNodeId }, document),
    [nodes, runs, viewNodeId, document],
  );

  const onOpenFile = useCallback(
    async (file: File) => {
      try {
        flowApi.getState().load(parseSerializedFlow(JSON.parse(await file.text())));
        builderApi.getState().reportInfo(`Opened the flow ${file.name}.`);
      } catch (err) {
        builderApi
          .getState()
          .reportError(
            `Could not open ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
          );
      }
    },
    [flowApi, builderApi],
  );

  const saveFlow = useCallback(async () => {
    const text = JSON.stringify(flowApi.getState().serialize(), null, 2);
    if (!host.save) {
      downloadBlob(new Blob([text], { type: "application/json" }), FLOW_FILE_NAME);
      return;
    }
    try {
      const said = await host.save({ name: FLOW_FILE_NAME, text, format: "flow" });
      if (said) builderApi.getState().reportInfo(said);
    } catch (err) {
      builderApi
        .getState()
        .reportError(
          `Could not save the flow: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
  }, [flowApi, builderApi, host]);

  const runningTitle = (() => {
    if (!running) return null;
    const id = Object.keys(runs).find((k) => runs[k].status === "running");
    const node = id ? nodes.find((n) => n.id === id) : undefined;
    if (!node) return "Running…";
    const params = node.data.params;
    const tool =
      params.type === "tool"
        ? (toolsConnection?.listing.tools.find((t) => t.name === params.tool) ?? null)
        : null;
    return `Running ${blockTitle(params, tool)}…`;
  })();

  const status =
    runningTitle ??
    (nodes.length === 0
      ? `${view ? `showing ${view.data.name} · ` : ""}Add blocks, wire them, then Run`
      : `${nodes.length} block${nodes.length === 1 ? "" : "s"} · ${
          view ? `showing ${view.data.name}` : "pick a block to see its result"
        }`);

  return {
    mode,
    setMode,
    view,
    deps,
    hasTools,
    serverOpen,
    openServer: () => setServerOpen(true),
    closeServer: () => setServerOpen(false),
    status,
    actions: {
      onOpenFile: (file) => void onOpenFile(file),
      onSave: () => void saveFlow(),
      onClear: () => flowApi.getState().clear(),
      hasBlocks: nodes.length > 0,
      running: !!running,
      onRun: () => void runAndShare(builderApi, flowApi, deps),
      onStop: () => flowApi.getState().cancel(),
    },
  };
}
