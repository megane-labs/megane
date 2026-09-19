import { describe, it, expect, beforeEach } from "vitest";
import {
  LIBRARY_STORAGE_KEY,
  allMolecules,
  createLibraryStore,
  isUserMolecule,
  sanitizeStored,
  useLibraryStore,
} from "@/builder/library/store";
import { PRESET_MOLECULES } from "@/builder/library/presets";
import type { LibraryMoleculeDraft } from "@/builder/library/types";

const draft = (name = "Thing"): LibraryMoleculeDraft => ({
  name,
  formula: "C",
  origin: "sketch",
  elements: [6],
  positions: [0, 0, 0],
  bonds: [],
});

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

describe("library store", () => {
  beforeEach(() => {
    localStorage.clear();
    useLibraryStore.setState({ user: [] });
  });

  it("lists the presets first, then the user's molecules", () => {
    const store = createLibraryStore();
    expect(allMolecules(store.getState())).toHaveLength(PRESET_MOLECULES.length);
    const added = store.getState().addMolecule(draft());
    expect(isUserMolecule(added.id)).toBe(true);
    expect(isUserMolecule("preset:water")).toBe(false);
    expect(allMolecules(store.getState()).at(-1)).toBe(added);
  });

  it("persists to the given storage and reads it back on creation", () => {
    const storage = new MemoryStorage();
    const a = createLibraryStore(storage);
    const added = a.getState().addMolecule(draft("Mine"));
    expect(JSON.parse(storage.getItem(LIBRARY_STORAGE_KEY)!)).toHaveLength(1);
    const b = createLibraryStore(storage);
    expect(b.getState().user).toEqual([added]);
    b.getState().renameMolecule(added.id, "  Renamed ");
    expect(b.getState().user[0].name).toBe("Renamed");
    b.getState().renameMolecule(added.id, "   ");
    b.getState().renameMolecule("user:nope", "x");
    expect(b.getState().user[0].name).toBe("Renamed");
    b.getState().removeMolecule("user:nope");
    b.getState().removeMolecule(added.id);
    expect(b.getState().user).toEqual([]);
    expect(createLibraryStore(storage).getState().user).toEqual([]);
  });

  it("survives a storage that throws or holds garbage", () => {
    const broken = new MemoryStorage();
    broken.setItem(LIBRARY_STORAGE_KEY, "{not json");
    const a = createLibraryStore(broken);
    expect(a.getState().user).toEqual([]);
    const throwing = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("quota");
      },
    } as unknown as Storage;
    const b = createLibraryStore(throwing);
    b.getState().addMolecule(draft());
    expect(b.getState().user).toHaveLength(1);
  });

  it("the app store uses localStorage", () => {
    const added = useLibraryStore.getState().addMolecule(draft("App"));
    expect(JSON.parse(localStorage.getItem(LIBRARY_STORAGE_KEY)!)[0].id).toBe(added.id);
  });

  it("sanitizeStored keeps only well-formed user molecules", () => {
    const good = {
      id: "user:1",
      name: "ok",
      formula: "C",
      origin: "sketch",
      elements: [6, 6],
      positions: [0, 0, 0, 1, 0, 0],
      bonds: [[0, 1]],
      bondOrders: [2],
      molfile: "M  END",
      planar: true,
    };
    expect(sanitizeStored("nope")).toEqual([]);
    expect(sanitizeStored([good])).toEqual([good]);
    expect(
      sanitizeStored([
        null,
        { ...good, id: "preset:water" },
        { ...good, name: 3 },
        { ...good, positions: [0] },
        { ...good, bonds: [[0, 5]] },
        { ...good, bonds: "x" },
      ]),
    ).toEqual([]);
    const loose = sanitizeStored([
      { ...good, formula: 1, origin: "weird", bondOrders: [1, 2], molfile: 4, planar: "yes" },
    ])[0];
    expect(loose.formula).toBe("");
    expect(loose.origin).toBe("file");
    expect(loose).not.toHaveProperty("bondOrders");
    expect(loose).not.toHaveProperty("molfile");
    expect(loose).not.toHaveProperty("planar");
  });
});
