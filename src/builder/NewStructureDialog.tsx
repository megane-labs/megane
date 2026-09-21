/**
 * "New structure": the one place a document starts from scratch, as an
 * empty cubic cell or a bulk crystal. Both replace whatever is open, which
 * the dialog says once instead of every form repeating it.
 */

import { useState } from "react";
import { Alert, Button, Group, Modal, SegmentedControl, Stack, Text } from "@mantine/core";
import type { BulkSpec } from "../crystal/bulk";
import { BulkForm } from "./crystal/BulkForm";
import { NumberField } from "./crystal/NumberField";

/** Default edge of a new cell, in Å. */
export const DEFAULT_NEW_CELL_EDGE = 10;

export type NewStructureKind = "cell" | "bulk";

const KINDS: { value: NewStructureKind; label: string }[] = [
  { value: "cell", label: "Empty cell" },
  { value: "bulk", label: "Bulk crystal" },
];

export interface NewStructureDialogProps {
  initialKind?: NewStructureKind;
  /** Whether a document is open (the dialog then warns that it is replaced). */
  hasDocument: boolean;
  onNewCell: (edge: number) => void;
  onNewBulk: (spec: BulkSpec) => void;
  onClose: () => void;
}

export function NewStructureDialog({
  initialKind = "cell",
  hasDocument,
  onNewCell,
  onNewBulk,
  onClose,
}: NewStructureDialogProps) {
  const [kind, setKind] = useState<NewStructureKind>(initialKind);
  const [edge, setEdge] = useState(DEFAULT_NEW_CELL_EDGE);
  const [error, setError] = useState<string | null>(null);
  const edgeValid = Number.isFinite(edge) && edge > 0;

  return (
    <Modal.Root opened onClose={onClose} size="lg" centered>
      <Modal.Overlay />
      <Modal.Content data-testid="builder-new-dialog">
        <Modal.Header>
          <Modal.Title fw={700}>New structure</Modal.Title>
          <Modal.CloseButton />
        </Modal.Header>
        <Modal.Body>
          <Stack gap="md">
            <SegmentedControl
              value={kind}
              onChange={(v) => {
                setKind(v as NewStructureKind);
                setError(null);
              }}
              data={KINDS.map((k) => ({
                value: k.value,
                label: <span data-testid={`builder-new-kind-${k.value}`}>{k.label}</span>,
              }))}
            />
            {kind === "cell" ? (
              <Stack gap="xs">
                <Text size="xs" c="dimmed">
                  An atom-less cubic cell to build into. The cell is what the camera frames and what
                  free atoms are placed against.
                </Text>
                <Group gap="xs">
                  <NumberField
                    label="Edge"
                    value={edge}
                    onChange={setEdge}
                    testId="builder-new-cell-edge"
                    min={0.1}
                    width={72}
                  />
                  <Text size="xs" c="dimmed">
                    Å
                  </Text>
                  <Button
                    data-testid="builder-new-cell"
                    disabled={!edgeValid}
                    onClick={() => {
                      onNewCell(edge);
                      onClose();
                    }}
                  >
                    Create empty cell
                  </Button>
                </Group>
              </Stack>
            ) : (
              <BulkForm
                onCreate={(spec) => {
                  onNewBulk(spec);
                  onClose();
                }}
                onError={setError}
              />
            )}
            {error && (
              <Alert color="red" variant="light" p="xs" data-testid="builder-new-error">
                {error}
              </Alert>
            )}
            {hasDocument && (
              <Text size="xs" c="orange.7" data-testid="builder-new-replaces">
                This replaces the open structure and its history.
              </Text>
            )}
            <Group justify="flex-end">
              <Button variant="default" data-testid="builder-new-close" onClick={onClose}>
                Close
              </Button>
            </Group>
          </Stack>
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}
