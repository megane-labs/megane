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
import { Button, Group, ScrollArea, Stack, Text } from "@mantine/core";
import { useBuilderStore, canEdit, shownSnapshot } from "../store";
import { Section } from "../Section";
import { autoPlacement } from "./fragment";
import { SketchModal } from "./SketchModal";
import { draftFromFile, draftFromSnapshot } from "./sketch";
import { allMolecules, isUserMolecule, useLibraryStore } from "./store";
import type { LibraryMolecule, LibraryMoleculeDraft } from "./types";

/** Default height of an adsorbate above the clicked surface atom, Å. */
export const DEFAULT_ADSORB_HEIGHT = 2;

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
      <Stack gap="xs" data-testid="builder-library">
        <Group gap="xs">
          <Button
            variant="default"
            data-testid="builder-library-sketch"
            onClick={() => setSketchOpen({})}
            title="Draw a molecule in Ketcher and add it to the library"
          >
            Sketch…
          </Button>
          <Button
            variant="default"
            data-testid="builder-library-import"
            onClick={() => fileRef.current?.click()}
            title="Add a molecule from a structure file"
          >
            From file…
          </Button>
          <input
            ref={fileRef}
            data-testid="builder-library-import-input"
            type="file"
            style={{ display: "none" }}
            onChange={(e) => void handleFileChange(e)}
          />
          <Button
            variant="default"
            data-testid="builder-library-save-selection"
            disabled={selected.length === 0 || !shown}
            onClick={handleSaveSelection}
            title="Keep the selected atoms (and the bonds between them) as a library molecule"
          >
            Save selection
          </Button>
        </Group>
        <Text size="xs" c="dimmed">
          <b>Add</b> drops a molecule beside the structure; <b>Place</b> stamps it where you click.
        </Text>
        <ScrollArea.Autosize mah={220} type="auto">
          <Stack gap={2} data-testid="builder-library-list">
            {molecules.map((m) => {
              const placing = tool === "place" && placeSource?.id === m.id;
              return (
                <Group
                  key={m.id}
                  gap={4}
                  wrap="nowrap"
                  px={4}
                  py={2}
                  data-testid={`builder-library-item-${m.id}`}
                  data-placing={placing ? "true" : undefined}
                  style={{
                    borderRadius: 4,
                    background: placing ? "var(--mantine-color-blue-light)" : undefined,
                  }}
                >
                  <Text size="sm" truncate style={{ flex: 1, minWidth: 0 }}>
                    <span data-testid="builder-library-item-name">{m.name}</span>{" "}
                    <Text span size="xs" c="dimmed">
                      {m.formula}
                      {m.planar ? " · flat" : ""}
                    </Text>
                  </Text>
                  <Button
                    size="compact-xs"
                    radius="xl"
                    variant="default"
                    data-testid="builder-library-add"
                    disabled={!editable}
                    onClick={() => handleAdd(m)}
                    title="Add beside the structure"
                  >
                    Add
                  </Button>
                  <Button
                    size="compact-xs"
                    radius="xl"
                    variant={placing ? "filled" : "default"}
                    aria-pressed={placing}
                    data-testid="builder-library-place"
                    onClick={() => handlePlace(m)}
                    title="Place where the next click lands"
                  >
                    Place
                  </Button>
                  {isUserMolecule(m.id) && (
                    <>
                      {m.molfile && (
                        <Button
                          size="compact-xs"
                          radius="xl"
                          variant="default"
                          data-testid="builder-library-edit"
                          onClick={() => setSketchOpen({ molfile: m.molfile, name: m.name })}
                          title="Open the sketch in Ketcher (adds the result as a new molecule)"
                        >
                          Edit
                        </Button>
                      )}
                      <Button
                        size="compact-xs"
                        radius="xl"
                        variant="default"
                        data-testid="builder-library-remove"
                        onClick={() => handleRemove(m)}
                        title="Remove from the library"
                      >
                        ×
                      </Button>
                    </>
                  )}
                </Group>
              );
            })}
          </Stack>
        </ScrollArea.Autosize>
        {sketchOpen && (
          <SketchModal
            initialMolfile={sketchOpen.molfile}
            initialName={sketchOpen.name}
            onAdd={handleSketchAdd}
            onClose={() => setSketchOpen(null)}
          />
        )}
      </Stack>
    </Section>
  );
}
