/**
 * The current tool's settings, at the top of the Details panel: pressing a
 * tool on the rail left of the view shows its options here, and only those —
 * the element for *Add atom* and *Element* (the periodic table opens beside
 * the panel for the rarer ones), the bond order for *Add atom* and *Bond*, Box /
 * All / Invert and select-by-element for *Select*, Snap and the drag gestures for
 * *Select* and *Move*, the molecule gallery and *Place on atoms* for *Place*,
 * and how hydrogens are kept for the tools that change atoms or bonds.
 * A tool with no settings shows none.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { shownSnapshot, type HydrogenMode } from "./store";
import { toolInfo } from "./ToolRail";
import { DEFAULT_ADSORB_HEIGHT } from "./library/ui";
import { LibraryPanel } from "./library/LibraryPanel";
import { PeriodicTable } from "./PeriodicTable";
import { getElementSymbol } from "../constants";
import {
  ACCENT,
  buttonStyle,
  fieldStyle,
  hintStyle,
  monoStyle,
  sectionStyle,
  sectionTitleStyle,
} from "./styles";
import { TOOL_KEYS } from "./shortcuts";
import { elementGroups, parseElement, useRecentElements } from "./elements";
import { balancesHydrogens } from "./hydrogens";
import { useBuilderStoreApi, useScopedBuilderStore, useScopedLibraryUi } from "./BuilderStores";
import { SNAP_ANGLE, SNAP_DISTANCE } from "./manipulate";

/** Elements offered as one-click buttons; anything else via the element field. */
export const QUICK_ELEMENTS = [6, 1, 7, 8, 9, 15, 16, 17, 35, 14];

/** Metals offered as one-click buttons, for surfaces, alloys and crystals. */
export const METAL_ELEMENTS = [3, 11, 12, 13, 22, 26, 29, 30, 78, 79];

/** Every element that already has a button, which the Recent row leaves out. */
const OFFERED = new Set([...QUICK_ELEMENTS, ...METAL_ELEMENTS]);

export const HYDROGEN_MODES: { value: HydrogenMode; label: string; title: string }[] = [
  {
    value: "auto",
    label: "Auto",
    title: "Keep hydrogens balanced while the structure has any H atom; leave a bare skeleton bare",
  },
  { value: "on", label: "On", title: "Always add and remove H to keep valences filled" },
  { value: "off", label: "Off", title: "Never add or remove H" },
];

/** What the Hydrogens setting does to the open structure, in a line. */
export function hydrogenHint(mode: HydrogenMode, autoBalances: boolean): string {
  if (mode === "on") return "On: edits add and remove H to keep valences filled.";
  if (mode === "off") return "Off: edits never add or remove H.";
  return autoBalances
    ? "Auto: on — this structure has explicit H, so edits keep them balanced."
    : "Auto: off — bare skeleton; edits add no H until the structure has some.";
}

/**
 * The selection a select-by-element button makes from `selected`: the
 * element's `atoms` alone; with `add` (Shift) the two together; with `toggle`
 * (Ctrl/⌘) the two together, or the selection without them when they are all
 * selected already.
 */
export function selectByElement(
  selected: readonly number[],
  atoms: readonly number[],
  { add = false, toggle = false }: { add?: boolean; toggle?: boolean } = {},
): number[] {
  if (!add && !toggle) return [...atoms];
  const have = new Set(selected);
  if (toggle && atoms.every((a) => have.has(a))) {
    const drop = new Set(atoms);
    return selected.filter((a) => !drop.has(a));
  }
  return [...selected, ...atoms.filter((a) => !have.has(a))];
}

/**
 * Arrow keys, Home and End in a radio group (`role="radiogroup"` around
 * `role="radio"` buttons): move to the next or previous choice and pick it,
 * as a native radio group does.
 */
export function radioGroupKeyDown(e: React.KeyboardEvent<HTMLElement>) {
  const radios = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')];
  const i = radios.indexOf(e.target as HTMLElement);
  if (i < 0) return;
  const n = radios.length;
  let j: number;
  switch (e.key) {
    case "ArrowRight":
    case "ArrowDown":
      j = (i + 1) % n;
      break;
    case "ArrowLeft":
    case "ArrowUp":
      j = (i - 1 + n) % n;
      break;
    case "Home":
      j = 0;
      break;
    case "End":
      j = n - 1;
      break;
    default:
      return;
  }
  e.preventDefault();
  radios[j].focus();
  radios[j].click();
}

