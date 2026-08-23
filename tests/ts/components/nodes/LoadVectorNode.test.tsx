import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { usePipelineStore } from "@/pipeline/store";
import { LoadVectorNode, setVectorLoadHandler } from "@/components/nodes/LoadVectorNode";
import type { LoadVectorParams } from "@/pipeline/types";
import { seedPipelineStore } from "./_helpers";

vi.mock("@xyflow/react", () => import("./_xyflowMock"));

function nodeProps(id: string, params: LoadVectorParams, enabled = true) {
  return {
    id,
    type: "load_vector" as const,
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

function fireFileInputChange(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, "files", {
    value: files,
    writable: false,
    configurable: true,
  });
  fireEvent.change(input);
}

describe("LoadVectorNode", () => {
  beforeEach(() => {
    cleanup();
    setVectorLoadHandler(null);
  });

  afterEach(() => {
    setVectorLoadHandler(null);
  });

  it("renders the placeholder when fileName is null", () => {
    const seeded = seedPipelineStore("load_vector", { id: "lv1" });
    render(<LoadVectorNode {...nodeProps("lv1", seeded.data.params as LoadVectorParams)} />);
    expect(screen.getByText("No vector file loaded")).toBeInTheDocument();
  });

  it("renders the filename when params.fileName is set", () => {
    const seeded = seedPipelineStore("load_vector", {
      id: "lv1",
      params: { fileName: "forces.vec" },
    });
    render(<LoadVectorNode {...nodeProps("lv1", seeded.data.params as LoadVectorParams)} />);
    expect(screen.getByText("forces.vec")).toBeInTheDocument();
    expect(screen.queryByText("No vector file loaded")).toBeNull();
  });

  it("file input change with .vec updates params and fires the load handler", () => {
    const updateNodeParams = vi.fn();
    const handler = vi.fn();
    const seeded = seedPipelineStore("load_vector", { id: "lv1" });
    usePipelineStore.setState({ updateNodeParams });
    setVectorLoadHandler(handler);

    render(<LoadVectorNode {...nodeProps("lv1", seeded.data.params as LoadVectorParams)} />);

    const file = new File(["dummy"], "forces.vec", { type: "application/octet-stream" });
    const input = screen
      .getByText("Load vectors...")
      .parentElement!.querySelector('input[type="file"]') as HTMLInputElement;
    fireFileInputChange(input, [file]);

    expect(updateNodeParams).toHaveBeenCalledWith("lv1", { fileName: "forces.vec" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(file);
  });

  it("file input change with an unsupported extension is a no-op", () => {
    const updateNodeParams = vi.fn();
    const handler = vi.fn();
    const seeded = seedPipelineStore("load_vector", { id: "lv1" });
    usePipelineStore.setState({ updateNodeParams });
    setVectorLoadHandler(handler);

    render(<LoadVectorNode {...nodeProps("lv1", seeded.data.params as LoadVectorParams)} />);

    const file = new File(["junk"], "garbage.json", { type: "application/json" });
    const input = screen
      .getByText("Load vectors...")
      .parentElement!.querySelector('input[type="file"]') as HTMLInputElement;
    fireFileInputChange(input, [file]);

    expect(updateNodeParams).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("clearing the load handler with setVectorLoadHandler(null) prevents subsequent dispatch", () => {
    const updateNodeParams = vi.fn();
    const handler = vi.fn();
    const seeded = seedPipelineStore("load_vector", { id: "lv1" });
    usePipelineStore.setState({ updateNodeParams });

    setVectorLoadHandler(handler);
    setVectorLoadHandler(null);

    render(<LoadVectorNode {...nodeProps("lv1", seeded.data.params as LoadVectorParams)} />);

    const file = new File(["dummy"], "v.vec", { type: "application/octet-stream" });
    const input = screen
      .getByText("Load vectors...")
      .parentElement!.querySelector('input[type="file"]') as HTMLInputElement;
    fireFileInputChange(input, [file]);

    expect(updateNodeParams).toHaveBeenCalledWith("lv1", { fileName: "v.vec" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("drag-and-drop of a supported file calls updateNodeParams and the load handler", () => {
    const updateNodeParams = vi.fn();
    const handler = vi.fn();
    const seeded = seedPipelineStore("load_vector", { id: "lv1" });
    usePipelineStore.setState({ updateNodeParams });
    setVectorLoadHandler(handler);

    render(<LoadVectorNode {...nodeProps("lv1", seeded.data.params as LoadVectorParams)} />);

    const file = new File(["dummy"], "fields.vec", { type: "application/octet-stream" });
    // Drop target is the wrapper that owns the file input — first ascendant
    // of the placeholder/filename text.
    const dropZone = screen.getByText("No vector file loaded").parentElement!;
    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });

    expect(updateNodeParams).toHaveBeenCalledWith("lv1", { fileName: "fields.vec" });
    expect(handler).toHaveBeenCalledWith(file);
  });

  it("drag-and-drop ignores files with unsupported extensions", () => {
    const updateNodeParams = vi.fn();
    const handler = vi.fn();
    const seeded = seedPipelineStore("load_vector", { id: "lv1" });
    usePipelineStore.setState({ updateNodeParams });
    setVectorLoadHandler(handler);

    render(<LoadVectorNode {...nodeProps("lv1", seeded.data.params as LoadVectorParams)} />);

    const file = new File(["junk"], "readme.txt", { type: "text/plain" });
    const dropZone = screen.getByText("No vector file loaded").parentElement!;
    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });

    expect(updateNodeParams).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("offers embedded channels without activating them", () => {
    const seeded = seedPipelineStore("load_vector", { id: "lv1" });
    usePipelineStore.setState({
      embeddedVectorChannels: [
        { name: "velocity", frames: [{ frame: 0, vectors: new Float32Array(3) }] },
      ],
      activeEmbeddedVectorChannel: null,
      fileVectors: null,
    });
    render(<LoadVectorNode {...nodeProps("lv1", seeded.data.params as LoadVectorParams)} />);
    const select = screen.getByLabelText("Embedded vector channel") as HTMLSelectElement;
    expect(select.value).toBe("");
    // Nothing rendered yet: the offer alone must not feed the overlay.
    expect(usePipelineStore.getState().fileVectors).toBeNull();
  });

  it("activates an embedded channel only when the user selects it", () => {
    const updateNodeParams = vi.fn();
    const seeded = seedPipelineStore("load_vector", { id: "lv1" });
    const frames = [{ frame: 0, vectors: Float32Array.from([1, 2, 3]) }];
    usePipelineStore.setState({
      updateNodeParams,
      embeddedVectorChannels: [{ name: "velocity", frames }],
      activeEmbeddedVectorChannel: null,
      fileVectors: null,
    });
    render(<LoadVectorNode {...nodeProps("lv1", seeded.data.params as LoadVectorParams)} />);
    fireEvent.change(screen.getByLabelText("Embedded vector channel"), {
      target: { value: "velocity" },
    });
    const state = usePipelineStore.getState();
    expect(state.activeEmbeddedVectorChannel).toBe("velocity");
    expect(state.fileVectors).toBe(frames);
    expect(updateNodeParams).toHaveBeenCalledWith("lv1", { fileName: "[embedded] velocity" });
  });

  it("deactivates the embedded channel when 'off' is selected", () => {
    const seeded = seedPipelineStore("load_vector", { id: "lv1" });
    const frames = [{ frame: 0, vectors: Float32Array.from([1, 2, 3]) }];
    usePipelineStore.setState({
      embeddedVectorChannels: [{ name: "velocity", frames }],
      activeEmbeddedVectorChannel: "velocity",
      fileVectors: frames,
    });
    render(<LoadVectorNode {...nodeProps("lv1", seeded.data.params as LoadVectorParams)} />);
    fireEvent.change(screen.getByLabelText("Embedded vector channel"), {
      target: { value: "" },
    });
    const state = usePipelineStore.getState();
    expect(state.activeEmbeddedVectorChannel).toBeNull();
    expect(state.fileVectors).toBeNull();
  });

  it("hides the embedded selector when the file carries no channels", () => {
    const seeded = seedPipelineStore("load_vector", { id: "lv1" });
    usePipelineStore.setState({ embeddedVectorChannels: null });
    render(<LoadVectorNode {...nodeProps("lv1", seeded.data.params as LoadVectorParams)} />);
    expect(screen.queryByLabelText("Embedded vector channel")).toBeNull();
  });
});
