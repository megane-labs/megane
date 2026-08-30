/**
 * Isosurface node.
 * Controls iso level, color, opacity, and optional dual-contour (negative lobe).
 */

import { useState } from "react";
import type { NodeProps, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { IsosurfaceParams, IsosurfaceColorMode, VolumeColormap } from "../../pipeline/types";
import { VOLUME_COLORMAP_LABELS } from "../../pipeline/executors/volumeColor";
import { useScopedPipelineStore } from "../../stores/MeganeProvider";
import { NodeShell } from "./NodeShell";

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  marginBottom: 8,
};

const labelStyle: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 500,
  color: "#64748b",
  flex: 1,
};

const inputStyle: React.CSSProperties = {
  width: 72,
  padding: "3px 6px",
  fontSize: 16,
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  background: "var(--megane-node-bg, #fff)",
  color: "inherit",
  boxSizing: "border-box",
};

const colorStyle: React.CSSProperties = {
  width: 40,
  height: 26,
  padding: 2,
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  cursor: "pointer",
  background: "none",
};

const sliderStyle: React.CSSProperties = {
  width: 90,
  accentColor: "#06b6d4",
};

const valueStyle: React.CSSProperties = {
  fontSize: 14,
  color: "#64748b",
  minWidth: 32,
  textAlign: "right",
};

const checkboxRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  marginBottom: 8,
};

const selectStyle: React.CSSProperties = {
  fontSize: 14,
  color: "#334155",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  padding: "3px 6px",
};

const rangeInputStyle: React.CSSProperties = {
  ...inputStyle,
  width: 64,
};

export function IsosurfaceNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((s) => s.updateNodeParams);
  const params = data.params as IsosurfaceParams;
  const colorMode = params.colorMode ?? "solid";

  // Draft text for the range inputs so a half-typed pair isn't clobbered by
  // the params round trip; only a complete, ordered pair overrides auto.
  const [rangeMinText, setRangeMinText] = useState(
    params.colorRange ? String(params.colorRange[0]) : "",
  );
  const [rangeMaxText, setRangeMaxText] = useState(
    params.colorRange ? String(params.colorRange[1]) : "",
  );

  const commitRange = (minText: string, maxText: string) => {
    const min = parseFloat(minText);
    const max = parseFloat(maxText);
    if (isFinite(min) && isFinite(max) && max > min) {
      updateNodeParams(id, { colorRange: [min, max] });
    } else {
      updateNodeParams(id, { colorRange: undefined });
    }
  };

  return (
    <NodeShell id={id} nodeType="isosurface" enabled={data.enabled}>
      {/* Iso level */}
      <div style={rowStyle}>
        <span style={labelStyle}>Iso level</span>
        <input
          type="number"
          className="nodrag"
          data-testid="isosurface-level"
          value={params.isoLevel}
          step={0.001}
          style={inputStyle}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!isNaN(v)) updateNodeParams(id, { isoLevel: v });
          }}
        />
      </div>

      {/* Color mode: solid color vs. sampling the Color Volume input */}
      <div style={rowStyle}>
        <span style={labelStyle}>Color by</span>
        <select
          className="nodrag"
          data-testid="isosurface-color-mode"
          value={colorMode}
          style={selectStyle}
          onChange={(e) =>
            updateNodeParams(id, { colorMode: e.target.value as IsosurfaceColorMode })
          }
        >
          <option value="solid">Solid color</option>
          <option value="volume">Color volume</option>
        </select>
      </div>

      {/* Positive color (solid mode) */}
      {colorMode === "solid" && (
        <div style={rowStyle}>
          <span style={labelStyle}>Color (+)</span>
          <input
            type="color"
            className="nodrag"
            data-testid="isosurface-color"
            value={params.color}
            style={colorStyle}
            onChange={(e) => updateNodeParams(id, { color: e.target.value })}
          />
        </div>
      )}

      {/* Colormap + range (volume mode) */}
      {colorMode === "volume" && (
        <>
          <div style={rowStyle}>
            <span style={labelStyle}>Colormap</span>
            <select
              className="nodrag"
              data-testid="isosurface-colormap"
              value={params.colormap ?? "rwb"}
              style={selectStyle}
              onChange={(e) => updateNodeParams(id, { colormap: e.target.value as VolumeColormap })}
            >
              {(Object.entries(VOLUME_COLORMAP_LABELS) as [VolumeColormap, string][]).map(
                ([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ),
              )}
            </select>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>Range</span>
            <input
              type="number"
              className="nodrag"
              data-testid="isosurface-range-min"
              placeholder="auto"
              value={rangeMinText}
              step={0.001}
              style={rangeInputStyle}
              onChange={(e) => {
                setRangeMinText(e.target.value);
                commitRange(e.target.value, rangeMaxText);
              }}
            />
            <input
              type="number"
              className="nodrag"
              data-testid="isosurface-range-max"
              placeholder="auto"
              value={rangeMaxText}
              step={0.001}
              style={rangeInputStyle}
              onChange={(e) => {
                setRangeMaxText(e.target.value);
                commitRange(rangeMinText, e.target.value);
              }}
            />
          </div>
        </>
      )}

      {/* Opacity */}
      <div style={rowStyle}>
        <span style={labelStyle}>Opacity</span>
        <input
          type="range"
          className="nodrag"
          data-testid="isosurface-opacity"
          min={0}
          max={1}
          step={0.05}
          value={params.opacity}
          style={sliderStyle}
          onChange={(e) => updateNodeParams(id, { opacity: parseFloat(e.target.value) })}
        />
        <span style={valueStyle}>{Math.round(params.opacity * 100)}%</span>
      </div>

      {/* Dual contour toggle */}
      <div style={checkboxRowStyle}>
        <input
          type="checkbox"
          className="nodrag"
          id={`${id}-neg`}
          data-testid="isosurface-show-negative"
          checked={params.showNegative}
          onChange={(e) => updateNodeParams(id, { showNegative: e.target.checked })}
        />
        <label htmlFor={`${id}-neg`} style={{ fontSize: 17, color: "#64748b" }}>
          Show negative lobe
        </label>
      </div>

      {/* Negative color (shown only when toggle is on and coloring is solid) */}
      {params.showNegative && colorMode === "solid" && (
        <div style={rowStyle}>
          <span style={labelStyle}>Color (−)</span>
          <input
            type="color"
            className="nodrag"
            data-testid="isosurface-negative-color"
            value={params.negativeColor}
            style={colorStyle}
            onChange={(e) => updateNodeParams(id, { negativeColor: e.target.value })}
          />
        </div>
      )}
    </NodeShell>
  );
}