export const BOND_ORDERS: { value: number; label: string; lines: string[] }[] = [
  { value: 1, label: "Single", lines: ["M4 12h16"] },
  { value: 2, label: "Double", lines: ["M4 9h16", "M4 15h16"] },
  { value: 3, label: "Triple", lines: ["M4 7h16", "M4 12h16", "M4 17h16"] },
  { value: 4, label: "Aromatic", lines: ["M4 9h16", "M4 15h3M10.5 15h3M17 15h3"] },
];

function choiceStyle(active: boolean): React.CSSProperties {
  return {
    minWidth: 30,
    height: 30,
    padding: "0 6px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: "none",
    borderRadius: 6,
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: 13,
    fontWeight: 600,
    background: active ? ACCENT : "transparent",
    color: active ? "#fff" : "var(--megane-text-body, #334155)",
  };
}

function Divider() {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 1,
        height: 22,
        margin: "0 6px",
        background: "var(--megane-border-solid, #e2e8f0)",
      }}
    />
  );
}

/** A labelled group of settings in the card. */
function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={sectionTitleStyle}>{label}</span>
      {children}
    </div>
  );
}

/** The drag gestures of Select and Move, as the Details panel lists them. */
export const DRAG_LEGEND: [string, string][] = [
  ["Drag", "move in the screen plane"],
  ["Shift", "move in depth"],
  ["Ctrl/⌘", "rotate about the centre"],
  ["Ctrl/⌘ Shift", "spin about the line of sight"],
  ["X Y Z  A B C", "while dragging: lock to an axis"],
  ["Drag elsewhere", "turn the view, as in the viewer"],
  ["Alt", "turn the view, even from an atom"],
];

const legendStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto 1fr",
  columnGap: 10,
  rowGap: 2,
  margin: 0,
  fontSize: 11,
  color: "var(--megane-text-secondary, #64748b)",
};

const wrapRow: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 2,
};

