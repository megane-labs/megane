/**
 * The current tool's settings, at the top of the Details panel: pressing a
 * tool on the rail left of the view shows its options here, and only those —
 * the element for *Add atom* and *Element* (the periodic table opens beside
 * the panel for the rarer ones), the bond order for *Add atom* and *Bond*, Box / All /
 * Invert and select-by-element for *Select*, the molecule gallery and *Place
 * on atoms* for *Place*. A tool with no settings (Move, Delete) shows none.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBuilderStore, shownSnapshot } from "./store";
import { toolInfo } from "./ToolRail";
import { DEFAULT_ADSORB_HEIGHT, useLibraryUi } from "./library/ui";
import { LibraryPanel } from "./library/LibraryPanel";
import { PeriodicTable } from "./PeriodicTable";
import { getElementSymbol } from "../constants";
import {
  ACCENT,
  buttonStyle,
  hintStyle,
  inputStyle,
  sectionStyle,
  sectionTitleStyle,
} from "./styles";
import { TOOL_KEYS } from "./shortcuts";
import { elementGroups } from "./elements";

const monoStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

/** Elements offered as one-click buttons; anything else via the Z field. */
export const QUICK_ELEMENTS = [6, 1, 7, 8, 9, 15, 16, 17, 35, 14];

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

const wrapRow: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 2,
};

export function ContextBar() {
  const tool = useBuilderStore((s) => s.tool);
  const element = useBuilderStore((s) => s.element);
  const bondOrder = useBuilderStore((s) => s.bondOrder);
  const adsorbHeight = useBuilderStore((s) => s.adsorbHeight);
  const boxSelect = useBuilderStore((s) => s.boxSelect);
  const setBoxSelect = useBuilderStore((s) => s.setBoxSelect);
  const selectAll = useBuilderStore((s) => s.selectAll);
  const invertSelection = useBuilderStore((s) => s.invertSelection);
  const setSelected = useBuilderStore((s) => s.setSelected);
  const setElement = useBuilderStore((s) => s.setElement);
  const setBondOrder = useBuilderStore((s) => s.setBondOrder);
  const setAdsorbHeight = useBuilderStore((s) => s.setAdsorbHeight);
  const source = useBuilderStore((s) => s.source);
  const result = useBuilderStore((s) => s.result);
  const showOriginal = useBuilderStore((s) => s.showOriginal);

  const placeSource = useBuilderStore((s) => s.placeSource);
  const galleryOpen = useLibraryUi((s) => s.galleryOpen);
  const setGalleryOpen = useLibraryUi((s) => s.setGalleryOpen);
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
              title="Drag a box on the view to select what it holds; Shift adds to the selection (the view stops rotating while on)"
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
                  onClick={() => setSelected(atoms)}
                  title={`Select every ${getElementSymbol(z)} atom`}
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

      {info.needs.includes("element") && (
        <Group label="Element">
          <div style={wrapRow}>
            {QUICK_ELEMENTS.map((z) => (
              <button
                key={z}
                type="button"
                data-testid={`builder-element-${getElementSymbol(z)}`}
                aria-pressed={element === z}
                style={choiceStyle(element === z)}
                onClick={() => setElement(z)}
              >
                {getElementSymbol(z)}
              </button>
            ))}
          </div>
          <div style={{ ...wrapRow, gap: 6 }}>
            <label
              style={{ ...hintStyle, display: "flex", alignItems: "center", gap: 4 }}
              title="Any element by atomic number"
            >
              Z
              <input
                data-testid="builder-element-z"
                type="number"
                min={1}
                max={118}
                value={element}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (Number.isFinite(v) && v >= 1 && v <= 118) setElement(v);
                }}
                style={{ ...inputStyle, width: 56 }}
              />
              <span data-testid="builder-element-symbol">{getElementSymbol(element)}</span>
            </label>
            <button
              ref={tableButton}
              type="button"
              data-testid="builder-element-table"
              aria-expanded={tableOpen}
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
          >
            {BOND_ORDERS.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                data-testid={`builder-bond-order-${o.value}`}
                aria-checked={bondOrder === o.value}
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
    <label style={{ ...hintStyle, display: "flex", alignItems: "center", gap: 6 }}>
      <input
        type="checkbox"
        data-testid="builder-adsorb-toggle"
        checked={height !== null}
        onChange={(e) => onChange(e.target.checked ? draft : null)}
      />
      On atoms:
      <input
        type="number"
        data-testid="builder-adsorb-height"
        step={0.1}
        value={draft}
        onChange={(e) => {
          const v = Number(e.target.value);
          setDraft(v);
          if (height !== null) onChange(v);
        }}
        style={{ ...inputStyle, width: 56 }}
        title="Height above the clicked atom along the cell's c axis (an adsorbate on a surface site)"
      />
      Å above along c
    </label>
  );
}
