import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// Exercises DocBody's standalone-file load path: the shared classifier decides
// whether a file is refused (spectrum / volumetric), loaded as a trajectory
// (with the topology hint on failure) or as a structure (with the sibling
// `.top` lookup for `.gro`).

const loadFile = vi.fn(async (_file: File, _top?: File) => {});
const loadXtc = vi.fn(async (_file: File) => {});
const local = { loadFile, loadXtc };

vi.mock("@megane/components/MeganeViewer", () => ({ MeganeViewer: vi.fn(() => null) }));
vi.mock("@megane/hooks/useMeganeLocal", () => ({ useMeganeLocal: () => local }));
vi.mock("@megane/pipeline/store", () => ({
  usePipelineStore: { getState: vi.fn(() => ({ reset: vi.fn() })), setState: vi.fn() },
}));
vi.mock("@megane/pipeline/storeSnapshot", () => ({ capturePipelineStore: vi.fn(() => ({})) }));
vi.mock("@megane/tour/useTour", () => ({ useTour: vi.fn() }));
vi.mock("@megane/components/ThemeSync", () => ({ ThemeSync: vi.fn(() => null) }));
vi.mock("@megane/styles/megane.css", () => ({}));
vi.mock("@megane/stores/usePlaybackStore", () => ({
  usePlaybackStore: { getState: () => ({ seekFrame: vi.fn() }) },
}));
vi.mock("../../../jupyterlab-megane/src/wasmLoader", () => ({ ensureWasmUrl: vi.fn() }));
vi.mock("../../../jupyterlab-megane/src/filetypes", () => ({
  STRUCTURE_FILETYPES_BINARY: [],
}));

import { MeganeReactView } from "../../../jupyterlab-megane/src/MeganeDocWidget";

type ViewArgs = ConstructorParameters<typeof MeganeReactView>;

function mount(path: string, contentsGet = vi.fn(async () => ({ content: "" }))) {
  const context = {
    path,
    model: { toString: () => "payload" },
    ready: Promise.resolve(),
    contentsModel: null,
  } as unknown as ViewArgs[0];
  const contents = { get: contentsGet } as unknown as ViewArgs[1];
  const view = new MeganeReactView(context, contents) as unknown as {
    render: () => JSX.Element;
  };
  render(view.render());
  return { contentsGet };
}

async function settledState(): Promise<HTMLElement> {
  const root = await screen.findByTestId("megane-doc-root");
  await waitFor(() => expect(root.getAttribute("data-state")).not.toBe("loading"));
  return screen.getByTestId("megane-doc-root");
}

describe("MeganeDocWidget standalone load path", () => {
  beforeEach(() => {
    loadFile.mockReset().mockResolvedValue(undefined);
    loadXtc.mockReset().mockResolvedValue(undefined);
  });

  it("refuses a JCAMP-DX spectrum with the shared message and loads nothing", async () => {
    mount("data/ir.jdx");
    const root = await settledState();
    expect(root.getAttribute("data-state")).toBe("error");
    expect(root.textContent).toContain("ir.jdx is a spectrum, which has no atoms");
    expect(loadFile).not.toHaveBeenCalled();
    expect(loadXtc).not.toHaveBeenCalled();
  });

  it("refuses a volumetric grid with the shared message", async () => {
    mount("density.cube");
    const root = await settledState();
    expect(root.getAttribute("data-state")).toBe("error");
    expect(root.textContent).toContain("density.cube is a volumetric grid");
    expect(loadFile).not.toHaveBeenCalled();
  });

  it("loads a trajectory-only file through loadXtc", async () => {
    mount("run.xtc");
    const root = await settledState();
    expect(root.getAttribute("data-state")).toBe("ready");
    expect(loadXtc).toHaveBeenCalledTimes(1);
    expect(loadXtc.mock.calls[0][0].name).toBe("run.xtc");
    expect(loadFile).not.toHaveBeenCalled();
  });

  it("appends the topology hint when a trajectory-only load fails", async () => {
    loadXtc.mockRejectedValue(new Error("No structure loaded."));
    mount("run.dcd");
    const root = await settledState();
    expect(root.getAttribute("data-state")).toBe("error");
    expect(root.textContent).toContain(
      "No structure loaded. Open a structure file (PDB, GRO, etc.) first, or use the pipeline editor to wire a Load Structure node.",
    );
  });

  it("stringifies a non-Error trajectory failure before appending the hint", async () => {
    loadXtc.mockRejectedValue("boom");
    mount("traj.nc");
    const root = await settledState();
    expect(root.textContent).toContain("boom Open a structure file");
  });

  it("loads a .gro with its sibling .top from the same directory", async () => {
    const contentsGet = vi.fn(async () => ({ content: "[ system ]" }));
    mount("sims/water.gro", contentsGet);
    const root = await settledState();
    expect(root.getAttribute("data-state")).toBe("ready");
    expect(contentsGet).toHaveBeenCalledWith("sims/water.top", { content: true, format: "text" });
    expect(loadFile).toHaveBeenCalledTimes(1);
    const [file, top] = loadFile.mock.calls[0];
    expect(file.name).toBe("water.gro");
    expect(top?.name).toBe("water.top");
    expect(top?.size).toBe("[ system ]".length);
  });

  it("looks up the sibling .top at the root when the .gro has no directory", async () => {
    const contentsGet = vi.fn(async () => ({ content: "" }));
    mount("water.gro", contentsGet);
    await settledState();
    expect(contentsGet).toHaveBeenCalledWith("water.top", { content: true, format: "text" });
    // Empty content → no topology file passed.
    expect(loadFile.mock.calls[0][1]).toBeUndefined();
  });

  it("proceeds without topology when the sibling .top is missing", async () => {
    const contentsGet = vi.fn(async () => {
      throw new Error("404");
    });
    mount("box.gro", contentsGet);
    const root = await settledState();
    expect(root.getAttribute("data-state")).toBe("ready");
    expect(loadFile.mock.calls[0][1]).toBeUndefined();
  });

  it("does not probe for a .top next to non-.gro structures", async () => {
    const contentsGet = vi.fn(async () => ({ content: "x" }));
    mount("1crn.pdb", contentsGet);
    const root = await settledState();
    expect(root.getAttribute("data-state")).toBe("ready");
    expect(contentsGet).not.toHaveBeenCalled();
    expect(loadFile.mock.calls[0][1]).toBeUndefined();
  });
});
