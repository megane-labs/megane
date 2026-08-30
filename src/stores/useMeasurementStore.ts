import { create, type StateCreator, type StoreApi } from "zustand";
import { createStore } from "zustand/vanilla";
import type { StoredMeasurement, Measurement } from "../types";

let _nextId = 1;

/** Generate a unique measurement ID (resetable in tests). */
function nextId(): string {
  return String(_nextId++);
}

/** Reset the ID counter — exported for test isolation only. */
export function _resetIdCounter(): void {
  _nextId = 1;
}

function makeName(type: StoredMeasurement["type"], id: string): string {
  const labels: Record<StoredMeasurement["type"], string> = {
    distance: "Dist",
    angle: "Angle",
    dihedral: "Dihedral",
  };
  return `${labels[type]} ${id}`;
}

export interface MeasurementStore {
  measurements: StoredMeasurement[];
  addMeasurement: (m: Measurement) => void;
  removeMeasurement: (id: string) => void;
  renameMeasurement: (id: string, name: string) => void;
  toggleVisibility: (id: string) => void;
  clearAll: () => void;
}

export const measurementStateCreator: StateCreator<MeasurementStore> = (set) => ({
  measurements: [],

  addMeasurement: (m: Measurement) => {
    const id = nextId();
    const stored: StoredMeasurement = {
      id,
      name: makeName(m.type, id),
      atoms: [...m.atoms],
      type: m.type,
      value: m.value,
      label: m.label,
      hidden: false,
      createdAt: Date.now(),
    };
    set((state) => ({ measurements: [...state.measurements, stored] }));
  },

  removeMeasurement: (id: string) =>
    set((state) => ({
      measurements: state.measurements.filter((m) => m.id !== id),
    })),

  renameMeasurement: (id: string, name: string) =>
    set((state) => ({
      measurements: state.measurements.map((m) => (m.id === id ? { ...m, name } : m)),
    })),

  toggleVisibility: (id: string) =>
    set((state) => ({
      measurements: state.measurements.map((m) => (m.id === id ? { ...m, hidden: !m.hidden } : m)),
    })),

  clearAll: () => set({ measurements: [] }),
});

/** App-wide singleton — used when no <MeganeProvider> is mounted. */
export const useMeasurementStore = create<MeasurementStore>(measurementStateCreator);

/**
 * Private measurement list for one viewer. Two viewers on a page (and, today,
 * two `MolecularViewer`s in one notebook — `WidgetViewer` mounts
 * `MeasurementPanel`, which reads the singleton) otherwise share one list.
 *
 * The `nextId` counter stays module-level on purpose: ids only need to be
 * unique, and a per-store counter would hand both viewers an id "1".
 */
export function createMeasurementStore(): StoreApi<MeasurementStore> {
  return createStore<MeasurementStore>(measurementStateCreator);
}
