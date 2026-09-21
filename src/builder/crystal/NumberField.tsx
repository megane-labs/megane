/**
 * A compact labelled number input for the crystal forms: Mantine's
 * `NumberInput` with the label beside it rather than above, so a row of three
 * cell lengths still fits the 320 px sidebar.
 */

import { Group, NumberInput, Text } from "@mantine/core";

export interface NumberFieldProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  testId: string;
  step?: number;
  min?: number;
  width?: number;
  title?: string;
}

export function NumberField({
  label,
  value,
  onChange,
  testId,
  step = 1,
  min,
  width = 58,
  title,
}: NumberFieldProps) {
  return (
    <Group gap={4} wrap="nowrap" title={title}>
      {label && (
        <Text size="xs" c="dimmed">
          {label}
        </Text>
      )}
      <NumberInput
        data-testid={testId}
        value={Number.isFinite(value) ? value : ""}
        step={step}
        min={min}
        hideControls
        allowDecimal
        w={width}
        onChange={(v) => onChange(typeof v === "number" ? v : Number(v))}
      />
    </Group>
  );
}
