/**
 * Pipeline serialization / deserialization.
 * Converts between xyflow nodes/edges and the JSON format (version 2).
 */

import type { Node, Edge } from "@xyflow/react";
import type { PipelineNodeData } from "./execute";
import type { SerializedPipeline, PipelineNodeType } from "./types";
import { defaultParams, NODE_PORTS } from "./types";

// Derive the valid node types from the authoritative NODE_PORTS record so this
// set can never drift out of sync with the node types the app supports. (A
// previously hardcoded list was missing surface_mesh, load_volumetric, and
// isosurface, which made deserializePipeline throw on any pipeline using them.)
const VALID_NODE_TYPES: Set<string> = new Set(Object.keys(NODE_PORTS));

/**
 * Serialize xyflow nodes and edges into the portable JSON format.
 */
export function serializePipeline(
  nodes: Node<PipelineNodeData>[],
  edges: Edge[],
): SerializedPipeline {
  return {
    version: 3,
    nodes: nodes.map((n) => {
      // Strip ephemeral (non-serializable) fields from params.
      // `volumetricData` holds Float32Arrays, `spectrumData` Float64Arrays, and
      // `parseError` is a transient UI message; all are documented as "not
      // serialized" on LoadVolumetricParams / LoadSpectrumParams.
      const { bondFileData, volumetricData, spectrumData, parseError, ...params } = n.data
        .params as typeof n.data.params & {
        bondFileData?: unknown;
        volumetricData?: unknown;
        spectrumData?: unknown;
        parseError?: unknown;
      };
      return {
        ...params,
        id: n.id,
        position: n.position,
        enabled: n.data.enabled,
      };
    }),
    edges: edges.map((e) => ({
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? "",
      targetHandle: e.targetHandle ?? "",
    })),
  };
}

/**
 * Deserialize the portable JSON format into xyflow nodes and edges.
 *
 * Also normalizes the graph to the canonical "LoadStructure → AddBond →
 * Viewport" shape: if the saved pipeline lacks an AddBond node connecting a
 * LoadStructure to the Viewport, one is injected with the standard wiring
 * (particle, cell, bond, and — when the loader carries a trajectory —
 * trajectory edges). This guards against older / hand-written .megane.json
 * files that only wired LoadStructure.particle → Viewport.particle and
 * therefore rendered without bonds.
 */
export function deserializePipeline(json: SerializedPipeline): {
  nodes: Node<PipelineNodeData>[];
  edges: Edge[];
} {
  if (json.version !== 3) {
    throw new Error(`Unsupported pipeline version: ${json.version}`);
  }

  const nodes: Node<PipelineNodeData>[] = json.nodes.map((serialized) => {
    if (!VALID_NODE_TYPES.has(serialized.type)) {
      throw new Error(`Unknown node type: ${serialized.type}`);
    }
    const nodeType = serialized.type as PipelineNodeType;
    const defaults = defaultParams(nodeType);
    const { id, position, enabled, ...paramFields } = serialized;
    // Drop legacy fields that no longer exist on the current params shape.
    // Viewport.colorScheme moved to Modify.colorMode; any value carried by
    // older saved pipelines is silently discarded (legacy graphs render with
    // the default CPK / byElement base colors until a Modify node is added).
    if (nodeType === "viewport" && "colorScheme" in paramFields) {
      delete (paramFields as { colorScheme?: unknown }).colorScheme;
    }
    // Viewport.representationMode moved to the dedicated Representation node;
    // legacy graphs render with the default "atoms" representation until a
    // Representation node is added.
    if (nodeType === "viewport" && "representationMode" in paramFields) {
      delete (paramFields as { representationMode?: unknown }).representationMode;
    }
    // Modify color section split into the dedicated Color node; legacy graphs
    // with these fields fall through to the default base colors.
    if (nodeType === "modify") {
      const legacy = paramFields as {
        colorEnabled?: unknown;
        colorMode?: unknown;
        uniformColor?: unknown;
        colorRange?: unknown;
      };
      delete legacy.colorEnabled;
      delete legacy.colorMode;
      delete legacy.uniformColor;
      delete legacy.colorRange;
    }
    // Coordination search moved out of Polyhedra. The graph migration below
    // preserves these values on an injected Coordination node; they must not
    // remain on Polyhedra itself.
    if (nodeType === "polyhedron_generator") {
      const legacy = paramFields as {
        centerElements?: unknown;
        ligandElements?: unknown;
        maxDistance?: unknown;
        excludedCenters?: unknown;
        excludedLigands?: unknown;
        cutoffTolerance?: unknown;
        boundaryMode?: unknown;
      };
      delete legacy.centerElements;
      delete legacy.ligandElements;
      delete legacy.maxDistance;
      delete legacy.excludedCenters;
      delete legacy.excludedLigands;
      delete legacy.cutoffTolerance;
      delete legacy.boundaryMode;
    }
    const params = { ...defaults, ...paramFields, type: nodeType } as typeof defaults;

    return {
      id,
      type: nodeType,
      position: position ?? { x: 0, y: 0 },
      data: {
        params,
        enabled: enabled !== false,
      },
    };
  });

  const edges: Edge[] = (json.edges ?? []).map((e, i) => ({
    id: `e-${e.source}-${e.sourceHandle}-${e.target}-${e.targetHandle}-${i}`,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle || null,
    targetHandle: e.targetHandle || null,
  }));

  const migrated = migrateLegacyPolyhedra(nodes, edges, json);
  return normalizePipeline(migrated.nodes, migrated.edges);
}

