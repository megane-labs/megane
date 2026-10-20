/**
 * The sketch dialog: Ketcher (stubbed) hands back a molfile, which RDKit
 * (stubbed) embeds in 3D; the paste field takes a molfile directly, and a
 * failed Ketcher load falls back to pasting. Closing asks before a drawing
 * is thrown away; Stop drops an embedding in flight.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import type { Snapshot } from "@/types";

const { parseStructureText, editorMode, ketcher, embedSketch, embedAvailable, canvas } = vi.hoisted(
  () => {
    const canvas = {
      blank: false,
      onChange: null as (() => void) | null,
      /** Draw (or clear) on the stub canvas and fire Ketcher's change event. */
      draw(blank: boolean) {
        canvas.blank = blank;
        canvas.onChange?.();
      },
    };
    return {
      parseStructureText: vi.fn(),
      editorMode: { current: "ok" as "ok" | "throw" },
      embedSketch: vi.fn(),
      embedAvailable: { current: true },
      canvas,
      ketcher: {
        getMolfile: vi.fn(async (_format?: string) => "KETCHER-MOL"),
        setMolecule: vi.fn(async (_mol: string) => undefined),
        editor: {
          struct: () => ({ isBlank: () => canvas.blank }),
          subscribe: (_event: string, handler: () => void) => {
            canvas.onChange = handler;
          },
        } as unknown,
      },
    };
  },
);
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

import { SketchModal, ketcherIsBlank } from "@/builder/library/SketchModal";
import { useBuilderStore } from "@/builder/store";

const confirmOpen = () => useBuilderStore.getState().confirm;
const answer = (ok: boolean) => act(() => useBuilderStore.getState().resolveConfirm(ok));
const addButton = () => screen.getByTestId("sketch-add");
const whenReady = () =>
  waitFor(() => expect(addButton().getAttribute("aria-disabled")).toBe("false"));
/** A press that starts and ends on the backdrop. */
const clickBackdrop = () => {
  const modal = screen.getByTestId("sketch-modal");
  fireEvent.pointerDown(modal);
  fireEvent.click(modal);
};

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
  ketcher.getMolfile.mockReset();
  ketcher.getMolfile.mockImplementation(async () => "KETCHER-MOL");
  ketcher.setMolecule.mockClear();
  canvas.blank = false;
  canvas.onChange = null;
  useBuilderStore.getState().resolveConfirm(false);
  editorMode.current = "ok";
  delete (window as unknown as { __megane_test_ketcher?: unknown }).__megane_test_ketcher;
  (globalThis as { __MEGANE_TEST__?: boolean }).__MEGANE_TEST__ = false;
});
afterEach(() => {
  cleanup();
  vi.spyOn(console, "error").mockRestore();
});

