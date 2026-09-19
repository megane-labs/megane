/**
 * The "Sketch a molecule" dialog: Ketcher in a modal, a name field, and an
 * *Add to library* button that reads the sketch back as a molfile and turns
 * it into a library molecule (`draftFromMolfile`).
 *
 * Ketcher is loaded on demand. While it loads, and if it cannot load at all
 * (offline bundle, blocked WASM), the dialog falls back to a plain molfile
 * text field so the library is never unreachable; the same field is offered
 * behind *Paste MOL* for users who bring a molfile from elsewhere.
 */

import { Component, lazy, Suspense, useCallback, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Ketcher } from "ketcher-core";
import { isE2ETestMode } from "../../testMode";
import { chipStyle, hintStyle, inputStyle } from "../styles";
import { draftFromMolfile } from "./sketch";
import type { LibraryMoleculeDraft } from "./types";

const KetcherEditor = lazy(() => import("./KetcherEditor"));

export interface SketchModalProps {
  /** A molfile to start from (re-editing a library sketch). */
  initialMolfile?: string;
  initialName?: string;
  onAdd: (draft: LibraryMoleculeDraft) => void;
  onClose: () => void;
}

/** Catches a failed lazy load (or a Ketcher crash) and shows the fallback instead. */
class LoadBoundary extends Component<
  { fallback: (error: Error) => ReactNode; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}

export function SketchModal({ initialMolfile, initialName, onAdd, onClose }: SketchModalProps) {
  const [name, setName] = useState(initialName ?? "");
  const [pasteMode, setPasteMode] = useState(false);
  const [molText, setMolText] = useState(initialMolfile ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const ketcherRef = useRef<Ketcher | null>(null);

  const handleInit = useCallback(
    (ketcher: Ketcher) => {
      ketcherRef.current = ketcher;
      setReady(true);
      if (isE2ETestMode()) {
        (window as unknown as { __megane_test_ketcher?: Ketcher }).__megane_test_ketcher = ketcher;
      }
      if (initialMolfile) void ketcher.setMolecule(initialMolfile).catch(() => undefined);
    },
    [initialMolfile],
  );

  const handleAdd = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      let molfile = molText;
      if (!pasteMode) {
        const ketcher = ketcherRef.current;
        if (!ketcher) throw new Error("The sketcher is still loading.");
        molfile = await ketcher.getMolfile("v2000");
      }
      const draft = await draftFromMolfile(molfile, name);
      onAdd(draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [molText, pasteMode, name, onAdd]);

  const canAdd = !busy && (pasteMode ? molText.trim().length > 0 : ready);

  const pasteField = (
    <textarea
      data-testid="sketch-molfile"
      value={molText}
      onChange={(e) => setMolText(e.target.value)}
      placeholder="Paste a MOL / SDF file here"
      spellCheck={false}
      style={{
        ...inputStyle,
        flex: 1,
        minHeight: 240,
        fontFamily: "ui-monospace, monospace",
        resize: "none",
      }}
    />
  );

  return createPortal(
    <div
      data-testid="sketch-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Sketch a molecule"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(15, 23, 42, 0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: "min(960px, 94vw)",
          height: "min(720px, 92vh)",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          padding: 12,
          borderRadius: 10,
          background: "var(--megane-surface-solid, #fff)",
          color: "var(--megane-text, #1e293b)",
          border: "1px solid var(--megane-border-solid, #e2e8f0)",
          boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
          fontSize: 13,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700 }}>Sketch a molecule</span>
          <label style={{ display: "flex", alignItems: "center", gap: 4, ...hintStyle }}>
            Name
            <input
              data-testid="sketch-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="(formula)"
              style={{ ...inputStyle, width: 160 }}
            />
          </label>
          <span
            role="button"
            data-testid="sketch-paste-toggle"
            aria-pressed={pasteMode}
            style={chipStyle(pasteMode)}
            onClick={() => setPasteMode((v) => !v)}
          >
            Paste MOL
          </span>
          <span style={{ flex: 1 }} />
          <span style={hintStyle}>
            Sketches are flat; add explicit hydrogens in Ketcher if you want them.
          </span>
        </div>
        <div
          data-testid="sketch-editor"
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            border: "1px solid var(--megane-border-solid, #e2e8f0)",
            borderRadius: 6,
            overflow: "hidden",
            // Ketcher's toolbars are light-themed; keep its surface white in dark mode.
            background: "#fff",
            colorScheme: "light",
          }}
        >
          {pasteMode ? (
            pasteField
          ) : (
            <LoadBoundary
              fallback={(err) => (
                <div
                  data-testid="sketch-fallback"
                  style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8, padding: 8 }}
                >
                  <div style={{ ...hintStyle, color: "#b45309" }}>
                    Ketcher could not be loaded ({err.message}). Paste a MOL file instead.
                  </div>
                  <span
                    role="button"
                    data-testid="sketch-fallback-paste"
                    style={{ ...chipStyle(false), alignSelf: "flex-start" }}
                    onClick={() => setPasteMode(true)}
                  >
                    Paste MOL
                  </span>
                </div>
              )}
            >
              <Suspense
                fallback={
                  <div data-testid="sketch-loading" style={{ ...hintStyle, padding: 12 }}>
                    Loading Ketcher…
                  </div>
                }
              >
                <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
                  <KetcherEditor onInit={handleInit} onError={(m) => setError(m)} />
                </div>
              </Suspense>
            </LoadBoundary>
          )}
        </div>
        {error && (
          <div data-testid="sketch-error" role="alert" style={{ ...hintStyle, color: "#991b1b" }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <span
            role="button"
            data-testid="sketch-cancel"
            style={chipStyle(false)}
            onClick={onClose}
          >
            Cancel
          </span>
          <span
            role="button"
            data-testid="sketch-add"
            aria-disabled={!canAdd}
            style={chipStyle(canAdd, !canAdd)}
            onClick={canAdd ? () => void handleAdd() : undefined}
          >
            {busy ? "Adding…" : "Add to library"}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
