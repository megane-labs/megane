import { ReactWidget } from "@jupyterlab/ui-components";
import type { DocumentRegistry } from "@jupyterlab/docregistry";
import type { Contents } from "@jupyterlab/services";
import { useCallback, useEffect, useRef, useState } from "react";
import { MeganeViewer } from "@megane/components/MeganeViewer";
import { ErrorBoundary } from "@megane/components/ErrorBoundary";
import { useMeganeLocal } from "@megane/hooks/useMeganeLocal";
import { usePipelineStore } from "@megane/pipeline/store";
import { capturePipelineStore, type PipelineStoreSnapshot } from "@megane/pipeline/storeSnapshot";
import { useTour } from "@megane/tour/useTour";
import { ThemeSync } from "@megane/components/ThemeSync";
import { usePlaybackStore } from "@megane/stores/usePlaybackStore";
import "@megane/styles/megane.css";
import { ensureWasmUrl } from "./wasmLoader";
import { STRUCTURE_FILETYPES_BINARY } from "./filetypes";
import {
  SPECTRUM_ONLY_EXTENSIONS,
  TRAJECTORY_ONLY_EXTENSIONS,
  VOLUMETRIC_ONLY_EXTENSIONS,
} from "./trajectoryUtils";
import { createSubscription, createFrameSubscription } from "./frameSubscription";
import type { SelectionState, Measurement } from "@megane/types";

const BINARY_EXTENSIONS = new Set(STRUCTURE_FILETYPES_BINARY.flatMap((f) => f.extensions ?? []));

/**
 * Subscription channel used by `DocBody` to re-load when the host
 * `MeganeReactView` widget becomes visible. Re-loading on activation is
 * required because the pipeline store is a singleton shared across every
 * open document tab — without a re-load on tab switch, the most recently
 * opened tab silently mutates earlier tabs' rendered state.
 */
type ActivationSubscribe = (cb: () => void) => () => void;

interface DocBodyProps {
  context: DocumentRegistry.Context;
  contents: Contents.IManager;
  subscribeActivation: ActivationSubscribe;
  onFrameChange?: (frame: number) => void;
  onSelectionChange?: (selection: SelectionState) => void;
  onMeasurementChange?: (measurement: Measurement | null) => void;
}

type LoadState = "loading" | "ready" | { error: string };

