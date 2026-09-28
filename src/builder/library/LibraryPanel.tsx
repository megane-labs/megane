/**
 * The molecule library as the Place tool's gallery: the presets and the
 * user's molecules, each with *Place* (stamp it where the next click lands)
 * and *Add* (drop it beside the structure now), *Edit* / *×* for the user's
 * own; *Sketch…* opens Ketcher and *From file…* imports a structure file.
 * It opens in the Place tool's settings (the Details panel) and from
 * Insert › Molecule….
 *
 * `LibraryHost` mounts the one sketch dialog and the one file input the
 * gallery, the Insert menu and the Inspector share.
 */

import { useEffect, useRef } from "react";
import { useBuilderStore, canEdit } from "../store";
import { buttonStyle, chipStyle, hintStyle } from "../styles";
import { SketchModal } from "./SketchModal";
import { allMolecules, isUserMolecule, useLibraryStore } from "./store";
import { useLibraryActions, useLibraryUi } from "./ui";

const smallChip = (active: boolean, disabled = false): React.CSSProperties => ({
  ...chipStyle(active, disabled),
  fontSize: 11,
  padding: "2px 7px",
  fontFamily: "inherit",
});

export function LibraryHost() {
  const sketch = useLibraryUi((s) => s.sketch);
  const closeSketch = useLibraryUi((s) => s.closeSketch);
  const setImporter = useLibraryUi((s) => s.setImporter);
  const { keep, importFile } = useLibraryActions();
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setImporter(() => fileRef.current?.click());
    return () => setImporter(null);
  }, [setImporter]);

  return (
    <>
      <input
        ref={fileRef}
        data-testid="builder-library-import-input"
        type="file"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void importFile(file);
        }}
      />
      {sketch && (
        <SketchModal
          initialMolfile={sketch.molfile}
          initialName={sketch.name}
          onAdd={(draft) => {
            keep(draft);
            closeSketch();
          }}
          onClose={closeSketch}
        />
      )}
    </>
  );
}

export function LibraryPanel({ onClose }: { onClose: () => void }) {
  const source = useBuilderStore((s) => s.source);
  const result = useBuilderStore((s) => s.result);
  const showOriginal = useBuilderStore((s) => s.showOriginal);
  const placeSource = useBuilderStore((s) => s.placeSource);
  const tool = useBuilderStore((s) => s.tool);
  const user = useLibraryStore((s) => s.user);
  const openSketch = useLibraryUi((s) => s.openSketch);
  const importer = useLibraryUi((s) => s.importer);
  const { add, place, remove } = useLibraryActions();

  // With nothing open, Add starts a new document with the molecule.
  const editable = !source || canEdit({ source, result, showOriginal });
  const molecules = allMolecules({ user });

  return (
    <div
      data-testid="builder-library"
      role="dialog"
      aria-label="Molecules"
      style={{
        width: "100%",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        borderRadius: 8,
        background: "var(--megane-surface-muted, #f1f5f9)",
        color: "var(--megane-text, #1e293b)",
        fontSize: 13,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px 6px" }}>
        <span style={{ fontWeight: 700 }}>Molecules</span>
        <span style={hintStyle} data-testid="builder-library-count">
          {molecules.length} molecule{molecules.length === 1 ? "" : "s"}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-testid="builder-library-close"
          aria-label="Close the molecule list"
          style={{ ...buttonStyle(), padding: "2px 8px" }}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div style={{ ...hintStyle, padding: "0 12px 6px" }}>
        <b>Place</b> stamps it where you click; <b>Add</b> drops it beside the structure now.
      </div>
      <ul
        data-testid="builder-library-list"
        style={{
          listStyle: "none",
          margin: 0,
          padding: "0 6px",
          maxHeight: 280,
          overflowY: "auto",
        }}
      >
        {molecules.map((m) => {
          const placing = tool === "place" && placeSource?.id === m.id;
          return (
            <li
              key={m.id}
              data-testid={`builder-library-item-${m.id}`}
              data-placing={placing ? "true" : undefined}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "4px 6px",
                borderRadius: 6,
                background: placing ? "rgba(59, 130, 246, 0.08)" : undefined,
              }}
            >
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                <span data-testid="builder-library-item-name">{m.name}</span>{" "}
                <span style={hintStyle}>
                  {m.formula}
                  {m.planar ? " · flat" : ""}
                </span>
              </span>
              <button
                type="button"
                data-testid="builder-library-place"
                aria-pressed={placing}
                style={smallChip(placing)}
                onClick={() => place(m)}
                title="Place where the next click lands"
              >
                Place
              </button>
              <button
                type="button"
                data-testid="builder-library-add"
                style={smallChip(false, !editable)}
                disabled={!editable}
                onClick={() => add(m)}
                title="Add beside the structure"
              >
                Add
              </button>
              {isUserMolecule(m.id) && (
                <>
                  {m.molfile && (
                    <button
                      type="button"
                      data-testid="builder-library-edit"
                      style={smallChip(false)}
                      onClick={() => openSketch({ molfile: m.molfile, name: m.name })}
                      title="Open the sketch in Ketcher (adds the result as a new molecule)"
                    >
                      Edit
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid="builder-library-remove"
                    aria-label={`Remove ${m.name} from the library`}
                    style={smallChip(false)}
                    onClick={() => remove(m)}
                    title="Remove from the library"
                  >
                    ×
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
      <div
        style={{
          display: "flex",
          gap: 8,
          padding: "8px 12px",
          marginTop: 6,
          borderTop: "1px solid var(--megane-border-solid, #e2e8f0)",
        }}
      >
        <button
          type="button"
          data-testid="builder-library-sketch"
          style={buttonStyle()}
          onClick={() => openSketch()}
          title="Draw a molecule in Ketcher and add it to the library"
        >
          Sketch…
        </button>
        <button
          type="button"
          data-testid="builder-library-import"
          style={buttonStyle()}
          onClick={() => importer?.()}
          title="Add a molecule from a structure file"
        >
          From file…
        </button>
      </div>
    </div>
  );
}
