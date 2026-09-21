/**
 * The sidebar's Library section: the presets and the user's molecules, each
 * with *Add* (drop it beside the structure) and *Place* (stamp it where the
 * next click lands); *Sketch…* opens Ketcher, *From file…* imports a
 * structure file, and *Save selection* keeps the selected atoms as a molecule.
 *
 * Errors and confirmations go to the store's single notice, not to a line of
 * this panel's own.
 */

import { useCallback, useRef, useState, type ChangeEvent } from "react";
import { useBuilderStore, canEdit, shownSnapshot } from "../store";
import { buttonStyle, chipStyle, hintStyle, rowStyle } from "../styles";
import { Section } from "../Section";
import { autoPlacement } from "./fragment";
import { SketchModal } from "./SketchModal";
import { draftFromFile, draftFromSnapshot } from "./sketch";
import { allMolecules, isUserMolecule, useLibraryStore } from "./store";
import type { LibraryMolecule, LibraryMoleculeDraft } from "./types";

/** Default height of an adsorbate above the clicked surface atom, Å. */
export const DEFAULT_ADSORB_HEIGHT = 2;

const itemRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "3px 4px",
};

const smallChip = (active: boolean, disabled = false): React.CSSProperties => ({
  ...chipStyle(active, disabled),
  fontSize: 11,
  padding: "2px 7px",
});

export function LibrarySection() {
  const source = useBuilderStore((s) => s.source);
  const result = useBuilderStore((s) => s.result);
  const showOriginal = useBuilderStore((s) => s.showOriginal);
  const selected = useBuilderStore((s) => s.selected);
  const placeSource = useBuilderStore((s) => s.placeSource);
  const tool = useBuilderStore((s) => s.tool);
  const addFragment = useBuilderStore((s) => s.addFragment);
  const setPlaceSource = useBuilderStore((s) => s.setPlaceSource);
  const reportError = useBuilderStore((s) => s.reportError);
  const reportInfo = useBuilderStore((s) => s.reportInfo);
  const user = useLibraryStore((s) => s.user);
  const addMolecule = useLibraryStore((s) => s.addMolecule);
  const removeMolecule = useLibraryStore((s) => s.removeMolecule);

  const [sketchOpen, setSketchOpen] = useState<{ molfile?: string; name?: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const editable = canEdit({ source, result, showOriginal });
  const shown = shownSnapshot({ source, result, showOriginal });
  const molecules = allMolecules({ user });

  const handleAdd = (m: LibraryMolecule) => {
    if (!editable) return;
    addFragment(m, autoPlacement(shown, m));
  };
  const handlePlace = (m: LibraryMolecule) => {
    setPlaceSource(placeSource?.id === m.id && tool === "place" ? null : m);
  };
  const handleRemove = (m: LibraryMolecule) => {
    if (placeSource?.id === m.id) setPlaceSource(null);
    removeMolecule(m.id);
  };
  const keep = useCallback(
    (draft: LibraryMoleculeDraft) => {
      const added = addMolecule(draft);
      reportInfo(`Added ${added.name} to the library.`);
    },
    [addMolecule, reportInfo],
  );
  const handleSketchAdd = useCallback(
    (draft: LibraryMoleculeDraft) => {
      keep(draft);
      setSketchOpen(null);
    },
    [keep],
  );
  const handleFileChange = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      try {
        keep(await draftFromFile(file));
      } catch (err) {
        reportError(
          `Could not import ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [keep, reportError],
  );
  const handleSaveSelection = () => {
    if (!shown || selected.length === 0) return;
    try {
      keep(draftFromSnapshot(shown, `Selection (${selected.length} atoms)`, "selection", selected));
    } catch (err) {
      reportError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Section
      id="library"
      title="Library"
      summary={
        <span data-testid="builder-library-count">
          {molecules.length} molecule{molecules.length === 1 ? "" : "s"}
        </span>
      }
    >
      <div
        data-testid="builder-library"
        style={{ display: "flex", flexDirection: "column", gap: 8 }}
      >
        <div style={rowStyle}>
          <button
            type="button"
            data-testid="builder-library-sketch"
            style={buttonStyle()}
            onClick={() => setSketchOpen({})}
            title="Draw a molecule in Ketcher and add it to the library"
          >
            Sketch…
          </button>
          <button
            type="button"
            data-testid="builder-library-import"
            style={buttonStyle()}
            onClick={() => fileRef.current?.click()}
            title="Add a molecule from a structure file"
          >
            From file…
          </button>
          <input
            ref={fileRef}
            data-testid="builder-library-import-input"
            type="file"
            style={{ display: "none" }}
            onChange={(e) => void handleFileChange(e)}
          />
          <button
            type="button"
            data-testid="builder-library-save-selection"
            style={buttonStyle("default", selected.length === 0 || !shown)}
            disabled={selected.length === 0 || !shown}
            onClick={handleSaveSelection}
            title="Keep the selected atoms (and the bonds between them) as a library molecule"
          >
            Save selection
          </button>
        </div>
        <div style={hintStyle}>
          <b>Add</b> drops a molecule beside the structure; <b>Place</b> stamps it where you click.
        </div>
        <ul
          data-testid="builder-library-list"
          style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 220, overflowY: "auto" }}
        >
          {molecules.map((m) => {
            const placing = tool === "place" && placeSource?.id === m.id;
            return (
              <li
                key={m.id}
                data-testid={`builder-library-item-${m.id}`}
                data-placing={placing ? "true" : undefined}
                style={{
                  ...itemRowStyle,
                  background: placing ? "rgba(37, 99, 235, 0.08)" : undefined,
                  borderRadius: 4,
                }}
              >
                <span
                  style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}
                >
                  <span data-testid="builder-library-item-name">{m.name}</span>{" "}
                  <span style={hintStyle}>
                    {m.formula}
                    {m.planar ? " · flat" : ""}
                  </span>
                </span>
                <span
                  role="button"
                  data-testid="builder-library-add"
                  style={smallChip(false, !editable)}
                  onClick={editable ? () => handleAdd(m) : undefined}
                  title="Add beside the structure"
                >
                  Add
                </span>
                <span
                  role="button"
                  data-testid="builder-library-place"
                  aria-pressed={placing}
                  style={smallChip(placing)}
                  onClick={() => handlePlace(m)}
                  title="Place where the next click lands"
                >
                  Place
                </span>
                {isUserMolecule(m.id) && (
                  <>
                    {m.molfile && (
                      <span
                        role="button"
                        data-testid="builder-library-edit"
                        style={smallChip(false)}
                        onClick={() => setSketchOpen({ molfile: m.molfile, name: m.name })}
                        title="Open the sketch in Ketcher (adds the result as a new molecule)"
                      >
                        Edit
                      </span>
                    )}
                    <span
                      role="button"
                      data-testid="builder-library-remove"
                      style={smallChip(false)}
                      onClick={() => handleRemove(m)}
                      title="Remove from the library"
                    >
                      ×
                    </span>
                  </>
                )}
              </li>
            );
          })}
        </ul>
        {sketchOpen && (
          <SketchModal
            initialMolfile={sketchOpen.molfile}
            initialName={sketchOpen.name}
            onAdd={handleSketchAdd}
            onClose={() => setSketchOpen(null)}
          />
        )}
      </div>
    </Section>
  );
}
