/**
 * Spectrum Plot node.
 *
 * The 2D plot surface issue #611 calls for. A spectrum has no coordinates, so
 * it never reaches the 3D renderer — this node is where it is displayed, drawn
 * as an inline SVG line chart with axes, tick labels, and the units the file
 * declared.
 *
 * SVG rather than a canvas or a charting library: a spectrum is a single
 * polyline, the node is small, and SVG keeps the node serialisable, printable
 * through the existing export path, and free of a new dependency.
 */

import { useMemo } from "react";
import type { NodeProps, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import { useScopedPipelineStore } from "../../stores/MeganeProvider";
import { NodeShell } from "./NodeShell";
import type { LoadSpectrumParams, SpectrumData, SpectrumPlotParams } from "../../pipeline/types";

/**
 * Resolve the spectrum wired into this plot node.
 *
 * The decoded spectrum lives on the source node's params (it is ephemeral and
 * never serialised), so the plot walks one edge back to find it rather than the
 * engine parking a second copy in the store. Exported for unit testing.
 */
export function resolveConnectedSpectrum(
  nodeId: string,
  nodes: Node<PipelineNodeData>[],
  edges: { source: string; target: string; targetHandle?: string | null }[],
): SpectrumData | null {
  for (const edge of edges) {
    if (edge.target !== nodeId) continue;
    if ((edge.targetHandle ?? "spectrum") !== "spectrum") continue;
    const source = nodes.find((n) => n.id === edge.source);
    if (source?.type !== "load_spectrum") continue;
    const params = source.data.params as LoadSpectrumParams;
    if (params.spectrumData) return params.spectrumData;
  }
  return null;
}

const PLOT_W = 320;
const PLOT_H = 160;
const PAD_L = 44;
const PAD_R = 8;
const PAD_T = 8;
const PAD_B = 26;

/** A short axis label: 3 significant figures, exponent form when extreme. */
export function formatTick(v: number): string {
  if (v === 0) return "0";
  const mag = Math.abs(v);
  if (mag >= 1e5 || mag < 1e-3) return v.toExponential(1);
  return String(Number(v.toPrecision(3)));
}

/**
 * Build the polyline points and the four corner tick values for a spectrum.
 * Exported so the geometry can be unit-tested without rendering.
 */
export function buildPlot(
  x: Float64Array | number[],
  y: Float64Array | number[],
  reverseX: boolean,
): {
  points: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
} | null {
  const n = Math.min(x.length, y.length);
  if (n < 2) return null;

  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (let i = 0; i < n; i++) {
    if (x[i] < xMin) xMin = x[i];
    if (x[i] > xMax) xMax = x[i];
    if (y[i] < yMin) yMin = y[i];
    if (y[i] > yMax) yMax = y[i];
  }
  if (!isFinite(xMin) || !isFinite(yMin)) return null;

  // A flat trace would divide by zero; give it a unit span so it draws centred.
  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin || 1;
  const innerW = PLOT_W - PAD_L - PAD_R;
  const innerH = PLOT_H - PAD_T - PAD_B;

  const parts: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const fx = (x[i] - xMin) / xSpan;
    // SVG y grows downward, so the ordinate is inverted regardless.
    const py = PAD_T + innerH * (1 - (y[i] - yMin) / ySpan);
    const px = PAD_L + innerW * (reverseX ? 1 - fx : fx);
    parts[i] = `${px.toFixed(2)},${py.toFixed(2)}`;
  }
  return { points: parts.join(" "), xMin, xMax, yMin, yMax };
}

export function SpectrumPlotNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((s) => s.updateNodeParams);
  const params = data.params as SpectrumPlotParams;
  const nodes = useScopedPipelineStore((s) => s.nodes);
  const edges = useScopedPipelineStore((s) => s.edges);
  const spectrum = useMemo(() => resolveConnectedSpectrum(id, nodes, edges), [id, nodes, edges]);

  const plot = useMemo(
    () => (spectrum ? buildPlot(spectrum.x, spectrum.y, params.reverseX) : null),
    [spectrum, params.reverseX],
  );

  // Left axis is the low end unless the abscissa is reversed (IR / NMR).
  const leftTick = plot ? (params.reverseX ? plot.xMax : plot.xMin) : 0;
  const rightTick = plot ? (params.reverseX ? plot.xMin : plot.xMax) : 0;

  return (
    <NodeShell id={id} nodeType="spectrum_plot" enabled={data.enabled}>
      <div>
        {!spectrum || !plot ? (
          <div
            data-testid="spectrum-plot-empty"
            style={{ fontSize: 20, color: "#94a3b8", fontStyle: "italic" }}
          >
            No spectrum connected
          </div>
        ) : (
          <>
            <div
              data-testid="spectrum-plot-title"
              style={{ fontSize: 14, color: "#334155", marginBottom: 2 }}
            >
              {spectrum.title || spectrum.dataType || "Spectrum"}
            </div>
            <svg
              data-testid="spectrum-plot-svg"
              width={PLOT_W}
              height={PLOT_H}
              viewBox={`0 0 ${PLOT_W} ${PLOT_H}`}
              role="img"
              aria-label={`${spectrum.dataType || "Spectrum"} plot`}
              style={{ background: "#fff", borderRadius: 4, border: "1px solid #e2e8f0" }}
            >
              {/* Axes */}
              <line
                x1={PAD_L}
                y1={PLOT_H - PAD_B}
                x2={PLOT_W - PAD_R}
                y2={PLOT_H - PAD_B}
                stroke="#cbd5e1"
              />
              <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={PLOT_H - PAD_B} stroke="#cbd5e1" />
              {/* Ordinate ticks */}
              <text x={PAD_L - 4} y={PAD_T + 8} textAnchor="end" fontSize="9" fill="#64748b">
                {formatTick(plot.yMax)}
              </text>
              <text x={PAD_L - 4} y={PLOT_H - PAD_B} textAnchor="end" fontSize="9" fill="#64748b">
                {formatTick(plot.yMin)}
              </text>
              {/* Abscissa ticks */}
              <text
                x={PAD_L}
                y={PLOT_H - PAD_B + 12}
                textAnchor="start"
                fontSize="9"
                fill="#64748b"
              >
                {formatTick(leftTick)}
              </text>
              <text
                x={PLOT_W - PAD_R}
                y={PLOT_H - PAD_B + 12}
                textAnchor="end"
                fontSize="9"
                fill="#64748b"
              >
                {formatTick(rightTick)}
              </text>
              {/* Unit labels */}
              <text
                x={(PLOT_W + PAD_L) / 2}
                y={PLOT_H - 3}
                textAnchor="middle"
                fontSize="9"
                fill="#94a3b8"
              >
                {spectrum.xUnits}
              </text>
              <text
                x={10}
                y={PLOT_H / 2}
                textAnchor="middle"
                fontSize="9"
                fill="#94a3b8"
                transform={`rotate(-90 10 ${PLOT_H / 2})`}
              >
                {spectrum.yUnits}
              </text>
              <polyline
                data-testid="spectrum-plot-trace"
                points={plot.points}
                fill="none"
                stroke={params.color}
                strokeWidth={1.2}
              />
            </svg>
          </>
        )}
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 14,
            marginTop: 6,
            color: "#475569",
          }}
        >
          <input
            data-testid="spectrum-plot-reverse"
            type="checkbox"
            checked={params.reverseX}
            onChange={(e) => updateNodeParams(id, { reverseX: e.target.checked })}
          />
          Reverse X (IR / NMR convention)
        </label>
      </div>
    </NodeShell>
  );
}
