import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { IDLE_XR_STATE, LazyXRSession } from "@/renderer/xr/LazyXRSession";
import type { XRBridge, XRHost, XRSessionController } from "@/renderer/xr/XRSessionController";

const pose = { position: [1, 2, 3], quaternion: [0, 0, 0, 1] } as const;

/** A stand-in controller recording what the facade forwards to it. */
function fakeController() {
  const unsubscribe = vi.fn();
  const controller = {
    presenting: true,
    getState: vi.fn(() => ({ ...IDLE_XR_STATE, presenting: true, frames: 7 })),
    setBridge: vi.fn(),
    subscribe: vi.fn(() => unsubscribe),
    enter: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    panelControlPose: vi.fn(() => pose),
    aimPose: vi.fn(() => pose),
    dispose: vi.fn(),
  };
  return { controller, unsubscribe };
}

function lazySession() {
  const { controller, unsubscribe } = fakeController();
  const host = {} as XRHost;
  const constructed: XRHost[] = [];
  const importController = vi.fn(async () => ({
    XRSessionController: class {
      constructor(h: XRHost) {
        constructed.push(h);
        return controller as unknown as XRSessionController;
      }
    } as unknown as new (host: XRHost) => XRSessionController,
  }));
  const session = new LazyXRSession(host, importController);
  return { session, controller, unsubscribe, importController, constructed, host };
}

describe("LazyXRSession", () => {
  it("reads as idle and answers no poses before the controller is loaded", async () => {
    const { session, importController } = lazySession();
    expect(session.presenting).toBe(false);
    expect(session.getState()).toBe(IDLE_XR_STATE);
    expect(session.panelControlPose("play" as never)).toBeNull();
    expect(session.aimPose(new THREE.Vector3())).toBeNull();
    await expect(session.exit()).resolves.toBeUndefined();
    session.dispose();
    expect(importController).not.toHaveBeenCalled();
  });

  it("hands the controller the bridge and listeners given before it loaded", async () => {
    const { session, controller, unsubscribe, importController, constructed, host } = lazySession();
    const bridge = {} as XRBridge;
    const listener = vi.fn();
    session.setBridge(bridge);
    const stop = session.subscribe(listener);

    const [a, b] = [session.preload(), session.preload()];
    expect(await a).toBe(await b);
    expect(importController).toHaveBeenCalledTimes(1);
    expect(constructed).toEqual([host]);
    expect(controller.setBridge).toHaveBeenCalledWith(bridge);
    expect(controller.subscribe).toHaveBeenCalledWith(listener);

    // Once loaded, everything goes straight to the controller.
    expect(session.presenting).toBe(true);
    expect(session.getState().frames).toBe(7);
    expect(session.panelControlPose("play" as never)).toBe(pose);
    expect(session.aimPose(new THREE.Vector3())).toBe(pose);
    session.setBridge(null);
    expect(controller.setBridge).toHaveBeenLastCalledWith(null);
    await session.exit();
    expect(controller.exit).toHaveBeenCalledTimes(1);

    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    session.dispose();
    expect(controller.dispose).toHaveBeenCalledTimes(1);
  });

  it("loads the controller on enter, and enters at once when it is loaded", async () => {
    const { session, controller } = lazySession();
    await session.enter("immersive-vr" as never);
    expect(controller.enter).toHaveBeenCalledWith("immersive-vr");
    await session.enter("immersive-ar" as never);
    expect(controller.enter).toHaveBeenLastCalledWith("immersive-ar");

    // A listener added after the load subscribes directly.
    const listener = vi.fn();
    session.subscribe(listener)();
    expect(controller.subscribe).toHaveBeenCalledWith(listener);
  });

  it("disposes a controller that finishes loading after the session was disposed", async () => {
    const { session, controller } = lazySession();
    const loading = session.preload();
    session.dispose();
    await loading;
    expect(controller.dispose).toHaveBeenCalledTimes(1);
  });
});
