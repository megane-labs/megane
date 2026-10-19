/**
 * Ambient declarations for the `@megane/*` aliases. The actual modules live
 * under `../src/*` (the shared megane frontend) and are resolved by webpack
 * at bundle time via the alias in webpack.config.js. We declare them here so
 * tsc does not try to follow the alias into the parent source tree (which
 * would force tsc to emit those files outside our rootDir).
 *
 * Because the real types cannot be imported, the declarations the host relies
 * on are mirrored here. `tests/types/jupyterlab-shim.ts` compares the mirrors
 * with the real modules under the root `tsc --noEmit`, so a renamed, removed
 * or retyped prop fails the root type check instead of slipping through.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

declare module "@megane/components/MeganeViewer" {
  import type { ComponentType } from "react";
  import type { SelectionState, Measurement } from "@megane/types";

  /** Mirror of `MeganeViewerUiOptions` (src/components/MeganeViewer.tsx). */
  export interface MeganeViewerUiOptions {
    pipelineEditor: boolean;
    resetView: boolean;
    viewAxes: boolean;
    perfHud: boolean;
    timeline: boolean;
    tooltip: boolean;
    measurement: boolean;
  }

  /** Mirror of `MeganeCameraState` (src/renderer/MoleculeRenderer.ts). */
  export interface MeganeCameraState {
    mode: "perspective" | "orthographic";
    position: [number, number, number];
    target: [number, number, number];
    zoom: number;
    up?: [number, number, number];
  }

  /**
   * Mirror of `MeganeViewer`'s props, without the deprecated legacy
   * bond/label/vector source callbacks the viewer never calls — so passing
   * one from this host is a type error. `preParsed` is a
   * `StructureParseResult`, left opaque because this host never reads it.
   */
  export interface MeganeViewerProps {
    playing?: boolean;
    fps?: number;
    onSeek?: (frame: number) => void;
    onPlayPause?: () => void;
    onFpsChange?: (fps: number) => void;
    onUploadStructure: (file: File, preParsed?: unknown) => void;
    onUploadTrajectory?: (file: File) => void;
    onFrameChange?: (frame: number) => void;
    onSelectionChange?: (selection: SelectionState) => void;
    onMeasurementChange?: (measurement: Measurement | null) => void;
    ui?: Partial<MeganeViewerUiOptions>;
    width?: string | number;
    height?: string | number;
    testContext?: string;
    initialCameraState?: MeganeCameraState | null;
    onCameraStateChange?: (state: MeganeCameraState) => void;
  }

  export const MeganeViewer: ComponentType<MeganeViewerProps>;
}

declare module "@megane/components/ErrorBoundary" {
  import type { ComponentType, ReactNode } from "react";
  export const ErrorBoundary: ComponentType<{ children?: ReactNode; context?: string }>;
}

declare module "@megane/hooks/useMeganeLocal" {
  /** The part of `MeganeLocalState` (src/hooks/useMeganeLocal.ts) this host uses. */
  export interface MeganeLocalState {
    loadFile: (pdb: File, topFile?: File) => Promise<void>;
    loadXtc: (xtc: File) => Promise<void>;
  }
  export function useMeganeLocal(): MeganeLocalState;
}

declare module "@megane/pipeline/store" {
  export const usePipelineStore: {
    getState(): {
      openFile(
        file: File,
        opts?: { mode?: "replace" | "merge"; companions?: File[] },
      ): Promise<void>;
      [key: string]: any;
    };
    setState(snapshot: any): void;
  };
}

declare module "@megane/pipeline/companionFiles" {
  export function companionFileName(node: { type?: unknown }): string | null;
}

declare module "@megane/pipeline/storeSnapshot" {
  export type PipelineStoreSnapshot = Record<string, unknown>;
  export function capturePipelineStore(state: any): PipelineStoreSnapshot;
}

declare module "@megane/components/ThemeSync" {
  export function ThemeSync(): null;
}

declare module "@megane/stores/usePlaybackStore" {
  export const usePlaybackStore: {
    getState(): { seekFrame(index: number): void; [key: string]: any };
    [key: string]: any;
  };
}

