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
import type { MeganeCameraState } from "../../src/renderer/MoleculeRenderer";
import type { SelectionState, Measurement } from "../../src/types";
import { useTour } from "../../src/tour/useTour";
import { ThemeSync } from "../../src/components/ThemeSync";
import { ErrorBoundary } from "../../src/components/ErrorBoundary";
import "../../src/styles/megane.css";

// Acquire VS Code API
const vscode = acquireVsCodeApi();

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
    const handler = (event: MessageEvent) => {
      const message = event.data;

      if (message.type === "loadFile") {
        const { contentBytes, filename, topBytes, topFilename } = message;
        // contentBytes / topBytes arrive as ArrayBuffers (structured clone).
        // The WASM URL is provided by the HTML (window.__MEGANE_WASM_URL__).
        const bytes = new Uint8Array(contentBytes as ArrayBuffer);
        const file = new File([bytes], filename);
        const topFile: File | undefined =
          topBytes && topFilename
            ? new File([new Uint8Array(topBytes as ArrayBuffer)], topFilename as string)
            : undefined;
        const lower = filename.toLowerCase();
        const isTrajectoryOnly =
          lower.endsWith(".xtc") || lower.endsWith(".dcd") || lower.endsWith(".nc");
        // A JCAMP-DX spectrum has no coordinates, so the 3D viewer has nothing
        // to draw. `.dx` is excluded: it is shared with OpenDX grids and only
        // content sniffing can tell them apart.
        if (lower.endsWith(".jdx") || lower.endsWith(".jcamp")) {
          setError(
            `${filename} is a spectrum, which has no atoms or coordinates to render. ` +
              "Add a Load Spectrum node in the pipeline editor and wire it to a " +
              "Spectrum Plot node to view it.",
          );
          return;
        }
        // Volumetric grids (CUBE, OpenDX) carry a scalar field but no atoms, so
        // there is nothing to render standalone. Guard them the same way.
        const isVolumetricOnly =
          lower.endsWith(".cube") || lower.endsWith(".cub") || lower.endsWith(".dx");
        if (isVolumetricOnly) {
          setError(
            `${filename} is a volumetric grid, which has no atoms to render on its own. ` +
              "Open a structure file (PDB, GRO, etc.) first, then add a Load Volumetric node " +
              "in the pipeline editor and point it at this file to draw an isosurface.",
          );
          return;
        }
        // Trajectory-only formats (XTC, DCD, NetCDF) need a topology loaded
        // first. Surface an actionable error rather than silently failing —
        // the user can recover via the always-mounted pipeline editor by
        // adding a Load Structure node and re-pointing the trajectory file.
        // LAMMPS dump (.lammpstrj/.dump/.trj) is NOT trajectory-only: it loads
        // standalone as a multi-frame structure via loadFile (topology from
        // frame 0), like a multi-frame XYZ / ASE .traj.
        const loadPromise = isTrajectoryOnly ? local.loadXtc(file) : local.loadFile(file, topFile);
        loadPromise
          .then(() => setLoaded(true))
          .catch((err) => {
            console.error("Failed to load file:", err);
            const base = err instanceof Error ? err.message : String(err);
            const hint = isTrajectoryOnly
              ? " Open a structure file (PDB, GRO, etc.) first, or use the pipeline editor to wire a Load Structure node."
              : "";
            setError(`Failed to load file: ${base}${hint}`);
          });
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
        const { pipeline, structureFiles, trajectoryFiles } = message as {
          pipeline: SerializedPipeline;
          structureFiles: Array<{ nodeId: string; content: string; filename: string }>;
          trajectoryFiles: Array<{ nodeId: string; content: ArrayBuffer; filename: string }>;
        };
        // The WASM URL is provided by the HTML (window.__MEGANE_WASM_URL__).

        (async () => {
          const companions: File[] = [
            ...structureFiles.map(
              (sf) => new File([sf.content], sf.filename, { type: "text/plain" }),
            ),
            ...trajectoryFiles.map((tf) => new File([new Uint8Array(tf.content)], tf.filename)),
          ];

          // Re-stringify the pipeline payload into a File so the canonical
          // openFile entry point sees the same .megane.json contract that
          // every other host uses.
          const meganeFile = new File([JSON.stringify(pipeline)], "pipeline.megane.json", {
            type: "application/json",
          });
          await usePipelineStore.getState().openFile(meganeFile, { companions });

          // Populate useMeganeLocal so MeganeViewer props (atom selection,
          // measurements) keep working in pipeline mode. applyResult re-runs
          // setNodeSnapshot on the first load_structure node — that's
          // idempotent because openFile already set the same snapshot for
          // that node a moment ago. PR-B will drop these props entirely.
          if (structureFiles.length > 0) {
            const firstStructure = new File(
              [structureFiles[0].content],
              structureFiles[0].filename,
              { type: "text/plain" },
            );
            await local.loadFile(firstStructure);
          }

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
        onBondSourceChange={(s) =>
          local.setBondSource(s as "structure" | "file" | "distance" | "none")
        }
        onLabelSourceChange={(s) => local.setLabelSource(s as "none" | "structure" | "file")}
        onLoadLabelFile={(f) => local.loadLabelFile(f)}
        onVectorSourceChange={(s) => local.setVectorSource(s as "none" | "file" | "demo")}
        onLoadVectorFile={(f) => local.loadVectorFile(f)}
        onLoadDemoVectors={() => local.loadDemoVectors()}
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
