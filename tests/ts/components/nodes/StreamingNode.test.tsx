import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { usePipelineStore } from "@/pipeline/store";
import { StreamingNode } from "@/components/nodes/StreamingNode";
import type { StreamingParams } from "@/pipeline/types";
import type { Snapshot } from "@/types";
import type { FrameProvider } from "@/pipeline/types";
import { seedPipelineStore } from "./_helpers";

vi.mock("@xyflow/react", () => import("./_xyflowMock"));

function nodeProps(id: string, params: StreamingParams, enabled = true) {
  return {
    id,
    type: "streaming" as const,
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

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    nAtoms: 3,
    nBonds: 0,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    elements: new Uint8Array([1, 1, 8]),
    bonds: new Uint32Array(),
    bondOrders: null,
    box: null,
    ...overrides,
  } as Snapshot;
}

function makeFrameProvider(nFrames: number): FrameProvider {
  return {
    kind: "stream",
    meta: { nFrames, timestepPs: 0.002, nAtoms: 3 },
    getFrame() {
      return null;
    },
  };
}

const ACTIVE_GREEN = "rgb(34, 197, 94)";

describe("StreamingNode", () => {
  beforeEach(() => {
    cleanup();
    usePipelineStore.setState({ nodeStreamingData: {} });
  });

  it("renders the Streaming title", () => {
    const seeded = seedPipelineStore("streaming", { id: "s1" });
    render(<StreamingNode {...nodeProps("s1", seeded.data.params as StreamingParams)} />);
    expect(screen.getByText("Streaming")).toBeInTheDocument();
  });

  it("shows 'Disconnected' status with red dot when params.connected=false", () => {
    const seeded = seedPipelineStore("streaming", {
      id: "s1",
      params: { connected: false },
    });
    render(<StreamingNode {...nodeProps("s1", seeded.data.params as StreamingParams)} />);

    const status = screen.getByText("Disconnected");
    expect(status).toBeInTheDocument();
    expect(status.style.color).toBe("var(--megane-danger)");
  });

  it("shows 'Connected' status with green dot when params.connected=true", () => {
    const seeded = seedPipelineStore("streaming", {
      id: "s1",
      params: { connected: true },
    });
    render(<StreamingNode {...nodeProps("s1", seeded.data.params as StreamingParams)} />);

    const status = screen.getByText("Connected");
    expect(status).toBeInTheDocument();
    expect(status.style.color).toBe(ACTIVE_GREEN);
  });

  it("shows the WebSocket origin hint", () => {
    const seeded = seedPipelineStore("streaming", { id: "s1" });
    render(<StreamingNode {...nodeProps("s1", seeded.data.params as StreamingParams)} />);
    expect(screen.getByText("WebSocket: same origin /ws")).toBeInTheDocument();
  });

  it("does not render the snapshot stat line when no streaming data is present", () => {
    const seeded = seedPipelineStore("streaming", { id: "s1" });
    render(<StreamingNode {...nodeProps("s1", seeded.data.params as StreamingParams)} />);
    expect(screen.queryByText(/atoms/)).toBeNull();
  });

  it("renders the atom count when a snapshot is present", () => {
    const seeded = seedPipelineStore("streaming", { id: "s1" });
    usePipelineStore.setState({
      nodeStreamingData: {
        s1: { snapshot: makeSnapshot({ nAtoms: 42, nBonds: 0 }), streamProvider: null },
      },
    });
    render(<StreamingNode {...nodeProps("s1", seeded.data.params as StreamingParams)} />);
    expect(screen.getByText("42 atoms")).toBeInTheDocument();
  });

  it("includes the bond count when nBonds > 0", () => {
    const seeded = seedPipelineStore("streaming", { id: "s1" });
    usePipelineStore.setState({
      nodeStreamingData: {
        s1: { snapshot: makeSnapshot({ nAtoms: 10, nBonds: 9 }), streamProvider: null },
      },
    });
    render(<StreamingNode {...nodeProps("s1", seeded.data.params as StreamingParams)} />);
    expect(screen.getByText("10 atoms, 9 bonds")).toBeInTheDocument();
  });

  it("includes the frame count when streamProvider is present", () => {
    const seeded = seedPipelineStore("streaming", { id: "s1" });
    usePipelineStore.setState({
      nodeStreamingData: {
        s1: {
          snapshot: makeSnapshot({ nAtoms: 5, nBonds: 4 }),
          streamProvider: makeFrameProvider(123),
        },
      },
    });
    render(<StreamingNode {...nodeProps("s1", seeded.data.params as StreamingParams)} />);
    expect(screen.getByText("5 atoms, 4 bonds, 123 frames")).toBeInTheDocument();
  });

  it("disables the bond / trajectory / cell handles when streaming data lacks them", () => {
    const seeded = seedPipelineStore("streaming", { id: "s1" });
    render(<StreamingNode {...nodeProps("s1", seeded.data.params as StreamingParams)} />);

    const disabledColor = "var(--megane-border-strong)"; // theme-aware gray
    expect(screen.getByTestId("handle-source-bond").style.background).toBe(disabledColor);
    expect(screen.getByTestId("handle-source-trajectory").style.background).toBe(disabledColor);
    expect(screen.getByTestId("handle-source-cell").style.background).toBe(disabledColor);
    // particle output stays its data-type color (green, not the disabled gray)
    expect(screen.getByTestId("handle-source-particle").style.background).not.toBe(disabledColor);
  });

  it("enables the bond / trajectory / cell handles based on snapshot contents", () => {
    const seeded = seedPipelineStore("streaming", { id: "s1" });
    usePipelineStore.setState({
      nodeStreamingData: {
        s1: {
          snapshot: makeSnapshot({
            nAtoms: 2,
            nBonds: 1,
            box: new Float32Array([10, 0, 0, 0, 10, 0, 0, 0, 10]),
          }),
          streamProvider: makeFrameProvider(5),
        },
      },
    });
    render(<StreamingNode {...nodeProps("s1", seeded.data.params as StreamingParams)} />);

    const disabledColor = "var(--megane-border-strong)";
    expect(screen.getByTestId("handle-source-bond").style.background).not.toBe(disabledColor);
    expect(screen.getByTestId("handle-source-trajectory").style.background).not.toBe(disabledColor);
    expect(screen.getByTestId("handle-source-cell").style.background).not.toBe(disabledColor);
  });
});
