/**
 * Shared hook for atom selection and measurement.
 * Used by both MeganeViewer and WidgetViewer.
 */

import { useState, useCallback, useRef } from "react";
import type { MoleculeRenderer } from "../renderer/MoleculeRenderer";
import type { SelectionState, Measurement } from "../types";

function sameAtoms(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((atom, i) => atom === b[i]);
}

export interface AtomSelectionState {
  selection: SelectionState;
  measurement: Measurement | null;
  handleAtomRightClick: (atomIndex: number) => void;
  handleClearSelection: () => void;
  handleFrameUpdated: () => void;
  setExternalSelection: (atoms: number[]) => void;
}

export function useAtomSelection(
  rendererRef: React.MutableRefObject<MoleculeRenderer | null>,
  onMeasurementChange?: (measurement: Measurement | null) => void,
  onSelectionChange?: (selection: SelectionState) => void,
): AtomSelectionState {
  const [selection, setSelection] = useState<SelectionState>({ atoms: [] });
  const [measurement, setMeasurement] = useState<Measurement | null>(null);
  const selectionRef = useRef(selection);
  const measurementRef = useRef(measurement);
  const onMeasurementChangeRef = useRef(onMeasurementChange);
  onMeasurementChangeRef.current = onMeasurementChange;
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;

  const updateSelection = useCallback((s: SelectionState) => {
    selectionRef.current = s;
    setSelection(s);
    onSelectionChangeRef.current?.(s);
  }, []);

  const updateMeasurement = useCallback((m: Measurement | null) => {
    measurementRef.current = m;
    setMeasurement(m);
    onMeasurementChangeRef.current?.(m);
  }, []);

  const handleAtomRightClick = useCallback(
    (atomIndex: number) => {
      if (!rendererRef.current) return;
      const newSelection = rendererRef.current.toggleAtomSelection(atomIndex);
      updateSelection(newSelection);
      updateMeasurement(rendererRef.current.getMeasurement());
    },
    [rendererRef, updateSelection, updateMeasurement],
  );

  const handleClearSelection = useCallback(() => {
    rendererRef.current?.clearSelection();
    updateSelection({ atoms: [] });
    updateMeasurement(null);
  }, [rendererRef, updateSelection, updateMeasurement]);

  // After a snapshot load or a trajectory frame. The renderer drops selected
  // atoms a new structure no longer has; mirror that, and the measurement at
  // the atoms' new positions (null once fewer than two atoms remain).
  const handleFrameUpdated = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const { atoms } = renderer.getSelection();
    if (!sameAtoms(atoms, selectionRef.current.atoms)) updateSelection({ atoms });
    const m = renderer.getMeasurement();
    if (m || measurementRef.current) updateMeasurement(m);
  }, [rendererRef, updateSelection, updateMeasurement]);

  const setExternalSelection = useCallback(
    (atoms: number[]) => {
      if (!rendererRef.current) return;
      if (atoms.length === 0) {
        rendererRef.current.clearSelection();
        updateSelection({ atoms: [] });
        updateMeasurement(null);
      } else {
        const newSelection = rendererRef.current.setSelection(atoms);
        updateSelection(newSelection);
        updateMeasurement(rendererRef.current.getMeasurement());
      }
    },
    [rendererRef, updateSelection, updateMeasurement],
  );

  return {
    selection,
    measurement,
    handleAtomRightClick,
    handleClearSelection,
    handleFrameUpdated,
    setExternalSelection,
  };
}
