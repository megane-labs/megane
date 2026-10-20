/**
 * The "new bulk crystal" form: a prototype structure, its species and
 * lattice constants, or one of the reference examples. Creating one starts a
 * new document (`BuilderStore.newBulk`), like an empty cell does.
 *
 * Choosing a prototype suggests its lattice constant (that of its reference
 * example) unless the user typed one for that prototype, which is kept; the
 * species slots are named by their role in the prototype, and a symbol that
 * is not an element is flagged as it is typed.
 */

import { useState } from "react";
import { buttonStyle, hintStyle, inputStyle, rowStyle } from "../styles";
import {
  BULK_EXAMPLES,
  BULK_STRUCTURES,
  bulkStructureInfo,
  elementFromSymbol,
  type BulkSpec,
  type BulkStructure,
} from "../../crystal/bulk";
import { getElementSymbol } from "../../constants";
import { NumberField, numberProblem } from "./NumberField";

/** Lattice constant suggested for a prototype with no reference example (Po, simple cubic), Å. */
const FALLBACK_A: Partial<Record<BulkStructure, number>> = { sc: 3.35 };

/** The lattice constant a prototype starts with: its first reference example's, Å. */
export function suggestedLatticeConstant(structure: BulkStructure): number {
  const ex = BULK_EXAMPLES.find((e) => e.spec.structure === structure);
  return ex?.spec.a ?? FALLBACK_A[structure] ?? 4;
}

/** The role of each species slot of a prototype, for its label ("A (cation)"). */
export function siteRoles(structure: BulkStructure): string[] {
  switch (structure) {
    case "zincblende":
    case "rocksalt":
    case "cesiumchloride":
    case "wurtzite":
      return ["cation", "anion"];
    case "fluorite":
      return ["cation", "anion ×2"];
    case "perovskite":
      return ["A-site cation", "B-site cation", "anion ×3"];
    default:
      return ["element"];
  }
}

/** Why `symbol` cannot fill slot `k`, or null when it is an element (or still blank). */
export function speciesProblem(k: number, symbol: string): string | null {
  if (!symbol.trim() || elementFromSymbol(symbol) !== null) return null;
  return `Species ${"ABX"[k]}: "${symbol}" is not an element symbol.`;
}

export interface BulkFormProps {
  /** Start a document from `spec`; may throw on a spec the generator refuses. */
  onCreate: (spec: BulkSpec) => void;
  onError: (msg: string) => void;
  /** Label of the commit button. */
  createLabel?: string;
}

