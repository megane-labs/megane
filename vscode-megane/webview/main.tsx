/**
 * VSCode webview entry point for megane.
 *
 * The extension host posts either a single structure file or a pipeline
 * (.megane.json + companion files) into the webview. Both flows are funneled
 * through the canonical `usePipelineStore.openFile` ingestion path so the
 * pipeline graph stays in sync with whatever was opened — exactly the same
 * contract the webapp drag-drop and the JupyterLab DocWidget use.
 *
 * `useMeganeLocal` is still instantiated to keep `MeganeViewer.snapshot` /
 * `frame` props populated for atom selection and measurement until PR-B
 * removes those props in favour of subscribing to pipeline state directly.
 */

import { StrictMode, useState, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { MeganeViewer } from "../../src/components/MeganeViewer";
import { useMeganeLocal } from "../../src/hooks/useMeganeLocal";
import { usePipelineStore } from "../../src/pipeline/store";
import { usePlaybackStore } from "../../src/stores/usePlaybackStore";
import type { SerializedPipeline } from "../../src/pipeline/types";
import {
  companionFilesFromPayload,
  type CompanionFilePayload,
} from "../../src/pipeline/companionFiles";
import type { MeganeCameraState } from "../../src/renderer/MoleculeRenderer";
import type { SelectionState, Measurement } from "../../src/types";
import { useTour } from "../../src/tour/useTour";
import { ThemeSync } from "../../src/components/ThemeSync";
import { ErrorBoundary } from "../../src/components/ErrorBoundary";
import { setRemoteFileSource } from "../../src/remote/fileSource";
import { createMessageFileSource } from "../../src/remote/messageFiles";
import { classifyStandaloneFile } from "../../src/hosts/classifyStandaloneFile";
import { fileFromBytes } from "../../src/parsers/fileBytes";
import { receiveProgressiveFile } from "../../src/hosts/progressiveFile";
import { installCrossOriginWorker } from "../../src/utils/crossOriginWorker";
import { perfMark } from "../../src/perf";
import { prewarmParseWorker } from "../../src/parsers/structure";
import "../../src/styles/megane.css";

// The parse worker is served from the extension's resource origin, which
// `new Worker` refuses from the webview's own origin.
installCrossOriginWorker();
// Compile the parser's WASM in its worker while the extension host is still
// posting the document's bytes.
prewarmParseWorker();

// Acquire VS Code API
const vscode = acquireVsCodeApi();

// Under VS Code Remote / code-server the webview's own file dialog shows the
// user's computer, not the workspace's machine; the extension host flags that
// and answers "Open from remote..." with VS Code's open dialog instead.
if ((globalThis as { __MEGANE_REMOTE_FILES__?: boolean }).__MEGANE_REMOTE_FILES__) {
  setRemoteFileSource(createMessageFileSource((message) => vscode.postMessage(message)));
}

// Route blob downloads through the extension host. A synthetic `<a download>`
// click is silently ignored inside the webview sandbox, so downloadBlob
// (src/renderer/RenderCapture.ts) defers to this hook when it is installed.
// Registered at module scope so it exists before any export can fire.
(
  globalThis as { __MEGANE_SAVE_BLOB__?: (blob: Blob, filename: string) => void }
).__MEGANE_SAVE_BLOB__ = (blob, filename) => {
  void blob.arrayBuffer().then((buf) => {
    vscode.postMessage({
      type: "saveFile",
      filename,
      bytes: Array.from(new Uint8Array(buf)),
    });
  });
};

interface VsCodeState {
  camera?: MeganeCameraState;
}

function App() {
  const local = useMeganeLocal();
  useTour({ host: "vscode" });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-document camera persistence using VS Code's webview state API.
  const [initialCameraState] = useState<MeganeCameraState | null>(() => {
    const saved = vscode.getState() as VsCodeState | undefined;
    return saved?.camera ?? null;
  });

  const handleCameraStateChange = useCallback((state: MeganeCameraState) => {
    const current = (vscode.getState() as VsCodeState | undefined) ?? {};
    vscode.setState({ ...current, camera: state });
  }, []);

  useEffect(() => {
    // Completes a large document whose head and tail came first (loadFile).
    let deliverMiddle: ((middle: Uint8Array) => void) | null = null;
    const handler = (event: MessageEvent) => {
      const message = event.data;

      if (message.type === "loadFile") {
        perfMark("megane:open:start");
        const { filename, topBytes, topFilename } = message;
        // Bytes arrive as ArrayBuffers (structured clone): all of them in
        // `contentBytes`, or for a large file the head and tail here and the
        // middle in a following `loadFileRest` (src/hosts/progressiveFile.ts).
        // The WASM URL is provided by the HTML (window.__MEGANE_WASM_URL__).
        const topFile: File | undefined =
          topBytes && topFilename
            ? fileFromBytes(new Uint8Array(topBytes as ArrayBuffer), topFilename as string)
            : undefined;
        // Spectra and volumetric grids have nothing to render standalone, and
        // trajectory-only formats (XTC, DCD, NetCDF) need a topology loaded
        // first; the shared classifier (also used by the JupyterLab DocWidget)
        // decides which, and words the actionable error. The user recovers via
        // the always-mounted pipeline editor.
        const classification = classifyStandaloneFile(filename);
        if (classification.errorMessage) {
          setError(classification.errorMessage);
          return;
        }
        let loadPromise: Promise<void>;
        if (message.headBytes) {
          const received = receiveProgressiveFile(
            filename,
            message.size as number,
            new Uint8Array(message.headBytes as ArrayBuffer),
            new Uint8Array(message.tailBytes as ArrayBuffer),
            fileFromBytes,
          );
          deliverMiddle = received.deliverMiddle;
          loadPromise =
            classification.kind === "trajectory-only"
              ? received.file.file.then((file) => local.loadXtc(file))
              : local.loadFileProgressive(received.file, topFile);
        } else {
          const file = fileFromBytes(new Uint8Array(message.contentBytes as ArrayBuffer), filename);
          loadPromise =
            classification.kind === "trajectory-only"
              ? local.loadXtc(file)
              : local.loadFile(file, topFile);
        }
        loadPromise
          .then(() => {
            perfMark("megane:open:loaded");
            setLoaded(true);
          })
          .catch((err) => {
            console.error("Failed to load file:", err);
            const base = err instanceof Error ? err.message : String(err);
            const hint = classification.loadFailureHint ? ` ${classification.loadFailureHint}` : "";
            setError(`Failed to load file: ${base}${hint}`);
          });
        return;
      }

      if (message.type === "loadFileRest") {
        perfMark("megane:open:rest");
        deliverMiddle?.(new Uint8Array(message.middleBytes as ArrayBuffer));
        deliverMiddle = null;
        return;
      }

      if (message.type === "seekFrame") {
        usePlaybackStore.getState().seekFrame(message.frame as number);
        return;
      }

      if (message.type === "error") {
        setError(message.message || "Unknown error from extension host");
        return;
      }

      if (message.type === "loadPipeline") {
        const { pipeline, companionFiles } = message as {
          pipeline: SerializedPipeline;
          companionFiles: CompanionFilePayload[];
        };
        // The WASM URL is provided by the HTML (window.__MEGANE_WASM_URL__).

        perfMark("megane:open:start");
        (async () => {
          // Companions arrive as raw bytes (ArrayBuffers, structured clone) so
          // binary formats such as ASE .traj survive; the shared parsers pick
          // text() or arrayBuffer() by extension.
          const companions = companionFilesFromPayload(companionFiles);

          // Re-stringify the pipeline payload into a File so the canonical
          // openFile entry point sees the same .megane.json contract that
          // every other host uses.
          const meganeFile = new File([JSON.stringify(pipeline)], "pipeline.megane.json", {
            type: "application/json",
          });
          await usePipelineStore.getState().openFile(meganeFile, { companions });
          perfMark("megane:open:pipeline");

          // Populate useMeganeLocal so MeganeViewer props (atom selection,
          // measurements) keep working in pipeline mode. applyResult re-runs
          // setNodeSnapshot on the first load_structure node — that's
          // idempotent because openFile already set the same snapshot for
          // that node a moment ago. PR-B will drop these props entirely.
          const firstStructure = companionFiles.findIndex((c) => c.nodeType === "load_structure");
          if (firstStructure >= 0) {
            await local.loadFile(companions[firstStructure]);
          }
          perfMark("megane:open:loaded");

          setLoaded(true);
        })().catch((err) => {
          console.error("Failed to load pipeline:", err);
          // Surface the viewer anyway so the user can recover via node file
          // pickers rather than facing a permanent loading screen.
          setLoaded(true);
        });
      }
    };

    window.addEventListener("message", handler);

    // Signal to the extension host that the webview is ready
    perfMark("megane:webview:ready");
    vscode.postMessage({ type: "ready" });

    return () => window.removeEventListener("message", handler);
  }, []);

  const handleUploadStructure = useCallback(
    (file: File) => {
      local.loadFile(file);
    },
    [local.loadFile],
  );

  const handleFrameChange = useCallback((frame: number) => {
    vscode.postMessage({ type: "frameChange", frame });
  }, []);

  const handleSelectionChange = useCallback((selection: SelectionState) => {
    vscode.postMessage({ type: "selectionChange", selection });
  }, []);

  const handleMeasurementChange = useCallback((measurement: Measurement | null) => {
    vscode.postMessage({ type: "measurementChange", measurement });
  }, []);

  if (error) {
    return (
      <>
        <ThemeSync />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            width: "100%",
            height: "100%",
            color: "#ef4444",
            fontSize: "14px",
            padding: "20px",
            textAlign: "center",
            gap: "8px",
          }}
        >
          <div style={{ fontWeight: "bold" }}>Error</div>
          <div
            style={{
              color: "var(--megane-text-secondary)",
              maxWidth: "400px",
              wordBreak: "break-word",
            }}
          >
            {error}
          </div>
        </div>
      </>
    );
  }

  if (!loaded) {
    return (
      <>
        <ThemeSync />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "100%",
            height: "100%",
            color: "var(--megane-text-secondary)",
            fontSize: "14px",
          }}
        >
          Loading structure...
        </div>
      </>
    );
  }

  return (
    <>
      <ThemeSync />
      <MeganeViewer
        testContext="vscode"
        onUploadStructure={handleUploadStructure}
        initialCameraState={initialCameraState}
        onCameraStateChange={handleCameraStateChange}
        onFrameChange={handleFrameChange}
        onSelectionChange={handleSelectionChange}
        onMeasurementChange={handleMeasurementChange}
      />
    </>
  );
}

// Declare acquireVsCodeApi for TypeScript
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary context="vscode">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
