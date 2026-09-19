import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { usePipelineStore } from "@/pipeline/store";
import { usePipelineUIStore } from "@/stores/usePipelineUIStore";
import { LoadStructureNode, setStructureLoadHandler } from "@/components/nodes/LoadStructureNode";
import type { LoadStructureParams } from "@/pipeline/types";
import { seedPipelineStore } from "./_helpers";

vi.mock("@xyflow/react", () => import("./_xyflowMock"));

function nodeProps(id: string, params: LoadStructureParams, enabled = true) {
  return {
    id,
    type: "load_structure" as const,
    data: { params, enabled },
    selected: false,
    isConnectable: true,
    xPos: 0,
    yPos: 0,
    zIndex: 0,
    dragging: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/**
 * Helper to simulate a `change` event on the hidden file input. jsdom does
 * not let us set `e.target.files` via `fireEvent.change` directly; instead
 * we redefine the property on the input element.
 */
function fireFileInputChange(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, "files", {
    value: files,
    writable: false,
    configurable: true,
  });
  fireEvent.change(input);
}

describe("LoadStructureNode", () => {
  beforeEach(() => {
    cleanup();
    setStructureLoadHandler(null);
  });

  afterEach(() => {
    setStructureLoadHandler(null);
  });

  it("renders the placeholder when fileName is null", () => {
    const seeded = seedPipelineStore("load_structure", { id: "ls1" });
    render(<LoadStructureNode {...nodeProps("ls1", seeded.data.params as LoadStructureParams)} />);
    expect(screen.getByTestId("load-structure-filename")).toHaveTextContent("No structure loaded");
  });

  it("renders the filename when params.fileName is set", () => {
    const seeded = seedPipelineStore("load_structure", {
      id: "ls1",
      params: { fileName: "water.pdb", hasTrajectory: false, hasCell: true },
    });
    render(<LoadStructureNode {...nodeProps("ls1", seeded.data.params as LoadStructureParams)} />);
    expect(screen.getByTestId("load-structure-filename")).toHaveTextContent("water.pdb");
  });

  it("file input change with a supported extension updates params and fires the load handler", () => {
    const updateNodeParams = vi.fn();
    const handler = vi.fn();
    const seeded = seedPipelineStore("load_structure", { id: "ls1" });
    usePipelineStore.setState({ updateNodeParams });
    setStructureLoadHandler(handler);

    render(<LoadStructureNode {...nodeProps("ls1", seeded.data.params as LoadStructureParams)} />);

    const file = new File(["dummy"], "system.pdb", { type: "chemical/x-pdb" });
    const input = screen.getByTestId("load-structure-input") as HTMLInputElement;
    fireFileInputChange(input, [file]);

    expect(updateNodeParams).toHaveBeenCalledWith("ls1", { fileName: "system.pdb" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("ls1", file);
  });

  it("file input change with an unsupported extension is a no-op", () => {
    const updateNodeParams = vi.fn();
    const handler = vi.fn();
    const seeded = seedPipelineStore("load_structure", { id: "ls1" });
    usePipelineStore.setState({ updateNodeParams });
    setStructureLoadHandler(handler);

    render(<LoadStructureNode {...nodeProps("ls1", seeded.data.params as LoadStructureParams)} />);

    const file = new File(["dummy"], "garbage.bad", { type: "text/plain" });
    const input = screen.getByTestId("load-structure-input") as HTMLInputElement;
    fireFileInputChange(input, [file]);

    expect(updateNodeParams).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("clearing the load handler with setStructureLoadHandler(null) prevents subsequent dispatch", () => {
    const updateNodeParams = vi.fn();
    const handler = vi.fn();
    const seeded = seedPipelineStore("load_structure", { id: "ls1" });
    usePipelineStore.setState({ updateNodeParams });

    setStructureLoadHandler(handler);
    setStructureLoadHandler(null);

    render(<LoadStructureNode {...nodeProps("ls1", seeded.data.params as LoadStructureParams)} />);

    const file = new File(["dummy"], "system.gro", { type: "text/plain" });
    const input = screen.getByTestId("load-structure-input") as HTMLInputElement;
    fireFileInputChange(input, [file]);

    expect(updateNodeParams).toHaveBeenCalledWith("ls1", { fileName: "system.gro" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("drag-and-drop of a supported file calls updateNodeParams and the load handler", () => {
    const updateNodeParams = vi.fn();
    const handler = vi.fn();
    const seeded = seedPipelineStore("load_structure", { id: "ls1" });
    usePipelineStore.setState({ updateNodeParams });
    setStructureLoadHandler(handler);

    render(<LoadStructureNode {...nodeProps("ls1", seeded.data.params as LoadStructureParams)} />);

    const file = new File(["dummy"], "trajectory.xyz", { type: "text/plain" });
    const dropZone = screen.getByTestId("load-structure-filename").parentElement!;
    fireEvent.drop(dropZone, {
      dataTransfer: { files: [file] },
    });

    expect(updateNodeParams).toHaveBeenCalledWith("ls1", { fileName: "trajectory.xyz" });
    expect(handler).toHaveBeenCalledWith("ls1", file);
  });

  it.each(["POSCAR", "CONTCAR", "XDATCAR_run2"])(
    "drag-and-drop accepts the extensionless VASP file %s",
    (filename) => {
      const updateNodeParams = vi.fn();
      const handler = vi.fn();
      const seeded = seedPipelineStore("load_structure", { id: "ls1" });
      usePipelineStore.setState({ updateNodeParams });
      setStructureLoadHandler(handler);

      render(
        <LoadStructureNode {...nodeProps("ls1", seeded.data.params as LoadStructureParams)} />,
      );

      const file = new File(["dummy"], filename, { type: "text/plain" });
      const dropZone = screen.getByTestId("load-structure-filename").parentElement!;
      fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });

      expect(updateNodeParams).toHaveBeenCalledWith("ls1", { fileName: filename });
      expect(handler).toHaveBeenCalledWith("ls1", file);
    },
  );

  it("drag-and-drop ignores files with unsupported extensions", () => {
    const updateNodeParams = vi.fn();
    const handler = vi.fn();
    const seeded = seedPipelineStore("load_structure", { id: "ls1" });
    usePipelineStore.setState({ updateNodeParams });
    setStructureLoadHandler(handler);

    render(<LoadStructureNode {...nodeProps("ls1", seeded.data.params as LoadStructureParams)} />);

    const file = new File(["dummy"], "readme.txt", { type: "text/plain" });
    const dropZone = screen.getByTestId("load-structure-filename").parentElement!;
    fireEvent.drop(dropZone, {
      dataTransfer: { files: [file] },
    });

    expect(updateNodeParams).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("disables trajectory and cell handles when params indicate they are absent", () => {
    const seeded = seedPipelineStore("load_structure", {
      id: "ls1",
      params: { fileName: "water.pdb", hasTrajectory: false, hasCell: false },
    });
    render(<LoadStructureNode {...nodeProps("ls1", seeded.data.params as LoadStructureParams)} />);

    const trajectoryHandle = screen.getByTestId("handle-source-trajectory");
    const cellHandle = screen.getByTestId("handle-source-cell");
    const particleHandle = screen.getByTestId("handle-source-particle");

    // Disabled handles use the slate-300 gray (#cbd5e1 → rgb(203, 213, 225))
    expect(trajectoryHandle.style.background).toBe("rgb(203, 213, 225)");
    expect(cellHandle.style.background).toBe("rgb(203, 213, 225)");
    // Particle handle remains its data-type color
    expect(particleHandle.style.background).not.toBe("rgb(203, 213, 225)");
  });

  it("enables trajectory handle when hasTrajectory is true", () => {
    const seeded = seedPipelineStore("load_structure", {
      id: "ls1",
      params: { fileName: "system.gro", hasTrajectory: true, hasCell: true },
    });
    render(<LoadStructureNode {...nodeProps("ls1", seeded.data.params as LoadStructureParams)} />);
    const trajectoryHandle = screen.getByTestId("handle-source-trajectory");
    expect(trajectoryHandle.style.background).not.toBe("rgb(203, 213, 225)");
  });

  // The Build panel's history rides on this node; the graph shows only a
  // count and a way back to the panel (the ops themselves live in the panel).
  it("shows no edit badge without edits, and the count plus Open Build with them", () => {
    usePipelineUIStore.setState({ buildOpen: false });
    const plain = seedPipelineStore("load_structure", { id: "ls1", params: { fileName: "a.xyz" } });
    const { unmount } = render(
      <LoadStructureNode {...nodeProps("ls1", plain.data.params as LoadStructureParams)} />,
    );
    expect(screen.queryByTestId("load-structure-edits")).toBeNull();
    unmount();

    const one = seedPipelineStore("load_structure", {
      id: "ls2",
      params: { fileName: "a.xyz", edits: [{ op: "delete_atoms", atoms: [0] }] },
    });
    const { unmount: unmount2 } = render(
      <LoadStructureNode {...nodeProps("ls2", one.data.params as LoadStructureParams)} />,
    );
    expect(screen.getByTestId("load-structure-edits").textContent).toContain("1 edit");
    expect(screen.getByTestId("load-structure-edits").textContent).not.toContain("1 edits");
    fireEvent.click(screen.getByTestId("load-structure-open-build"));
    expect(usePipelineUIStore.getState().buildOpen).toBe(true);
    unmount2();

    const many = seedPipelineStore("load_structure", {
      id: "ls3",
      params: {
        fileName: "a.xyz",
        edits: [
          { op: "delete_atoms", atoms: [0] },
          { op: "set_cell", box: null },
        ],
      },
    });
    render(<LoadStructureNode {...nodeProps("ls3", many.data.params as LoadStructureParams)} />);
    expect(screen.getByTestId("load-structure-edits").textContent).toContain("2 edits");
    usePipelineUIStore.setState({ buildOpen: false });
  });
});
