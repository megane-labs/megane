import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { usePipelineStore } from "@/pipeline/store";
import {
  LoadTrajectoryNode,
  setTrajectoryLoadHandler,
} from "@/components/nodes/LoadTrajectoryNode";
import type { LoadTrajectoryParams } from "@/pipeline/types";
import { seedPipelineStore } from "./_helpers";

vi.mock("@xyflow/react", () => import("./_xyflowMock"));

function nodeProps(id: string, params: LoadTrajectoryParams, enabled = true) {
  return {
    id,
    type: "load_trajectory" as const,
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

describe("LoadTrajectoryNode", () => {
  beforeEach(() => {
    cleanup();
    setTrajectoryLoadHandler(null);
  });

  afterEach(() => {
    setTrajectoryLoadHandler(null);
  });

  it("renders the placeholder when fileName is null", () => {
    const seeded = seedPipelineStore("load_trajectory", { id: "lt1" });
    render(
      <LoadTrajectoryNode {...nodeProps("lt1", seeded.data.params as LoadTrajectoryParams)} />,
    );

    expect(screen.getByTestId("load-trajectory-filename")).toHaveTextContent(
      "No trajectory loaded",
    );
  });

  it("renders the filename when params.fileName is set", () => {
    const seeded = seedPipelineStore("load_trajectory", {
      id: "lt1",
      params: { fileName: "traj.xtc" },
    });
    render(
      <LoadTrajectoryNode {...nodeProps("lt1", seeded.data.params as LoadTrajectoryParams)} />,
    );

    expect(screen.getByTestId("load-trajectory-filename")).toHaveTextContent("traj.xtc");
  });

  it("file input change with .xtc updates params and fires the load handler", () => {
    const updateNodeParams = vi.fn();
    const handler = vi.fn();
    const seeded = seedPipelineStore("load_trajectory", { id: "lt1" });
    usePipelineStore.setState({ updateNodeParams });
    setTrajectoryLoadHandler(handler);

    render(
      <LoadTrajectoryNode {...nodeProps("lt1", seeded.data.params as LoadTrajectoryParams)} />,
    );

    const file = new File(["dummy"], "traj.xtc", { type: "application/octet-stream" });
    const input = screen
      .getByText("Load trajectory...")
      .parentElement!.querySelector('input[type="file"]') as HTMLInputElement;
    fireFileInputChange(input, [file]);

    expect(updateNodeParams).toHaveBeenCalledWith("lt1", { fileName: "traj.xtc", source: "file" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(file);
  });

  it("file input change with .lammpstrj is accepted", () => {
    const updateNodeParams = vi.fn();
    const handler = vi.fn();
    const seeded = seedPipelineStore("load_trajectory", { id: "lt1" });
    usePipelineStore.setState({ updateNodeParams });
    setTrajectoryLoadHandler(handler);

    render(
      <LoadTrajectoryNode {...nodeProps("lt1", seeded.data.params as LoadTrajectoryParams)} />,
    );

    const file = new File(["dummy"], "run.lammpstrj", { type: "text/plain" });
    const input = screen
      .getByText("Load trajectory...")
      .parentElement!.querySelector('input[type="file"]') as HTMLInputElement;
    fireFileInputChange(input, [file]);

    expect(updateNodeParams).toHaveBeenCalledWith("lt1", { fileName: "run.lammpstrj", source: "file" });
    expect(handler).toHaveBeenCalledWith(file);
  });

  it("file input change with .dcd is accepted", () => {
    const updateNodeParams = vi.fn();
    const handler = vi.fn();
    const seeded = seedPipelineStore("load_trajectory", { id: "lt1" });
    usePipelineStore.setState({ updateNodeParams });
    setTrajectoryLoadHandler(handler);

    render(
      <LoadTrajectoryNode {...nodeProps("lt1", seeded.data.params as LoadTrajectoryParams)} />,
    );

    const file = new File(["dummy"], "trajectory.dcd", { type: "application/octet-stream" });
    const input = screen
      .getByText("Load trajectory...")
      .parentElement!.querySelector('input[type="file"]') as HTMLInputElement;
    fireFileInputChange(input, [file]);

    expect(updateNodeParams).toHaveBeenCalledWith("lt1", { fileName: "trajectory.dcd", source: "file" });
    expect(handler).toHaveBeenCalledWith(file);
  });

  it("file input change with an unsupported extension is a no-op", () => {
    const updateNodeParams = vi.fn();
    const handler = vi.fn();
    const seeded = seedPipelineStore("load_trajectory", { id: "lt1" });
    usePipelineStore.setState({ updateNodeParams });
    setTrajectoryLoadHandler(handler);

    render(
      <LoadTrajectoryNode {...nodeProps("lt1", seeded.data.params as LoadTrajectoryParams)} />,
    );

    const file = new File(["junk"], "garbage.bad", { type: "text/plain" });
    const input = screen
      .getByText("Load trajectory...")
      .parentElement!.querySelector('input[type="file"]') as HTMLInputElement;
    fireFileInputChange(input, [file]);

    expect(updateNodeParams).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("clearing the load handler with setTrajectoryLoadHandler(null) prevents subsequent dispatch", () => {
    const updateNodeParams = vi.fn();
    const handler = vi.fn();
    const seeded = seedPipelineStore("load_trajectory", { id: "lt1" });
    usePipelineStore.setState({ updateNodeParams });

    setTrajectoryLoadHandler(handler);
    setTrajectoryLoadHandler(null);

    render(
      <LoadTrajectoryNode {...nodeProps("lt1", seeded.data.params as LoadTrajectoryParams)} />,
    );

    const file = new File(["dummy"], "traj.xtc", { type: "application/octet-stream" });
    const input = screen
      .getByText("Load trajectory...")
      .parentElement!.querySelector('input[type="file"]') as HTMLInputElement;
    fireFileInputChange(input, [file]);

    expect(updateNodeParams).toHaveBeenCalledWith("lt1", { fileName: "traj.xtc", source: "file" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("drag-and-drop of a supported file calls updateNodeParams and the load handler", () => {
    const updateNodeParams = vi.fn();
    const handler = vi.fn();
    const seeded = seedPipelineStore("load_trajectory", { id: "lt1" });
    usePipelineStore.setState({ updateNodeParams });
    setTrajectoryLoadHandler(handler);

    render(
      <LoadTrajectoryNode {...nodeProps("lt1", seeded.data.params as LoadTrajectoryParams)} />,
    );

    const file = new File(["dummy"], "run.dump", { type: "text/plain" });
    const dropZone = screen.getByTestId("load-trajectory-filename").parentElement!;
    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });

    expect(updateNodeParams).toHaveBeenCalledWith("lt1", { fileName: "run.dump", source: "file" });
    expect(handler).toHaveBeenCalledWith(file);
  });

  it("drag-and-drop ignores files with unsupported extensions", () => {
    const updateNodeParams = vi.fn();
    const handler = vi.fn();
    const seeded = seedPipelineStore("load_trajectory", { id: "lt1" });
    usePipelineStore.setState({ updateNodeParams });
    setTrajectoryLoadHandler(handler);

    render(
      <LoadTrajectoryNode {...nodeProps("lt1", seeded.data.params as LoadTrajectoryParams)} />,
    );

    const file = new File(["junk"], "readme.txt", { type: "text/plain" });
    const dropZone = screen.getByTestId("load-trajectory-filename").parentElement!;
    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });

    expect(updateNodeParams).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("drag-and-drop picks the first matching file when multiple are dropped", () => {
    const updateNodeParams = vi.fn();
    const handler = vi.fn();
    const seeded = seedPipelineStore("load_trajectory", { id: "lt1" });
    usePipelineStore.setState({ updateNodeParams });
    setTrajectoryLoadHandler(handler);

    render(
      <LoadTrajectoryNode {...nodeProps("lt1", seeded.data.params as LoadTrajectoryParams)} />,
    );

    const junk = new File(["x"], "ignored.txt", { type: "text/plain" });
    const traj = new File(["x"], "good.xtc", { type: "application/octet-stream" });
    const dropZone = screen.getByTestId("load-trajectory-filename").parentElement!;
    fireEvent.drop(dropZone, { dataTransfer: { files: [junk, traj] } });

    expect(updateNodeParams).toHaveBeenCalledWith("lt1", { fileName: "good.xtc", source: "file" });
    expect(handler).toHaveBeenCalledWith(traj);
  });
});
