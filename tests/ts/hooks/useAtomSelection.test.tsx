/**
 * The measurement panel follows the renderer's selection when the structure
 * changes: a new snapshot re-validates the selection (atoms the structure no
 * longer has are dropped) and moves the measurement with the atoms, and the
 * panel state must mirror both — not keep the old atoms and value.
 */
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { useAtomSelection } from "@/hooks/useAtomSelection";
import type { MoleculeRenderer } from "@/renderer/MoleculeRenderer";
import type { Measurement } from "@/types";

/** A renderer whose selection and measurement the test sets by hand. */
function fakeRenderer() {
  const state: { atoms: number[]; measurement: Measurement | null } = {
    atoms: [],
    measurement: null,
  };
  const renderer = {
    toggleAtomSelection: (i: number) => {
      state.atoms = [...state.atoms, i];
      return { atoms: [...state.atoms] };
    },
    getSelection: () => ({ atoms: [...state.atoms] }),
    getMeasurement: () => state.measurement,
    clearSelection: vi.fn(),
    setSelection: vi.fn(),
  };
  const ref = { current: renderer } as unknown as MutableRefObject<MoleculeRenderer | null>;
  return { state, ref };
}

const distance = (value: number): Measurement => ({
  atoms: [0, 5],
  type: "distance",
  value,
  label: `${value.toFixed(3)} Å`,
});

describe("useAtomSelection — structure changes", () => {
  it("follows a measurement that moved with its atoms", () => {
    const { state, ref } = fakeRenderer();
    const onMeasurement = vi.fn();
    const { result } = renderHook(() => useAtomSelection(ref, onMeasurement));
    state.measurement = distance(1);
    act(() => result.current.handleAtomRightClick(0));
    act(() => result.current.handleAtomRightClick(5));
    state.measurement = distance(2); // e.g. the wrap node moved atom 5
    act(() => result.current.handleFrameUpdated());
    expect(result.current.measurement).toEqual(distance(2));
    expect(onMeasurement).toHaveBeenLastCalledWith(distance(2));
  });

  it("drops atoms the renderer dropped and clears the measurement", () => {
    const { state, ref } = fakeRenderer();
    const onMeasurement = vi.fn();
    const onSelection = vi.fn();
    const { result } = renderHook(() => useAtomSelection(ref, onMeasurement, onSelection));
    state.measurement = distance(1);
    act(() => result.current.handleAtomRightClick(0));
    act(() => result.current.handleAtomRightClick(5));

    // A smaller structure loads: atom 5 is gone, so is the distance.
    state.atoms = [0];
    state.measurement = null;
    act(() => result.current.handleFrameUpdated());
    expect(result.current.selection).toEqual({ atoms: [0] });
    expect(onSelection).toHaveBeenLastCalledWith({ atoms: [0] });
    expect(result.current.measurement).toBeNull();
    expect(onMeasurement).toHaveBeenLastCalledWith(null);

    // Nothing changed since: no further callbacks on later frames.
    const selectionCalls = onSelection.mock.calls.length;
    const measurementCalls = onMeasurement.mock.calls.length;
    act(() => result.current.handleFrameUpdated());
    expect(onSelection.mock.calls.length).toBe(selectionCalls);
    expect(onMeasurement.mock.calls.length).toBe(measurementCalls);
  });

  it("does nothing without a renderer", () => {
    const ref = { current: null } as MutableRefObject<MoleculeRenderer | null>;
    const onMeasurement = vi.fn();
    const { result } = renderHook(() => useAtomSelection(ref, onMeasurement));
    act(() => result.current.handleFrameUpdated());
    expect(onMeasurement).not.toHaveBeenCalled();
  });
});
