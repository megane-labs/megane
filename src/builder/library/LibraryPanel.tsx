/**
 * The molecule library as the Place tool's gallery: the presets and the
 * user's molecules, each with *Place* (stamp it where the next click lands)
 * and *Add* (drop it into the document now), *Rename* / *Edit* / *×* for the
 * user's own (× asks first); *Sketch…* opens Ketcher and *From file…*
 * imports a structure file. It opens in the Place tool's settings (the
 * Details panel).
 *
 * `LibraryHost` mounts the one sketch dialog and the one file input the
 * gallery and the Inspector share.
 */

import { useEffect, useRef, useState } from "react";
import { useDismiss } from "../../hooks/useDismiss";
import { STRUCTURE_ACCEPT } from "../../parsers/fileNames";
import { canEdit } from "../store";
import { buttonStyle, chipStyle, hintStyle, inputStyle } from "../styles";
import { SketchModal } from "./SketchModal";
import { allMolecules, isUserMolecule, useLibraryStore } from "./store";
import { useLibraryActions } from "./ui";
import type { LibraryMolecule } from "./types";
import { useScopedBuilderStore, useScopedLibraryUi } from "../BuilderStores";

const smallChip = (active: boolean, disabled = false): React.CSSProperties => ({
  ...chipStyle(active, disabled),
  fontSize: 11,
  padding: "2px 7px",
  fontFamily: "inherit",
});

export function LibraryHost() {
  const sketch = useScopedLibraryUi((s) => s.sketch);
  const closeSketch = useScopedLibraryUi((s) => s.closeSketch);
  const setImporter = useScopedLibraryUi((s) => s.setImporter);
  const { keep, update, importFile } = useLibraryActions();
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
        accept={STRUCTURE_ACCEPT}
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
          onSave={
            sketch.id
              ? (draft) => {
                  update(sketch.id!, draft);
                  closeSketch();
                }
              : undefined
          }
          onClose={closeSketch}
        />
      )}
    </>
  );
}

/** A user molecule's name, renamed in place: Enter or leaving the field keeps it, Escape does not. */
function RenameField({
  molecule,
  onDone,
}: {
  molecule: LibraryMolecule;
  onDone: (name: string | null) => void;
}) {
  const [text, setText] = useState(molecule.name);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  // Escape cancels the rename, not the gallery behind it.
  useDismiss({ onDismiss: () => finish(null) });
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      data-testid="builder-library-rename-input"
      aria-label={`New name for ${molecule.name}`}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(text);
        }
      }}
      onBlur={() => finish(text)}
      style={{ ...inputStyle, width: "100%", boxSizing: "border-box", fontSize: 12 }}
    />
  );
}

export function LibraryPanel({ onClose }: { onClose: () => void }) {
  const source = useScopedBuilderStore((s) => s.source);
  const result = useScopedBuilderStore((s) => s.result);
  const showOriginal = useScopedBuilderStore((s) => s.showOriginal);
  const placeSource = useScopedBuilderStore((s) => s.placeSource);
  const tool = useScopedBuilderStore((s) => s.tool);
  const user = useLibraryStore((s) => s.user);
  const openSketch = useScopedLibraryUi((s) => s.openSketch);
  const importer = useScopedLibraryUi((s) => s.importer);
  const { add, place, remove, rename } = useLibraryActions();
  const [renaming, setRenaming] = useState<string | null>(null);

  // With nothing open, Add starts a new document with the molecule.
  const editable = !source || canEdit({ source, result, showOriginal });
  const addTitle = editable
    ? "Add to the document now (inside the cell when there is room)"
    : showOriginal
      ? "Editing is paused while the original structure is shown"
      : "The open structure cannot be edited right now";
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
        <b>Place</b> stamps it where you click; <b>Add</b> drops it in now, in the emptiest part of
        the cell when there is room, otherwise beside the structure.
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
              {renaming === m.id ? (
                <span style={{ flex: 1, minWidth: 0 }}>
                  <RenameField
                    molecule={m}
                    onDone={(name) => {
                      setRenaming(null);
                      if (name !== null) rename(m, name);
                    }}
                  />
                </span>
              ) : (
                <span
                  style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}
                  onDoubleClick={isUserMolecule(m.id) ? () => setRenaming(m.id) : undefined}
                >
                  <span data-testid="builder-library-item-name">{m.name}</span>{" "}
                  <span style={hintStyle}>
                    {m.formula}
                    {m.planar ? " · flat" : ""}
                  </span>
                </span>
              )}
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
                title={addTitle}
              >
                Add
              </button>
              {isUserMolecule(m.id) && (
                <>
                  <button
                    type="button"
                    data-testid="builder-library-rename"
                    aria-label={`Rename ${m.name}`}
                    style={smallChip(renaming === m.id)}
                    onClick={() => setRenaming(renaming === m.id ? null : m.id)}
                    title="Rename (or double-click the name)"
                  >
                    ✎
                  </button>
                  {m.molfile && (
                    <button
                      type="button"
                      data-testid="builder-library-edit"
                      style={smallChip(false)}
                      onClick={() => openSketch({ molfile: m.molfile, name: m.name, id: m.id })}
                      title="Open the sketch in Ketcher to change it or save a variant"
                    >
                      Edit
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid="builder-library-remove"
                    aria-label={`Remove ${m.name} from the library`}
                    style={smallChip(false)}
                    onClick={() => void remove(m)}
                    title="Remove from the library (asks first)"
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