function DocBody({
  context,
  contents,
  subscribeActivation,
  onFrameChange,
  onSelectionChange,
  onMeasurementChange,
}: DocBodyProps): JSX.Element {
  const local = useMeganeLocal();
  const [state, setState] = useState<LoadState>("loading");
  useTour({ host: "jupyterlab" });

  // Cached pipeline-store state captured after the first successful parse.
  // On subsequent tab activations we restore from this cache instead of
  // re-parsing the file (which dominates open latency for large structures
  // and trajectories).
  const cachedRef = useRef<PipelineStoreSnapshot | null>(null);

  const parseAndLoad = useCallback(
    async (token: { cancelled: boolean }) => {
      try {
        await ensureWasmUrl();
        await context.ready;
        if (token.cancelled) return;
        // Reset the global pipeline store before loading. The same
        // singleton store is shared across every JupyterLab document
        // tab, so a previously-opened .megane.json (or a failed open)
        // would otherwise leave its graph + node snapshots in place,
        // and useMeganeLocal.applyResult would inject this file's data
        // into a foreign pipeline — or silently no-op if that graph
        // had no load_structure node.
        usePipelineStore.getState().reset();
        const filename = context.path.split("/").pop() ?? "structure";
        const raw = context.model.toString();
        // Binary file types (e.g. ASE .traj) are registered with
        // fileFormat: "base64" in filetypes.ts, so the model serializes to a
        // base64 string. Decode to bytes and let parseStructureFile dispatch
        // to the right WASM parser via file.arrayBuffer(). We check both the
        // contentsModel format and the file extension as a safety net,
        // because contentsModel can be null in some restore paths.
        const dot = filename.lastIndexOf(".");
        const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : "";
        const isBase64 = context.contentsModel?.format === "base64" || BINARY_EXTENSIONS.has(ext);
        const bytes = isBase64
          ? Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))
          : new TextEncoder().encode(raw);
        const file = new File([bytes], filename);
        if (SPECTRUM_ONLY_EXTENSIONS.has(ext)) {
          // A spectrum has no coordinates at all, so the 3D viewer has nothing
          // to draw. Point at the node that does display it.
          throw new Error(
            `${filename} is a spectrum, which has no atoms or coordinates to render. ` +
              "Add a Load Spectrum node in the pipeline editor and wire it to a " +
              "Spectrum Plot node to view it.",
          );
        }
        if (VOLUMETRIC_ONLY_EXTENSIONS.has(ext)) {
          // A scalar grid carries a field but no atoms, so there is nothing to
          // render on its own. Same shape of guard as the trajectory-only
          // formats: say what to do instead of failing obscurely.
          throw new Error(
            `${filename} is a volumetric grid, which has no atoms to render on its own. ` +
              "Open a structure file (PDB, GRO, etc.) first, then add a Load Volumetric node " +
              "in the pipeline editor and point it at this file to draw an isosurface.",
          );
        }
        if (TRAJECTORY_ONLY_EXTENSIONS.has(ext)) {
          // Trajectory-only formats need a topology already loaded. Surface
          // an actionable error; the always-mounted pipeline editor lets the
          // user wire a Load Structure node to recover.
          try {
            await local.loadXtc(file);
          } catch (err) {
            const base = err instanceof Error ? err.message : String(err);
            throw new Error(
              `${base} Open a structure file (PDB, GRO, etc.) first, or use the pipeline editor to wire a Load Structure node.`,
            );
          }
        } else {
          // For .gro files, probe for a sibling .top file with the same stem.
          let topFile: File | undefined;
          if (ext === ".gro") {
            const stem = filename.slice(0, filename.lastIndexOf("."));
            const topName = stem + ".top";
            const dir = context.path.includes("/")
              ? context.path.slice(0, context.path.lastIndexOf("/"))
              : "";
            const topPath = dir ? `${dir}/${topName}` : topName;
            try {
              const model = await contents.get(topPath, {
                content: true,
                format: "text",
              });
              if (model.content) {
                topFile = new File([String(model.content)], topName);
              }
            } catch {
              // .top file not present — proceed without topology bonds
            }
          }
          await local.loadFile(file, topFile);
        }
        if (token.cancelled) return;
        cachedRef.current = capturePipelineStore(usePipelineStore.getState());
        setState("ready");
      } catch (err) {
        if (!token.cancelled) {
          setState({ error: err instanceof Error ? err.message : String(err) });
        }
      }
    },
    // `local` is intentionally omitted: useMeganeLocal returns a fresh
    // object on every render, so including it would re-fire this effect
    // on every state update and re-parse the file in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [context],
  );

  useEffect(() => {
    let activeToken = { cancelled: false };
    void parseAndLoad(activeToken);
    // Re-activate this tab's cached state whenever JupyterLab brings the
    // widget back into view. We only re-parse when no cache is available
    // yet (initial onAfterShow racing the in-flight parse) — every later
    // activation just restores the captured store snapshot, which is
    // effectively instant and avoids the WASM reparse.
    const unsubscribe = subscribeActivation(() => {
      const cache = cachedRef.current;
      if (cache) {
        usePipelineStore.setState(cache);
        return;
      }
      // No cache yet: an activation fired before the initial load
      // completed. The in-flight token will populate the cache as soon
      // as parsing finishes; nothing to do here.
    });
    return () => {
      activeToken.cancelled = true;
      unsubscribe();
    };
  }, [parseAndLoad, subscribeActivation]);

  const handleUploadStructure = useCallback(
    (file: File) => {
      local.loadFile(file);
    },
    [local],
  );

  if (typeof state === "object") {
    return (
      <div className="megane-jupyter-status error" data-testid="megane-doc-root" data-state="error">
        <div className="label">Error</div>
        <div>{state.error}</div>
      </div>
    );
  }

  if (state === "loading") {
    return (
      <div className="megane-jupyter-status" data-testid="megane-doc-root" data-state="loading">
        Loading structure...
      </div>
    );
  }

  return (
    <div data-testid="megane-doc-root" data-state="ready" style={{ width: "100%", height: "100%" }}>
      <ThemeSync />
      <MeganeViewer
        testContext="jupyterlab-doc"
        onUploadStructure={handleUploadStructure}
        onBondSourceChange={(s: string) =>
          local.setBondSource(s as "structure" | "file" | "distance" | "none")
        }
        onLabelSourceChange={(s: string) =>
          local.setLabelSource(s as "none" | "structure" | "file")
        }
        onLoadLabelFile={(f: File) => local.loadLabelFile(f)}
        onVectorSourceChange={(s: string) => local.setVectorSource(s as "none" | "file" | "demo")}
        onLoadVectorFile={(f: File) => local.loadVectorFile(f)}
        onLoadDemoVectors={() => local.loadDemoVectors()}
        onFrameChange={onFrameChange}
        onSelectionChange={onSelectionChange}
        onMeasurementChange={onMeasurementChange}
      />
    </div>
  );
}

export class MeganeReactView extends ReactWidget {
  private readonly listeners = new Set<() => void>();
  private readonly _frameSub = createFrameSubscription();
  private readonly _selectionSub = createSubscription<SelectionState>();
  private readonly _measurementSub = createSubscription<Measurement | null>();

  /** Subscribe to trajectory frame-change events emitted by the viewer. */
  readonly subscribeFrameChange = this._frameSub.subscribe.bind(this._frameSub);
  /** Subscribe to atom selection-change events emitted by the viewer. */
  readonly subscribeSelectionChange = this._selectionSub.subscribe.bind(this._selectionSub);
  /** Subscribe to measurement-change events emitted by the viewer. */
  readonly subscribeMeasurementChange = this._measurementSub.subscribe.bind(this._measurementSub);

  /** Programmatically seek the viewer to a specific trajectory frame. */
  seekFrame(index: number): void {
    usePlaybackStore.getState().seekFrame(index);
  }

  private readonly _handleFrameChange = (frame: number): void => {
    this._frameSub.emit(frame);
  };

  private readonly _handleSelectionChange = (selection: SelectionState): void => {
    this._selectionSub.emit(selection);
  };

  private readonly _handleMeasurementChange = (measurement: Measurement | null): void => {
    this._measurementSub.emit(measurement);
  };

  constructor(
    private readonly context: DocumentRegistry.Context,
    private readonly contents: Contents.IManager,
  ) {
    super();
    this.addClass("megane-jupyter-doc");
  }

  /** Notify subscribers that this widget has become visible. */
  protected onAfterShow(msg: import("@lumino/messaging").Message): void {
    super.onAfterShow(msg);
    for (const cb of this.listeners) {
      try {
        cb();
      } catch {
        /* swallow — a noisy listener shouldn't break others */
      }
    }
  }

  private subscribeActivation = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  protected render(): JSX.Element {
    return (
      <ErrorBoundary context="jupyterlab-doc">
        <DocBody
          context={this.context}
          contents={this.contents}
          subscribeActivation={this.subscribeActivation}
          onFrameChange={this._handleFrameChange}
          onSelectionChange={this._handleSelectionChange}
          onMeasurementChange={this._handleMeasurementChange}
        />
      </ErrorBoundary>
    );
  }
}
