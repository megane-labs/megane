import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { makeXRBridge, XRControls, type XRControlsTarget } from "@/components/XRControls";
import type { XREditBridge } from "@/renderer/xr/XRSessionController";
import type { MeganeXRState, XRBridge } from "@/renderer/MoleculeRenderer";

type Listener = (state: MeganeXRState) => void;

function fakeXR(supported: XRSessionMode[]) {
  const listeners = new Set<() => void>();
  const xr = {
    isSessionSupported: vi.fn(async (mode: XRSessionMode) => supported.includes(mode)),
    addEventListener: vi.fn((_type: string, cb: () => void) => listeners.add(cb)),
    removeEventListener: vi.fn((_type: string, cb: () => void) => listeners.delete(cb)),
  };
  vi.stubGlobal("navigator", { xr });
  return { xr, fireDeviceChange: () => listeners.forEach((cb) => cb()), listeners };
}

function fakeTarget() {
  let listener: Listener | null = null;
  const target = {
    enterXR: vi.fn(async () => {}),
    exitXR: vi.fn(async () => {}),
    onXRStateChange: vi.fn((cb: Listener) => {
      listener = cb;
      return vi.fn(() => {
        listener = null;
      });
    }),
    setXRBridge: vi.fn((_bridge: XRBridge | null) => {}),
  } satisfies XRControlsTarget;
  const emit = (mode: MeganeXRState["mode"]) =>
    act(() => {
      listener?.({
        presenting: mode !== null,
        mode,
        frames: 0,
        scale: 1,
        position: [0, 0, 0],
        panel: [],
        measuring: false,
        labels: 0,
      });
    });
  return { target, emit, hasListener: () => listener !== null };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("XRControls", () => {
  it("renders nothing where no immersive mode is available", async () => {
    const { xr } = fakeXR([]);
    render(<XRControls getTarget={() => null} />);
    await waitFor(() => expect(xr.isSessionSupported).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("xr-controls")).toBeNull();
  });

  it("renders nothing without WebXR at all", async () => {
    vi.stubGlobal("navigator", {});
    render(<XRControls getTarget={() => null} />);
    await Promise.resolve();
    expect(screen.queryByTestId("xr-controls")).toBeNull();
  });

  it("offers each supported mode and applies the root style", async () => {
    fakeXR(["immersive-vr", "immersive-ar"]);
    render(<XRControls getTarget={() => null} style={{ marginTop: 4 }} />);
    expect(await screen.findByTestId("xr-enter-vr")).toBeTruthy();
    expect(screen.getByTestId("xr-enter-ar")).toBeTruthy();
    expect(screen.getByTestId("xr-controls").style.marginTop).toBe("4px");
  });

  it("re-checks support when a headset is plugged in", async () => {
    let supported: XRSessionMode[] = [];
    const { xr, fireDeviceChange } = fakeXR([]);
    xr.isSessionSupported.mockImplementation(async (mode) => supported.includes(mode));
    render(<XRControls getTarget={() => null} />);
    await waitFor(() => expect(xr.isSessionSupported).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("xr-controls")).toBeNull();
    supported = ["immersive-vr"];
    fireDeviceChange();
    expect(await screen.findByTestId("xr-enter-vr")).toBeTruthy();
    expect(screen.queryByTestId("xr-enter-ar")).toBeNull();
  });

  it("enters the clicked mode and turns into an Exit button while presenting", async () => {
    fakeXR(["immersive-vr", "immersive-ar"]);
    const { target, emit } = fakeTarget();
    render(<XRControls getTarget={() => target} />);
    fireEvent.click(await screen.findByTestId("xr-enter-ar"));
    expect(target.enterXR).toHaveBeenCalledWith("immersive-ar");
    emit("immersive-ar");
    const exit = screen.getByTestId("xr-exit");
    expect(exit.textContent).toBe("Exit AR");
    fireEvent.click(exit);
    expect(target.exitXR).toHaveBeenCalled();
    emit(null);
    expect(screen.getByTestId("xr-enter-vr")).toBeTruthy();
    // A second entry reuses the subscription.
    fireEvent.click(screen.getByTestId("xr-enter-vr"));
    expect(target.onXRStateChange).toHaveBeenCalledTimes(1);
  });

  it("shows why a session could not start, and clears it on the next try", async () => {
    fakeXR(["immersive-vr"]);
    const { target } = fakeTarget();
    target.enterXR.mockRejectedValueOnce(new Error("NotAllowedError"));
    render(<XRControls getTarget={() => target} />);
    fireEvent.click(await screen.findByTestId("xr-enter-vr"));
    expect((await screen.findByTestId("xr-error")).textContent).toBe(
      "VR could not start: NotAllowedError",
    );
    target.enterXR.mockRejectedValueOnce("denied");
    fireEvent.click(screen.getByTestId("xr-enter-vr"));
    await waitFor(() =>
      expect(screen.getByTestId("xr-error").textContent).toBe("VR could not start: denied"),
    );
    fireEvent.click(screen.getByTestId("xr-enter-vr"));
    await waitFor(() => expect(screen.queryByTestId("xr-error")).toBeNull());
  });

  it("does nothing before the renderer is mounted", async () => {
    fakeXR(["immersive-vr"]);
    render(<XRControls getTarget={() => null} />);
    fireEvent.click(await screen.findByTestId("xr-enter-vr"));
    expect(screen.queryByTestId("xr-error")).toBeNull();
  });

  it("drops its listeners on unmount", async () => {
    const { xr, listeners } = fakeXR(["immersive-vr"]);
    const { target, hasListener } = fakeTarget();
    const { unmount } = render(<XRControls getTarget={() => target} />);
    fireEvent.click(await screen.findByTestId("xr-enter-vr"));
    expect(hasListener()).toBe(true);
    unmount();
    expect(xr.removeEventListener).toHaveBeenCalledWith("devicechange", expect.any(Function));
    expect(listeners.size).toBe(0);
    expect(hasListener()).toBe(false);
  });
});

describe("XRControls bridge", () => {
  const playback = (over: Partial<{ currentFrame: number; playing: boolean }> = {}) => ({
    currentFrame: 2,
    totalFrames: 8,
    playing: false,
    onSeek: vi.fn(),
    onPlayPause: vi.fn(),
    ...over,
  });

  it("hands the page's playback and measurement to the renderer on entry", async () => {
    fakeXR(["immersive-vr"]);
    const { target } = fakeTarget();
    const pb = playback();
    const onToggle = vi.fn();
    const onClear = vi.fn();
    render(
      <XRControls
        getTarget={() => target}
        playback={pb}
        onToggleMeasureAtom={onToggle}
        onClearMeasurement={onClear}
      />,
    );
    fireEvent.click(await screen.findByTestId("xr-enter-vr"));
    const bridge = target.setXRBridge.mock.calls[0][0]!;
    // Set before the session request, which needs the click's activation.
    expect(target.setXRBridge.mock.invocationCallOrder[0]).toBeLessThan(
      target.enterXR.mock.invocationCallOrder[0],
    );
    expect(bridge.playback!.getState()).toEqual({ frame: 2, total: 8, playing: false });
    bridge.playback!.togglePlay();
    bridge.playback!.seek(5);
    expect(pb.onPlayPause).toHaveBeenCalled();
    expect(pb.onSeek).toHaveBeenCalledWith(5);
    bridge.measure!.toggleAtom(3);
    bridge.measure!.clear();
    expect(onToggle).toHaveBeenCalledWith(3);
    expect(onClear).toHaveBeenCalled();
  });

  it("reads the latest props and re-sends when what the page offers changes", async () => {
    fakeXR(["immersive-vr"]);
    const { target, emit } = fakeTarget();
    const { rerender } = render(<XRControls getTarget={() => target} />);
    fireEvent.click(await screen.findByTestId("xr-enter-vr"));
    expect(target.setXRBridge.mock.calls[0][0]).toEqual({
      playback: undefined,
      measure: undefined,
    });
    emit("immersive-vr");
    const pb = playback({ currentFrame: 6, playing: true });
    rerender(<XRControls getTarget={() => target} playback={pb} />);
    const bridge = target.setXRBridge.mock.lastCall![0]!;
    expect(bridge.playback!.getState()).toEqual({ frame: 6, total: 8, playing: true });
    rerender(<XRControls getTarget={() => target} playback={{ ...pb, currentFrame: 7 }} />);
    expect(bridge.playback!.getState().frame).toBe(7);
  });
});

describe("XRControls editing", () => {
  it("hands over the page's editing, and withdraws it while a session runs", async () => {
    fakeXR(["immersive-vr"]);
    const { target, emit } = fakeTarget();
    const edit = { panel: vi.fn() } as unknown as XREditBridge;
    const { rerender } = render(<XRControls getTarget={() => target} edit={edit} />);
    fireEvent.click(await screen.findByTestId("xr-enter-vr"));
    expect(target.setXRBridge.mock.calls[0][0]!.edit).toBe(edit);
    emit("immersive-vr");
    // Builder's Flow mode: the headset only shows the result.
    rerender(<XRControls getTarget={() => target} />);
    expect(target.setXRBridge.mock.lastCall![0]!.edit).toBeUndefined();
  });
});

describe("makeXRBridge", () => {
  it("falls back to the props it was made with once the page withdraws them", () => {
    const onSeek = vi.fn();
    const onToggle = vi.fn();
    const props: { current: Parameters<typeof makeXRBridge>[0]["current"] } = {
      current: {
        playback: { currentFrame: 1, totalFrames: 3, playing: false, onSeek, onPlayPause: vi.fn() },
        onToggleMeasureAtom: onToggle,
      },
    };
    const bridge = makeXRBridge(props);
    props.current = {};
    expect(bridge.playback!.getState().frame).toBe(1);
    bridge.playback!.seek(2);
    expect(onSeek).toHaveBeenCalledWith(2);
    bridge.measure!.toggleAtom(4);
    expect(onToggle).toHaveBeenCalledWith(4);
    expect(() => bridge.measure!.clear()).not.toThrow();
  });
});