/**
 * Migrate the former `particle -> Polyhedra -> {mesh,bond}` shape to the
 * responsibility-separated graph:
 *
 * `particle -> Drawing Boundary -> Coordination -> Polyhedra`
 *                                      `-> bond`
 *
 * Current graphs already connected through the coordination port are left
 * untouched. This is deliberately a deserialization concern; the Polyhedra
 * executor itself only accepts resolved coordination data.
 */
function migrateLegacyPolyhedra(
  nodes: Node<PipelineNodeData>[],
  edges: Edge[],
  serialized: SerializedPipeline,
): { nodes: Node<PipelineNodeData>[]; edges: Edge[] } {
  const outNodes = [...nodes];
  const outEdges = [...edges];
  const usedIds = new Set(outNodes.map((node) => node.id));
  const uniqueId = (prefix: string): string => {
    let suffix = 1;
    while (usedIds.has(`${prefix}-${suffix}`)) suffix++;
    const id = `${prefix}-${suffix}`;
    usedIds.add(id);
    return id;
  };

  for (const polyhedron of nodes.filter((node) => node.type === "polyhedron_generator")) {
    const legacyInputs = outEdges.filter(
      (edge) => edge.target === polyhedron.id && (edge.targetHandle ?? "") === "particle",
    );
    if (legacyInputs.length === 0) continue;

    const raw = serialized.nodes.find((node) => node.id === polyhedron.id) as
      | (Record<string, unknown> & { id: string })
      | undefined;
    const coordinationId = uniqueId(`coordination-${polyhedron.id}`);
    outNodes.push({
      id: coordinationId,
      type: "coordination_generator",
      position: { x: polyhedron.position.x, y: polyhedron.position.y - 170 },
      data: {
        params: {
          ...defaultParams("coordination_generator"),
          excludedCenters: (raw?.excludedCenters as number[] | undefined) ?? [],
          excludedLigands: (raw?.excludedLigands as number[] | undefined) ?? [],
          cutoffTolerance: (raw?.cutoffTolerance as number | undefined) ?? 1.15,
          boundaryMode: (raw?.boundaryMode as "inside" | "complete" | undefined) ?? "complete",
        } as ReturnType<typeof defaultParams>,
        enabled: polyhedron.data.enabled,
      },
    });

    for (const input of legacyInputs) {
      const sourceNode = outNodes.find((node) => node.id === input.source);
      let periodicSource = input.source;
      let periodicHandle = input.sourceHandle ?? "particle";
      if (sourceNode?.type !== "drawing_boundary") {
        const boundaryId = uniqueId(`drawing-boundary-${polyhedron.id}`);
        outNodes.push({
          id: boundaryId,
          type: "drawing_boundary",
          position: { x: polyhedron.position.x, y: polyhedron.position.y - 340 },
          data: { params: defaultParams("drawing_boundary"), enabled: polyhedron.data.enabled },
        });
        outEdges.push({
          id: `e-${input.source}-${boundaryId}-migration`,
          source: input.source,
          target: boundaryId,
          sourceHandle: input.sourceHandle ?? "particle",
          targetHandle: "particle",
        });
        periodicSource = boundaryId;
        periodicHandle = "particle";

        // If the same particle stream was sent directly to a viewport, route
        // it through Drawing Boundary so its copies are visible independently
        // of whether the Polyhedra mesh is connected.
        for (const viewportEdge of outEdges) {
          if (
            viewportEdge !== input &&
            viewportEdge.source === input.source &&
            (viewportEdge.sourceHandle ?? "") === (input.sourceHandle ?? "") &&
            (viewportEdge.targetHandle ?? "") === "particle" &&
            outNodes.find((node) => node.id === viewportEdge.target)?.type === "viewport"
          ) {
            viewportEdge.source = boundaryId;
            viewportEdge.sourceHandle = "particle";
          }
        }
      }
      input.source = periodicSource;
      input.sourceHandle = periodicHandle;
      input.target = coordinationId;
      input.targetHandle = "particle";
    }

    outEdges.push({
      id: `e-${coordinationId}-${polyhedron.id}-migration`,
      source: coordinationId,
      target: polyhedron.id,
      sourceHandle: "coordination",
      targetHandle: "coordination",
    });
    for (const output of outEdges) {
      if (output.source === polyhedron.id && (output.sourceHandle ?? "") === "bond") {
        output.source = coordinationId;
        output.sourceHandle = "bond";
      }
    }
  }

  return { nodes: outNodes, edges: outEdges };
}

