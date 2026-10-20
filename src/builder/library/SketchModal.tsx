/**
 * The "Sketch a molecule" dialog: Ketcher in a modal, a name field, and an
 * *Add to library* button that reads the sketch back as a molfile and turns
 * it into a library molecule (`draftFromMolfile`): RDKit (`megane-rdkit`,
 * in a worker) embeds it in 3D with the hydrogens it leaves implicit;
 * *Add hydrogens* turns those off for a bare skeleton. RDKit is the only
 * way a sketch becomes 3D, so when it cannot run (no Web Workers, the WASM
 * blocked, a drawing it cannot sanitise) the dialog reports the error and
 * nothing is added. Editing a library molecule (`onSave`) offers *Save
 * changes* beside *Save as new*.
 *
 * Ketcher is loaded on demand. While it loads, and if it cannot load at all
 * (offline bundle, blocked WASM), the dialog falls back to a plain molfile
 * text field so the library is never unreachable; the same field is offered
 * behind *Paste MOL* for users who bring a molfile from elsewhere. Switching
 * between the two carries the drawing across.
 *
 * The dialog is drawn over the Builder (not the page), under the Builder's
 * confirm dialog, which asks before a drawing is thrown away (Cancel, a
 * click on the backdrop, Escape). Tab stays inside it; Escape is the only key
 * it takes from Ketcher.
 */

import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type { Ketcher } from "ketcher-core";
import { useDismiss } from "../../hooks/useDismiss";
import { isE2ETestMode } from "../../testMode";
import { useBuilderStoreApi } from "../BuilderStores";
import { chipStyle, hintStyle, inputStyle } from "../styles";
import { canEmbed } from "./embed";
import { draftFromMolfile, sketchErrorMessage } from "./sketch";
import type { LibraryMoleculeDraft } from "./types";

const KetcherEditor = lazy(() => import("./KetcherEditor"));

export interface SketchModalProps {
  /** A molfile to start from (re-editing a library sketch). */
  initialMolfile?: string;
  initialName?: string;
  onAdd: (draft: LibraryMoleculeDraft) => void;
  /** Editing a library molecule: save the result over it (*Save changes*). */
  onSave?: (draft: LibraryMoleculeDraft) => void;
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

/** Whether Ketcher's canvas is empty; null when this Ketcher cannot say. */
export function ketcherIsBlank(ketcher: Ketcher | null): boolean | null {
  try {
    const struct = ketcher?.editor?.struct?.();
    return struct ? struct.isBlank() : null;
  } catch {
    return null;
  }
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keep Tab inside `container`: past the last control it wraps to the first, and back. */
export function trapTab(e: ReactKeyboardEvent, container: HTMLElement | null) {
  if (e.key !== "Tab" || !container) return;
  const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.getAttribute("aria-hidden") !== "true",
  );
  if (items.length === 0) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !container.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !container.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

type BusyAction = "add" | "save";

export function SketchModal({
  initialMolfile,
  initialName,
  onAdd,
  onSave,
  onClose,
}: SketchModalProps) {
  const builder = useBuilderStoreApi();
  const [name, setName] = useState(initialName ?? "");
  const [pasteMode, setPasteMode] = useState(false);
  const [molText, setMolText] = useState(initialMolfile ?? "");
  const [withHydrogens, setWithHydrogens] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [ready, setReady] = useState(false);
  /** Ketcher's canvas is empty (null: unknown, this Ketcher cannot say). */
  const [blank, setBlank] = useState<boolean | null>(initialMolfile ? false : null);
  const ketcherRef = useRef<Ketcher | null>(null);
  /** What a (re)mounted Ketcher loads: the molecule being edited, or the pasted text. */
  const seedRef = useRef<string | null>(initialMolfile ?? null);
  /** The embedding in flight; Stop marks it cancelled so its result is dropped. */
  const runRef = useRef<{ cancelled: boolean } | null>(null);
  const downOnBackdrop = useRef(false);
  const asking = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    return () => {
      // Closed mid-embedding: the result must not land after the dialog is gone.
      if (runRef.current) runRef.current.cancelled = true;
    };
  }, []);