export function ContextBar() {
  const tool = useScopedBuilderStore((s) => s.tool);
  const element = useScopedBuilderStore((s) => s.element);
  const bondOrder = useScopedBuilderStore((s) => s.bondOrder);
  const adsorbHeight = useScopedBuilderStore((s) => s.adsorbHeight);
  const boxSelect = useScopedBuilderStore((s) => s.boxSelect);
  const setBoxSelect = useScopedBuilderStore((s) => s.setBoxSelect);
  const snap = useScopedBuilderStore((s) => s.snap);
  const setSnap = useScopedBuilderStore((s) => s.setSnap);
  const selectAll = useScopedBuilderStore((s) => s.selectAll);
  const invertSelection = useScopedBuilderStore((s) => s.invertSelection);
  const setSelected = useScopedBuilderStore((s) => s.setSelected);
  const setElement = useScopedBuilderStore((s) => s.setElement);
  const setBondOrder = useScopedBuilderStore((s) => s.setBondOrder);
  const setAdsorbHeight = useScopedBuilderStore((s) => s.setAdsorbHeight);
  const source = useScopedBuilderStore((s) => s.source);
  const result = useScopedBuilderStore((s) => s.result);
  const showOriginal = useScopedBuilderStore((s) => s.showOriginal);
  const hydrogenMode = useScopedBuilderStore((s) => s.hydrogenMode);
  const setHydrogenMode = useScopedBuilderStore((s) => s.setHydrogenMode);
  const api = useBuilderStoreApi();
  const recent = useRecentElements((s) => s.recent);
  const remember = useRecentElements((s) => s.remember);

  const placeSource = useScopedBuilderStore((s) => s.placeSource);
  const galleryOpen = useScopedLibraryUi((s) => s.galleryOpen);
  const setGalleryOpen = useScopedLibraryUi((s) => s.setGalleryOpen);
  const [tableOpen, setTableOpen] = useState(false);
  const tableButton = useRef<HTMLButtonElement>(null);
  const closeTable = useCallback(() => setTableOpen(false), []);

  // The periodic table belongs to the tool it was opened from.
  useEffect(() => setTableOpen(false), [tool]);

  // Place with nothing to place opens the gallery; choosing a molecule closes
  // it, and so does leaving the tool.
  useEffect(() => {
    if (tool !== "place") setGalleryOpen(false);
    else if (!placeSource) setGalleryOpen(true);
  }, [tool, setGalleryOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (placeSource) setGalleryOpen(false);
  }, [placeSource, setGalleryOpen]);

  const shown = shownSnapshot({ source, result, showOriginal });
  const groups = useMemo(() => (shown ? elementGroups(shown.elements) : []), [shown]);
  // Edits apply to the current document, whatever the view shows.
  const doc = result?.snapshot ?? source;
  const autoBalances = useMemo(() => !!doc && balancesHydrogens("auto", doc), [doc]);
  const recentShown = recent.filter((z) => !OFFERED.has(z));

  const info = toolInfo(tool);
  if (info.needs.length === 0) return null;

  return (
    <div
      data-testid="builder-context-bar"
      role="toolbar"
      aria-label={`${info.label} settings`}
      style={{ ...sectionStyle, gap: 12 }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span data-testid="builder-context-label" style={{ fontSize: 13, fontWeight: 600 }}>
          {info.label}
        </span>
        <span style={{ ...hintStyle, fontSize: 11 }}>({TOOL_KEYS[tool]})</span>
      </div>

      {info.needs.includes("select") && (
        <Group label="Selection">
          <div style={wrapRow}>
            <button
              type="button"
              data-testid="builder-select-box"
              aria-pressed={boxSelect}
              title="Drag a box on the view to select what it holds; Shift adds, Ctrl/⌘ removes (the view stops turning on a left drag while on)"
              style={{ ...choiceStyle(boxSelect), fontWeight: 500, padding: "0 10px" }}
              onClick={() => setBoxSelect(!boxSelect)}
            >
              Box
            </button>
            <Divider />
            <button
              type="button"
              data-testid="builder-select-all"
              title="Select every atom (Ctrl/⌘ + A)"
              style={{ ...choiceStyle(false), fontWeight: 500, padding: "0 10px" }}
              onClick={selectAll}
            >
              All
            </button>
            <button
              type="button"
              data-testid="builder-select-invert"
              title="Select the atoms that are not selected"
              style={{ ...choiceStyle(false), fontWeight: 500, padding: "0 10px" }}
              onClick={invertSelection}
            >
              Invert
            </button>
          </div>
          {groups.length > 0 && (
            <div style={{ ...wrapRow, gap: 4 }}>
              {groups.map(({ z, atoms }) => (
                <button
                  key={z}
                  type="button"
                  data-testid={`builder-inspector-element-${getElementSymbol(z)}`}
                  style={{ ...buttonStyle(), display: "inline-flex", gap: 6 }}
                  onClick={(e) =>
                    setSelected(
                      selectByElement(api.getState().selected, atoms, {
                        add: e.shiftKey,
                        toggle: e.ctrlKey || e.metaKey,
                      }),
                    )
                  }
                  title={`Select every ${getElementSymbol(z)} atom; Shift adds them to the selection, Ctrl/⌘ adds them or, when all are selected, removes them`}
                >
                  {getElementSymbol(z)}
                  <span style={{ ...monoStyle, color: "var(--megane-text-secondary, #64748b)" }}>
                    {atoms.length}
                  </span>
                </button>
              ))}
            </div>
          )}
        </Group>
      )}

      {info.needs.includes("drag") && (
        <Group label="Drag">
          <div style={wrapRow}>
            <button
              type="button"
              data-testid="builder-snap"
              aria-pressed={snap}
              title={`Round drags to ${SNAP_DISTANCE} Å and ${SNAP_ANGLE}°`}
              style={{ ...choiceStyle(snap), fontWeight: 500, padding: "0 10px" }}
              onClick={() => setSnap(!snap)}
            >
              Snap {SNAP_DISTANCE} Å / {SNAP_ANGLE}°
            </button>
          </div>
          <dl data-testid="builder-drag-legend" style={legendStyle}>
            {DRAG_LEGEND.map(([keys, what]) => (
              <div key={keys} style={{ display: "contents" }}>
                <dt style={{ ...monoStyle, whiteSpace: "nowrap" }}>{keys}</dt>
                <dd style={{ margin: 0 }}>{what}</dd>
              </div>
            ))}
          </dl>
        </Group>
      )}

      {info.needs.includes("element") && (
        <Group label="Element">
          <ElementButtons
            label="Common elements"
            elements={QUICK_ELEMENTS}
            element={element}
            onPick={setElement}
          />
          <ElementButtons
            label="Metals"
            elements={METAL_ELEMENTS}
            element={element}
            onPick={setElement}
          />
          {recentShown.length > 0 && (
            <ElementButtons
              label="Recent"
              elements={recentShown}
              element={element}
              onPick={setElement}
              testIdPrefix="builder-element-recent-"
              caption
            />
          )}
          <div style={{ ...wrapRow, gap: 6 }}>
            <ElementField element={element} onChange={setElement} onCommit={remember} />
            <button
              ref={tableButton}
              type="button"
              data-testid="builder-element-table"
              aria-expanded={tableOpen}
              aria-haspopup="dialog"
              title="Choose the element from the periodic table"
              style={{ ...choiceStyle(tableOpen), fontWeight: 500, padding: "0 10px" }}
              onClick={() => setTableOpen(!tableOpen)}
            >
              Periodic table {tableOpen ? "◂" : "…"}
            </button>
          </div>
          {tableOpen && (
            <PeriodicTable
              value={element}
              anchor={tableButton}
              onPick={(z) => {
                setElement(z);
                remember(z);
                setTableOpen(false);
              }}
              onClose={closeTable}
            />
          )}
        </Group>
      )}

      {info.needs.includes("bondOrder") && (
        <Group label="Bond order">
          <div
            data-testid="builder-bond-order"
            role="radiogroup"
            aria-label="Bond order"
            style={wrapRow}
            onKeyDown={radioGroupKeyDown}
          >
            {BOND_ORDERS.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                data-testid={`builder-bond-order-${o.value}`}
                aria-checked={bondOrder === o.value}
                tabIndex={bondOrder === o.value ? 0 : -1}
                aria-label={`${o.label} bond`}
                title={`${o.label} bond`}
                style={{ ...choiceStyle(bondOrder === o.value), width: 34 }}
                onClick={() => setBondOrder(o.value)}
              >
                <svg
                  viewBox="0 0 24 24"
                  width={20}
                  height={20}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  {o.lines.map((d) => (
                    <path key={d} d={d} />
                  ))}
                </svg>
              </button>
            ))}
          </div>
        </Group>
      )}

      {info.needs.includes("hydrogens") && (
        <Group label="Hydrogens">
          <div
            data-testid="builder-hydrogens"
            role="radiogroup"
            aria-label="Hydrogens"
            aria-describedby="builder-hydrogens-hint"
            style={wrapRow}
            onKeyDown={radioGroupKeyDown}
          >
            {HYDROGEN_MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                role="radio"
                data-testid={`builder-hydrogens-${m.value}`}
                aria-checked={hydrogenMode === m.value}
                tabIndex={hydrogenMode === m.value ? 0 : -1}
                title={m.title}
                style={{
                  ...choiceStyle(hydrogenMode === m.value),
                  fontWeight: 500,
                  padding: "0 10px",
                }}
                onClick={() => setHydrogenMode(m.value)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <span
            id="builder-hydrogens-hint"
            data-testid="builder-hydrogens-hint"
            style={{ ...hintStyle, fontSize: 11 }}
          >
            {hydrogenHint(hydrogenMode, autoBalances)}
          </span>
        </Group>
      )}

      {info.needs.includes("place") && (
        <Group label="Molecule">
          <button
            type="button"
            data-testid="builder-place-fragment"
            aria-expanded={galleryOpen}
            title="Choose the molecule to place"
            style={{
              minHeight: 30,
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 10px",
              borderRadius: 6,
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 13,
              fontWeight: 500,
              textAlign: "left",
              border: `1px solid ${placeSource ? ACCENT : "var(--megane-border-strong, #cbd5e1)"}`,
              background: placeSource ? "rgba(59, 130, 246, 0.08)" : "transparent",
              color: "var(--megane-text, #1e293b)",
            }}
            onClick={() => setGalleryOpen(!galleryOpen)}
          >
            {placeSource ? (
              <>
                {placeSource.name}
                <span style={{ ...hintStyle, fontSize: 11 }}>{placeSource.formula}</span>
              </>
            ) : (
              "Choose a molecule…"
            )}
            <span style={{ flex: 1 }} />
            <span aria-hidden="true">{galleryOpen ? "▴" : "▾"}</span>
          </button>
          {galleryOpen && <LibraryPanel onClose={() => setGalleryOpen(false)} />}
          <AdsorbOption height={adsorbHeight} onChange={setAdsorbHeight} />
        </Group>
      )}
    </div>
  );
}

/** A row of one-click element buttons, the current element pressed. */
function ElementButtons({
  label,
  elements,
  element,
  onPick,
  testIdPrefix = "builder-element-",
  caption = false,
}: {
  label: string;
  elements: readonly number[];
  element: number;
  onPick: (z: number) => void;
  testIdPrefix?: string;
  /** Show `label` in front of the buttons (it is always their group's name). */
  caption?: boolean;
}) {
  return (
    <div role="group" aria-label={label} style={wrapRow}>
      {caption && <span style={{ ...hintStyle, fontSize: 11, marginRight: 4 }}>{label}</span>}
      {elements.map((z) => (
        <button
          key={z}
          type="button"
          data-testid={`${testIdPrefix}${getElementSymbol(z)}`}
          aria-pressed={element === z}
          title={`${getElementSymbol(z)} (Z = ${z})`}
          style={choiceStyle(element === z)}
          onClick={() => onPick(z)}
        >
          {getElementSymbol(z)}
        </button>
      ))}
    </div>
  );
}

/**
 * Any element by symbol ("Fe", any case) or atomic number. What is typed is
 * kept as a draft: a valid one takes effect at once, an invalid one is
 * marked and changes nothing; Enter or leaving the field settles it (an
 * invalid draft is dropped), and Escape puts back the element held before
 * typing.
 */
function ElementField({
  element,
  onChange,
  onCommit,
}: {
  element: number;
  onChange: (z: number) => void;
  /** A typed element the user settled on (Enter or leaving the field). */
  onCommit: (z: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const before = useRef(element);
  const typed = draft !== null ? parseElement(draft) : element;
  const invalid = typed === null;

  const settle = () => {
    if (draft === null) return;
    if (typed !== null) onCommit(typed);
    setDraft(null);
  };

  return (
    <label
      style={{ ...hintStyle, display: "flex", alignItems: "center", gap: 4 }}
      title="Any element by symbol (Fe) or atomic number (26); Esc puts back the previous one"
    >
      Element
      <input
        data-testid="builder-element-z"
        type="text"
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        aria-label="Element symbol or atomic number"
        aria-invalid={invalid}
        value={draft ?? String(element)}
        onFocus={() => (before.current = element)}
        onChange={(e) => {
          if (draft === null) before.current = element;
          setDraft(e.target.value);
          const z = parseElement(e.target.value);
          if (z !== null) onChange(z);
        }}
        onBlur={settle}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (!invalid) settle();
          } else if (e.key === "Escape" && draft !== null) {
            e.preventDefault();
            e.stopPropagation();
            if (element !== before.current) onChange(before.current);
            setDraft(null);
          }
        }}
        style={{ ...fieldStyle(invalid), width: 56 }}
      />
      <span data-testid="builder-element-symbol">{getElementSymbol(element)}</span>
    </label>
  );
}

