/**
 * Everything `BuilderApp` needs from Flow mode, in one hook: the mode, what
 * the 3D view shows while in Flow mode, the left rail's actions, and the
 * status line. Keeps the app's own body about layout.
 */

import { useCallback, useMemo, useState } from "react";
import { downloadBlob } from "../../renderer/RenderCapture";
import { allMolecules, useLibraryStore } from "../library/store";
import type { BuilderToolInfo } from "../tools/contract";
import { hostHasTools, type BuilderHost } from "../host";
import {
  useBuilderStoreApi,
  useFlowStoreApi,
  useScopedFlowStore,
  useScopedToolsStore,
} from "../BuilderStores";
import { useFlowDeps } from "./deps";
import { blockTitle } from "./describe";
import type { FlowDeps } from "./engine";
import { addMenuItems, type FlowRailProps } from "./FlowRail";
import { initialToolParams } from "./ports";
import { flowViewData, parseSerializedFlow } from "./store";
import type { FlowData, FlowMode, FlowParams } from "./types";

/** File name a saved flow gets. */
export const FLOW_FILE_NAME = "builder.megane-flow.json";

export interface FlowModeState {
  mode: FlowMode;
  setMode: (mode: FlowMode) => void;
  /** What the 3D view shows in Flow mode, or null. */
  view: { id: string; data: FlowData } | null;
  rail: FlowRailProps;
  deps: FlowDeps;
  /** The tool server form is open under the graph. */
  serverOpen: boolean;
  closeServer: () => void;
  /** The status line in Flow mode. */
  status: string;
}

/**
 * Flow mode for the Builder on `host`: Save writes a flow where the host saves
 * structures (or downloads it), and the Add menu lists tools where the host
 * has them. `onReveal` opens the Flow panel when a block is added.
 */
export function useFlowMode(host: BuilderHost, onReveal: () => void): FlowModeState {
  const hasTools = hostHasTools(host);
  const flowApi = useFlowStoreApi();
  const builderApi = useBuilderStoreApi();
  const mode = useScopedFlowStore((s) => s.mode);
  const setMode = useScopedFlowStore((s) => s.setMode);
  const nodes = useScopedFlowStore((s) => s.nodes);
  const runs = useScopedFlowStore((s) => s.runs);
  const viewNodeId = useScopedFlowStore((s) => s.viewNodeId);
  const running = useScopedFlowStore((s) => s.running);
  const toolsStatus = useScopedToolsStore((s) => s.status);
  const toolsConnection = useScopedToolsStore((s) => s.connection);
  const toolServers = useScopedToolsStore((s) => s.servers);
  const setToolServer = useScopedToolsStore((s) => s.setUrl);
  const connectToolServer = useScopedToolsStore((s) => s.connect);
  const user = useLibraryStore((s) => s.user);
  const deps = useFlowDeps();
  const [serverOpen, setServerOpen] = useState(false);

  const view = useMemo(() => flowViewData({ nodes, runs, viewNodeId }), [nodes, runs, viewNodeId]);

  const addBlock = useCallback(
    (params: FlowParams) => {
      flowApi.getState().addNode(params);
      setServerOpen(false);
      onReveal();
    },
    [flowApi, onReveal],
  );

  const addItems = addMenuItems({
    addSmiles: () =>
      addBlock({ type: "molecule", source: "smiles", smiles: "", libraryId: "", name: "" }),
    addLibrary: () =>
      addBlock({
        type: "molecule",
        source: "library",
        smiles: "",
        libraryId: allMolecules({ user })[0]?.id ?? "",
        name: "",
      }),
    addDocument: () => addBlock({ type: "document" }),
    addTool: (tool: BuilderToolInfo) => addBlock(initialToolParams(tool)),
    openServer: () => {
      setServerOpen(true);
      onReveal();
    },
    tools: hasTools
      ? {
          status: toolsStatus,
          connection: toolsConnection,
          servers: toolServers,
          setUrl: setToolServer,
          connect: connectToolServer,
        }
      : undefined,
  });

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
      ? "Add blocks, wire them, then Run"
      : `${nodes.length} block${nodes.length === 1 ? "" : "s"} · ${
          view ? `showing ${view.data.name}` : "pick a block to see its result"
        }`);

  return {
    mode,
    setMode,
    view,
    deps,
    serverOpen,
    closeServer: () => setServerOpen(false),
    status,
    rail: {
      addItems,
      onOpenFile: (file) => void onOpenFile(file),
      onSave: () => void saveFlow(),
      onClear: () => flowApi.getState().clear(),
      hasBlocks: nodes.length > 0,
      running: !!running,
      onRun: () => void flowApi.getState().run(deps),
      onStop: () => flowApi.getState().cancel(),
    },
  };
}