  const handleInit = useCallback((ketcher: Ketcher) => {
    ketcherRef.current = ketcher;
    setReady(true);
    if (isE2ETestMode()) {
      (window as unknown as { __megane_test_ketcher?: Ketcher }).__megane_test_ketcher = ketcher;
    }
    const refresh = () => {
      if (ketcherRef.current !== ketcher) return;
      setBlank(ketcherIsBlank(ketcher));
      setError(null);
    };
    try {
      ketcher.editor?.subscribe?.("change", refresh);
    } catch {
      /* an editor without change events: Add stays enabled */
    }
    const seed = seedRef.current;
    if (seed && seed.trim()) {
      void ketcher
        .setMolecule(seed)
        .catch(() => undefined)
        .then(() => {
          if (ketcherRef.current === ketcher) setBlank(ketcherIsBlank(ketcher) ?? false);
        });
    } else {
      setBlank(ketcherIsBlank(ketcher));
    }
  }, []);

  /** Whether closing now would throw a drawing away. */
  const hasWork = useCallback(() => {
    if (pasteMode) return molText.trim().length > 0;
    if (!ready) return !!seedRef.current?.trim();
    return ketcherIsBlank(ketcherRef.current) !== true;
  }, [pasteMode, molText, ready]);

  const stop = useCallback(() => {
    if (runRef.current) runRef.current.cancelled = true;
    runRef.current = null;
    setBusy(null);
  }, []);

  /** Close, asking first when there is a drawing to lose; a running embedding is stopped instead. */
  const requestClose = useCallback(async () => {
    if (busy) {
      stop();
      return;
    }
    if (asking.current) return;
    if (hasWork()) {
      asking.current = true;
      const ok = await builder.getState().requestConfirm({
        title: "Discard the sketch?",
        message: "The drawing has not been added to the library and will be lost.",
        confirmLabel: "Discard sketch",
        danger: true,
      });
      asking.current = false;
      if (!ok) return;
    }
    onClose();
  }, [busy, stop, hasWork, builder, onClose]);

  useDismiss({ onDismiss: () => void requestClose() });