declare module "@megane/hosts/classifyStandaloneFile" {
  export interface StandaloneFileClassification {
    kind: "structure" | "trajectory-only" | "spectrum" | "volumetric";
    errorMessage?: string;
    loadFailureHint?: string;
  }
  export function classifyStandaloneFile(fileName: string): StandaloneFileClassification;
  export function siblingTopologyName(fileName: string): string | null;
}

declare module "@megane/styles/megane.css";

declare module "@megane/tour/useTour" {
  export function useTour(opts: {
    host: "webapp" | "vscode" | "jupyterlab" | "ipywidget";
    autoStartDelayMs?: number;
  }): { startTour: () => void };
}

declare module "@megane/types" {
  export interface SelectionState {
    atoms: number[];
  }
  export interface Measurement {
    atoms: number[];
    type: "distance" | "angle" | "dihedral";
    value: number;
    label: string;
  }
}

declare module "@megane/builder/host" {
  export interface BuilderSaveRequest {
    name: string;
    text: string;
    format: "xyz" | "pdb" | "mol";
  }
  export interface BuilderHost {
    save?: (file: BuilderSaveRequest) => Promise<string | null | void>;
    tools?: boolean;
    toolBridge?: import("@megane/builder/tools/bridge").ToolBridge;
    scopeShortcuts?: boolean;
  }
}

declare module "@megane/builder/tools/bridgeProtocol" {
  export interface BridgeServer {
    id: string;
    kind: "stdio" | "http";
    description: string;
    fingerprint?: string;
  }
  export type BridgeRequest =
    | { type: "tools:servers"; requestId: number }
    | { type: "tools:connect"; requestId: number; server: string }
    | {
        type: "tools:call";
        requestId: number;
        server: string;
        name: string;
        arguments: Record<string, unknown>;
        timeoutMs: number;
      }
    | { type: "tools:cancel"; requestId: number }
    | { type: "tools:disconnect"; server: string }
    | { type: "tools:openSettings" };
}

declare module "@megane/builder/tools/bridge" {
  import type { BridgeRequest, BridgeServer } from "@megane/builder/tools/bridgeProtocol";
  export interface BridgePort {
    post: (message: BridgeRequest) => void;
    listen: (handler: (message: unknown) => void) => () => void;
  }
  /** Opaque here: the labextension only passes connections through to the Builder. */
  export type ToolConnection = unknown;
  export interface ToolBridge {
    configHint: string;
    listServers: () => Promise<BridgeServer[]>;
    connect: (serverId: string) => Promise<ToolConnection>;
    openSettings?: () => void;
  }
  export function createMessageBridge(
    port: BridgePort,
    options: { configHint: string; openSettings?: boolean },
  ): ToolBridge;
}

declare module "@megane/builder/mount" {
  import type { BuilderHost } from "@megane/builder/host";
  export interface MountedBuilder {
    open(file: File): Promise<boolean>;
    dispose(): void;
  }
  export function mountBuilder(el: HTMLElement, host?: BuilderHost): MountedBuilder;
}

declare module "@megane/builder/open" {
  export function openStructureFile(file: File): Promise<boolean>;
}

declare module "@megane/builder/store" {
  export const useBuilderStore: {
    getState(): { closeDocument(): void; [key: string]: any };
  };
}

declare module "@megane/remote/fileSource" {
  export interface RemoteFileEntry {
    name: string;
    path: string;
    isDir: boolean;
    size?: number | null;
  }
  export interface RemoteDirListing {
    path: string;
    parent: string | null;
    entries: RemoteFileEntry[];
  }
  export interface BrowsableRemoteFileSource {
    mode: "browse";
    label: string;
    initialPath?: () => string;
    list(path: string): Promise<RemoteDirListing>;
    read(path: string): Promise<File>;
  }
  export type RemoteFileSource = BrowsableRemoteFileSource | { mode: "native"; [key: string]: any };
  export function setRemoteFileSource(source: RemoteFileSource | null): void;
}
