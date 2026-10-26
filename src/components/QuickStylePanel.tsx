/**
 * Quick Style — a few global "how does it look" controls (style, color, atom
 * size / opacity, bond width / opacity, polyhedra, labels, perspective, cell
 * axes), the successor of the old Appearance panel. Every control writes
 * pipeline nodes through `setQuickStyle` (see `pipeline/quickStyle.ts`) and
 * every value is read back from the graph, so the panel and the Editor never
 * disagree.
 *
 * Mounted at the top of the Inspector tab, and on its own in the Jupyter
 * widget when `MolecularViewer(quick_style=True)`. The store is passed in
 * rather than taken from `MeganeProvider` because the widget keeps a private
 * pipeline store of its own.
 */

import { useMemo, type CSSProperties } from "react";
import { useStore, type StoreApi } from "zustand";
import type { PipelineStore } from "../pipeline/store";
import {
  QUICK_STYLE_IDS,
  quickStyleDefaults,
  readQuickStyle,
  type QuickStyle,
  type QuickStyleLabels,
} from "../pipeline/quickStyle";
import type { ColorMode, RepresentationMode } from "../pipeline/types";

export const COLOR_MODE_LABELS: Record<ColorMode, string> = {
  uniform: "Uniform",
  byElement: "Element",
  byResidue: "Residue",
  byChain: "Chain",
  byBFactor: "B-Factor",
  byProperty: "Property",
  illustrative: "Illustrative",
};

export const REP_LABELS: Record<RepresentationMode, string> = {
  atoms: "Ball",
  licorice: "Licorice",
  cartoon: "Cartoon",
  both: "Cartoon + Atoms",
  surface: "Surface",
  line: "Line",
  illustrative: "Illustrative",
};

const LABEL_OPTIONS: { value: QuickStyleLabels; label: string }[] = [
  { value: "none", label: "None" },
  { value: "element", label: "Element" },
  { value: "resname", label: "Residue" },
  { value: "index", label: "Index" },
];

const sectionStyle: CSSProperties = {
  border: "1px solid var(--megane-border-solid)",
  borderRadius: 8,
  padding: 10,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  background: "var(--megane-surface-solid)",
};

const titleStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "var(--megane-text-secondary)",
};

const rowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const labelStyle: CSSProperties = { fontSize: 12, width: 92, flexShrink: 0 };
const valueStyle: CSSProperties = {
  fontSize: 11,
  minWidth: 36,
  textAlign: "right",
  color: "var(--megane-text-secondary)",
};

const controlStyle: CSSProperties = {
  fontSize: 13,
  color: "var(--megane-text-body)",
  background: "var(--megane-surface-muted)",
  border: "1px solid var(--megane-border-strong)",
  borderRadius: 4,
  padding: "3px 6px",
};

function chipStyle(active: boolean, disabled = false): CSSProperties {
  return {
    fontSize: 12,
    padding: "3px 9px",
    borderRadius: 999,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.45 : 1,
    border: active ? "1px solid #2563eb" : "1px solid var(--megane-border-strong)",
    background: active ? "#2563eb" : "var(--megane-surface-muted)",
    color: active ? "#fff" : "var(--megane-text-body)",
  };
}

interface SliderRowProps {
  testId: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}

function SliderRow({ testId, label, value, min, max, step, format, onChange }: SliderRowProps) {
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{label}</span>
      <input
        data-testid={testId}
        className="nodrag"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ flex: 1, minWidth: 0 }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span style={valueStyle}>{format(value)}</span>
    </div>
  );
}

const fixed2 = (v: number) => v.toFixed(2);
const percent = (v: number) => `${Math.round(v * 100)}%`;

export interface QuickStylePanelProps {
  store: StoreApi<PipelineStore>;
  /** Draw the bordered "Quick style" section (Inspector). Off inside another panel. */
  framed?: boolean;
  /** Called after every change the panel writes to the graph. */
  onApplied?: () => void;
  /** Shown instead of the controls, e.g. when the host has no pipeline to edit. */
  disabledReason?: string | null;
}

