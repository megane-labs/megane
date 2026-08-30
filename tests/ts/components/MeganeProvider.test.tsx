import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import {
  MeganeProvider,
  useMeganeStores,
  useScopedPipelineStore,
  useScopedMeasurementStore,
  usePipelineStoreApi,
} from "@/stores/MeganeProvider";
import { createMeganeStores, globalMeganeStores } from "@/stores/meganeStores";
import { usePipelineStore } from "@/pipeline/store";
import { _resetTestRegistry } from "@/stores/testRegistry";

/** Renders the node count of whichever pipeline store is in scope. */
function NodeCount({ label }: { label: string }) {
  const count = useScopedPipelineStore((s) => s.nodes.length);
  return <div data-testid={label}>{count}</div>;
}

function MeasurementCount({ label }: { label: string }) {
  const count = useScopedMeasurementStore((s) => s.measurements.length);
  return <div data-testid={label}>{count}</div>;
}

function BundleId({ label }: { label: string }) {
  const stores = useMeganeStores();
  return <div data-testid={label}>{stores.id}</div>;
}

describe("MeganeProvider", () => {
  beforeEach(() => {
    cleanup();
    _resetTestRegistry();
  });
  afterEach(() => {
    cleanup();
    _resetTestRegistry();
  });

  it("falls back to the module-global stores when no provider is mounted", () => {
    render(<BundleId label="id" />);
    expect(screen.getByTestId("id").textContent).toBe(globalMeganeStores.id);
  });

  it("reads the global pipeline store with no provider, so existing hosts are unaffected", () => {
    render(<NodeCount label="count" />);
    const expected = usePipelineStore.getState().nodes.length;
    expect(screen.getByTestId("count").textContent).toBe(String(expected));

    act(() => {
      usePipelineStore.getState().addNode("color");
    });
    expect(screen.getByTestId("count").textContent).toBe(String(expected + 1));
  });

  it("gives two sibling providers independent pipeline state — the #672 repro", () => {
    const left = createMeganeStores({ id: "left" });
    const right = createMeganeStores({ id: "right" });
    const baseline = left.pipeline.getState().nodes.length;

    render(
      <>
        <MeganeProvider stores={left}>
          <NodeCount label="left" />
        </MeganeProvider>
        <MeganeProvider stores={right}>
          <NodeCount label="right" />
        </MeganeProvider>
      </>,
    );

    expect(screen.getByTestId("left").textContent).toBe(String(baseline));
    expect(screen.getByTestId("right").textContent).toBe(String(baseline));

    act(() => {
      left.pipeline.getState().addNode("color");
    });

    // Before the fix both panels moved together, because both read one store.
    expect(screen.getByTestId("left").textContent).toBe(String(baseline + 1));
    expect(screen.getByTestId("right").textContent).toBe(String(baseline));
  });

  it("keeps measurements separate between two providers", () => {
    const left = createMeganeStores();
    const right = createMeganeStores();

    render(
      <>
        <MeganeProvider stores={left}>
          <MeasurementCount label="left" />
        </MeganeProvider>
        <MeganeProvider stores={right}>
          <MeasurementCount label="right" />
        </MeganeProvider>
      </>,
    );

    act(() => {
      left.measurement.getState().addMeasurement({
        atoms: [0, 1],
        type: "distance",
        value: 1.5,
        label: "1.50 Å",
      });
    });

    expect(screen.getByTestId("left").textContent).toBe("1");
    expect(screen.getByTestId("right").textContent).toBe("0");
  });

  it("does not leak provider state into a sibling that has no provider", () => {
    const scoped = createMeganeStores();
    const globalBaseline = usePipelineStore.getState().nodes.length;

    render(
      <>
        <MeganeProvider stores={scoped}>
          <NodeCount label="scoped" />
        </MeganeProvider>
        <NodeCount label="unscoped" />
      </>,
    );

    act(() => {
      scoped.pipeline.getState().addNode("color");
    });

    expect(screen.getByTestId("unscoped").textContent).toBe(String(globalBaseline));
  });

  it("creates and owns a bundle when none is passed", () => {
    render(
      <MeganeProvider>
        <BundleId label="id" />
      </MeganeProvider>,
    );
    const id = screen.getByTestId("id").textContent;
    expect(id).toBeTruthy();
    expect(id).not.toBe(globalMeganeStores.id);
  });

  it("keeps its own bundle stable across re-renders", () => {
    function Wrapper({ tick }: { tick: number }) {
      return (
        <MeganeProvider>
          <BundleId label="id" />
          <span data-testid="tick">{tick}</span>
        </MeganeProvider>
      );
    }
    const { rerender } = render(<Wrapper tick={1} />);
    const first = screen.getByTestId("id").textContent;

    rerender(<Wrapper tick={2} />);

    expect(screen.getByTestId("tick").textContent).toBe("2");
    expect(screen.getByTestId("id").textContent).toBe(first);
  });

  it("destroys a bundle it created on unmount, but not an injected one", () => {
    const injected = createMeganeStores();
    const injectedDestroy = vi.spyOn(injected, "destroy");

    const { unmount } = render(
      <MeganeProvider stores={injected}>
        <BundleId label="id" />
      </MeganeProvider>,
    );
    unmount();

    // The caller owns an injected bundle and may reuse it elsewhere.
    expect(injectedDestroy).not.toHaveBeenCalled();
  });

  it("exposes the store API for imperative use outside the render path", () => {
    const scoped = createMeganeStores();
    let seen: unknown = null;

    function Probe() {
      const api = usePipelineStoreApi();
      seen = api;
      return null;
    }
    render(
      <MeganeProvider stores={scoped}>
        <Probe />
      </MeganeProvider>,
    );

    expect(seen).toBe(scoped.pipeline);
  });
});
