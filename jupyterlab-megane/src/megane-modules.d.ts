/**
 * Ambient declarations for the `@megane/*` aliases. The actual modules live
 * under `../src/*` (the shared megane frontend) and are resolved by webpack
 * at bundle time via the alias in webpack.config.js. We declare them here so
 * tsc does not try to follow the alias into the parent source tree (which
 * would force tsc to emit those files outside our rootDir).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

declare module "@megane/components/MeganeViewer" {
  import type { ComponentType } from "react";
  export const MeganeViewer: ComponentType<any>;
}

declare module "@megane/components/ErrorBoundary" {
  import type { ComponentType, ReactNode } from "react";
  export const ErrorBoundary: ComponentType<{ children?: ReactNode; context?: string }>;
}

declare module "@megane/hooks/useMeganeLocal" {
  export function useMeganeLocal(): any;
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
    scopeShortcuts?: boolean;
  }
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
