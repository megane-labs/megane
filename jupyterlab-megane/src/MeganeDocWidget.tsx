import { ReactWidget } from "@jupyterlab/ui-components";
import type { DocumentRegistry } from "@jupyterlab/docregistry";
import type { Contents } from "@jupyterlab/services";
import { useCallback, useEffect, useState } from "react";
import { MeganeViewer } from "@megane/components/MeganeViewer";
import { ErrorBoundary } from "@megane/components/ErrorBoundary";
import { useMeganeLocal } from "@megane/hooks/useMeganeLocal";
import { useTemplateData } from "@megane/hooks/useTemplateData";
import { usePipelineStore } from "@megane/pipeline/store";
import { useTour } from "@megane/tour/useTour";
import { ThemeSync } from "@megane/components/ThemeSync";
import { usePlaybackStore } from "@megane/stores/usePlaybackStore";
import "@megane/styles/megane.css";
import { fileFromBytes } from "@megane/parsers/fileBytes";
import { perfMark } from "@megane/perf";
import { prewarmParseWorker } from "@megane/parsers/structure";
import { ensureWasmUrl } from "./wasmLoader";
import { readServerFileBytes, type ServerRequest } from "./serverFileBytes";
import { classifyStandaloneFile, siblingTopologyName } from "@megane/hosts/classifyStandaloneFile";
import { createSubscription, createFrameSubscription } from "./frameSubscription";
import { TabStoreCache } from "./tabStoreCache";
import type { SelectionState, Measurement } from "@megane/types";

interface DocBodyProps {
  context: DocumentRegistry.Context;
  contents: Contents.IManager;
  request: ServerRequest;
  /**
   * This tab's copy of the pipeline store. The store is a singleton shared
   * across every open document tab, so the host `MeganeReactView` puts this
   * copy back whenever the tab is shown — instead of re-parsing the file,
   * which dominates open latency for large structures and trajectories.
   */
  storeCache: TabStoreCache;
  onFrameChange?: (frame: number) => void;
  onSelectionChange?: (selection: SelectionState) => void;
  onMeasurementChange?: (measurement: Measurement | null) => void;
}

type LoadState = "loading" | "ready" | { error: string };

function DocBody({
  context,
  contents,
  request,
  storeCache,
  onFrameChange,
  onSelectionChange,
  onMeasurementChange,
}: DocBodyProps): JSX.Element {
  const local = useMeganeLocal();
  const [state, setState] = useState<LoadState>("loading");
  useTour({ host: "jupyterlab" });
  // Applying a template from the editor loads its demo files over this file.
  useTemplateData(local);

  const parseAndLoad = useCallback(
    async (token: { cancelled: boolean }) => {
      try {
        perfMark("megane:open:start");
        await ensureWasmUrl();
        // Compile the parser's WASM in its worker while the file is still
        // being downloaded.
        prewarmParseWorker();
        // The document model holds no content (rawModel.ts): download the
        // file's raw bytes ourselves, alongside the context's metadata fetch.
        const bytesRequest = readServerFileBytes(contents, request, context.path);
        bytesRequest.catch(() => {}); // surfaced by the await below
        await context.ready;
        perfMark("megane:open:contextReady");
        if (token.cancelled) return;
        // Reset the global pipeline store before loading. The same
        // singleton store is shared across every JupyterLab document
        // tab, so a previously-opened .megane.json (or a failed open)
        // would otherwise leave its graph + node snapshots in place,
        // and useMeganeLocal.applyResult would inject this file's data
        // into a foreign pipeline — or silently no-op if that graph
        // had no load_structure node.
        storeCache.claim();
        usePipelineStore.getState().reset();
        const filename = context.path.split("/").pop() ?? "structure";
        // Raw bytes for every format: the shared parser dispatches by
        // extension to text or binary (e.g. ASE .traj) decoding.
        const file = fileFromBytes(await bytesRequest, filename);
        if (token.cancelled) return;
        perfMark("megane:open:decoded");
        // Spectra and volumetric grids have nothing to render standalone, and
        // trajectory-only formats (XTC, DCD, NetCDF) need a topology loaded
        // first; the shared classifier (also used by the VSCode webview)
        // decides which, and words the actionable error. The always-mounted
        // pipeline editor lets the user wire the right node to recover.
        const classification = classifyStandaloneFile(filename);
        if (classification.errorMessage) {
          throw new Error(classification.errorMessage);
        }
        if (classification.kind === "trajectory-only") {
          try {
            await local.loadXtc(file);
          } catch (err) {
            const base = err instanceof Error ? err.message : String(err);
            throw new Error(`${base} ${classification.loadFailureHint}`);
          }
        } else {
          // For .gro files, probe for a sibling .top file with the same stem.
          let topFile: File | undefined;
          const topName = siblingTopologyName(filename);
          if (topName) {
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
        perfMark("megane:open:loaded");
        if (token.cancelled) return;
        storeCache.capture();
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
    [context, contents, request, storeCache],
  );

  useEffect(() => {
    let activeToken = { cancelled: false };
    void parseAndLoad(activeToken);
    return () => {
      activeToken.cancelled = true;
      storeCache.release();
    };
  }, [parseAndLoad, storeCache]);

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
        onFrameChange={onFrameChange}
        onSelectionChange={onSelectionChange}
        onMeasurementChange={onMeasurementChange}
      />
    </div>
  );
}

export class MeganeReactView extends ReactWidget {
  private readonly storeCache = new TabStoreCache();
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
    private readonly request: ServerRequest,
  ) {
    super();
    this.addClass("megane-jupyter-doc");
  }

  /** The tab became visible: put its state back into the shared store. */
  protected onAfterShow(msg: import("@lumino/messaging").Message): void {
    super.onAfterShow(msg);
    this.storeCache.restore();
  }

  /** The tab is being hidden: keep the edits made in it for its next show. */
  protected onBeforeHide(msg: import("@lumino/messaging").Message): void {
    this.storeCache.save();
    super.onBeforeHide(msg);
  }

  protected render(): JSX.Element {
    return (
      <ErrorBoundary context="jupyterlab-doc">
        <DocBody
          context={this.context}
          contents={this.contents}
          request={this.request}
          storeCache={this.storeCache}
          onFrameChange={this._handleFrameChange}
          onSelectionChange={this._handleSelectionChange}
          onMeasurementChange={this._handleMeasurementChange}
        />
      </ErrorBoundary>
    );
  }
}
