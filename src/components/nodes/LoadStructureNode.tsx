/**
 * Load Structure node.
 * Source node in the pipeline — file upload only, no bond selection.
 * Outputs: particle, trajectory (if present), cell (if present).
 * Ports without data are grayed out.
 */

import type { NodeProps, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { LoadStructureParams } from "../../pipeline/types";
import { useScopedPipelineStore, useLoadHandlers } from "../../stores/MeganeProvider";
import { globalLoadHandlers, type StructureLoadHandler } from "../../stores/loadHandlers";
import { NodeShell } from "./NodeShell";
import { smallBtnStyle, fileNameStyle } from "../ui";
import { useRef, useCallback } from "react";
import { matchesStructureName } from "../../parsers/fileNames";

// The file-dialog filter can only express extensions, so VASP contributes
// `.vasp` here. Its extensionless spellings (POSCAR / CONTCAR / XDATCAR) are
// still accepted on drag-drop via `matchesStructureName`.
const STRUCTURE_ACCEPT =
  ".pdb,.gro,.xyz,.mol,.sdf,.mol2,.cif,.mmcif,.data,.lammps,.prmtop,.traj,.lammpstrj,.dump,.trj,.vasp,.cml,.molden,.xsf,.axsf,.jxyz,.c3xml,.xodydata,.odydata,.magres,.gamess,.phonon";
export const STRUCTURE_EXTS = [
  // Molden geometry output.
  ".molden",
  // Chem3D XML (CDXML family).
  ".c3xml",
  // Wavefunction Odyssey. `.xodydata` is XML, `.odydata` is the older text
  // layout; the parser detects which from the content, not the extension.
  ".xodydata",
  ".odydata",
  // CASTEP / Quantum ESPRESSO NMR output.
  ".magres",
  ".gamess",
  ".phonon",
  ".pdb",
  ".gro",
  ".xyz",
  // Jmol's second extension for plain XYZ.
  ".jxyz",
  ".mol",
  ".sdf",
  ".mol2",
  ".cif",
  ".mmcif",
  ".data",
  ".lammps",
  ".prmtop",
  ".traj",
  // LAMMPS dump opened standalone as a multi-frame structure (topology from
  // frame 0; integer atom `type` ids used as element proxies).
  ".lammpstrj",
  ".dump",
  ".trj",
  // XCrySDen structure / animation (`.axsf` is the animated variant).
  ".xsf",
  ".axsf",
  // Chemical Markup Language.
  ".cml",
  // VASP POSCAR / CONTCAR / XDATCAR. Bare (extensionless) VASP filenames are
  // matched by `matchesStructureName`, not by this suffix list.
  ".vasp",
];

/**
 * Event bus for structure loading.
 * MeganeViewer listens for these events to trigger actual file parsing.
 */
export type { StructureLoadHandler };

/**
 * Legacy module-global registration, kept so provider-less hosts and any
 * existing embedder keep working. It writes the process-global slots; a
 * viewer inside a <MeganeProvider> uses that provider's own slots instead.
 */
export function setStructureLoadHandler(handler: StructureLoadHandler | null) {
  globalLoadHandlers.setStructure(handler);
}

export function LoadStructureNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((s) => s.updateNodeParams);
  const loadHandlers = useLoadHandlers();
  const params = data.params as LoadStructureParams;
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    (file: File) => {
      if (!matchesStructureName(file.name, STRUCTURE_EXTS)) return;
      updateNodeParams(id, { fileName: file.name });
      loadHandlers.structure?.(id, file);
    },
    [id, updateNodeParams, loadHandlers],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const files = Array.from(e.dataTransfer.files);
      const match = files.find((f) => matchesStructureName(f.name, STRUCTURE_EXTS));
      if (match) handleFile(match);
    },
    [handleFile],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  // Determine which output ports are disabled (no data available)
  const disabledPorts = new Set<string>();
  if (!params.hasTrajectory) disabledPorts.add("trajectory");
  if (!params.hasCell) disabledPorts.add("cell");

  return (
    <NodeShell
      id={id}
      nodeType="load_structure"
      enabled={data.enabled}
      disabledPorts={disabledPorts}
    >
      <div onDrop={handleDrop} onDragOver={handleDragOver}>
        {params.fileName ? (
          <div data-testid="load-structure-filename" style={fileNameStyle}>
            {params.fileName}
          </div>
        ) : (
          <div
            data-testid="load-structure-filename"
            style={{ fontSize: 20, color: "#94a3b8", fontStyle: "italic" }}
          >
            No structure loaded
          </div>
        )}
        <button
          onClick={() => inputRef.current?.click()}
          style={{ ...smallBtnStyle, marginTop: 6, width: "100%" }}
        >
          Load structure...
        </button>
        <input
          ref={inputRef}
          data-testid="load-structure-input"
          type="file"
          accept={STRUCTURE_ACCEPT}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            e.target.value = "";
          }}
          style={{ display: "none" }}
        />
      </div>
    </NodeShell>
  );
}