export function BulkForm({
  onCreate,
  onError,
  createLabel = "Create bulk crystal",
}: BulkFormProps) {
  const [structure, setStructure] = useState<BulkStructure>("fcc");
  const [symbols, setSymbols] = useState(["Cu", "", ""]);
  const [a, setA] = useState(suggestedLatticeConstant("fcc"));
  /** The lattice constant the user typed per prototype: kept when they switch back. */
  const [typedA, setTypedA] = useState<Partial<Record<BulkStructure, number>>>({});
  const [covera, setCovera] = useState(Math.sqrt(8 / 3));
  const [cubic, setCubic] = useState(true);
  const info = bulkStructureInfo(structure);
  const roles = siteRoles(structure);
  const symbolProblems = symbols
    .slice(0, info.species)
    .map((sym, k) => speciesProblem(k, sym))
    .filter((p): p is string => p !== null);
  const aProblem = numberProblem("a", a, { min: 0, exclusiveMin: true, unit: "Å" });

  const chooseStructure = (next: BulkStructure) => {
    setStructure(next);
    const typed = typedA[next];
    setA(typed !== undefined && Number.isFinite(typed) ? typed : suggestedLatticeConstant(next));
  };

  const loadExample = (name: string) => {
    const ex = BULK_EXAMPLES.find((e) => e.name === name);
    if (!ex) return;
    const exInfo = bulkStructureInfo(ex.spec.structure);
    setStructure(ex.spec.structure);
    setSymbols(
      [0, 1, 2].map((k) => (k < exInfo.species ? getElementSymbol(ex.spec.elements[k]) : "")),
    );
    setA(ex.spec.a);
    // An example's constant is a suggestion, not the user's own.
    setTypedA((t) => ({ ...t, [ex.spec.structure]: undefined }));
    if (ex.spec.covera !== undefined) setCovera(ex.spec.covera);
    setCubic(ex.spec.cubic ?? false);
  };

  const create = () => {
    const elements: number[] = [];
    for (let k = 0; k < info.species; k++) {
      const z = elementFromSymbol(symbols[k]);
      if (z === null) {
        onError(
          symbols[k].trim()
            ? `Species ${"ABX"[k]}: "${symbols[k]}" is not an element symbol.`
            : `Enter an element for species ${"ABX"[k]} (the ${roles[k]}).`,
        );
        return;
      }
      elements.push(z);
    }
    const spec: BulkSpec = { structure, elements, a };
    if (info.hexagonal) spec.covera = covera;
    if (info.cubic) spec.cubic = cubic;
    try {
      onCreate(spec);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="builder-bulk">
      <div style={rowStyle}>
        <select
          data-testid="builder-bulk-example"
          value=""
          onChange={(e) => loadExample(e.target.value)}
          style={inputStyle}
          title="Fill the fields from a reference structure"
        >
          <option value="">Examples…</option>
          {BULK_EXAMPLES.map((ex) => (
            <option key={ex.name} value={ex.name}>
              {ex.name}
            </option>
          ))}
        </select>
        <select
          data-testid="builder-bulk-structure"
          value={structure}
          onChange={(e) => chooseStructure(e.target.value as BulkStructure)}
          style={inputStyle}
        >
          {BULK_STRUCTURES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <div style={rowStyle}>
        {Array.from({ length: info.species }, (_, k) => {
          const bad = speciesProblem(k, symbols[k]) !== null;
          return (
            <label
              key={k}
              style={{ display: "flex", alignItems: "center", gap: 3 }}
              title={`Species ${"ABX"[k]}: the ${roles[k]}`}
            >
              <span style={hintStyle} data-testid={`builder-bulk-role-${k}`}>
                {info.species === 1 ? "Element" : `${"ABX"[k]} (${roles[k]})`}
              </span>
              <input
                data-testid={`builder-bulk-element-${k}`}
                aria-invalid={bad || undefined}
                value={symbols[k]}
                onChange={(e) => setSymbols(symbols.map((s, i) => (i === k ? e.target.value : s)))}
                style={{
                  ...inputStyle,
                  width: 40,
                  ...(bad ? { borderColor: "var(--megane-danger-text, #b91c1c)" } : {}),
                }}
                placeholder="El"
              />
            </label>
          );
        })}
        <NumberField
          label="a"
          value={a}
          onChange={(v) => {
            setA(v);
            setTypedA((t) => ({ ...t, [structure]: v }));
          }}
          testId="builder-bulk-a"
          step={0.01}
          min={0.1}
          unit="Å"
          title="Lattice constant, Å"
        />
        {info.hexagonal && (
          <NumberField
            label="c/a"
            value={covera}
            onChange={setCovera}
            testId="builder-bulk-covera"
            step={0.001}
            min={0.1}
            width={66}
          />
        )}
        {info.cubic && (
          <label style={{ ...hintStyle, display: "flex", alignItems: "center", gap: 4 }}>
            <input
              type="checkbox"
              data-testid="builder-bulk-cubic"
              checked={cubic}
              onChange={(e) => setCubic(e.target.checked)}
            />
            conventional cell
          </label>
        )}
      </div>
      {(symbolProblems[0] ?? aProblem) && (
        <span
          role="status"
          data-testid="builder-bulk-problem"
          style={{ ...hintStyle, color: "var(--megane-warning-text, #b45309)" }}
        >
          {symbolProblems[0] ?? aProblem}
        </span>
      )}
      <div style={rowStyle}>
        <button
          type="button"
          data-testid="builder-bulk-create"
          style={buttonStyle("primary")}
          onClick={create}
          title="Start from this bulk crystal (replaces the open structure)"
        >
          {createLabel}
        </button>
      </div>
    </div>
  );
}
