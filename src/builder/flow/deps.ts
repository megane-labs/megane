/**
 * What a Flow run reaches outside the graph, bound to one Builder: RDKit for
 * SMILES, the molecule library, the Manual document, and the tool server of
 * that Builder's tools store.
 */

import { useMemo } from "react";
import type { StoreApi } from "zustand";
import { parseStructureText } from "../../parsers/structure";
import type { Snapshot } from "../../types";
import { embedSketch } from "../library/embed";
import { allMolecules, useLibraryStore } from "../library/store";
import type { LibraryStore } from "../library/store";
import { shownSnapshot, UNTITLED, type BuilderStore } from "../store";
import type { ToolsStore } from "../tools/store";
import { useBuilderStoreApi, useToolsStoreApi } from "../BuilderStores";
import type { FlowDeps } from "./engine";

export interface FlowDepsSources {
  builder: StoreApi<BuilderStore>;
  tools: StoreApi<ToolsStore>;
  library: StoreApi<LibraryStore>;
  /** SMILES → 3D structure; RDKit through the embedding worker by default. */
  embedSmiles?: (smiles: string) => Promise<Snapshot>;
}

/** Embed a SMILES string with RDKit (hydrogens added, MMFF94s) and parse the mol block. */
export async function embedSmilesWithRDKit(smiles: string): Promise<Snapshot> {
  const embedded = await embedSketch(smiles);
  const parsed = await parseStructureText(embedded.molblock, "smiles.mol");
  return parsed.snapshot;
}

const snapshotIds = new WeakMap<Snapshot, number>();
let nextSnapshotId = 1;

/** A key that stays the same for one Snapshot object and differs for any other. */
function snapshotKey(snapshot: Snapshot): string {
  let id = snapshotIds.get(snapshot);
  if (id === undefined) {
    id = nextSnapshotId++;
    snapshotIds.set(snapshot, id);
  }
  return `doc-${id}`;
}

export function createFlowDeps({
  builder,
  tools,
  library,
  embedSmiles = embedSmilesWithRDKit,
}: FlowDepsSources): FlowDeps {
  return {
    embedSmiles,
    library: () => allMolecules(library.getState()),
    document: () => {
      const s = builder.getState();
      const snapshot = shownSnapshot(s);
      if (!snapshot) return null;
      return {
        data: { name: s.fileName ?? UNTITLED, snapshot, labels: s.sourceLabels },
        key: snapshotKey(snapshot),
      };
    },
    tool: (name) => tools.getState().connection?.listing.tools.find((t) => t.name === name) ?? null,
    call: async (tool, args, options) => {
      const connection = tools.getState().connection;
      if (!connection) return { ok: false, error: "Not connected to a tool server." };
      return connection.call(tool.name, args, options);
    },
  };
}

/** The Flow dependencies of the Builder this component is in. */
export function useFlowDeps(): FlowDeps {
  const builder = useBuilderStoreApi();
  const tools = useToolsStoreApi();
  return useMemo(
    () => createFlowDeps({ builder, tools, library: useLibraryStore }),
    [builder, tools],
  );
}
