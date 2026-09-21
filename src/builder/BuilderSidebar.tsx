/**
 * The Builder's side panel, in four layers:
 *
 *   Tool      — the tool, and *only* the settings that tool uses
 *   Library   — molecules to drop into the document
 *   Crystal   — cell, supercell, slab, symmetry (edits of the open structure)
 *   History   — the operation list, undo / redo / clear, "show original"
 *
 * Document-level actions (open, new, save) live in the top bar, not here, so
 * each control appears exactly once. Built from Mantine components over
 * `useBuilderStore`; every edit goes through the store's actions and the
 * handlers installed by `useBuilderHandlers`.
 */

import { useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Divider,
  Group,
  List,
  NativeSelect,
  NumberInput,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { useBuilderStore, canEdit } from "./store";
import { describeOp } from "./placement";
import { Section } from "./Section";
import { TOOL_KEYS } from "./shortcuts";
import type { BuildTool } from "./types";
import type { EditAtomRef } from "../pipeline/types";
import { getElementSymbol } from "../constants";
import { LibrarySection, DEFAULT_ADSORB_HEIGHT } from "./library/LibrarySection";
import { CrystalSection } from "./crystal/CrystalSection";

export interface ToolInfo {
  value: BuildTool;
  label: string;
  hint: string;
  /** Which contextual settings the tool panel shows for it. */
  needs: ("element" | "bondOrder" | "place")[];
}

export const TOOLS: ToolInfo[] = [
  {
    value: "select",
    label: "Select",
    hint: "Click atoms to select them (Shift adds).",
    needs: [],
  },
  {
    value: "add",
    label: "Add atom",
    hint: "Click an atom to attach a new one at bond length; click empty space to place it free.",
    needs: ["element", "bondOrder"],
  },
  {
    value: "bond",
    label: "Bond",
    hint: "Click two atoms to bond them (or change the bond order).",
    needs: ["bondOrder"],
  },
  {
    value: "delete",
    label: "Delete",
    hint: "Click an atom to remove it with its bonds.",
    needs: [],
  },
  { value: "move", label: "Move", hint: "Drag an atom in the screen plane.", needs: [] },
  {
    value: "element",
    label: "Element",
    hint: "Click an atom to change it to the chosen element.",
    needs: ["element"],
  },
  {
    value: "place",
    label: "Place",
    hint: "Click empty space to drop the library molecule chosen below there.",
    needs: ["place"],
  },
];

/** Elements offered as quick chips; anything else via the number input. */
const QUICK_ELEMENTS = [1, 6, 7, 8, 9, 15, 16, 17, 35, 14];

const BOND_ORDERS = [
  { value: "1", label: "Single" },
  { value: "2", label: "Double" },
  { value: "3", label: "Triple" },
  { value: "4", label: "Aromatic" },
];

export function BuilderSidebar() {
  const source = useBuilderStore((s) => s.source);
  const result = useBuilderStore((s) => s.result);
  const showOriginal = useBuilderStore((s) => s.showOriginal);
  const edits = useBuilderStore((s) => s.edits);
  const setShowOriginal = useBuilderStore((s) => s.setShowOriginal);

  const editable = canEdit({ source, result, showOriginal });

  return (
    <ScrollArea h="100%" type="auto">
      <Stack gap="sm" p="sm" data-testid="builder-sidebar">
        {!source && (
          <Text size="xs" c="dimmed" data-testid="builder-empty-hint">
            Open a structure file, or start a new one from the top bar.
          </Text>
        )}
        {source && showOriginal && (
          <Alert color="yellow" variant="light" p="xs" data-testid="builder-paused">
            <Stack gap={6}>
              <Text size="xs">Showing the structure as loaded. Editing is paused.</Text>
              <Group>
                <Button
                  variant="default"
                  data-testid="builder-resume-editing"
                  onClick={() => setShowOriginal(false)}
                >
                  Back to the edited structure
                </Button>
              </Group>
            </Stack>
          </Alert>
        )}

        <ToolPanel editable={editable} />
        <LibrarySection />
        <CrystalSection />
        <HistorySection defaultOpen={edits.length > 0} />
      </Stack>
    </ScrollArea>
  );
}

// ── Tool ──

function ToolPanel({ editable }: { editable: boolean }) {
  const tool = useBuilderStore((s) => s.tool);
  const element = useBuilderStore((s) => s.element);
  const bondOrder = useBuilderStore((s) => s.bondOrder);
  const selected = useBuilderStore((s) => s.selected);
  const pendingBondAtom = useBuilderStore((s) => s.pendingBondAtom);
  const placeSource = useBuilderStore((s) => s.placeSource);
  const adsorbHeight = useBuilderStore((s) => s.adsorbHeight);
  const setTool = useBuilderStore((s) => s.setTool);
  const setElement = useBuilderStore((s) => s.setElement);
  const setBondOrder = useBuilderStore((s) => s.setBondOrder);
  const setAdsorbHeight = useBuilderStore((s) => s.setAdsorbHeight);

  const active = TOOLS.find((t) => t.value === tool)!;

  return (
    <Paper withBorder radius="md" p="sm" data-testid="builder-tools">
      <Stack gap="xs">
        <Text size="xs" fw={700} tt="uppercase" c="dimmed" style={{ letterSpacing: 0.4 }}>
          Tool
        </Text>
        <Group gap={4} role="radiogroup" aria-label="Tool">
          {TOOLS.map((t) => (
            <Tooltip key={t.value} label={`${t.label} (${TOOL_KEYS[t.value]})`} openDelay={400}>
              <Button
                variant={tool === t.value ? "filled" : "default"}
                size="compact-xs"
                role="radio"
                aria-checked={tool === t.value}
                aria-pressed={tool === t.value}
                data-testid={`builder-tool-${t.value}`}
                onClick={() => setTool(t.value)}
              >
                {t.label}
              </Button>
            </Tooltip>
          ))}
        </Group>
        <Text size="xs" c="dimmed" data-testid="builder-tool-hint">
          {active.hint}
          {tool === "bond" && pendingBondAtom !== null && ` First atom: #${pendingBondAtom}.`}
          {tool === "place" &&
            (placeSource ? ` Placing ${placeSource.name}.` : " Choose a molecule in the library.")}
        </Text>

        {active.needs.includes("element") && (
          <Stack gap={6}>
            <Text size="xs" c="dimmed">
              Element
            </Text>
            <Group gap={4}>
              {QUICK_ELEMENTS.map((z) => (
                <Button
                  key={z}
                  size="compact-xs"
                  radius="xl"
                  variant={element === z ? "filled" : "default"}
                  aria-pressed={element === z}
                  data-testid={`builder-element-${getElementSymbol(z)}`}
                  onClick={() => setElement(z)}
                >
                  {getElementSymbol(z)}
                </Button>
              ))}
              <Group gap={4} wrap="nowrap">
                <Text size="xs" c="dimmed">
                  Z
                </Text>
                <NumberInput
                  data-testid="builder-element-z"
                  min={1}
                  max={118}
                  w={64}
                  hideControls
                  value={element}
                  onChange={(v) => {
                    const n = typeof v === "number" ? v : parseInt(String(v), 10);
                    if (Number.isFinite(n) && n >= 1 && n <= 118) setElement(n);
                  }}
                />
                <Text size="xs" c="dimmed">
                  = {getElementSymbol(element)}
                </Text>
              </Group>
            </Group>
          </Stack>
        )}

        {active.needs.includes("bondOrder") && (
          <Group gap={6} wrap="nowrap">
            <Text size="xs" c="dimmed">
              Bond order
            </Text>
            <NativeSelect
              data-testid="builder-bond-order"
              value={String(bondOrder)}
              onChange={(e) => setBondOrder(parseInt(e.currentTarget.value, 10))}
              data={BOND_ORDERS}
            />
          </Group>
        )}

        {active.needs.includes("place") && (
          <AdsorbOption height={adsorbHeight} onChange={setAdsorbHeight} />
        )}

        {selected.length > 0 && <SelectionActions editable={editable} />}
      </Stack>
    </Paper>
  );
}

/**
 * "Place on atoms": with a height set, the Place tool also accepts a click on
 * an atom and stamps the molecule that far above it — an adsorbate on a site.
 */
function AdsorbOption({
  height,
  onChange,
}: {
  height: number | null;
  onChange: (h: number | null) => void;
}) {
  // The typed height survives unticking the box, so turning the option back
  // on uses it again rather than the default.
  const [draft, setDraft] = useState(height ?? DEFAULT_ADSORB_HEIGHT);
  return (
    <Group gap={6} wrap="nowrap">
      <Checkbox
        data-testid="builder-adsorb-toggle"
        checked={height !== null}
        onChange={(e) => onChange(e.currentTarget.checked ? draft : null)}
        label="Place on atoms:"
      />
      <NumberInput
        data-testid="builder-adsorb-height"
        step={0.1}
        w={64}
        hideControls
        value={draft}
        onChange={(v) => {
          const n = typeof v === "number" ? v : Number(v);
          setDraft(n);
          if (height !== null) onChange(n);
        }}
        title="Height above the clicked atom along the cell's c axis (an adsorbate on a surface site)"
      />
      <Text size="xs" c="dimmed">
        Å above along c
      </Text>
    </Group>
  );
}

/** What can be done with the current selection, shown only while there is one. */
function SelectionActions({ editable }: { editable: boolean }) {
  const result = useBuilderStore((s) => s.result);
  const selected = useBuilderStore((s) => s.selected);
  const element = useBuilderStore((s) => s.element);
  const clearSelected = useBuilderStore((s) => s.clearSelected);
  const pushOp = useBuilderStore((s) => s.pushOp);

  const refs = (): EditAtomRef[] =>
    selected
      .map((i) => (result && i >= 0 && i < result.snapshot.nAtoms ? result.refAt(i) : null))
      .filter((r): r is EditAtomRef => r !== null);

  const handleDelete = () => {
    const atoms = refs();
    if (atoms.length === 0) return;
    clearSelected();
    pushOp({ op: "delete_atoms", atoms });
  };
  const handleSetElement = () => {
    const atoms = refs();
    if (atoms.length === 0) return;
    pushOp({ op: "set_element", atoms, element });
  };

  return (
    <Stack gap={6} data-testid="builder-selection">
      <Divider />
      <Text size="xs" c="dimmed" data-testid="builder-selected-count">
        {selected.length} atom{selected.length === 1 ? "" : "s"} selected.
      </Text>
      <Group gap="xs">
        <Button
          color="red"
          variant="outline"
          data-testid="builder-delete-selected"
          disabled={!editable}
          onClick={handleDelete}
        >
          Delete
        </Button>
        <Button
          variant="default"
          data-testid="builder-set-element-selected"
          disabled={!editable}
          onClick={handleSetElement}
        >
          Set to {getElementSymbol(element)}
        </Button>
        <Button variant="default" data-testid="builder-clear-selection" onClick={clearSelected}>
          Clear
        </Button>
      </Group>
    </Stack>
  );
}

// ── History ──

function HistorySection({ defaultOpen }: { defaultOpen: boolean }) {
  const source = useBuilderStore((s) => s.source);
  const edits = useBuilderStore((s) => s.edits);
  const redoStack = useBuilderStore((s) => s.redoStack);
  const result = useBuilderStore((s) => s.result);
  const showOriginal = useBuilderStore((s) => s.showOriginal);
  const undo = useBuilderStore((s) => s.undo);
  const redo = useBuilderStore((s) => s.redo);
  const clearOps = useBuilderStore((s) => s.clearOps);
  const setShowOriginal = useBuilderStore((s) => s.setShowOriginal);

  return (
    <Section
      id="history"
      title="History"
      defaultOpen={defaultOpen}
      summary={
        <span data-testid="builder-op-count">
          {edits.length} edit{edits.length === 1 ? "" : "s"}
        </span>
      }
    >
      <Stack gap="xs">
        <Group gap="xs">
          <Button
            variant="default"
            data-testid="builder-undo"
            disabled={edits.length === 0}
            onClick={() => undo()}
          >
            Undo
          </Button>
          <Button
            variant="default"
            data-testid="builder-redo"
            disabled={redoStack.length === 0}
            onClick={() => redo()}
          >
            Redo
          </Button>
          <Button
            variant="outline"
            color="red"
            data-testid="builder-clear-ops"
            disabled={edits.length === 0}
            onClick={clearOps}
          >
            Clear all
          </Button>
          <Button
            variant={showOriginal ? "light" : "default"}
            aria-pressed={showOriginal}
            data-testid="builder-show-original"
            disabled={!source || (edits.length === 0 && !showOriginal)}
            onClick={() => setShowOriginal(!showOriginal)}
            title="Preview the structure as loaded, without the edits"
          >
            Show original
          </Button>
        </Group>
        {edits.length > 0 && (
          <ScrollArea.Autosize mah={160}>
            <List type="ordered" size="xs" c="dimmed" data-testid="builder-op-list" withPadding>
              {edits.map((op, i) => (
                <List.Item key={i}>{describeOp(op)}</List.Item>
              ))}
            </List>
          </ScrollArea.Autosize>
        )}
        {result && result.warnings.length > 0 && (
          <Stack gap={2} data-testid="builder-warnings">
            {result.warnings.map((w, i) => (
              <Text key={i} size="xs" c="orange.7">
                {w}
              </Text>
            ))}
          </Stack>
        )}
      </Stack>
    </Section>
  );
}
