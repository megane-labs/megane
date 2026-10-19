/**
 * Settings of Flow mode's built-in blocks (`builtins.ts`), in the viewer's
 * node-form rows: a bulk crystal (with Manual mode's reference examples), a
 * polymer's repeat unit (with common polymers ready to pick), a supercell's
 * repeats, a slab's Miller indices, and how molecules sit on a surface.
 */

import type { ReactNode } from "react";
import { Field, FormStack } from "../../components/nodes/form";
import {
  checkboxStyle,
  codeInputStyle,
  hintStyle,
  inputStyle,
  selectStyle,
} from "../../components/nodes/formStyles";
import { getElementSymbol } from "../../constants";
import {
  BULK_EXAMPLES,
  BULK_STRUCTURES,
  bulkStructureInfo,
  type BulkStructure,
} from "../../crystal/bulk";
import { useScopedFlowStore } from "../BuilderStores";
import { chainSmiles, POLYMER_PRESETS } from "./polymer";
import type {
  AdsorbParams,
  CrystalParams,
  FlowParams,
  PolymerParams,
  SlabParams,
  SupercellParams,
} from "./types";

const numberStyle: React.CSSProperties = { ...inputStyle, minWidth: 0 };

function NumberInput({
  value,
  onChange,
  testId,
  step = 1,
  min,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  testId: string;
  step?: number;
  min?: number;
  label?: string;
}) {
  return (
    <input
      type="number"
      aria-label={label}
      data-testid={testId}
      style={numberStyle}
      value={Number.isFinite(value) ? value : ""}
      step={step}
      min={min}
      onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))}
    />
  );
}

/** Several numbers on one row (a b c repeats, h k l). */
function NumberRow<T extends number[]>({
  values,
  onChange,
  testId,
  labels,
  min,
}: {
  values: T;
  onChange: (v: T) => void;
  testId: string;
  labels: string[];
  min?: number;
}) {
  return (
    <span style={{ display: "flex", gap: 4 }}>
      {values.map((v, k) => (
        <NumberInput
          key={k}
          value={v}
          min={min}
          label={labels[k]}
          testId={`${testId}-${k}`}
          onChange={(next) => onChange(values.map((x, i) => (i === k ? next : x)) as T)}
        />
      ))}
    </span>
  );
}

function Hint({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <span style={hintStyle} data-testid={testId}>
      {children}
    </span>
  );
}

function useUpdate<P extends FlowParams>(id: string) {
  const updateParams = useScopedFlowStore((s) => s.updateParams);
  return (patch: Partial<P>) => updateParams(id, patch as Partial<FlowParams>);
}

