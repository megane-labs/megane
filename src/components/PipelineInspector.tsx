/**
 * Selection Inspector — a lightweight third editing surface (alongside the
 * visual pipeline Editor and the AI Chat) for "select a subset, change how it
 * looks", inspired by OVITO's Expression Select.
 *
 * The user builds selections from structure-aware chips (the actual elements /
 * residues / chains present) or a raw expression, tunes appearance (color,
 * representation, size, opacity, visibility), and the panel compiles each
 * "layer" straight into ordinary pipeline nodes via `setInspectorLayers`. Those
 * nodes appear verbatim in the Editor tab — editing here *is* editing the
 * pipeline (see `pipeline/inspectorSync.ts`).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  useScopedPipelineStore,
  useScopedPipelineUIStore,
  useScopedInspectorStore,
  usePipelineStoreApi,
} from "../stores/MeganeProvider";
import { getStructureFacts } from "../ai/structureSummary";
import { evaluateSelection, validateQuery } from "../pipeline/selection";
import {
  buildQueryFromChips,
  quickSelectExpression,
  indicesToExpression,
  type QuickSelectKind,
} from "../pipeline/inspectorQuery";
import {
  defaultInspectorAppearance,
  layersFromGraph,
  type InspectorLayer,
  type InspectorAppearance,
} from "../pipeline/inspectorSync";
import type { ColorMode, RepresentationMode } from "../pipeline/types";

const COLOR_MODE_LABELS: Record<ColorMode, string> = {
  uniform: "Uniform",
  byElement: "Element",
  byResidue: "Residue",
  byChain: "Chain",
  byBFactor: "B-Factor",
  byProperty: "Property",
  illustrative: "Illustrative",
};

const REP_LABELS: Record<RepresentationMode, string> = {
  atoms: "Ball",
  licorice: "Licorice",
  cartoon: "Cartoon",
  both: "Ball + Stick",
  surface: "Surface",
  line: "Line",
  illustrative: "Illustrative",
};

const panelStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: 12,
  display: "flex",
  flexDirection: "column",
  gap: 12,
  fontSize: 13,
  color: "var(--megane-text, #1e293b)",
};

const sectionStyle: React.CSSProperties = {
  border: "1px solid var(--megane-border-solid, #e2e8f0)",
  borderRadius: 8,
  padding: 10,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  background: "var(--megane-surface-solid, #fff)",
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "#64748b",
};

const chipRowStyle: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 6 };

const selectStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#334155",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  padding: "3px 6px",
};

function chipStyle(active: boolean): React.CSSProperties {
  return {
    fontSize: 12,
    padding: "3px 9px",
    borderRadius: 999,
    cursor: "pointer",
    border: active ? "1px solid #2563eb" : "1px solid #cbd5e1",
    background: active ? "#2563eb" : "#f1f5f9",
    color: active ? "#fff" : "#334155",
    userSelect: "none",
  };
}

function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function newLayer(existing: InspectorLayer[]): InspectorLayer {
  let max = 0;
  for (const l of existing) {
    const m = l.id.match(/(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  const n = max + 1;
  return {
    id: `layer-${n}`,
    name: `Layer ${n}`,
    query: "",
    appearance: defaultInspectorAppearance(),
  };
}

export function PipelineInspector() {
  // The rendered snapshot lives on the primary particle stream (as in
  // MeganeViewer); fall back to the legacy top-level `snapshot` for hosts that
  // set it directly (Jupyter widget / tests).
  const pipelineApi = usePipelineStoreApi();
  const snapshot = useScopedPipelineStore(
    (s) => s.viewportState.particles[0]?.source ?? s.snapshot,
  );
  const atomLabels = useScopedPipelineStore((s) => s.atomLabels);
  const setInspectorLayers = useScopedPipelineStore((s) => s.setInspectorLayers);
  const setMode = useScopedPipelineUIStore((s) => s.setMode);
  const isActiveMode = useScopedPipelineUIStore((s) => s.mode === "inspector");

  const setPreviewIndices = useScopedInspectorStore((s) => s.setPreviewIndices);
  const boxSelectActive = useScopedInspectorStore((s) => s.boxSelectActive);
  const setBoxSelectActive = useScopedInspectorStore((s) => s.setBoxSelectActive);
  const boxResult = useScopedInspectorStore((s) => s.boxResult);
  const pickedAtom = useScopedInspectorStore((s) => s.pickedAtom);

  const facts = useMemo(() => getStructureFacts(snapshot, atomLabels), [snapshot, atomLabels]);

  const [layers, setLayersState] = useState<InspectorLayer[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Per-active-layer chip composer state. Reset whenever the active layer
  // changes (we don't parse arbitrary raw expressions back into chips).
  const [chipEls, setChipEls] = useState<Set<string>>(new Set());
  const [chipRes, setChipRes] = useState<Set<string>>(new Set());
  const [chipChains, setChipChains] = useState<Set<string>>(new Set());
  const [withinR, setWithinR] = useState<string>("");
  const [customQuery, setCustomQuery] = useState(false);

  // Hydrate from any Inspector nodes already in the graph, once on mount.
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    const existing = layersFromGraph(pipelineApi.getState().nodes);
    if (existing.length > 0) {
      setLayersState(existing);
      setActiveId(existing[0].id);
    }
  }, [pipelineApi]);

  useEffect(() => {
    // Reset the chip composer when switching layers.
    setChipEls(new Set());
    setChipRes(new Set());
    setChipChains(new Set());
    setWithinR("");
    setCustomQuery(false);
  }, [activeId]);

  const active = layers.find((l) => l.id === activeId) ?? null;

  function commit(next: InspectorLayer[]) {
    setLayersState(next);
    setInspectorLayers(next);
  }

  function updateActive(mutate: (l: InspectorLayer) => InspectorLayer) {
    if (!active) return;
    commit(layers.map((l) => (l.id === active.id ? mutate(l) : l)));
  }

  function updateAppearance(patch: Partial<InspectorAppearance>) {
    updateActive((l) => ({ ...l, appearance: { ...l.appearance, ...patch } }));
  }

  function regenerateFromChips(
    els: Set<string>,
    res: Set<string>,
    chains: Set<string>,
    radius: string,
  ) {
    const r = radius.trim() === "" ? null : Number(radius);
    const query = buildQueryFromChips({
      elements: [...els],
      resnames: [...res],
      chains: [...chains],
      withinRadius: r,
    });
    updateActive((l) => ({ ...l, query }));
  }

  function handleAddLayer() {
    const layer = newLayer(layers);
    const next = [...layers, layer];
    commit(next);
    setActiveId(layer.id);
  }

  function handleDeleteLayer(id: string) {
    const next = layers.filter((l) => l.id !== id);
    commit(next);
    if (activeId === id) setActiveId(next.length > 0 ? next[next.length - 1].id : null);
  }

  const queryValidation = active ? validateQuery(active.query) : { valid: true };
  const activeQuery = active?.query ?? "";
  const selectedCount = useMemo(() => {
    if (!snapshot || !active || !queryValidation.valid) return null;
    try {
      const sel = evaluateSelection(active.query, snapshot, atomLabels);
      return sel === null ? snapshot.nAtoms : sel.size;
    } catch {
      return null;
    }
  }, [snapshot, atomLabels, active, queryValidation.valid]);

  function setActiveQuery(query: string) {
    setCustomQuery(true);
    updateActive((l) => ({ ...l, query }));
  }

  // Publish the active selection to the 3D view as a live green highlight —
  // only while the Inspector tab is showing.
  useEffect(() => {
    if (!isActiveMode || !snapshot || !active || !queryValidation.valid) {
      setPreviewIndices(null);
      return;
    }
    try {
      const sel = evaluateSelection(activeQuery, snapshot, atomLabels);
      // A null selection means "all atoms" — don't flood the view with green.
      setPreviewIndices(sel === null ? null : [...sel]);
    } catch {
      setPreviewIndices(null);
    }
    return () => setPreviewIndices(null);
  }, [isActiveMode, snapshot, atomLabels, activeQuery, active?.id, queryValidation.valid]);

  // Consume a completed 3D box selection into the active layer's expression.
  const lastBoxToken = useRef(0);
  useEffect(() => {
    if (!boxResult || boxResult.token === lastBoxToken.current) return;
    lastBoxToken.current = boxResult.token;
    if (!isActiveMode || !active) return;
    setActiveQuery(indicesToExpression(boxResult.indices));
    setBoxSelectActive(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxResult]);

  function applyQuickSelect(kind: QuickSelectKind) {
    if (!pickedAtom) return;
    const expr = quickSelectExpression(kind, pickedAtom);
    if (expr) setActiveQuery(expr);
  }

  if (!facts) {
    return (
      <div style={panelStyle} data-testid="pipeline-inspector">
        <div style={{ color: "#64748b", fontSize: 13 }}>
          Load a structure to start selecting atoms.
        </div>
      </div>
    );
  }

  return (
    <div style={panelStyle} data-testid="pipeline-inspector">
      {/* Layer list */}
      <div style={sectionStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={sectionTitleStyle}>Layers</span>
          <button
            data-testid="inspector-add-layer"
            onClick={handleAddLayer}
            style={{ ...selectStyle, cursor: "pointer" }}
          >
            + Add selection
          </button>
        </div>
        {layers.length === 0 ? (
          <div style={{ color: "#94a3b8", fontSize: 12 }}>
            No selections yet — add one to color or restyle a subset of atoms.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {layers.map((l) => (
              <div
                key={l.id}
                data-testid={`inspector-layer-${l.id}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 6px",
                  borderRadius: 6,
                  cursor: "pointer",
                  background: l.id === activeId ? "#e0e7ff" : "transparent",
                }}
                onClick={() => setActiveId(l.id)}
              >
                <span
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 3,
                    background: l.appearance.colorEnabled ? l.appearance.uniformColor : "#cbd5e1",
                    flexShrink: 0,
                  }}
                />
                <span style={{ flex: 1, fontSize: 12 }}>{l.name}</span>
                <code
                  style={{
                    fontSize: 10,
                    color: "#64748b",
                    maxWidth: 120,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {l.query || "all"}
                </code>
                <button
                  data-testid={`inspector-delete-${l.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteLayer(l.id);
                  }}
                  style={{
                    border: "none",
                    background: "none",
                    cursor: "pointer",
                    color: "#94a3b8",
                  }}
                  aria-label={`Delete ${l.name}`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {active && (
        <>
          {/* Selection builder */}
          <div style={sectionStyle} data-testid="inspector-selection">
            <span style={sectionTitleStyle}>Selection</span>

            {/* Pick from the 3D view */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              <span
                data-testid="inspector-box-toggle"
                style={chipStyle(!!boxSelectActive)}
                onClick={() => setBoxSelectActive(!boxSelectActive)}
              >
                {boxSelectActive ? "Box select: ON — drag in 3D" : "▣ Box select in 3D"}
              </span>
              {pickedAtom && (
                <>
                  <span style={{ fontSize: 11, color: "#64748b" }}>Atom #{pickedAtom.index}:</span>
                  <span
                    data-testid="inspector-quick-element"
                    style={chipStyle(false)}
                    onClick={() => applyQuickSelect("element")}
                  >
                    same element
                  </span>
                  {pickedAtom.resname && (
                    <span style={chipStyle(false)} onClick={() => applyQuickSelect("resname")}>
                      same residue
                    </span>
                  )}
                  {pickedAtom.chain && (
                    <span style={chipStyle(false)} onClick={() => applyQuickSelect("chain")}>
                      same chain
                    </span>
                  )}
                  {pickedAtom.moleculeId != null && (
                    <span style={chipStyle(false)} onClick={() => applyQuickSelect("molecule")}>
                      same molecule
                    </span>
                  )}
                  <span style={chipStyle(false)} onClick={() => applyQuickSelect("index")}>
                    just this
                  </span>
                </>
              )}
            </div>

            <div style={{ fontSize: 11, color: "#64748b" }}>Elements</div>
            <div style={chipRowStyle}>
              {facts.elements.map((e) => (
                <span
                  key={e.symbol}
                  data-testid={`inspector-chip-element-${e.symbol}`}
                  style={chipStyle(chipEls.has(e.symbol))}
                  onClick={() => {
                    const next = toggle(chipEls, e.symbol);
                    setChipEls(next);
                    setCustomQuery(false);
                    regenerateFromChips(next, chipRes, chipChains, withinR);
                  }}
                >
                  {e.symbol} ({e.count})
                </span>
              ))}
            </div>

            {facts.resnames.length > 0 && (
              <>
                <div style={{ fontSize: 11, color: "#64748b" }}>Residues</div>
                <div style={chipRowStyle}>
                  {facts.resnames.map((r) => (
                    <span
                      key={r}
                      data-testid={`inspector-chip-resname-${r}`}
                      style={chipStyle(chipRes.has(r))}
                      onClick={() => {
                        const next = toggle(chipRes, r);
                        setChipRes(next);
                        setCustomQuery(false);
                        regenerateFromChips(chipEls, next, chipChains, withinR);
                      }}
                    >
                      {r}
                    </span>
                  ))}
                </div>
              </>
            )}

            {facts.chains.length > 0 && (
              <>
                <div style={{ fontSize: 11, color: "#64748b" }}>Chains</div>
                <div style={chipRowStyle}>
                  {facts.chains.map((c) => (
                    <span
                      key={c}
                      data-testid={`inspector-chip-chain-${c}`}
                      style={chipStyle(chipChains.has(c))}
                      onClick={() => {
                        const next = toggle(chipChains, c);
                        setChipChains(next);
                        setCustomQuery(false);
                        regenerateFromChips(chipEls, chipRes, next, withinR);
                      }}
                    >
                      {c}
                    </span>
                  ))}
                </div>
              </>
            )}

            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <label style={{ fontSize: 11, color: "#64748b" }}>Within (Å)</label>
              <input
                data-testid="inspector-within"
                type="number"
                min={0}
                step={0.5}
                value={withinR}
                placeholder="—"
                style={{ ...selectStyle, width: 70 }}
                onChange={(e) => {
                  setWithinR(e.target.value);
                  if (!customQuery)
                    regenerateFromChips(chipEls, chipRes, chipChains, e.target.value);
                }}
              />
              <span style={{ fontSize: 11, color: "#94a3b8" }}>of the above</span>
            </div>

            {/* Raw expression (source of truth) */}
            <div style={{ fontSize: 11, color: "#64748b" }}>Expression</div>
            <textarea
              data-testid="inspector-query"
              className="nodrag"
              value={active.query}
              placeholder='e.g. element == "C" and within 5 of (resname == "HEM")'
              rows={2}
              spellCheck={false}
              style={{
                ...selectStyle,
                fontFamily: "monospace",
                fontSize: 12,
                resize: "vertical",
                borderColor: queryValidation.valid ? "#cbd5e1" : "#ef4444",
              }}
              onChange={(e) => {
                setCustomQuery(true);
                updateActive((l) => ({ ...l, query: e.target.value }));
              }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
              <span
                data-testid="inspector-selected-count"
                style={{ color: queryValidation.valid ? "#059669" : "#ef4444" }}
              >
                {queryValidation.valid
                  ? selectedCount != null
                    ? `${selectedCount} atom${selectedCount === 1 ? "" : "s"} selected`
                    : ""
                  : queryValidation.error}
              </span>
            </div>
          </div>

          {/* Appearance */}
          <div style={sectionStyle} data-testid="inspector-appearance">
            <span style={sectionTitleStyle}>Appearance</span>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                data-testid="inspector-color-enabled"
                type="checkbox"
                checked={active.appearance.colorEnabled}
                onChange={(e) => updateAppearance({ colorEnabled: e.target.checked })}
              />
              <span style={{ fontSize: 12, width: 70 }}>Color</span>
              <select
                data-testid="inspector-color-mode"
                value={active.appearance.colorMode}
                disabled={!active.appearance.colorEnabled}
                style={{ ...selectStyle, flex: 1 }}
                onChange={(e) => updateAppearance({ colorMode: e.target.value as ColorMode })}
              >
                {(Object.entries(COLOR_MODE_LABELS) as [ColorMode, string][]).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
              {active.appearance.colorMode === "uniform" && (
                <input
                  data-testid="inspector-color-value"
                  type="color"
                  disabled={!active.appearance.colorEnabled}
                  value={active.appearance.uniformColor}
                  onChange={(e) => updateAppearance({ uniformColor: e.target.value })}
                  style={{
                    width: 36,
                    height: 24,
                    border: "1px solid #cbd5e1",
                    borderRadius: 4,
                    padding: 0,
                  }}
                />
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                data-testid="inspector-rep-enabled"
                type="checkbox"
                checked={active.appearance.representationEnabled}
                onChange={(e) => updateAppearance({ representationEnabled: e.target.checked })}
              />
              <span style={{ fontSize: 12, width: 70 }}>Style</span>
              <select
                data-testid="inspector-rep-mode"
                value={active.appearance.representation}
                disabled={!active.appearance.representationEnabled}
                style={{ ...selectStyle, flex: 1 }}
                onChange={(e) =>
                  updateAppearance({ representation: e.target.value as RepresentationMode })
                }
              >
                {(Object.entries(REP_LABELS) as [RepresentationMode, string][]).map(
                  ([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ),
                )}
              </select>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, width: 80 }}>
                Size {active.appearance.scale.toFixed(2)}
              </span>
              <input
                data-testid="inspector-scale"
                type="range"
                min={0.1}
                max={2}
                step={0.05}
                value={active.appearance.scale}
                style={{ flex: 1 }}
                onChange={(e) => updateAppearance({ scale: Number(e.target.value) })}
              />
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, width: 80 }}>
                Opacity {active.appearance.opacity.toFixed(2)}
              </span>
              <input
                data-testid="inspector-opacity"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={active.appearance.opacity}
                disabled={!active.appearance.visible}
                style={{ flex: 1 }}
                onChange={(e) => updateAppearance({ opacity: Number(e.target.value) })}
              />
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                data-testid="inspector-visible"
                type="checkbox"
                checked={active.appearance.visible}
                onChange={(e) => updateAppearance({ visible: e.target.checked })}
              />
              <span style={{ fontSize: 12 }}>Visible</span>
            </div>
          </div>

          <button
            data-testid="inspector-open-editor"
            onClick={() => setMode("editor")}
            style={{ ...selectStyle, cursor: "pointer", alignSelf: "flex-start" }}
          >
            Open generated nodes in Editor →
          </button>
        </>
      )}
    </div>
  );
}
