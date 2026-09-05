/**
 * Benchmark dataset for the megane LLM (pipeline generator).
 *
 * Each case is a realistic natural-language request paired with a programmatic
 * rubric. The rubric only references node types and parameters that the system
 * prompt (`buildSystemPrompt`) actually documents, so a perfect model can score
 * 1.0. Cases are tagged by category so the report can break results down by the
 * kind of request (molecule, crystal, filtering, …).
 *
 * To extend the benchmark, add a case here — the scorer and runner are generic.
 */

import type { BenchCase } from "./types";

/** Read a string parameter off a serialized node without widening to `any`. */
function str(node: unknown, key: string): string {
  const v = (node as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
}

function num(node: unknown, key: string): number {
  const v = (node as Record<string, unknown>)[key];
  return typeof v === "number" ? v : NaN;
}

function arr(node: unknown, key: string): unknown[] {
  const v = (node as Record<string, unknown>)[key];
  return Array.isArray(v) ? v : [];
}

export const DATASET: BenchCase[] = [
  // ── Basic molecule ───────────────────────────────────────────────────
  {
    id: "molecule-basic",
    prompt: "Show a molecule with its chemical bonds.",
    tags: ["molecule", "basic"],
    rubric: {
      requiredNodeTypes: ["load_structure", "add_bond", "viewport"],
      requiredConnections: [
        { sourceType: "load_structure", targetType: "viewport", sourceHandle: "particle" },
        { sourceType: "add_bond", targetType: "viewport", sourceHandle: "bond", targetHandle: "bond" },
      ],
      minNodes: 3,
    },
  },
  {
    id: "molecule-no-bonds",
    prompt: "Just display the atoms of my structure, no bonds at all.",
    tags: ["molecule", "basic"],
    rubric: {
      requiredNodeTypes: ["load_structure", "viewport"],
      forbiddenNodeTypes: ["add_bond"],
      requiredConnections: [
        { sourceType: "load_structure", targetType: "viewport", sourceHandle: "particle" },
      ],
      maxNodes: 3,
    },
  },
  {
    id: "molecule-trajectory",
    prompt: "Load a protein and play its MD trajectory with bonds.",
    tags: ["molecule", "trajectory"],
    rubric: {
      requiredNodeTypes: ["load_structure", "add_bond", "viewport"],
      requiredConnections: [
        { sourceType: "add_bond", targetType: "viewport", sourceHandle: "bond", targetHandle: "bond" },
        { sourceType: "load_trajectory", targetType: "viewport", targetHandle: "trajectory" },
      ],
    },
  },

  // ── Crystalline solids / polyhedra ───────────────────────────────────
  {
    id: "crystal-polyhedra",
    prompt: "Visualize a perovskite crystal with coordination polyhedra around the metal atoms.",
    tags: ["solid", "polyhedra"],
    rubric: {
      requiredNodeTypes: ["load_structure", "polyhedron_generator", "viewport"],
      requiredConnections: [
        {
          sourceType: "polyhedron_generator",
          targetType: "viewport",
          sourceHandle: "mesh",
          targetHandle: "mesh",
        },
        { sourceType: "load_structure", targetType: "viewport", sourceHandle: "cell", targetHandle: "cell" },
      ],
    },
  },
  {
    id: "crystal-distance-bonds",
    prompt:
      "I have a crystal XYZ file without bond records. Show it with distance-based bonds and the unit cell.",
    tags: ["solid", "bonds"],
    rubric: {
      requiredNodeTypes: ["load_structure", "add_bond", "viewport"],
      requiredConnections: [
        { sourceType: "load_structure", targetType: "viewport", sourceHandle: "cell", targetHandle: "cell" },
      ],
      paramChecks: [
        {
          label: 'add_bond.bondSource === "distance"',
          nodeType: "add_bond",
          test: (n) => str(n, "bondSource") === "distance",
        },
      ],
    },
  },
  {
    id: "crystal-polyhedra-exclude",
    prompt:
      "Show coordination polyhedra for an oxide but skip titanium (Z=22) as a center, keep only the others.",
    tags: ["solid", "polyhedra", "params"],
    rubric: {
      requiredNodeTypes: ["load_structure", "polyhedron_generator", "viewport"],
      paramChecks: [
        {
          label: "polyhedron excludedCenters contains 22 (Ti)",
          nodeType: "polyhedron_generator",
          test: (n) => arr(n, "excludedCenters").includes(22),
        },
      ],
    },
  },

  // ── Filtering ────────────────────────────────────────────────────────
  {
    id: "filter-carbon",
    prompt: "Display only the carbon atoms of my structure.",
    tags: ["filter", "params"],
    rubric: {
      requiredNodeTypes: ["load_structure", "filter", "viewport"],
      paramChecks: [
        {
          label: 'filter.query selects carbon (element == "C")',
          nodeType: "filter",
          test: (n) => /element\s*==\s*["']?C["']?/i.test(str(n, "query")),
        },
      ],
    },
  },
  {
    id: "filter-residue",
    prompt: "Show only the alanine residues (resname ALA).",
    tags: ["filter", "params"],
    rubric: {
      requiredNodeTypes: ["load_structure", "filter", "viewport"],
      paramChecks: [
        {
          label: "filter.query selects resname ALA",
          nodeType: "filter",
          test: (n) => /resname\s*==\s*["']?ALA["']?/i.test(str(n, "query")),
        },
      ],
    },
  },
  {
    id: "filter-oxygen-nitrogen",
    prompt: "Highlight just the oxygen and nitrogen atoms.",
    tags: ["filter", "params"],
    rubric: {
      requiredNodeTypes: ["load_structure", "filter", "viewport"],
      paramChecks: [
        {
          label: "filter.query references both O and N",
          nodeType: "filter",
          test: (n) => {
            const q = str(n, "query");
            return /["']?O["']?/.test(q) && /["']?N["']?/.test(q) && /\bor\b/i.test(q);
          },
        },
      ],
    },
  },

  // ── Modify / appearance ──────────────────────────────────────────────
  {
    id: "modify-scale",
    prompt: "Show the molecule with the atoms drawn at half their normal size.",
    tags: ["modify", "params"],
    rubric: {
      requiredNodeTypes: ["load_structure", "modify", "viewport"],
      paramChecks: [
        {
          label: "modify.scale is around 0.5",
          nodeType: "modify",
          test: (n) => Math.abs(num(n, "scale") - 0.5) < 0.2,
        },
      ],
    },
  },
  {
    id: "modify-transparent",
    prompt: "Make the structure semi-transparent so I can see through it.",
    tags: ["modify", "params"],
    rubric: {
      requiredNodeTypes: ["load_structure", "modify", "viewport"],
      paramChecks: [
        {
          label: "modify.opacity is below 1 (transparent)",
          nodeType: "modify",
          test: (n) => num(n, "opacity") < 1 && num(n, "opacity") > 0,
        },
      ],
    },
  },

  // ── Overlays: labels / vectors ───────────────────────────────────────
  {
    id: "labels-element",
    prompt: "Display the structure and label every atom with its element symbol.",
    tags: ["overlay", "labels"],
    rubric: {
      requiredNodeTypes: ["load_structure", "label_generator", "viewport"],
      requiredConnections: [
        {
          sourceType: "label_generator",
          targetType: "viewport",
          sourceHandle: "label",
          targetHandle: "label",
        },
      ],
      paramChecks: [
        {
          label: 'label_generator.source === "element"',
          nodeType: "label_generator",
          test: (n) => str(n, "source") === "element",
        },
      ],
    },
  },
  {
    id: "vectors-forces",
    prompt: "Load forces from a file and draw them as arrows on each atom.",
    tags: ["overlay", "vectors"],
    rubric: {
      requiredNodeTypes: ["load_structure", "load_vector", "vector_overlay", "viewport"],
      requiredConnections: [
        {
          sourceType: "vector_overlay",
          targetType: "viewport",
          sourceHandle: "vector",
          targetHandle: "vector",
        },
      ],
    },
  },

  // ── Multi-step compositions ──────────────────────────────────────────
  {
    id: "multistep-filter-bonds",
    prompt:
      "Show my structure with bonds, but only the carbon atoms, and label them with their element.",
    tags: ["multistep", "filter", "labels"],
    rubric: {
      requiredNodeTypes: ["load_structure", "add_bond", "filter", "label_generator", "viewport"],
      paramChecks: [
        {
          label: "filter.query selects carbon",
          nodeType: "filter",
          test: (n) => /["']?C["']?/.test(str(n, "query")),
        },
      ],
      minNodes: 5,
    },
  },
  {
    id: "multistep-water-transparent",
    prompt:
      "I have a caffeine molecule dissolved in water, where the water residues are named HOH. Keep the caffeine fully visible, but make the water molecules semi-transparent.",
    tags: ["multistep", "filter", "modify", "params"],
    rubric: {
      requiredNodeTypes: ["load_structure", "filter", "modify", "viewport"],
      requiredConnections: [
        { sourceType: "filter", targetType: "modify", sourceHandle: "out", targetHandle: "in" },
        {
          sourceType: "modify",
          targetType: "viewport",
          sourceHandle: "out",
          targetHandle: "particle",
        },
      ],
      paramChecks: [
        {
          label: 'filter.query selects water (resname == "HOH")',
          nodeType: "filter",
          test: (n) => /resname\s*==\s*["']?HOH["']?/i.test(str(n, "query")),
        },
        {
          label: "modify.opacity is below 1 (transparent)",
          nodeType: "modify",
          test: (n) => num(n, "opacity") < 1 && num(n, "opacity") > 0,
        },
      ],
      minNodes: 4,
    },
  },
  {
    id: "representation-water-line",
    prompt:
      "I have a caffeine molecule dissolved in water, where the water residues are named HOH. Render the water molecules as a line representation, but leave the caffeine in its normal style.",
    tags: ["multistep", "filter", "representation", "params"],
    rubric: {
      requiredNodeTypes: ["load_structure", "filter", "representation", "viewport"],
      requiredConnections: [
        { sourceType: "filter", targetType: "representation", sourceHandle: "out", targetHandle: "in" },
        {
          sourceType: "representation",
          targetType: "viewport",
          sourceHandle: "out",
          targetHandle: "particle",
        },
      ],
      paramChecks: [
        {
          label: 'a filter selects water (resname == "HOH")',
          nodeType: "filter",
          test: (n) => /resname\s*==\s*["']?HOH["']?/i.test(str(n, "query")),
        },
        {
          label: 'representation.mode === "line"',
          nodeType: "representation",
          test: (n) => str(n, "mode") === "line",
        },
      ],
      minNodes: 4,
    },
  },
  {
    id: "hide-water",
    prompt:
      "I have a caffeine molecule dissolved in water, where the water residues are named HOH. Hide the water so only the caffeine is shown.",
    tags: ["multistep", "filter", "modify", "params"],
    rubric: {
      requiredNodeTypes: ["load_structure", "filter", "modify", "viewport"],
      requiredConnections: [
        { sourceType: "filter", targetType: "modify", sourceHandle: "out", targetHandle: "in" },
        {
          sourceType: "modify",
          targetType: "viewport",
          sourceHandle: "out",
          targetHandle: "particle",
        },
      ],
      paramChecks: [
        {
          label: 'filter selects water (resname == "HOH")',
          nodeType: "filter",
          test: (n) => /resname\s*==\s*["']?HOH["']?/i.test(str(n, "query")),
        },
        {
          label: "modify.opacity is 0 (water hidden)",
          nodeType: "modify",
          test: (n) => num(n, "opacity") === 0,
        },
      ],
      minNodes: 4,
    },
  },

  // ── Multilingual robustness (Japanese) ───────────────────────────────
  {
    id: "molecule-basic-ja",
    prompt: "分子を結合付きで表示してください。",
    tags: ["molecule", "multilingual"],
    rubric: {
      requiredNodeTypes: ["load_structure", "add_bond", "viewport"],
      requiredConnections: [
        { sourceType: "add_bond", targetType: "viewport", sourceHandle: "bond", targetHandle: "bond" },
      ],
    },
  },
  {
    id: "filter-carbon-ja",
    prompt: "炭素原子だけを表示して。",
    tags: ["filter", "multilingual", "params"],
    rubric: {
      requiredNodeTypes: ["load_structure", "filter", "viewport"],
      paramChecks: [
        {
          label: "filter.query selects carbon",
          nodeType: "filter",
          test: (n) => /element\s*==\s*["']?C["']?/i.test(str(n, "query")),
        },
      ],
    },
  },

  // ── Supercells, coloring, representation, surfaces, volumetric ───────
  {
    id: "solid-supercell",
    prompt: "Show a 2x2x2 supercell of my crystal structure.",
    tags: ["solid", "replicate", "params"],
    rubric: {
      requiredNodeTypes: ["load_structure", "replicate", "viewport"],
      paramChecks: [
        {
          label: "replicate.nx/ny/nz === 2",
          nodeType: "replicate",
          test: (n) => num(n, "nx") === 2 && num(n, "ny") === 2 && num(n, "nz") === 2,
        },
      ],
    },
  },
  {
    id: "color-by-element",
    prompt: "Color the atoms by their element.",
    tags: ["color", "params"],
    rubric: {
      requiredNodeTypes: ["load_structure", "color", "viewport"],
      paramChecks: [
        {
          label: 'color.mode === "byElement"',
          nodeType: "color",
          test: (n) => str(n, "mode") === "byElement",
        },
      ],
    },
  },
  {
    id: "representation-cartoon",
    prompt: "Show my protein as a cartoon.",
    tags: ["representation", "params"],
    rubric: {
      requiredNodeTypes: ["load_structure", "representation", "viewport"],
      paramChecks: [
        {
          label: 'representation.mode === "cartoon" or "both"',
          nodeType: "representation",
          test: (n) => ["cartoon", "both"].includes(str(n, "mode")),
        },
      ],
    },
  },
  {
    id: "surface-molecular",
    prompt: "Show the molecular surface of my structure.",
    tags: ["surface_mesh"],
    rubric: {
      requiredNodeTypes: ["load_structure", "surface_mesh", "viewport"],
      requiredConnections: [
        {
          sourceType: "surface_mesh",
          targetType: "viewport",
          sourceHandle: "mesh",
          targetHandle: "mesh",
        },
      ],
    },
  },
  {
    id: "volumetric-isosurface",
    prompt: "Load a cube file and render its isosurface.",
    tags: ["volumetric", "isosurface"],
    rubric: {
      requiredNodeTypes: ["load_volumetric", "isosurface", "viewport"],
      requiredConnections: [
        {
          sourceType: "load_volumetric",
          targetType: "isosurface",
          sourceHandle: "volumetric",
          targetHandle: "volumetric",
        },
        {
          sourceType: "isosurface",
          targetType: "viewport",
          sourceHandle: "mesh",
          targetHandle: "mesh",
        },
      ],
    },
  },
];