describe("SketchModal", () => {
  it("draws over the Builder, loads Ketcher, and adds the sketch embedded in 3D by RDKit", async () => {
    parseStructureText.mockResolvedValue(parsed(ethanol3D()));
    const onAdd = vi.fn();
    const onClose = vi.fn();
    const { container } = render(<SketchModal onAdd={onAdd} onClose={onClose} />);
    const modal = screen.getByTestId("sketch-modal");
    // Not portalled: it stays inside the Builder, under the Builder's confirm dialog.
    expect(container.contains(modal)).toBe(true);
    expect(modal.style.position).toBe("absolute");
    expect(document.activeElement).toBe(screen.getByTestId("sketch-name"));
    expect(screen.getByTestId("sketch-add").getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("sketch-add").getAttribute("title")).toBe(
      "The sketcher is still loading.",
    );
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
    // An empty canvas closes from the backdrop without asking; clicking inside does not close.
    canvas.blank = true;
    fireEvent.click(screen.getByTestId("sketch-name"));
    expect(onClose).not.toHaveBeenCalled();
    clickBackdrop();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(confirmOpen()).toBeNull();
    fireEvent.click(screen.getByTestId("sketch-cancel"));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
  });

  it("asks before throwing a drawing away, and a drag released on the backdrop keeps it", async () => {
    const onClose = vi.fn();
    render(<SketchModal onAdd={vi.fn()} onClose={onClose} />);
    await whenReady();
    const modal = screen.getByTestId("sketch-modal");
    // A drag that starts inside (in Ketcher) and ends over the backdrop.
    fireEvent.pointerDown(screen.getByTestId("sketch-editor"));
    fireEvent.click(modal);
    // A click event alone (no press on the backdrop) does nothing either.
    fireEvent.click(modal);
    expect(confirmOpen()).toBeNull();
    // A real backdrop click asks; No keeps the dialog.
    clickBackdrop();
    await waitFor(() => expect(confirmOpen()?.confirmLabel).toBe("Discard sketch"));
    clickBackdrop(); // a second request while asking is ignored
    answer(false);
    await act(async () => {});
    expect(onClose).not.toHaveBeenCalled();
    // Cancel asks too; Yes closes.
    fireEvent.click(screen.getByTestId("sketch-cancel"));
    await waitFor(() => expect(confirmOpen()).not.toBeNull());
    answer(true);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("Escape closes through the same question", async () => {
    const onClose = vi.fn();
    render(<SketchModal onAdd={vi.fn()} onClose={onClose} />);
    await whenReady();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(confirmOpen()).not.toBeNull());
    answer(true);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("keeps Tab inside the dialog", async () => {
    render(<SketchModal onAdd={vi.fn()} onClose={vi.fn()} />);
    await whenReady();
    const panel = screen.getByTestId("sketch-panel");
    const add = addButton();
    add.focus();
    fireEvent.keyDown(add, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByTestId("sketch-name"));
    fireEvent.keyDown(screen.getByTestId("sketch-name"), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(add);
    // In the middle, Tab is the browser's (and Ketcher's) to move.
    const toggle = screen.getByTestId("sketch-paste-toggle");
    toggle.focus();
    fireEvent.keyDown(toggle, { key: "Tab" });
    expect(document.activeElement).toBe(toggle);
    // Other keys pass through untouched.
    fireEvent.keyDown(panel, { key: "Delete" });
    expect(document.activeElement).toBe(toggle);
  });

  it("disables Add while the canvas is empty, says why, and clears an error when the sketch changes", async () => {
    canvas.blank = true;
    embedSketch.mockRejectedValueOnce(new Error("Could not sanitize molecule"));
    render(<SketchModal onAdd={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId("sketch-blocked").textContent).toBe("Draw a molecule first."),
    );
    expect(addButton().getAttribute("aria-disabled")).toBe("true");
    act(() => canvas.draw(false));
    await whenReady();
    fireEvent.click(addButton());
    await waitFor(() =>
      expect(screen.getByTestId("sketch-error").textContent).toBe(
        "RDKit could not embed the sketch in 3D: Could not sanitize molecule",
      ),
    );
    act(() => canvas.draw(false));
    expect(screen.queryByTestId("sketch-error")).toBeNull();
  });

  it("names a Ketcher read failure as such", async () => {
    ketcher.getMolfile.mockRejectedValueOnce(new Error("bad struct"));
    render(<SketchModal onAdd={vi.fn()} onClose={vi.fn()} />);
    await whenReady();
    fireEvent.click(addButton());
    await waitFor(() =>
      expect(screen.getByTestId("sketch-error").textContent).toBe(
        "Could not read the sketch from Ketcher: bad struct",
      ),
    );
  });

  it("Stop drops the embedding in flight: nothing is added later", async () => {
    let finish!: () => void;
    embedSketch.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = () => resolve(embedded);
      }),
    );
    parseStructureText.mockResolvedValue(parsed(ethanol3D()));
    const onAdd = vi.fn();
    const onClose = vi.fn();
    render(<SketchModal onAdd={onAdd} onClose={onClose} />);
    await whenReady();
    fireEvent.click(addButton());
    await waitFor(() => expect(screen.getByTestId("sketch-cancel").textContent).toBe("Stop"));
    fireEvent.click(screen.getByTestId("sketch-cancel"));
    expect(screen.getByTestId("sketch-cancel").textContent).toBe("Cancel");
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish());
    await act(async () => {});
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.queryByTestId("sketch-error")).toBeNull();
  });

  it("Escape during the embedding stops it; closing mid-embedding adds nothing", async () => {
    let finish!: () => void;
    embedSketch.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(embedded);
        }),
    );
    parseStructureText.mockResolvedValue(parsed(ethanol3D()));
    const onAdd = vi.fn();
    const { unmount } = render(<SketchModal onAdd={onAdd} onClose={vi.fn()} />);
    await whenReady();
    fireEvent.click(addButton());
    await waitFor(() => expect(addButton().textContent).toBe("Embedding…"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(addButton().textContent).toBe("Add to library");
    expect(confirmOpen()).toBeNull();
    fireEvent.click(addButton());
    await waitFor(() => expect(addButton().textContent).toBe("Embedding…"));
    unmount();
    await act(async () => finish());
    await act(async () => {});
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("edits a library molecule: Save changes or Save as new, Enter saves", async () => {
    parseStructureText.mockResolvedValue(parsed(ethanol3D()));
    const onAdd = vi.fn();
    const onSave = vi.fn();
    render(
      <SketchModal
        initialMolfile="SEED"
        initialName="Ethanol"
        onAdd={onAdd}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Edit molecule")).toBeTruthy();
    expect(addButton().textContent).toBe("Save as new");
    await whenReady();
    fireEvent.click(screen.getByTestId("sketch-save"));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onAdd).not.toHaveBeenCalled();
    fireEvent.click(addButton());
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(screen.getByTestId("sketch-name"), { key: "Enter" });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
  });

  it("Enter in the name field adds; the hint follows Add hydrogens", async () => {
    parseStructureText.mockResolvedValue(parsed(ethanol3D()));
    const onAdd = vi.fn();
    render(<SketchModal onAdd={onAdd} onClose={vi.fn()} />);
    expect(screen.getByTestId("sketch-mode-hint").textContent).toContain("adding its missing");
    fireEvent.click(screen.getByTestId("sketch-hydrogens"));
    expect(screen.getByTestId("sketch-mode-hint").textContent).toContain(
      "without adding hydrogens",
    );
    await whenReady();
    fireEvent.keyDown(screen.getByTestId("sketch-name"), { key: "a" });
    expect(embedSketch).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByTestId("sketch-name"), { key: "Enter" });
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
  });

  it("ketcherIsBlank reads the canvas, or says it cannot", () => {
    expect(ketcherIsBlank(null)).toBeNull();
    expect(ketcherIsBlank({} as never)).toBeNull();
    expect(
      ketcherIsBlank({
        editor: {
          struct: () => {
            throw new Error("gone");
          },
        },
      } as never),
    ).toBeNull();
    canvas.blank = true;
    expect(ketcherIsBlank(ketcher as never)).toBe(true);
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
    expect(screen.getByTestId("sketch-cancel").textContent).toBe("Stop");
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

  it("Paste MOL carries the drawing across both ways", async () => {
    render(<SketchModal onAdd={vi.fn()} onClose={vi.fn()} />);
    await whenReady();
    fireEvent.click(screen.getByTestId("sketch-paste-toggle"));
    await waitFor(() =>
      expect((screen.getByTestId("sketch-molfile") as HTMLTextAreaElement).value).toBe(
        "KETCHER-MOL",
      ),
    );
    expect(ketcher.getMolfile).toHaveBeenCalledWith("v2000");
    expect(screen.getByTestId("sketch-paste-toggle").getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(screen.getByTestId("sketch-molfile"), { target: { value: "PASTED" } });
    fireEvent.click(screen.getByTestId("sketch-paste-toggle"));
    await waitFor(() => expect(ketcher.setMolecule).toHaveBeenCalledWith("PASTED"));
    // A failed read keeps what the field held; an empty field seeds nothing.
    ketcher.getMolfile.mockRejectedValueOnce(new Error("nope"));
    await whenReady();
    fireEvent.click(screen.getByTestId("sketch-paste-toggle"));
    await waitFor(() =>
      expect((screen.getByTestId("sketch-molfile") as HTMLTextAreaElement).value).toBe("PASTED"),
    );
    fireEvent.change(screen.getByTestId("sketch-molfile"), { target: { value: " " } });
    ketcher.setMolecule.mockClear();
    fireEvent.click(screen.getByTestId("sketch-paste-toggle"));
    await waitFor(() => expect(screen.getByTestId("ketcher-stub")).toBeTruthy());
    expect(ketcher.setMolecule).not.toHaveBeenCalled();
  });

  it("Paste MOL takes a molfile directly, embeds it, and reports parse errors", async () => {
    parseStructureText.mockRejectedValueOnce(new Error("no atoms"));
    const onAdd = vi.fn();
    const onClose = vi.fn();
    canvas.blank = true;
    render(<SketchModal onAdd={onAdd} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("sketch-paste-toggle"));
    await waitFor(() => expect(screen.queryByTestId("ketcher-stub")).toBeNull());
    expect(screen.getByTestId("sketch-add").getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("sketch-blocked").textContent).toBe("Paste a MOL file first.");
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
    // A pasted text is a drawing too: closing asks.
    fireEvent.click(screen.getByTestId("sketch-cancel"));
    await waitFor(() => expect(confirmOpen()).not.toBeNull());
    answer(false);
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
    expect(screen.getByTestId("sketch-fallback-paste").tagName).toBe("BUTTON");
    await act(async () => {
      fireEvent.click(screen.getByTestId("sketch-fallback-paste"));
    });
    expect(screen.getByTestId("sketch-molfile")).toBeTruthy();
  });
});
