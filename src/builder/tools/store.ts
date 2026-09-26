/**
 * State of the Builder's tool servers: the connection, the tool whose form is
 * open, the call in flight, and the record of applied results (§7).
 *
 * Applying a result goes through the Builder store's ordinary actions
 * (`openStructure`, `pushOps`), so Undo, Save and the edit history treat a
 * tool's output like any other edit (§5.2).
 */

import { create, type StateCreator, type StoreApi } from "zustand";
import { createStore } from "zustand/vanilla";
import { canEdit, useBuilderStore, type BuilderStore } from "../store";
import { newFragmentId } from "../library/fragment";
import { callTimeoutMs, sanitizeName, type BuilderResult, type BuilderToolInfo } from "./contract";
import { connectToolServer, errorMessage, type CallOutcome, type ToolConnection } from "./client";
import { insertOps, residueLabels, structureToSnapshot } from "./payload";

export const TOOLS_STORAGE_KEY = "megane.builder.tools.v1";
export const DEFAULT_TOOL_SERVER_URL = "http://127.0.0.1:8765/mcp";

export type ConnectionStatus = "idle" | "connecting" | "connected" | "error";

/** One applied result, as §7 asks Builder to record it. */
export interface AppliedToolResult {
  server: { name: string; version: string | null; url: string };
  tool: string;
  contract: number;
  /** Arguments as sent, the document replaced by its size. */
  arguments: Record<string, unknown>;
  provenance: Record<string, unknown>;
  atoms: number;
}

export interface RunningCall {
  tool: BuilderToolInfo;
  fraction: number | null;
  message: string | null;
  controller: AbortController;
}

export interface ToolsStore {
  url: string;
  token: string;
  status: ConnectionStatus;
  error: string | null;
  connection: ToolConnection | null;
  /** The tool whose form is open, if any. */
  openTool: BuilderToolInfo | null;
  running: RunningCall | null;
  applied: AppliedToolResult[];

  setUrl: (url: string) => void;
  setToken: (token: string) => void;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  openForm: (tool: BuilderToolInfo) => void;
  closeForm: () => void;
  /** Call `tool` and apply its result; resolves to the outcome (errors stay in the form). */
  run: (tool: BuilderToolInfo, args: Record<string, unknown>) => Promise<CallOutcome>;
  cancel: () => void;
}

export interface ToolsStoreDeps {
  connector: (url: string, token: string) => Promise<ToolConnection>;
  builder: StoreApi<BuilderStore>;
  storage: Storage | null;
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readStoredUrl(storage: Storage | null): string {
  try {
    const raw = storage?.getItem(TOOLS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { url?: unknown }).url === "string"
    ) {
      return (parsed as { url: string }).url;
    }
  } catch {
    /* corrupt or blocked storage */
  }
  return DEFAULT_TOOL_SERVER_URL;
}

function writeStoredUrl(storage: Storage | null, url: string) {
  try {
    storage?.setItem(TOOLS_STORAGE_KEY, JSON.stringify({ url }));
  } catch {
    /* quota or blocked storage */
  }
}

/** `#tools=<url>&token=<token>` in the page URL: connect on load (the token never reaches a server log). */
export function readLaunchParams(hash: string): { url: string; token: string } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const url = params.get("tools");
  if (!url) return null;
  return { url, token: params.get("token") ?? "" };
}

/** Arguments as recorded: the document argument replaced by its atom count. */
export function recordedArguments(
  tool: BuilderToolInfo,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const documentKey = tool.fields?.find((f) => f.kind === "widget" && f.widget === "document")?.key;
  if (!documentKey || !(documentKey in args)) return { ...args };
  const doc = args[documentKey] as { elements?: unknown[] } | null;
  return { ...args, [documentKey]: { atoms: doc?.elements?.length ?? 0 } };
}

