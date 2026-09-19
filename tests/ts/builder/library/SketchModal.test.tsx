/**
 * The sketch dialog: Ketcher (stubbed) hands back a molfile, the paste field
 * takes one directly, and a failed Ketcher load falls back to pasting.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import type { Snapshot } from "@/types";

const { parseStructureText, editorMode, ketcher } = vi.hoisted(() => ({
  parseStructureText: vi.fn(),
  editorMode: { current: "ok" as "ok" | "throw" },
  ketcher: {
    getMolfile: vi.fn(async () => "KETCHER-MOL"),
    setMolecule: vi.fn(async () => undefined),
  },
}));
vi.mock("@/parsers/structure", () => ({ parseStructureText, parseStructureFile: vi.fn() }));
vi.mock("@/builder/library/KetcherEditor", async () => {
  const React = await import("react");
  return {
    default: ({ onInit }: { onInit: (k: unknown) => void }) => {
      if (editorMode.current === "throw") throw new Error("no wasm");
      React.useEffect(() => onInit(ketcher), [onInit]);
      return React.createElement("div", { "data-testid": "ketcher-stub" });
    },
  };
});

import { SketchModal } from "@/builder/library/SketchModal";

function ethanolLike(): Snapshot {
  return {
    nAtoms: 3,
    nBonds: 2,
    nFileBonds: 2,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
    elements: new Uint8Array([6, 6, 8]),
    bonds: new Uint32Array([0, 1, 1, 2]),
    bondOrders: null,
    box: null,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}
const parsed = (s: Snapshot) => ({
  snapshot: s,
  labels: null,
  frames: [],
  meta: null,
  vectorChannels: [],
  scalarChannels: [],
  warnings: [],
});

beforeEach(() => {
  parseStructureText.mockReset();
  ketcher.getMolfile.mockClear();
  ketcher.setMolecule.mockClear();
  editorMode.current = "ok";
  delete (window as unknown as { __megane_test_ketcher?: unknown }).__megane_test_ketcher;
  (globalThis as { __MEGANE_TEST__?: boolean }).__MEGANE_TEST__ = false;
});
afterEach(() => {
  cleanup();
  vi.spyOn(console, "error").mockRestore();
});

describe("SketchModal", () => {
  it("renders into the body, loads Ketcher, and adds the sketch as a molecule", async () => {
    parseStructureText.mockResolvedValue(parsed(ethanolLike()));
    const onAdd = vi.fn();
    const onClose = vi.fn();
    render(<SketchModal onAdd={onAdd} onClose={onClose} />);
    const modal = screen.getByTestId("sketch-modal");
    expect(modal.parentElement).toBe(document.body);
    expect(screen.getByTestId("sketch-add").getAttribute("aria-disabled")).toBe("true");
    await waitFor(() => expect(screen.getByTestId("ketcher-stub")).toBeTruthy());
    await waitFor(() =>
      expect(screen.getByTestId("sketch-add").getAttribute("aria-disabled")).toBe("false"),
    );
    fireEvent.change(screen.getByTestId("sketch-name"), { target: { value: "Ethanol-ish" } });
    fireEvent.click(screen.getByTestId("sketch-add"));
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    expect(ketcher.getMolfile).toHaveBeenCalledWith("v2000");
    expect(parseStructureText).toHaveBeenCalledWith("KETCHER-MOL", "sketch.mol");
    const draft = onAdd.mock.calls[0][0];
    expect(draft.name).toBe("Ethanol-ish");
    // The implicit hydrogens are added by default.
    expect(draft.formula).toBe("C2H6O");
    expect(draft.molfile).toBe("KETCHER-MOL");
    expect(draft.planar).toBe(true);
    // Clicking the backdrop closes; clicking inside does not.
    fireEvent.click(screen.getByTestId("sketch-name"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(modal);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("sketch-cancel"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("keeps the sketch bare when Add hydrogens is unticked", async () => {
    parseStructureText.mockResolvedValue(parsed(ethanolLike()));
    const onAdd = vi.fn();
    render(<SketchModal onAdd={onAdd} onClose={vi.fn()} />);
    const box = screen.getByTestId("sketch-hydrogens") as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(box.checked).toBe(false);
    await waitFor(() =>
      expect(screen.getByTestId("sketch-add").getAttribute("aria-disabled")).toBe("false"),
    );
    fireEvent.click(screen.getByTestId("sketch-add"));
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    expect(onAdd.mock.calls[0][0].formula).toBe("C2O");
  });

  it("exposes the instance in test mode and seeds an initial molfile", async () => {
    (globalThis as { __MEGANE_TEST__?: boolean }).__MEGANE_TEST__ = true;
    render(
      <SketchModal initialMolfile="SEED" initialName="Seeded" onAdd={vi.fn()} onClose={vi.fn()} />,
    );
    await waitFor(() => expect(ketcher.setMolecule).toHaveBeenCalledWith("SEED"));
    expect((window as unknown as { __megane_test_ketcher?: unknown }).__megane_test_ketcher).toBe(
      ketcher,
    );
    expect((screen.getByTestId("sketch-name") as HTMLInputElement).value).toBe("Seeded");
  });

  it("Paste MOL takes a molfile directly and reports parse errors", async () => {
    parseStructureText.mockRejectedValueOnce(new Error("no atoms"));
    const onAdd = vi.fn();
    render(<SketchModal onAdd={onAdd} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("sketch-paste-toggle"));
    expect(screen.queryByTestId("ketcher-stub")).toBeNull();
    expect(screen.getByTestId("sketch-add").getAttribute("aria-disabled")).toBe("true");
    fireEvent.change(screen.getByTestId("sketch-molfile"), { target: { value: "MOLTEXT" } });
    fireEvent.click(screen.getByTestId("sketch-add"));
    await waitFor(() =>
      expect(screen.getByTestId("sketch-error").textContent).toContain("no atoms"),
    );
    expect(onAdd).not.toHaveBeenCalled();
    parseStructureText.mockResolvedValueOnce(parsed(ethanolLike()));
    fireEvent.click(screen.getByTestId("sketch-add"));
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    expect(parseStructureText).toHaveBeenLastCalledWith("MOLTEXT", "sketch.mol");
    expect(onAdd.mock.calls[0][0].name).toBe("C2H6O");
    // Back to the sketcher.
    fireEvent.click(screen.getByTestId("sketch-paste-toggle"));
    await waitFor(() => expect(screen.getByTestId("ketcher-stub")).toBeTruthy());
  });

  it("falls back to pasting when Ketcher cannot load", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    editorMode.current = "throw";
    render(<SketchModal onAdd={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("sketch-fallback")).toBeTruthy());
    expect(screen.getByTestId("sketch-fallback").textContent).toContain("no wasm");
    expect(screen.getByTestId("sketch-add").getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      fireEvent.click(screen.getByTestId("sketch-fallback-paste"));
    });
    expect(screen.getByTestId("sketch-molfile")).toBeTruthy();
  });
});
