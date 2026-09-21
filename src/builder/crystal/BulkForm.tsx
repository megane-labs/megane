/**
 * The "new bulk crystal" form: a prototype structure, its species and
 * lattice constants, or one of the reference examples. Creating one starts a
 * new document (`BuilderStore.newBulk`), like an empty cell does.
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
import { NumberField } from "./NumberField";

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
  const [a, setA] = useState(3.61);
  const [covera, setCovera] = useState(Math.sqrt(8 / 3));
  const [cubic, setCubic] = useState(true);
  const info = bulkStructureInfo(structure);

  const loadExample = (name: string) => {
    const ex = BULK_EXAMPLES.find((e) => e.name === name);
    if (!ex) return;
    const exInfo = bulkStructureInfo(ex.spec.structure);
    setStructure(ex.spec.structure);
    setSymbols(
      [0, 1, 2].map((k) => (k < exInfo.species ? getElementSymbol(ex.spec.elements[k]) : "")),
    );
    setA(ex.spec.a);
    if (ex.spec.covera !== undefined) setCovera(ex.spec.covera);
    setCubic(ex.spec.cubic ?? false);
  };

  const create = () => {
    const elements: number[] = [];
    for (let k = 0; k < info.species; k++) {
      const z = elementFromSymbol(symbols[k]);
      if (z === null) {
        onError(`Species ${"ABX"[k]}: "${symbols[k]}" is not an element symbol.`);
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
          onChange={(e) => setStructure(e.target.value as BulkStructure)}
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
        {Array.from({ length: info.species }, (_, k) => (
          <label key={k} style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <span style={hintStyle}>{"ABX"[k]}</span>
            <input
              data-testid={`builder-bulk-element-${k}`}
              value={symbols[k]}
              onChange={(e) => setSymbols(symbols.map((s, i) => (i === k ? e.target.value : s)))}
              style={{ ...inputStyle, width: 40 }}
              placeholder="El"
            />
          </label>
        ))}
        <NumberField
          label="a"
          value={a}
          onChange={setA}
          testId="builder-bulk-a"
          step={0.01}
          min={0.1}
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
