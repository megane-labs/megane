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
import { TabSelector } from "../ui";
import { Field, FileDrop, FormStack, SliderField } from "./form";
import { parseTopBonds, parsePsfBonds } from "../../parsers/structure";
import { DEFAULT_VDW_BOND_FACTOR } from "../../parsers/inferBondsJS";
import type { BondSource } from "../../types";
import { useRef, useCallback } from "react";

const TOPOLOGY_ACCEPT = ".top,.psf";
const TOPOLOGY_EXTS = [".top", ".psf"];

// Allowed range for the VDW distance threshold scale. Lower tightens (fewer
// bonds), higher loosens (more bonds). 0.6 is the default used elsewhere.
const VDW_SCALE_MIN = 0.3;
const VDW_SCALE_MAX = 1.2;
const VDW_SCALE_STEP = 0.05;

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
      <FormStack>
        <Field label="Source" group>
          <TabSelector<BondSource>
            size="compact"
            options={[
              { value: "structure", label: "File" },
              { value: "distance", label: "VDW" },
              { value: "file", label: "Topology" },
            ]}
            value={params.bondSource}
            onChange={(v) => updateNodeParams(id, { bondSource: v })}
          />
        </Field>
        {params.bondSource === "distance" && (
          <SliderField
            label="Threshold"
            testId="add-bond-vdw-scale"
            min={VDW_SCALE_MIN}
            max={VDW_SCALE_MAX}
            step={VDW_SCALE_STEP}
            value={params.vdwScale ?? DEFAULT_VDW_BOND_FACTOR}
            format={(v) => v.toFixed(2)}
            onChange={(v) => updateNodeParams(id, { vdwScale: v })}
          />
        )}
        {params.bondSource === "file" && (
          <FileDrop
            fileName={params.bondFileName}
            emptyText="No topology loaded"
            buttonLabel="Load .top / .psf..."
            onPick={() => inputRef.current?.click()}
            fileInput={
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
            }
          />
        )}
      </FormStack>
    </NodeShell>
  );
}