/** A height the adsorption field accepts: a finite number of Å above zero. */
export function parseAdsorbHeight(text: string): number | null {
  if (text.trim() === "") return null;
  const v = Number(text);
  return Number.isFinite(v) && v > 0 ? v : null;
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
  // on uses it again rather than the default. Only a height above zero is
  // ever used; anything else is marked and leaves the last good one in force.
  const [draft, setDraft] = useState(String(height ?? DEFAULT_ADSORB_HEIGHT));
  const lastGood = useRef(height ?? DEFAULT_ADSORB_HEIGHT);
  const invalid = parseAdsorbHeight(draft) === null;
  return (
    <label
      style={{ ...hintStyle, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}
    >
      <input
        type="checkbox"
        data-testid="builder-adsorb-toggle"
        checked={height !== null}
        onChange={(e) => onChange(e.target.checked ? lastGood.current : null)}
      />
      On atoms:
      <input
        type="number"
        data-testid="builder-adsorb-height"
        aria-label="Height above the atom, Å"
        aria-invalid={invalid}
        min={0.1}
        step={0.1}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          const v = parseAdsorbHeight(e.target.value);
          if (v === null) return;
          lastGood.current = v;
          if (height !== null) onChange(v);
        }}
        onBlur={() => {
          if (invalid) setDraft(String(lastGood.current));
        }}
        style={{ ...fieldStyle(invalid), width: 56 }}
        title="Height above the clicked atom (an adsorbate on a surface site); must be above 0"
      />
      <span>Å above the atom along c (or +z without a cell)</span>
    </label>
  );
}
