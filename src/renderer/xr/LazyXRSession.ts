/**
 * The renderer's handle on the immersive view, without the immersive view's
 * code: `XRSessionController` (the session, controllers, hands, the headset
 * panel) is only needed in a headset, so it is loaded as its own chunk once
 * the page finds a mode the browser supports (`preload`), or at the latest
 * when a session starts. Until then the state reads as idle and listeners and
 * the bridge are held for the controller.
 */
import type * as THREE from "three";
import type { MeganeXRState, XRBridge, XRHost, XRSessionController } from "./XRSessionController";
import type { XRPanelControl } from "./XRPanel";
import type { MeganeXRMode } from "./xrSupport";

/** What `getState()` reads before an immersive view was ever loaded. */
export const IDLE_XR_STATE: MeganeXRState = {
  presenting: false,
  mode: null,
  frames: 0,
  scale: 1,
  position: [0, 0, 0],
  panel: [],
  measuring: false,
  labels: 0,
  editing: false,
  dragging: false,
};

type Listener = (state: MeganeXRState) => void;
type Pose = { position: [number, number, number]; quaternion: [number, number, number, number] };

export class LazyXRSession {
  private controller: XRSessionController | null = null;
  private loading: Promise<XRSessionController> | null = null;
  private bridge: XRBridge | null = null;
  private readonly listeners = new Map<Listener, (() => void) | null>();
  private disposed = false;

  constructor(
    private readonly host: XRHost,
    private readonly importController: () => Promise<{
      XRSessionController: new (host: XRHost) => XRSessionController;
    }> = () => import("./XRSessionController"),
  ) {}

  get presenting(): boolean {
    return this.controller?.presenting ?? false;
  }

  getState(): MeganeXRState {
    return this.controller?.getState() ?? IDLE_XR_STATE;
  }

  /** Load the controller now, so a later `enter` starts without waiting. */
  preload(): Promise<XRSessionController> {
    this.loading ??= this.importController().then(({ XRSessionController }) => {
      const controller = new XRSessionController(this.host);
      controller.setBridge(this.bridge);
      for (const listener of this.listeners.keys()) {
        this.listeners.set(listener, controller.subscribe(listener));
      }
      this.controller = controller;
      if (this.disposed) controller.dispose();
      return controller;
    });
    return this.loading;
  }

  /**
   * Start a session. Loaded already (the usual case: the page preloads as
   * soon as it offers the buttons), the request goes out within the click
   * that asked for it, as the browser requires.
   */
  enter(mode: MeganeXRMode): Promise<void> {
    if (this.controller) return this.controller.enter(mode);
    return this.preload().then((controller) => controller.enter(mode));
  }

  exit(): Promise<void> {
    return this.controller?.exit() ?? Promise.resolve();
  }

  setBridge(bridge: XRBridge | null): void {
    this.bridge = bridge;
    this.controller?.setBridge(bridge);
  }

  panelControlPose(id: XRPanelControl): Pose | null {
    return this.controller?.panelControlPose(id) ?? null;
  }

  aimPose(at: THREE.Vector3): Pose | null {
    return this.controller?.aimPose(at) ?? null;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.set(listener, this.controller?.subscribe(listener) ?? null);
    return () => {
      this.listeners.get(listener)?.();
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.disposed = true;
    this.controller?.dispose();
  }
}