/** Put a result into the Builder document (§5.2). Returns the number of atoms applied. */
export function applyResult(
  builder: StoreApi<BuilderStore>,
  tool: BuilderToolInfo,
  result: BuilderResult,
): number {
  const s = builder.getState();
  const structure = result.structure;
  if (tool.apply === "new_document") {
    s.openStructure(
      structureToSnapshot(structure),
      residueLabels(structure),
      sanitizeName(result.name),
    );
    return structure.elements.length;
  }
  if (!canEdit(s))
    throw new Error("Open a structure (and leave the original preview) to insert into it.");
  const before = s.result!.snapshot.nAtoms;
  s.pushOps(insertOps(structure, newFragmentId(result.name), s.result!.snapshot.box));
  const after = builder.getState().result!.snapshot.nAtoms;
  builder.getState().setSelected(Array.from({ length: after - before }, (_, k) => before + k));
  return after - before;
}

export function toolsStateCreator(deps: ToolsStoreDeps): StateCreator<ToolsStore> {
  return (set, get) => ({
    url: readStoredUrl(deps.storage),
    token: "",
    status: "idle",
    error: null,
    connection: null,
    openTool: null,
    running: null,
    applied: [],

    setUrl: (url) => set({ url }),
    setToken: (token) => set({ token }),

    connect: async () => {
      const { url, token, connection } = get();
      if (connection) await connection.close().catch(() => undefined);
      set({ status: "connecting", error: null, connection: null, openTool: null });
      try {
        const next = await deps.connector(url.trim(), token.trim());
        writeStoredUrl(deps.storage, url.trim());
        set({ status: "connected", connection: next });
      } catch (err) {
        set({ status: "error", error: `Could not connect to ${url}: ${errorMessage(err)}` });
      }
    },

    disconnect: async () => {
      const { connection, running } = get();
      running?.controller.abort();
      set({ status: "idle", error: null, connection: null, openTool: null, running: null });
      await connection?.close().catch(() => undefined);
    },

    openForm: (tool) => set({ openTool: tool }),
    closeForm: () => set((s) => (s.running ? {} : { openTool: null })),

    run: async (tool, args) => {
      const { connection, url } = get();
      if (!connection) return { ok: false, error: "Not connected to a tool server." };
      const controller = new AbortController();
      set({ running: { tool, fraction: null, message: null, controller } });
      let outcome: CallOutcome;
      try {
        outcome = await connection.call(tool.name, args, {
          signal: controller.signal,
          timeoutMs: callTimeoutMs(tool.expectedSeconds),
          onProgress: (fraction, message) =>
            set((s) =>
              s.running?.controller === controller
                ? { running: { ...s.running, fraction, message } }
                : {},
            ),
        });
      } finally {
        set((s) => (s.running?.controller === controller ? { running: null } : {}));
      }
      // A result that arrives after Cancel is discarded (§6).
      if (controller.signal.aborted) return { ok: false, error: "Cancelled." };
      if (!outcome.ok) return outcome;
      let atoms: number;
      try {
        atoms = applyResult(deps.builder, tool, outcome.result);
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
      const { result, summary } = outcome;
      set((s) => ({
        openTool: null,
        applied: [
          ...s.applied,
          {
            server: { name: connection.serverName, version: connection.serverVersion, url },
            tool: tool.name,
            contract: result.contract,
            arguments: recordedArguments(tool, args),
            provenance: result.provenance,
            atoms,
          },
        ],
      }));
      const text = [summary ?? `${tool.label}: added ${atoms} atoms.`, ...result.warnings].join(
        " ",
      );
      deps.builder.getState().reportInfo(text);
      return outcome;
    },

    cancel: () => get().running?.controller.abort(),
  });
}

/** A private tools store (tests). */
export function createToolsStore(deps: ToolsStoreDeps): StoreApi<ToolsStore> {
  return createStore<ToolsStore>(toolsStateCreator(deps));
}

/** The app's tools store, bound to the app's Builder store. */
export const useToolsStore = create<ToolsStore>(
  toolsStateCreator({
    connector: connectToolServer,
    builder: useBuilderStore,
    storage: defaultStorage(),
  }),
);
