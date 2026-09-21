/**
 * The "Sketch a molecule" dialog: Ketcher in a modal, a name field, and an
 * *Add to library* button that reads the sketch back as a molfile and turns
 * it into a library molecule (`draftFromMolfile`): RDKit (`megane-rdkit`,
 * in a worker) embeds it in 3D with the hydrogens it leaves implicit;
 * *Add hydrogens* turns those off for a bare skeleton. RDKit is the only
 * way a sketch becomes 3D, so when it cannot run (no Web Workers, the WASM
 * blocked, a drawing it cannot sanitise) the dialog reports the error and
 * nothing is added.
 *
 * Ketcher is loaded on demand. While it loads, and if it cannot load at all
 * (offline bundle, blocked WASM), the dialog falls back to a plain molfile
 * text field so the library is never unreachable; the same field is offered
 * behind *Paste MOL* for users who bring a molfile from elsewhere.
 */

import { Component, lazy, Suspense, useCallback, useRef, useState, type ReactNode } from "react";
import { Box, Button, Checkbox, Group, Modal, Text, TextInput, Textarea } from "@mantine/core";
import type { Ketcher } from "ketcher-core";
import { isE2ETestMode } from "../../testMode";
import { canEmbed } from "./embed";
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
  const [withHydrogens, setWithHydrogens] = useState(true);
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
      const draft = await draftFromMolfile(molfile, name, { addHydrogens: withHydrogens });
      onAdd(draft);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`RDKit could not embed the sketch in 3D: ${message}`);
    } finally {
      setBusy(false);
    }
  }, [molText, pasteMode, name, withHydrogens, onAdd]);

  const canAdd = !busy && canEmbed() && (pasteMode ? molText.trim().length > 0 : ready);

  const pasteField = (
    <Textarea
      data-testid="sketch-molfile"
      value={molText}
      onChange={(e) => setMolText(e.currentTarget.value)}
      placeholder="Paste a MOL / SDF file here"
      spellCheck={false}
      styles={{
        root: { flex: 1, display: "flex" },
        wrapper: { flex: 1, display: "flex" },
        input: { flex: 1, minHeight: 240, fontFamily: "ui-monospace, monospace", resize: "none" },
      }}
    />
  );

  return (
    <Modal.Root opened onClose={onClose} size="min(960px, 94vw)" centered>
      <Modal.Overlay />
      <Modal.Content data-testid="sketch-modal">
        <Modal.Header>
          <Modal.Title fw={700}>Sketch a molecule</Modal.Title>
          <Modal.CloseButton />
        </Modal.Header>
        <Modal.Body
          style={{ height: "min(70vh, 640px)", display: "flex", flexDirection: "column" }}
        >
          <Group gap="xs" mb="xs">
            <TextInput
              data-testid="sketch-name"
              label={null}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder="Name (formula)"
              w={180}
            />
            <Button
              variant={pasteMode ? "filled" : "default"}
              aria-pressed={pasteMode}
              data-testid="sketch-paste-toggle"
              onClick={() => setPasteMode((v) => !v)}
            >
              Paste MOL
            </Button>
            <Checkbox
              data-testid="sketch-hydrogens"
              checked={withHydrogens}
              onChange={(e) => setWithHydrogens(e.currentTarget.checked)}
              label="Add hydrogens"
            />
          </Group>
          <Text size="xs" c="dimmed" data-testid="sketch-mode-hint" mb="xs">
            {canEmbed()
              ? "RDKit embeds the sketch in 3D (ETKDG, then MMFF94s / UFF) with its missing hydrogens."
              : "3D embedding needs Web Workers, which this host lacks."}
          </Text>
          <Box
            data-testid="sketch-editor"
            style={{
              flex: 1,
              minHeight: 0,
              display: "flex",
              border: "1px solid var(--mantine-color-default-border)",
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
                  <Box data-testid="sketch-fallback" p="sm" style={{ flex: 1 }}>
                    <Text size="xs" c="orange.7" mb="xs">
                      Ketcher could not be loaded ({err.message}). Paste a MOL file instead.
                    </Text>
                    <Button
                      variant="default"
                      data-testid="sketch-fallback-paste"
                      onClick={() => setPasteMode(true)}
                    >
                      Paste MOL
                    </Button>
                  </Box>
                )}
              >
                <Suspense
                  fallback={
                    <Text size="xs" c="dimmed" p="sm" data-testid="sketch-loading">
                      Loading Ketcher…
                    </Text>
                  }
                >
                  <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
                    <KetcherEditor onInit={handleInit} onError={(m) => setError(m)} />
                  </div>
                </Suspense>
              </LoadBoundary>
            )}
          </Box>
          {error && (
            <Text size="xs" c="red.7" role="alert" data-testid="sketch-error" mt="xs">
              {error}
            </Text>
          )}
          <Group justify="flex-end" mt="sm">
            <Button variant="default" data-testid="sketch-cancel" onClick={onClose}>
              Cancel
            </Button>
            <Button
              data-testid="sketch-add"
              disabled={!canAdd}
              aria-disabled={!canAdd}
              onClick={() => void handleAdd()}
            >
              {busy ? "Embedding…" : "Add to library"}
            </Button>
          </Group>
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}
