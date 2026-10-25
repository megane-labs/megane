import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { PerfHud, formatBytes } from "@/components/PerfHud";

type Deadline = { timeRemaining(): number };
const idleWindow = window as unknown as {
  requestIdleCallback?: (cb: (d: Deadline) => void) => number;
  cancelIdleCallback?: (h: number) => void;
};

describe("PerfHud", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders atom and bond counts from props immediately", () => {
    render(<PerfHud atomCount={1234} bondCount={56} getStats={() => null} />);
    expect(screen.getByTestId("perf-hud-atoms")).toHaveTextContent("Atoms 1234");
    expect(screen.getByTestId("perf-hud-bonds")).toHaveTextContent("Bonds 56");
  });

  it("polls getStats immediately and shows rounded fps and draw calls", () => {
    const getStats = vi.fn(() => ({ fps: 59.6, drawCalls: 7 }));
    render(<PerfHud atomCount={10} bondCount={2} getStats={getStats} />);
    // The effect polls once on mount, so values populate without waiting.
    expect(getStats).toHaveBeenCalled();
    expect(screen.getByTestId("perf-hud-fps")).toHaveTextContent("60 FPS");
    expect(screen.getByTestId("perf-hud-draws")).toHaveTextContent("Draws 7");
    // Subsequent interval ticks keep it updated.
    const callsAfterMount = getStats.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(getStats.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  it("shows the memory Megane's data takes, with the raw bytes in data-bytes", () => {
    const getStats = vi.fn(() => ({ fps: 30, drawCalls: 1, memoryBytes: 25 * 1024 * 1024 }));
    render(<PerfHud atomCount={1} bondCount={0} getStats={getStats} />);
    const mem = screen.getByTestId("perf-hud-mem");
    expect(mem).toHaveTextContent("Mem 25.0 MB");
    expect(mem).toHaveAttribute("data-bytes", String(25 * 1024 * 1024));
  });

  it("shows a memory placeholder until the stats carry a byte count", () => {
    render(<PerfHud atomCount={1} bondCount={0} getStats={() => ({ fps: 1, drawCalls: 1 })} />);
    expect(screen.getByTestId("perf-hud-mem")).toHaveTextContent("Mem -- MB");
  });

  it("shows CPU as -- where the main-thread load cannot be measured", () => {
    render(<PerfHud atomCount={1} bondCount={0} getStats={() => null} />);
    const cpu = screen.getByTestId("perf-hud-cpu");
    expect(cpu).toHaveTextContent("CPU --%");
    expect(cpu).not.toHaveAttribute("data-percent");
  });

  describe("with requestIdleCallback", () => {
    let pending: ((d: Deadline) => void) | null = null;

    beforeEach(() => {
      pending = null;
      idleWindow.requestIdleCallback = vi.fn((cb: (d: Deadline) => void) => {
        pending = cb;
        return 1;
      });
      idleWindow.cancelIdleCallback = vi.fn(() => {
        pending = null;
      });
    });

    afterEach(() => {
      delete idleWindow.requestIdleCallback;
      delete idleWindow.cancelIdleCallback;
    });

    /** Let 1 s pass with `idleMs` of idle time handed out at its start. */
    function idleSecond(idleMs: number) {
      act(() => {
        pending?.({ timeRemaining: () => idleMs });
        vi.advanceTimersByTime(1000);
        pending?.({ timeRemaining: () => 0 });
      });
    }

    it("shows the main thread's busy share as CPU %", () => {
      render(<PerfHud atomCount={1} bondCount={0} getStats={() => null} />);
      idleSecond(700);
      // The window closed on the second callback; the next poll picks it up.
      act(() => {
        vi.advanceTimersByTime(500);
      });
      const cpu = screen.getByTestId("perf-hud-cpu");
      expect(cpu).toHaveTextContent("CPU 30%");
      expect(cpu).toHaveAttribute("data-percent", "30");
    });

    it("stops sampling idle time when the HUD unmounts", () => {
      const { unmount } = render(<PerfHud atomCount={1} bondCount={0} getStats={() => null} />);
      expect(idleWindow.requestIdleCallback).toHaveBeenCalled();
      unmount();
      expect(idleWindow.cancelIdleCallback).toHaveBeenCalled();
    });

    it("freezes CPU and memory to placeholders when stable, keeping the live values in data-*", () => {
      const getStats = () => ({ fps: 42, drawCalls: 3, memoryBytes: 2048 });
      render(<PerfHud atomCount={5} bondCount={1} getStats={getStats} stable />);
      idleSecond(500);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      const cpu = screen.getByTestId("perf-hud-cpu");
      expect(cpu).toHaveTextContent("CPU --%");
      expect(cpu).toHaveAttribute("data-percent", "50");
      const mem = screen.getByTestId("perf-hud-mem");
      expect(mem).toHaveTextContent("Mem -- MB");
      expect(mem).toHaveAttribute("data-bytes", "2048");
    });
  });

  it("ignores null stats (renderer not ready)", () => {
    const getStats = vi.fn(() => null);
    render(<PerfHud atomCount={0} bondCount={0} getStats={getStats} />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByTestId("perf-hud-fps")).toHaveTextContent("0 FPS");
  });

  it("renders a fixed fps placeholder when stable", () => {
    const getStats = vi.fn(() => ({ fps: 42, drawCalls: 3 }));
    render(<PerfHud atomCount={5} bondCount={1} getStats={getStats} stable />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    // FPS frozen, but draw calls (deterministic) still update.
    expect(screen.getByTestId("perf-hud-fps")).toHaveTextContent("-- FPS");
    expect(screen.getByTestId("perf-hud-draws")).toHaveTextContent("Draws 3");
  });

  it("defaults its left offset to clear the Reset View button", () => {
    render(<PerfHud atomCount={1} bondCount={1} getStats={() => null} />);
    expect(screen.getByTestId("perf-hud")).toHaveStyle({ left: "92px" });
  });

  it("honours an explicit left offset (Reset View hidden)", () => {
    render(<PerfHud atomCount={1} bondCount={1} getStats={() => null} left={12} />);
    expect(screen.getByTestId("perf-hud")).toHaveStyle({ left: "12px" });
  });

  it("stops polling after unmount", () => {
    const getStats = vi.fn(() => ({ fps: 30, drawCalls: 1 }));
    const { unmount } = render(<PerfHud atomCount={1} bondCount={1} getStats={getStats} />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    const callsBefore = getStats.mock.calls.length;
    unmount();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(getStats.mock.calls.length).toBe(callsBefore);
  });
});

describe("formatBytes", () => {
  it("prints MB with one decimal below 100 MB", () => {
    expect(formatBytes(0)).toBe("0.0 MB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });

  it("prints whole MB from 100 MB", () => {
    expect(formatBytes(512 * 1024 * 1024)).toBe("512 MB");
  });

  it("prints GB with two decimals from 1 GB", () => {
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.50 GB");
  });
});