  const handleAdd = useCallback(
    async (action: BusyAction) => {
      const run = { cancelled: false };
      runRef.current = run;
      setBusy(action);
      setError(null);
      try {
        let molfile = molText;
        if (!pasteMode) {
          const ketcher = ketcherRef.current;
          if (!ketcher) throw new Error("The sketcher is still loading; try again in a moment.");
          try {
            molfile = await ketcher.getMolfile("v2000");
          } catch (err) {
            throw new Error(
              `Could not read the sketch from Ketcher: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        const draft = await draftFromMolfile(molfile, name, { addHydrogens: withHydrogens });
        if (run.cancelled) return;
        (action === "save" && onSave ? onSave : onAdd)(draft);
      } catch (err) {
        if (!run.cancelled) setError(sketchErrorMessage(err));
      } finally {
        if (runRef.current === run) {
          runRef.current = null;
          setBusy(null);
        }
      }
    },
    [molText, pasteMode, name, withHydrogens, onAdd, onSave],
  );

  /** Switch between Ketcher and the text field, carrying the drawing across. */
  const togglePaste = useCallback(async () => {
    if (pasteMode) {
      seedRef.current = molText.trim() ? molText : null;
      setBlank(molText.trim() ? false : null);
      setPasteMode(false);
      return;
    }
    const ketcher = ketcherRef.current;
    if (ketcher && ketcherIsBlank(ketcher) !== true) {
      try {
        setMolText(await ketcher.getMolfile("v2000"));
      } catch {
        /* keep whatever the field held */
      }
    }
    ketcherRef.current = null;
    setReady(false);
    setError(null);
    setPasteMode(true);
  }, [pasteMode, molText]);

  const empty = pasteMode ? molText.trim().length === 0 : blank === true;
  const blockedReason = !canEmbed()
    ? "3D embedding needs Web Workers, which this host lacks."
    : busy
      ? "Embedding…"
      : !pasteMode && !ready
        ? "The sketcher is still loading."
        : empty
          ? pasteMode
            ? "Paste a MOL file first."
            : "Draw a molecule first."
          : null;
  const canAdd = blockedReason === null;

  const pasteField = (
    <textarea
      data-testid="sketch-molfile"
      aria-label="MOL / SDF text"
      value={molText}
      onChange={(e) => {
        setMolText(e.target.value);
        setError(null);
      }}
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

  const actionButton = (action: BusyAction, label: string, testId: string, primary: boolean) => (
    <button
      type="button"
      data-testid={testId}
      aria-disabled={!canAdd}
      title={blockedReason && busy !== action ? blockedReason : undefined}
      style={{ ...chipStyle(canAdd && primary, !canAdd), fontFamily: "inherit" }}
      onClick={canAdd ? () => void handleAdd(action) : undefined}
    >
      {busy === action ? "Embedding…" : label}
    </button>
  );

  return (
    <div
      data-testid="sketch-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Sketch a molecule"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 1000,
        background: "rgba(15, 23, 42, 0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onPointerDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // Only a click that both starts and ends on the backdrop: a drag out
        // of Ketcher that is released over the backdrop keeps the dialog.
        const start = downOnBackdrop.current;
        downOnBackdrop.current = false;
        if (start && e.target === e.currentTarget) void requestClose();
      }}
    >
      <div
        ref={panelRef}
        data-testid="sketch-panel"
        onKeyDown={(e) => trapTab(e, panelRef.current)}
        style={{
          width: "min(960px, 94%)",
          height: "min(720px, 92%)",
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
          <span style={{ fontWeight: 700 }}>{onSave ? "Edit molecule" : "Sketch a molecule"}</span>
          <label style={{ display: "flex", alignItems: "center", gap: 4, ...hintStyle }}>
            Name
            <input
              ref={nameRef}
              data-testid="sketch-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canAdd) {
                  e.preventDefault();
                  void handleAdd(onSave ? "save" : "add");
                }
              }}
              placeholder="(formula)"
              style={{ ...inputStyle, width: 160 }}
            />
          </label>
          <button
            type="button"
            data-testid="sketch-paste-toggle"
            aria-pressed={pasteMode}
            style={{ ...chipStyle(pasteMode), fontFamily: "inherit" }}
            onClick={() => void togglePaste()}
            title={
              pasteMode
                ? "Back to the sketcher, with the pasted molecule"
                : "Edit the drawing as MOL text, or paste one"
            }
          >
            Paste MOL
          </button>
          <label style={{ display: "flex", alignItems: "center", gap: 4, ...hintStyle }}>
            <input
              type="checkbox"
              data-testid="sketch-hydrogens"
              checked={withHydrogens}
              onChange={(e) => setWithHydrogens(e.target.checked)}
            />
            Add hydrogens
          </label>
          <span style={{ flex: 1 }} />
          <span data-testid="sketch-mode-hint" style={hintStyle}>
            {!canEmbed()
              ? "3D embedding needs Web Workers, which this host lacks."
              : withHydrogens
                ? "RDKit embeds the sketch in 3D (ETKDG, then MMFF94s / UFF), adding its missing hydrogens."
                : "RDKit embeds the sketch in 3D (ETKDG, then MMFF94s / UFF) as drawn, without adding hydrogens."}
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
                  <div style={{ ...hintStyle, color: "var(--megane-warning-text, #b45309)" }}>
                    Ketcher could not be loaded ({err.message}). Paste a MOL file instead.
                  </div>
                  <button
                    type="button"
                    data-testid="sketch-fallback-paste"
                    style={{ ...chipStyle(false), alignSelf: "flex-start", fontFamily: "inherit" }}
                    onClick={() => setPasteMode(true)}
                  >
                    Paste MOL
                  </button>
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
          <div
            data-testid="sketch-error"
            role="alert"
            style={{ ...hintStyle, color: "var(--megane-danger-text, #b91c1c)" }}
          >
            {error}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
          {blockedReason && !busy && canEmbed() && (
            <span data-testid="sketch-blocked" style={hintStyle}>
              {blockedReason}
            </span>
          )}
          <button
            type="button"
            data-testid="sketch-cancel"
            style={{ ...chipStyle(false), fontFamily: "inherit" }}
            onClick={() => void requestClose()}
            title={busy ? "Stop embedding and keep the drawing" : undefined}
          >
            {busy ? "Stop" : "Cancel"}
          </button>
          {onSave ? (
            <>
              {actionButton("add", "Save as new", "sketch-add", false)}
              {actionButton("save", "Save changes", "sketch-save", true)}
            </>
          ) : (
            actionButton("add", "Add to library", "sketch-add", true)
          )}
        </div>
      </div>
    </div>
  );
}
