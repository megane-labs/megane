/**
 * Two-viewer harness for issue #672.
 *
 * Mounts two `<MeganeViewer>`s side by side, each inside its own
 * `<MeganeProvider>`, and loads a different structure into each through that
 * provider's own pipeline store — the exact shape the issue reports as broken:
 *
 *     usePipelineStore.getState().openFile(new File([text], fileName))
 *
 * Before the store scoping landed, the second `openFile` replaced the graph
 * the first viewer was rendering and both panels showed the same structure.
 * Each panel's `data-atom-count` is what `tests/e2e/multi-instance.spec.ts`
 * asserts on.
 *
 * Built as its own Vite entry (`multi-instance.html`) rather than a branch
 * inside the main app, so the standalone webapp bundle is untouched.
 */

import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MeganeViewer } from "./components/MeganeViewer";
import { MeganeProvider } from "./stores/MeganeProvider";
import { createMeganeStores, type MeganeStores } from "./stores/meganeStores";
import "./styles/megane.css";

interface PanelProps {
  label: string;
  stores: MeganeStores;
}

function Panel({ label, stores }: PanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // The viewer's Load nodes drive parsing themselves; this harness only needs
  // to satisfy the required prop.
  const handleUploadStructure = useCallback(() => {}, []);

  const handleChange = useCallback(() => {
    const file = inputRef.current?.files?.[0];
    if (!file) return;
    // Straight onto THIS provider's store — the call the issue reports.
    void stores.pipeline.getState().openFile(file);
  }, [stores]);

  return (
    <section
      data-testid={`panel-${label}`}
      style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}
    >
      <header
        style={{
          padding: "4px 8px",
          font: "12px system-ui, sans-serif",
          borderBottom: "1px solid rgba(0,0,0,0.12)",
        }}
      >
        {label}
      </header>
      <input
        ref={inputRef}
        data-testid={`load-${label}`}
        type="file"
        onChange={handleChange}
        style={{ display: "none" }}
      />
      <div style={{ flex: 1, minHeight: 0 }}>
        <MeganeProvider stores={stores}>
          <MeganeViewer
            onUploadStructure={handleUploadStructure}
            testContext="multi-instance"
            ui={{ pipelineEditor: false, perfHud: false, resetView: false, viewAxes: false }}
            width="100%"
            height="100%"
          />
        </MeganeProvider>
      </div>
    </section>
  );
}

function App() {
  // Created once, outside render, so each panel keeps one bundle for the
  // lifetime of the page.
  const [left] = useState(() => createMeganeStores({ id: "left" }));
  const [right] = useState(() => createMeganeStores({ id: "right" }));

  useEffect(() => {
    return () => {
      left.destroy();
      right.destroy();
    };
  }, [left, right]);

  return (
    <div style={{ display: "flex", width: "100%", height: "100%" }}>
      <Panel label="left" stores={left} />
      <div style={{ width: 1, background: "rgba(0,0,0,0.15)" }} />
      <Panel label="right" stores={right} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