export function CrystalForm({ id, params }: { id: string; params: CrystalParams }) {
  const update = useUpdate<CrystalParams>(id);
  const info = bulkStructureInfo(params.structure);
  const loadExample = (name: string) => {
    const ex = BULK_EXAMPLES.find((e) => e.name === name);
    if (!ex) return;
    const exInfo = bulkStructureInfo(ex.spec.structure);
    update({
      structure: ex.spec.structure,
      elements: [0, 1, 2].map((k) =>
        k < exInfo.species ? getElementSymbol(ex.spec.elements[k]) : "",
      ),
      a: ex.spec.a,
      covera: ex.spec.covera ?? params.covera,
      cubic: ex.spec.cubic ?? false,
    });
  };
  return (
    <FormStack>
      <Field label="Example">
        <select
          data-testid="builder-flow-crystal-example"
          style={selectStyle}
          value=""
          onChange={(e) => loadExample(e.target.value)}
        >
          <option value="">Pick a crystal…</option>
          {BULK_EXAMPLES.map((ex) => (
            <option key={ex.name} value={ex.name}>
              {ex.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Structure">
        <select
          data-testid="builder-flow-crystal-structure"
          style={selectStyle}
          value={params.structure}
          onChange={(e) => update({ structure: e.target.value as BulkStructure })}
        >
          {BULK_STRUCTURES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label={info.species === 1 ? "Element" : "Species"}>
        <span style={{ display: "flex", gap: 4 }}>
          {Array.from({ length: info.species }, (_, k) => (
            <input
              key={k}
              aria-label={`Species ${"ABX"[k]}`}
              data-testid={`builder-flow-crystal-element-${k}`}
              style={numberStyle}
              value={params.elements[k] ?? ""}
              placeholder={"ABX"[k]}
              onChange={(e) =>
                update({
                  elements: [0, 1, 2].map((i) =>
                    i === k ? e.target.value : (params.elements[i] ?? ""),
                  ),
                })
              }
            />
          ))}
        </span>
      </Field>
      <Field label="a (Å)">
        <NumberInput
          testId="builder-flow-crystal-a"
          value={params.a}
          step={0.01}
          min={0.1}
          onChange={(a) => update({ a })}
        />
      </Field>
      {info.hexagonal && (
        <Field label="c/a">
          <NumberInput
            testId="builder-flow-crystal-covera"
            value={params.covera}
            step={0.001}
            min={0.1}
            onChange={(covera) => update({ covera })}
          />
        </Field>
      )}
      {info.cubic && (
        <Field label="Cubic cell">
          <input
            type="checkbox"
            data-testid="builder-flow-crystal-cubic"
            style={checkboxStyle}
            checked={params.cubic}
            onChange={(e) => update({ cubic: e.target.checked })}
          />
        </Field>
      )}
      <Hint>
        Built in the browser, as Manual mode&apos;s bulk crystal is. Wire it into a Slab or a
        Supercell.
      </Hint>
    </FormStack>
  );
}

/** What a polymer block's repeat unit gives, or why it cannot be chained. */
function polymerCheck(params: PolymerParams): { ok: boolean; text: string } {
  try {
    const { unit } = chainSmiles(params.repeatUnit, params.length);
    return {
      ok: true,
      text: `${unit.heavyAtoms * params.length} heavy atoms; RDKit embeds the chain (hydrogens added, MMFF94s) when the flow runs.`,
    };
  } catch (err) {
    return { ok: false, text: err instanceof Error ? err.message : String(err) };
  }
}

export function PolymerForm({ id, params }: { id: string; params: PolymerParams }) {
  const update = useUpdate<PolymerParams>(id);
  const preset = POLYMER_PRESETS.find((p) => p.repeatUnit === params.repeatUnit);
  const check = polymerCheck(params);
  return (
    <FormStack>
      <Field label="Polymer">
        <select
          data-testid="builder-flow-polymer-preset"
          style={selectStyle}
          value={preset?.id ?? ""}
          onChange={(e) => {
            const p = POLYMER_PRESETS.find((x) => x.id === e.target.value);
            if (p) update({ repeatUnit: p.repeatUnit, name: p.name });
          }}
        >
          {!preset && <option value="">Custom</option>}
          {POLYMER_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Repeat unit">
        <input
          data-testid="builder-flow-polymer-unit"
          style={codeInputStyle}
          value={params.repeatUnit}
          placeholder="*CC(C)*"
          spellCheck={false}
          onChange={(e) => update({ repeatUnit: e.target.value })}
        />
      </Field>
      <Field label="Repeat units">
        <NumberInput
          testId="builder-flow-polymer-length"
          value={params.length}
          min={1}
          onChange={(length) => update({ length })}
        />
      </Field>
      <Field label="Name">
        <input
          data-testid="builder-flow-polymer-name"
          style={inputStyle}
          value={params.name}
          placeholder="optional"
          onChange={(e) => update({ name: e.target.value })}
        />
      </Field>
      <span
        data-testid="builder-flow-polymer-check"
        data-ok={check.ok ? "true" : "false"}
        style={check.ok ? hintStyle : { ...hintStyle, color: "var(--megane-warning-text)" }}
      >
        {check.text}
      </span>
      <Hint>
        The first * is the head and the last * the tail of a unit; the chain ends are capped with
        hydrogen. The name is the residue name a liquid box gives each chain.
      </Hint>
    </FormStack>
  );
}

export function SupercellForm({ id, params }: { id: string; params: SupercellParams }) {
  const update = useUpdate<SupercellParams>(id);
  return (
    <FormStack>
      <Field label="Repeats a b c">
        <NumberRow
          testId="builder-flow-supercell-repeat"
          labels={["Repeats along a", "Repeats along b", "Repeats along c"]}
          min={1}
          values={params.repeat}
          onChange={(repeat) => update({ repeat })}
        />
      </Field>
      <Hint>Repeats the input along its cell vectors (it needs a unit cell).</Hint>
    </FormStack>
  );
}

export function SlabForm({ id, params }: { id: string; params: SlabParams }) {
  const update = useUpdate<SlabParams>(id);
  return (
    <FormStack>
      <Field label="Miller h k l">
        <NumberRow
          testId="builder-flow-slab-miller"
          labels={["h", "k", "l"]}
          values={params.miller}
          onChange={(miller) => update({ miller })}
        />
      </Field>
      <Field label="Layers">
        <NumberInput
          testId="builder-flow-slab-layers"
          value={params.layers}
          min={1}
          onChange={(layers) => update({ layers })}
        />
      </Field>
      <Field label="Vacuum (Å)">
        <NumberInput
          testId="builder-flow-slab-vacuum"
          value={params.vacuum}
          min={0}
          step={0.5}
          onChange={(vacuum) => update({ vacuum })}
        />
      </Field>
      <Field label="Repeats a b">
        <NumberRow
          testId="builder-flow-slab-repeat"
          labels={["Repeats along a", "Repeats along b"]}
          min={1}
          values={params.repeat}
          onChange={(repeat) => update({ repeat })}
        />
      </Field>
      <Hint>
        Cut as Manual mode&apos;s Cut slab… cuts it (ASE&apos;s surface): a layer is one surface
        cell of the input along the normal, and the vacuum is added on each side.
      </Hint>
    </FormStack>
  );
}

export function AdsorbForm({ id, params }: { id: string; params: AdsorbParams }) {
  const update = useUpdate<AdsorbParams>(id);
  return (
    <FormStack>
      <Field label="Height (Å)">
        <NumberInput
          testId="builder-flow-adsorb-height"
          value={params.height}
          step={0.1}
          onChange={(height) => update({ height })}
        />
      </Field>
      <Field label="Copies a b">
        <NumberRow
          testId="builder-flow-adsorb-grid"
          labels={["Copies along a", "Copies along b"]}
          min={1}
          values={params.grid}
          onChange={(grid) => update({ grid })}
        />
      </Field>
      <Hint>
        Lays copies of the molecule on an even grid over the surface cell, each one&apos;s lowest
        atom this far above the surface&apos;s top atom, as the molecule is oriented.
      </Hint>
    </FormStack>
  );
}

/** The form of a built-in block, or null for another block. */
export function BuiltinForm({ id, params }: { id: string; params: FlowParams }) {
  switch (params.type) {
    case "crystal":
      return <CrystalForm id={id} params={params} />;
    case "polymer":
      return <PolymerForm id={id} params={params} />;
    case "supercell":
      return <SupercellForm id={id} params={params} />;
    case "slab":
      return <SlabForm id={id} params={params} />;
    case "adsorb":
      return <AdsorbForm id={id} params={params} />;
    default:
      return null;
  }
}
