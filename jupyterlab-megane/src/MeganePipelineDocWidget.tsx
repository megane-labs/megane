import { ReactWidget } from "@jupyterlab/ui-components";
import type { DocumentRegistry } from "@jupyterlab/docregistry";
import type { Contents } from "@jupyterlab/services";
import { useCallback, useEffect, useRef, useState } from "react";
import { MeganeViewer } from "@megane/components/MeganeViewer";
import { ErrorBoundary } from "@megane/components/ErrorBoundary";
import { useMeganeLocal } from "@megane/hooks/useMeganeLocal";
import { useTemplateData } from "@megane/hooks/useTemplateData";
import { usePipelineStore } from "@megane/pipeline/store";
import { capturePipelineStore, type PipelineStoreSnapshot } from "@megane/pipeline/storeSnapshot";
import { useTour } from "@megane/tour/useTour";
import "@megane/styles/megane.css";
import { prewarmParseWorker } from "@megane/parsers/structure";
import { usePlaybackStore } from "@megane/stores/usePlaybackStore";
import type { SelectionState, Measurement } from "@megane/types";
import { ensureWasmUrl } from "./wasmLoader";
import type { ServerRequest } from "./serverFileBytes";
import { createSubscription, createFrameSubscription } from "./frameSubscription";
import {
  basename,
  dirname,
  fetchPipelineCompanions,
  type MinimalSerializedPipeline,
} from "./pipelineCompanions";

type ActivationSubscribe = (cb: () => void) => () => void;

interface DocBodyProps {
  context: DocumentRegistry.Context;
  contents: Contents.IManager;
  request: ServerRequest;
  subscribeActivation: ActivationSubscribe;
  onFrameChange?: (frame: number) => void;
  onSelectionChange?: (selection: SelectionState) => void;
  onMeasurementChange?: (measurement: Measurement | null) => void;
}

type LoadState = "loading" | "ready" | { error: string };

function DocBody({
  context,
  contents,
  request,
  subscribeActivation,
  onFrameChange,
  onSelectionChange,
  onMeasurementChange,
}: DocBodyProps): JSX.Element {
  const [state, setState] = useState<LoadState>("loading");
  useTour({ host: "jupyterlab" });
  // The pipeline itself opens through `openFile`; the local loader is only
  // the structure path a template's demo files load through.
  useTemplateData(useMeganeLocal());

  // Cached store state captured after the first parse. Subsequent tab
  // activations restore from this cache instead of re-parsing.
  const cachedRef = useRef<PipelineStoreSnapshot | null>(null);

  const parseAndLoad = useCallback(
    async (token: { cancelled: boolean }) => {
      try {
        await ensureWasmUrl();
        // Compile the parser's WASM in its worker while the pipeline file and
        // its companions are still being fetched.
        prewarmParseWorker();
        await context.ready;
        if (token.cancelled) return;

        // Same reasoning as MeganeDocWidget: the pipeline store is a
        // singleton shared across documents, so we start every open
        // from a clean default before deserialize installs the new
        // graph. If JSON.parse below throws, we still want subsequent
        // documents to land in a sane state.
        usePipelineStore.getState().reset();

        const pipelineText = context.model.toString();
        const pipeline = JSON.parse(pipelineText) as MinimalSerializedPipeline;
        const dir = dirname(context.path);

        // Resolve every file-bearing node's referenced file (structure,
        // trajectory, topology, grid, spectrum, vectors) under the pipeline
        // file's directory and pull them through the Jupyter Contents service
        // in parallel. We delegate the rest (deserialize, parse,
        // setNodeSnapshot) to the shared `usePipelineStore.openFile` entry
        // point.
        const companions = await fetchPipelineCompanions(contents, request, pipeline, dir);
        if (token.cancelled) return;

        const meganeFile = new File([pipelineText], basename(context.path), {
          type: "application/json",
        });
        await usePipelineStore.getState().openFile(meganeFile, { companions });

        if (token.cancelled) return;
        cachedRef.current = capturePipelineStore(usePipelineStore.getState());
        setState("ready");
      } catch (err) {
        // Reset the store again so a half-deserialized pipeline (e.g.
        // deserialize ran but a companion parse threw) doesn't leak
        // into the next document the user opens.
        usePipelineStore.getState().reset();
        if (!token.cancelled) {
          setState({ error: err instanceof Error ? err.message : String(err) });
        }
      }
    },
    [context, contents, request],
  );

  useEffect(() => {
    const activeToken = { cancelled: false };
    void parseAndLoad(activeToken);
    const unsubscribe = subscribeActivation(() => {
      const cache = cachedRef.current;
      if (cache) {
        usePipelineStore.setState(cache);
      }
      // No cache yet: the in-flight parse will populate it on completion.
    });
    return () => {
      activeToken.cancelled = true;
      unsubscribe();
    };
  }, [parseAndLoad, subscribeActivation]);

  const handleUploadStructure = useCallback((file: File) => {
    void usePipelineStore.getState().openFile(file, { mode: "merge" });
  }, []);

  if (typeof state === "object") {
    return (
      <div
        className="megane-jupyter-status error"
        data-testid="megane-pipeline-doc-root"
        data-state="error"
      >
        <div className="label">Error</div>
        <div>{state.error}</div>
      </div>
    );
  }

  if (state === "loading") {
    return (
      <div
        className="megane-jupyter-status"
        data-testid="megane-pipeline-doc-root"
        data-state="loading"
      >
        Loading pipeline...
      </div>
    );
  }

  return (
    <div
      data-testid="megane-pipeline-doc-root"
      data-state="ready"
      style={{ width: "100%", height: "100%" }}
    >
      <MeganeViewer
        testContext="jupyterlab-pipeline"
        onUploadStructure={handleUploadStructure}
        onFrameChange={onFrameChange}
        onSelectionChange={onSelectionChange}
        onMeasurementChange={onMeasurementChange}
      />
    </div>
  );
}

export class MeganePipelineReactView extends ReactWidget {
  private readonly listeners = new Set<() => void>();
  private readonly _frameSub = createFrameSubscription();
  private readonly _selectionSub = createSubscription<SelectionState>();
  private readonly _measurementSub = createSubscription<Measurement | null>();

  // The same event API as the structure viewer's `MeganeReactView`, so the
  // frame status bar and other extensions treat both tabs alike.
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

  protected onAfterShow(msg: import("@lumino/messaging").Message): void {
    super.onAfterShow(msg);
    for (const cb of this.listeners) {
      try {
        cb();
      } catch {
        /* ignore */
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
      <ErrorBoundary context="jupyterlab-pipeline">
        <DocBody
          context={this.context}
          contents={this.contents}
          request={this.request}
          subscribeActivation={this.subscribeActivation}
          onFrameChange={this._handleFrameChange}
          onSelectionChange={this._handleSelectionChange}
          onMeasurementChange={this._handleMeasurementChange}
        />
      </ErrorBoundary>
    );
  }
}
