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
import { Field, FormStack, SliderField } from "./form";
import { checkboxStyle, colorInputStyle, inputStyle, selectStyle } from "./formStyles";

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
      <FormStack>
        <Field label="Iso level">
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
        </Field>

        {/* Color mode: solid color vs. sampling the Color Volume input */}
        <Field label="Color by">
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
        </Field>

        {/* Positive color (solid mode) */}
        {colorMode === "solid" && (
          <Field label="Color (+)">
            <input
              type="color"
              className="nodrag"
              data-testid="isosurface-color"
              value={params.color}
              style={colorInputStyle}
              onChange={(e) => updateNodeParams(id, { color: e.target.value })}
            />
          </Field>
        )}

        {/* Colormap + range (volume mode) */}
        {colorMode === "volume" && (
          <>
            <Field label="Colormap">
              <select
                className="nodrag"
                data-testid="isosurface-colormap"
                value={params.colormap ?? "rwb"}
                style={selectStyle}
                onChange={(e) =>
                  updateNodeParams(id, { colormap: e.target.value as VolumeColormap })
                }
              >
                {(Object.entries(VOLUME_COLORMAP_LABELS) as [VolumeColormap, string][]).map(
                  ([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ),
                )}
              </select>
            </Field>
            <Field label="Range">
              <input
                type="number"
                className="nodrag"
                data-testid="isosurface-range-min"
                aria-label="Range minimum"
                placeholder="auto"
                value={rangeMinText}
                step={0.001}
                style={inputStyle}
                onChange={(e) => {
                  setRangeMinText(e.target.value);
                  commitRange(e.target.value, rangeMaxText);
                }}
              />
              <input
                type="number"
                className="nodrag"
                data-testid="isosurface-range-max"
                aria-label="Range maximum"
                placeholder="auto"
                value={rangeMaxText}
                step={0.001}
                style={inputStyle}
                onChange={(e) => {
                  setRangeMaxText(e.target.value);
                  commitRange(rangeMinText, e.target.value);
                }}
              />
            </Field>
          </>
        )}

        <SliderField
          label="Opacity"
          testId="isosurface-opacity"
          min={0}
          max={1}
          step={0.05}
          value={params.opacity}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => updateNodeParams(id, { opacity: v })}
        />

        {/* Dual contour toggle */}
        <Field label="Negative lobe">
          <input
            type="checkbox"
            className="nodrag"
            data-testid="isosurface-show-negative"
            checked={params.showNegative}
            style={checkboxStyle}
            onChange={(e) => updateNodeParams(id, { showNegative: e.target.checked })}
          />
        </Field>

        {/* Negative color (shown only when toggle is on and coloring is solid) */}
        {params.showNegative && colorMode === "solid" && (
          <Field label="Color (−)">
            <input
              type="color"
              className="nodrag"
              data-testid="isosurface-negative-color"
              value={params.negativeColor}
              style={colorInputStyle}
              onChange={(e) => updateNodeParams(id, { negativeColor: e.target.value })}
            />
          </Field>
        )}
      </FormStack>
    </NodeShell>
  );
}
