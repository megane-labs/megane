/**
 * The sketch dialog: Ketcher (stubbed) hands back a molfile, which RDKit
 * (stubbed) embeds in 3D; the paste field takes a molfile directly, and a
 * failed Ketcher load falls back to pasting.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import type { Snapshot } from "@/types";

const { parseStructureText, editorMode, ketcher, embedSketch, embedAvailable } = vi.hoisted(() => ({
  parseStructureText: vi.fn(),
  editorMode: { current: "ok" as "ok" | "throw" },
  embedSketch: vi.fn(),
  embedAvailable: { current: true },
  ketcher: {
    getMolfile: vi.fn(async () => "KETCHER-MOL"),
    setMolecule: vi.fn(async () => undefined),
  },
}));
vi.mock("@/parsers/structure", () => ({ parseStructureText, parseStructureFile: vi.fn() }));
vi.mock("@/builder/library/embed", () => ({
  embedSketch,
  canEmbed: () => embedAvailable.current,
}));
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

/** What RDKit hands back for ethanol: every hydrogen explicit, 3D coordinates. */
function ethanol3D(): Snapshot {
  return {
    nAtoms: 9,
    nBonds: 8,
    nFileBonds: 8,
    positions: new Float32Array([
      0, 0, 0, 1.52, 0, 0, 2.0, 1.35, 0, -0.4, 1.0, 0.3, -0.4, -0.5, -0.9, -0.4, -0.5, 0.9, 1.9,
      -0.5, -0.9, 1.9, -0.5, 0.9, 2.95, 1.3, 0.1,
    ]),
    elements: new Uint8Array([6, 6, 8, 1, 1, 1, 1, 1, 1]),
    bonds: new Uint32Array([0, 1, 1, 2, 0, 3, 0, 4, 0, 5, 1, 6, 1, 7, 2, 8]),
    bondOrders: null,
    box: null,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}
const embedded = {
  molblock: "MOLBLOCK-3D",
  energy: -3.2,
  converged: true,
  forceField: "MMFF94s",
  warnings: [],
  rdkitVersion: "2026.03.6",
};
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
  embedSketch.mockReset();
  embedSketch.mockResolvedValue(embedded);
  embedAvailable.current = true;
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
  it("renders into the body, loads Ketcher, and adds the sketch embedded in 3D by RDKit", async () => {
    parseStructureText.mockResolvedValue(parsed(ethanol3D()));
    const onAdd = vi.fn();
    const onClose = vi.fn();
    render(<SketchModal onAdd={onAdd} onClose={onClose} />);
    const modal = screen.getByTestId("sketch-modal");
    expect(modal.parentElement).toBe(document.body);
    expect(screen.getByTestId("sketch-add").getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("sketch-mode-hint").textContent).toContain("RDKit embeds");
    await waitFor(() => expect(screen.getByTestId("ketcher-stub")).toBeTruthy());
    await waitFor(() =>
      expect(screen.getByTestId("sketch-add").getAttribute("aria-disabled")).toBe("false"),
    );
    fireEvent.change(screen.getByTestId("sketch-name"), { target: { value: "Ethanol-ish" } });
    fireEvent.click(screen.getByTestId("sketch-add"));
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    expect(ketcher.getMolfile).toHaveBeenCalledWith("v2000");
    // Ketcher's molfile goes to RDKit with hydrogens on; RDKit's mol block is what gets parsed.
    expect(embedSketch).toHaveBeenCalledWith("KETCHER-MOL", {
      addHydrogens: true,
      forceField: undefined,
    });
    expect(parseStructureText).toHaveBeenCalledWith("MOLBLOCK-3D", "sketch.mol");
    const draft = onAdd.mock.calls[0][0];
    expect(draft.name).toBe("Ethanol-ish");
    expect(draft.formula).toBe("C2H6O");
    expect(draft.molfile).toBe("KETCHER-MOL");
    expect(draft.planar).toBeUndefined();
    // Clicking the backdrop closes; clicking inside does not.
    fireEvent.click(screen.getByTestId("sketch-name"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(modal);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("sketch-cancel"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("passes Add hydrogens off to RDKit", async () => {
    const bare = ethanol3D();
    parseStructureText.mockResolvedValue(
      parsed({
        ...bare,
        nAtoms: 3,
        nBonds: 2,
        nFileBonds: 2,
        positions: bare.positions.slice(0, 9),
        elements: bare.elements.slice(0, 3),
        bonds: bare.bonds.slice(0, 4),
      }),
    );
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
    expect(embedSketch).toHaveBeenCalledWith("KETCHER-MOL", {
      addHydrogens: false,
      forceField: undefined,
    });
    expect(onAdd.mock.calls[0][0].formula).toBe("C2O");
  });

  it("reports an RDKit failure and shows the busy label while embedding", async () => {
    let release!: () => void;
    embedSketch.mockReturnValueOnce(
      new Promise<never>((_, reject) => {
        release = () => reject(new Error("Could not sanitize molecule"));
      }),
    );
    const onAdd = vi.fn();
    render(<SketchModal onAdd={onAdd} onClose={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId("sketch-add").getAttribute("aria-disabled")).toBe("false"),
    );
    fireEvent.click(screen.getByTestId("sketch-add"));
    await waitFor(() => expect(screen.getByTestId("sketch-add").textContent).toBe("Embedding…"));
    await act(async () => release());
    await waitFor(() => expect(screen.getByTestId("sketch-error")).toBeTruthy());
    expect(screen.getByTestId("sketch-error").textContent).toBe(
      "RDKit could not embed the sketch in 3D: Could not sanitize molecule",
    );
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByTestId("sketch-add").textContent).toBe("Add to library");
  });

  it("cannot add where Web Workers are missing, and says why", async () => {
    embedAvailable.current = false;
    const onAdd = vi.fn();
    render(<SketchModal onAdd={onAdd} onClose={vi.fn()} />);
    expect(screen.getByTestId("sketch-mode-hint").textContent).toContain("needs Web Workers");
    await waitFor(() => expect(screen.getByTestId("ketcher-stub")).toBeTruthy());
    expect(screen.getByTestId("sketch-add").getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByTestId("sketch-add"));
    expect(embedSketch).not.toHaveBeenCalled();
    expect(onAdd).not.toHaveBeenCalled();
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

  it("Paste MOL takes a molfile directly, embeds it, and reports parse errors", async () => {
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
    parseStructureText.mockResolvedValueOnce(parsed(ethanol3D()));
    fireEvent.click(screen.getByTestId("sketch-add"));
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    // The pasted text is what RDKit embeds; its mol block is what the parser sees.
    expect(embedSketch).toHaveBeenLastCalledWith("MOLTEXT", {
      addHydrogens: true,
      forceField: undefined,
    });
    expect(parseStructureText).toHaveBeenLastCalledWith("MOLBLOCK-3D", "sketch.mol");
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
