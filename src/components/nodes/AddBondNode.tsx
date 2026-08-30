/**
 * Add Bond node.
 * Takes particle input and outputs bond data.
 * Supports bond sources: structure (from file), VDW (distance-based), topology file (.top).
 */

import type { NodeProps, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { AddBondParams } from "../../pipeline/types";
import { useScopedPipelineStore } from "../../stores/MeganeProvider";
import { NodeShell } from "./NodeShell";
import { TabSelector, smallBtnStyle, fileNameStyle } from "../ui";
import { parseTopBonds, parsePsfBonds } from "../../parsers/structure";
import { DEFAULT_VDW_BOND_FACTOR } from "../../parsers/inferBondsJS";
import type { BondSource } from "../../types";
import { useRef, useCallback } from "react";

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 600,
  color: "#94a3b8",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  marginBottom: 7,
  marginTop: 0,
};

const TOPOLOGY_ACCEPT = ".top,.psf";
const TOPOLOGY_EXTS = [".top", ".psf"];

// Allowed range for the VDW distance threshold scale. Lower tightens (fewer
// bonds), higher loosens (more bonds). 0.6 is the default used elsewhere.
const VDW_SCALE_MIN = 0.3;
const VDW_SCALE_MAX = 1.2;
const VDW_SCALE_STEP = 0.05;

const thresholdRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginTop: 8,
};

const thresholdLabelStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 500,
  color: "#64748b",
  flex: 1,
};

const thresholdSliderStyle: React.CSSProperties = {
  width: 110,
  accentColor: "#06b6d4",
};

const thresholdValueStyle: React.CSSProperties = {
  fontSize: 15,
  color: "#64748b",
  minWidth: 30,
  textAlign: "right",
};

export function AddBondNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((s) => s.updateNodeParams);
  const params = data.params as AddBondParams;
  const inputRef = useRef<HTMLInputElement>(null);

  const handleTopologyFile = useCallback(
    async (file: File) => {
      const lower = file.name.toLowerCase();
      if (!TOPOLOGY_EXTS.some((ext) => lower.endsWith(ext))) return;
      const text = await file.text();
      // Parse with max n_atoms; executor filters to actual atom count
      const bondIndices = lower.endsWith(".psf")
        ? await parsePsfBonds(text, 0xffffffff)
        : await parseTopBonds(text, 0xffffffff);
      updateNodeParams(id, {
        bondSource: "file" as BondSource,
        bondFileName: file.name,
        bondFileData: bondIndices,
      });
    },
    [id, updateNodeParams],
  );

  return (
    <NodeShell id={id} nodeType="add_bond" enabled={data.enabled}>
      <div style={sectionLabelStyle}>Source</div>
      <TabSelector<BondSource>
        options={[
          { value: "structure", label: "File" },
          { value: "distance", label: "VDW" },
          { value: "file", label: "Topology" },
        ]}
        value={params.bondSource}
        onChange={(v) => updateNodeParams(id, { bondSource: v })}
      />
      {params.bondSource === "distance" && (
        <div style={thresholdRowStyle}>
          <span style={thresholdLabelStyle}>Threshold</span>
          <input
            type="range"
            className="nodrag"
            data-testid="add-bond-vdw-scale"
            min={VDW_SCALE_MIN}
            max={VDW_SCALE_MAX}
            step={VDW_SCALE_STEP}
            value={params.vdwScale ?? DEFAULT_VDW_BOND_FACTOR}
            style={thresholdSliderStyle}
            onChange={(e) => updateNodeParams(id, { vdwScale: parseFloat(e.target.value) })}
          />
          <span style={thresholdValueStyle}>
            {(params.vdwScale ?? DEFAULT_VDW_BOND_FACTOR).toFixed(2)}
          </span>
        </div>
      )}
      {params.bondSource === "file" && (
        <div style={{ marginTop: 4 }}>
          {params.bondFileName ? (
            <div style={{ ...fileNameStyle, fontSize: 18 }}>{params.bondFileName}</div>
          ) : (
            <div style={{ fontSize: 18, color: "#94a3b8", fontStyle: "italic" }}>
              No topology loaded
            </div>
          )}
          <button
            onClick={() => inputRef.current?.click()}
            style={{ ...smallBtnStyle, marginTop: 6, width: "100%" }}
          >
            Load .top / .psf...
          </button>
          <input
            ref={inputRef}
            type="file"
            accept={TOPOLOGY_ACCEPT}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleTopologyFile(file);
              e.target.value = "";
            }}
            style={{ display: "none" }}
          />
        </div>
      )}
    </NodeShell>
  );
}
