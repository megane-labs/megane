import { describe, it, expect, vi, afterEach } from "vitest";
import { MainThreadLoad, mainThreadLoad, watchMainThreadLoad } from "@/utils/mainThreadLoad";

describe("MainThreadLoad", () => {
  it("reports null until the first window closes", () => {
    const m = new MainThreadLoad(1000);
    m.idle(0, 10);
    m.idle(500, 10);
    expect(m.load).toBeNull();
  });

  it("computes the busy share of a window from the idle time inside it", () => {
    const m = new MainThreadLoad(1000);
    // 10 frames of 100 ms, each leaving 75 ms idle → 25 % busy.
    for (let t = 0; t < 1000; t += 100) m.idle(t, 75);
    m.idle(1000, 75);
    expect(m.load).toBeCloseTo(0.25);
  });

  it("charges an idle period to the window that is open when it starts", () => {
    const m = new MainThreadLoad(1000);
    m.idle(0, 50);
    // Closes [0, 1000) with only the first period's 50 ms idle; this period's
    // 900 ms belongs to the next window.
    m.idle(1000, 900);
    expect(m.load).toBeCloseTo(0.95);
    m.idle(2000, 0);
    expect(m.load).toBeCloseTo(0.1);
  });

  it("reads a fully blocked stretch as 100 % busy", () => {
    const m = new MainThreadLoad(1000);
    m.idle(0, 0);
    // No idle period for three seconds: the thread never came up for air.
    m.idle(3000, 50);
    expect(m.load).toBe(1);
  });

  it("clamps an idle sum past the window length to 0 % busy", () => {
    const m = new MainThreadLoad(1000);
    m.idle(0, 1200);
    m.idle(1000, 0);
    expect(m.load).toBe(0);
  });
});

describe("watchMainThreadLoad", () => {
  type Deadline = { timeRemaining(): number };
  const w = window as unknown as {
    requestIdleCallback?: (cb: (d: Deadline) => void) => number;
    cancelIdleCallback?: (h: number) => void;
  };

  afterEach(() => {
    delete w.requestIdleCallback;
    delete w.cancelIdleCallback;
    vi.restoreAllMocks();
  });

  function stubIdleCallbacks() {
    const queue = new Map<number, (d: Deadline) => void>();
    let next = 1;
    const request = vi.fn((cb: (d: Deadline) => void) => {
      queue.set(next, cb);
      return next++;
    });
    const cancel = vi.fn((h: number) => {
      queue.delete(h);
    });
    w.requestIdleCallback = request;
    w.cancelIdleCallback = cancel;
    /** Run the pending callback with `idleMs` of idle time at `nowMs`. */
    const fire = (nowMs: number, idleMs: number) => {
      vi.spyOn(performance, "now").mockReturnValue(nowMs);
      const [handle, cb] = [...queue.entries()][0];
      queue.delete(handle);
      cb({ timeRemaining: () => idleMs });
    };
    return { request, cancel, queue, fire };
  }

  it("is a no-op returning null where requestIdleCallback is missing", () => {
    const release = watchMainThreadLoad();
    expect(mainThreadLoad()).toBeNull();
    expect(() => release()).not.toThrow();
  });

  it("samples idle periods until released and reports the load", () => {
    const { queue, fire, cancel } = stubIdleCallbacks();
    const release = watchMainThreadLoad();
    expect(queue.size).toBe(1);
    fire(0, 20);
    fire(500, 20);
    expect(mainThreadLoad()).toBeNull();
    fire(1000, 20);
    // 40 ms idle in a 1000 ms window → 96 % busy.
    expect(mainThreadLoad()).toBeCloseTo(0.96);
    // Each callback re-arms the next one.
    expect(queue.size).toBe(1);
    release();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(queue.size).toBe(0);
    expect(mainThreadLoad()).toBeNull();
  });

  it("shares one sampler between callers and stops after the last release", () => {
    const { request, cancel } = stubIdleCallbacks();
    const a = watchMainThreadLoad();
    const b = watchMainThreadLoad();
    expect(request).toHaveBeenCalledTimes(1);
    a();
    a(); // a second release from the same caller is ignored
    expect(cancel).not.toHaveBeenCalled();
    b();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