/**
 * Ensure the deserialized graph has the canonical
 * `LoadStructure → AddBond → Viewport` shape.
 *
 * For every (loader, viewport) pair where loader.particle reaches viewport
 * (directly or via filter/modify chains), this helper guarantees:
 *   - an AddBond node is wired in (loader.particle → addbond.particle,
 *     addbond.bond → viewport.bond);
 *   - the viewport receives loader.cell on the cell port;
 *   - the viewport receives loader.trajectory on the trajectory port iff
 *     the loader was saved with `hasTrajectory: true`.
 *
 * Existing edges and nodes are never removed; we only add what is missing.
 */
function normalizePipeline(
  nodes: Node<PipelineNodeData>[],
  edges: Edge[],
): { nodes: Node<PipelineNodeData>[]; edges: Edge[] } {
  const loaders = nodes.filter((n) => n.type === "load_structure");
  const viewports = nodes.filter((n) => n.type === "viewport");
  if (loaders.length === 0 || viewports.length === 0) {
    return { nodes, edges };
  }

  const outNodes = [...nodes];
  const outEdges = [...edges];
  const usedIds = new Set(outNodes.map((n) => n.id));

  function uniqueId(prefix: string): string {
    let i = 1;
    while (usedIds.has(`${prefix}-${i}`)) i++;
    const id = `${prefix}-${i}`;
    usedIds.add(id);
    return id;
  }

  function hasEdge(
    source: string,
    sourceHandle: string,
    target: string,
    targetHandle: string,
  ): boolean {
    return outEdges.some(
      (e) =>
        e.source === source &&
        (e.sourceHandle ?? "") === sourceHandle &&
        e.target === target &&
        (e.targetHandle ?? "") === targetHandle,
    );
  }

  function pushEdge(
    source: string,
    sourceHandle: string,
    target: string,
    targetHandle: string,
  ): void {
    if (hasEdge(source, sourceHandle, target, targetHandle)) return;
    outEdges.push({
      id: `e-${source}-${sourceHandle}-${target}-${targetHandle}-norm`,
      source,
      target,
      sourceHandle,
      targetHandle,
    });
  }

  function isDownstreamOf(startId: string, targetId: string): boolean {
    const visited = new Set<string>([startId]);
    const stack = [startId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === targetId) return true;
      for (const edge of outEdges) {
        if (edge.source !== id || visited.has(edge.target)) continue;
        visited.add(edge.target);
        stack.push(edge.target);
      }
    }
    return false;
  }

  for (const loader of loaders) {
    // Match this loader to the first viewport its particle ultimately
    // feeds. We follow filter/modify chains so user-customised graphs
    // aren't double-wired.
    const reach = findReachableViewport(outNodes, outEdges, loader.id, viewports);
    if (!reach) continue;
    const { viewport, particleConnected } = reach;

    // A legacy Polyhedra node can provide its own center-neighbor bond
    // stream. Preserve that explicit connection instead of injecting a second,
    // generic distance-based AddBond node beside it.
    const hasDerivedBondInput = outEdges.some(
      (edge) =>
        edge.target === viewport.id &&
        (edge.targetHandle ?? "") === "bond" &&
        isDownstreamOf(loader.id, edge.source),
    );

    // Existing AddBond node consuming this loader's particles?
    let addBondId: string | null = null;
    for (const e of outEdges) {
      if (e.source !== loader.id) continue;
      if ((e.sourceHandle ?? "") !== "particle") continue;
      const target = outNodes.find((n) => n.id === e.target);
      if (target?.type === "add_bond") {
        addBondId = target.id;
        break;
      }
    }

    if (!addBondId && !hasDerivedBondInput) {
      addBondId = uniqueId("addbond");
      const params = defaultParams("add_bond");
      outNodes.push({
        id: addBondId,
        type: "add_bond",
        position: {
          x: loader.position.x,
          y: loader.position.y + 255,
        },
        data: { params, enabled: true },
      });
      pushEdge(loader.id, "particle", addBondId, "particle");
    }

    // Mirror of the particle guard below: only wire AddBond straight to the
    // viewport when nothing downstream of the loader already feeds
    // viewport.bond. Without the guard, a graph that routes bonds through
    // `add_bond -> filter -> modify -> viewport.bond` — the only way to fade or
    // hide a species' bonds — also gets the raw, unfiltered bond stream, and
    // the selection is drawn at full opacity underneath the faded copy.
    if (addBondId && !hasDerivedBondInput) {
      pushEdge(addBondId, "bond", viewport.id, "bond");
    }
    // Only add the direct loader.particle → viewport.particle edge when the
    // loader doesn't already reach the viewport via a particle path
    // (filter / modify chain). Otherwise we'd double-render the unfiltered
    // particle stream alongside the user's filtered subset.
    if (!particleConnected) {
      pushEdge(loader.id, "particle", viewport.id, "particle");
    }
    pushEdge(loader.id, "cell", viewport.id, "cell");

    const loaderParams = loader.data.params as { hasTrajectory?: boolean };
    if (loaderParams.hasTrajectory) {
      pushEdge(loader.id, "trajectory", viewport.id, "trajectory");
    }
  }

  return { nodes: outNodes, edges: outEdges };
}