export function QuickStylePanel({
  store,
  framed = true,
  onApplied,
  disabledReason = null,
}: QuickStylePanelProps) {
  const nodes = useStore(store, (s) => s.nodes);
  const edges = useStore(store, (s) => s.edges);
  const hasCell = useStore(store, (s) => s.viewportState.cells.length > 0);
  const hasResidueLabels = useStore(
    store,
    (s) => (s.viewportState.particles[0]?.source.atomLabels?.length ?? 0) > 0,
  );
  const setQuickStyle = useStore(store, (s) => s.setQuickStyle);
  // Why Quick Style's own polyhedra draw nothing (e.g. no metal centers).
  const polyhedraNotice = useStore(store, (s) => {
    for (const id of [QUICK_STYLE_IDS.coordination, QUICK_STYLE_IDS.polyhedra]) {
      const message = s.nodeErrors[id]?.[0]?.message;
      if (message) return message;
    }
    return null;
  });
  const { style, available } = useMemo(() => readQuickStyle(nodes, edges), [nodes, edges]);
  // The pipeline's own polyhedra are switched in place; otherwise Quick Style adds its own.
  const polyhedraOn = style.pipelinePolyhedra ?? style.polyhedra;

  function apply(patch: Partial<QuickStyle>) {
    setQuickStyle(patch);
    onApplied?.();
  }

  const body = disabledReason ? (
    <div
      data-testid="quick-style-disabled"
      style={{ fontSize: 12, color: "var(--megane-text-muted)" }}
    >
      {disabledReason}
    </div>
  ) : !available.viewport ? (
    <div style={{ fontSize: 12, color: "var(--megane-text-muted)" }}>
      Add a Viewport node to the pipeline to style the view.
    </div>
  ) : (
    <>
      <div style={rowStyle}>
        <span style={labelStyle}>Style</span>
        <select
          data-testid="quick-style-rep"
          value={style.representation ?? ""}
          style={{ ...controlStyle, flex: 1, minWidth: 0 }}
          onChange={(e) =>
            apply({ representation: (e.target.value || null) as RepresentationMode | null })
          }
        >
          <option value="">Pipeline default</option>
          {(Object.entries(REP_LABELS) as [RepresentationMode, string][]).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>Color</span>
        <select
          data-testid="quick-style-color"
          value={style.colorMode ?? ""}
          style={{ ...controlStyle, flex: 1, minWidth: 0 }}
          onChange={(e) => apply({ colorMode: (e.target.value || null) as ColorMode | null })}
        >
          <option value="">Pipeline default</option>
          {(Object.entries(COLOR_MODE_LABELS) as [ColorMode, string][]).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        {style.colorMode === "uniform" && (
          <input
            data-testid="quick-style-color-value"
            type="color"
            value={style.uniformColor}
            onChange={(e) => apply({ uniformColor: e.target.value })}
            style={{
              width: 36,
              height: 24,
              border: "1px solid var(--megane-border-strong)",
              borderRadius: 4,
              padding: 0,
            }}
          />
        )}
      </div>

      <SliderRow
        testId="quick-style-atom-scale"
        label="Atom size"
        value={style.atomScale}
        min={0.1}
        max={2}
        step={0.05}
        format={fixed2}
        onChange={(v) => apply({ atomScale: v })}
      />
      <SliderRow
        testId="quick-style-atom-opacity"
        label="Atom opacity"
        value={style.atomOpacity}
        min={0}
        max={1}
        step={0.05}
        format={percent}
        onChange={(v) => apply({ atomOpacity: v })}
      />

      {available.bonds && (
        <>
          <SliderRow
            testId="quick-style-bond-scale"
            label="Bond width"
            value={style.bondScale}
            min={0.1}
            max={3}
            step={0.05}
            format={fixed2}
            onChange={(v) => apply({ bondScale: v })}
          />
          <SliderRow
            testId="quick-style-bond-opacity"
            label="Bond opacity"
            value={style.bondOpacity}
            min={0}
            max={1}
            step={0.05}
            format={percent}
            onChange={(v) => apply({ bondOpacity: v })}
          />
        </>
      )}
      {style.bondTolerance !== null && (
        <SliderRow
          testId="quick-style-bond-tolerance"
          label="Bond tolerance"
          value={style.bondTolerance}
          min={0.3}
          max={1.2}
          step={0.01}
          format={fixed2}
          onChange={(v) => apply({ bondTolerance: v })}
        />
      )}
      {style.vectorScale !== null && (
        <SliderRow
          testId="quick-style-vector-scale"
          label="Arrow scale"
          value={style.vectorScale}
          min={0.1}
          max={10}
          step={0.1}
          format={(v) => v.toFixed(1)}
          onChange={(v) => apply({ vectorScale: v })}
        />
      )}

      <div style={rowStyle}>
        <span style={labelStyle}>Polyhedra</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          <button
            type="button"
            data-testid="quick-style-polyhedra"
            aria-pressed={polyhedraOn}
            style={chipStyle(polyhedraOn)}
            onClick={() =>
              apply(
                style.pipelinePolyhedra === null
                  ? { polyhedra: !style.polyhedra }
                  : { pipelinePolyhedra: !style.pipelinePolyhedra },
              )
            }
          >
            Show
          </button>
          {polyhedraOn && (
            <button
              type="button"
              data-testid="quick-style-polyhedra-edges"
              aria-pressed={style.polyhedronEdges}
              style={chipStyle(style.polyhedronEdges)}
              onClick={() => apply({ polyhedronEdges: !style.polyhedronEdges })}
            >
              Edges
            </button>
          )}
        </div>
      </div>
      {polyhedraOn && (
        <SliderRow
          testId="quick-style-polyhedra-opacity"
          label="Poly. opacity"
          value={style.polyhedronOpacity}
          min={0}
          max={1}
          step={0.05}
          format={percent}
          onChange={(v) => apply({ polyhedronOpacity: v })}
        />
      )}
      {style.polyhedra && style.pipelinePolyhedra === null && polyhedraNotice && (
        <div
          data-testid="quick-style-polyhedra-notice"
          style={{ fontSize: 11, color: "var(--megane-text-muted)" }}
        >
          Polyhedra: {polyhedraNotice}
        </div>
      )}

      <div style={rowStyle}>
        <span style={labelStyle}>Labels</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {LABEL_OPTIONS.map((o) => {
            const disabled =
              (o.value === "resname" && !hasResidueLabels) ||
              (o.value !== "none" && available.foreignLabels);
            return (
              <button
                key={o.value}
                type="button"
                data-testid={`quick-style-labels-${o.value}`}
                disabled={disabled}
                style={chipStyle(style.labels === o.value, disabled)}
                onClick={() => apply({ labels: o.value })}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>View</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          <button
            type="button"
            data-testid="quick-style-perspective"
            aria-pressed={style.perspective}
            style={chipStyle(style.perspective)}
            onClick={() => apply({ perspective: !style.perspective })}
          >
            Perspective
          </button>
          {hasCell && (
            <button
              type="button"
              data-testid="quick-style-cell-axes"
              aria-pressed={style.cellAxesVisible}
              style={chipStyle(style.cellAxesVisible)}
              onClick={() => apply({ cellAxesVisible: !style.cellAxesVisible })}
            >
              Cell axes
            </button>
          )}
        </div>
      </div>

      {available.foreignStyleNodes > 0 && (
        <div
          data-testid="quick-style-foreign-hint"
          style={{ fontSize: 11, color: "var(--megane-text-muted)" }}
        >
          {available.foreignStyleNodes} other style node
          {available.foreignStyleNodes === 1 ? "" : "s"} in the pipeline also change the look.
        </div>
      )}

      <button
        type="button"
        data-testid="quick-style-reset"
        style={{ ...controlStyle, cursor: "pointer", alignSelf: "flex-end", fontSize: 12 }}
        onClick={() => apply(quickStyleDefaults())}
      >
        ↺ Reset
      </button>
    </>
  );

  if (!framed) {
    return (
      <div data-testid="quick-style" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {body}
      </div>
    );
  }
  return (
    <div data-testid="quick-style" style={sectionStyle}>
      <span style={titleStyle}>Quick style</span>
      {body}
    </div>
  );
}
