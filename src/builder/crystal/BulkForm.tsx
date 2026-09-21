/**
 * The "new bulk crystal" form: a prototype structure, its species and
 * lattice constants, or one of the reference examples. Creating one starts a
 * new document (`BuilderStore.newBulk`), like an empty cell does.
 */

import { useState } from "react";
import { Button, Checkbox, Group, NativeSelect, Stack, Text, TextInput } from "@mantine/core";
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
    <Stack gap="xs" data-testid="builder-bulk">
      <Group gap="xs">
        <NativeSelect
          data-testid="builder-bulk-example"
          value=""
          onChange={(e) => loadExample(e.currentTarget.value)}
          title="Fill the fields from a reference structure"
          data={[
            { value: "", label: "Examples…" },
            ...BULK_EXAMPLES.map((ex) => ({ value: ex.name, label: ex.name })),
          ]}
        />
        <NativeSelect
          data-testid="builder-bulk-structure"
          value={structure}
          onChange={(e) => setStructure(e.currentTarget.value as BulkStructure)}
          data={BULK_STRUCTURES.map((s) => ({ value: s.value, label: s.label }))}
        />
      </Group>
      <Group gap="xs">
        {Array.from({ length: info.species }, (_, k) => (
          <Group key={k} gap={4} wrap="nowrap">
            <Text size="xs" c="dimmed">
              {"ABX"[k]}
            </Text>
            <TextInput
              data-testid={`builder-bulk-element-${k}`}
              value={symbols[k]}
              onChange={(e) =>
                setSymbols(symbols.map((s, i) => (i === k ? e.currentTarget.value : s)))
              }
              w={48}
              placeholder="El"
            />
          </Group>
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
          <Checkbox
            data-testid="builder-bulk-cubic"
            checked={cubic}
            onChange={(e) => setCubic(e.currentTarget.checked)}
            label="conventional cell"
          />
        )}
      </Group>
      <Group>
        <Button
          data-testid="builder-bulk-create"
          onClick={create}
          title="Start from this bulk crystal (replaces the open structure)"
        >
          {createLabel}
        </Button>
      </Group>
    </Stack>
  );
}