/**
 * Walk the particle graph forward from `loaderId` (transparently traversing
 * filter/modify nodes) and return the first viewport reachable via a
 * particle edge, plus a flag indicating whether such a path actually
 * exists. When no path exists we fall back to the first viewport so the
 * bond/cell/trajectory ports can still be wired up.
 */
function findReachableViewport(
  nodes: Node<PipelineNodeData>[],
  edges: Edge[],
  loaderId: string,
  viewports: Node<PipelineNodeData>[],
): { viewport: Node<PipelineNodeData>; particleConnected: boolean } | null {
  const viewportIds = new Set(viewports.map((v) => v.id));
  const visited = new Set<string>([loaderId]);
  const stack: string[] = [loaderId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const e of edges) {
      if (e.source !== id) continue;
      // Only follow particle-bearing edges (particle / filter "out" / modify "out").
      const sh = e.sourceHandle ?? "";
      if (sh !== "particle" && sh !== "out") continue;
      if (viewportIds.has(e.target)) {
        // Only count as "particle-connected" if the destination port on
        // the viewport is actually `particle` — a stray edge into another
        // viewport input doesn't satisfy the canonical wiring.
        const th = e.targetHandle ?? "";
        const viewport = viewports.find((v) => v.id === e.target) ?? null;
        if (!viewport) continue;
        if (th === "particle") {
          return { viewport, particleConnected: true };
        }
        continue;
      }
      const tgt = nodes.find((n) => n.id === e.target);
      if (!tgt) continue;
      if (
        tgt.type !== "filter" &&
        tgt.type !== "modify" &&
        tgt.type !== "color" &&
        tgt.type !== "representation" &&
        tgt.type !== "drawing_boundary" &&
        tgt.type !== "boundary_completion"
      )
        continue;
      if (!visited.has(tgt.id)) {
        visited.add(tgt.id);
        stack.push(tgt.id);
      }
    }
  }
  return viewports[0] ? { viewport: viewports[0], particleConnected: false } : null;
}
