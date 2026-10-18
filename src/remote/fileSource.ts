/**
 * Files on the machine megane runs on, as opposed to the one the browser runs on.
 *
 * A Load node's own button opens the browser's file dialog, which only sees the
 * user's computer. When megane runs somewhere else — `megane serve` on a
 * cluster behind an SSH tunnel, JupyterLab on a remote server, VS Code Remote
 * (SSH / WSL / containers) or code-server — the files the user wants are on
 * that other machine. A host that can reach them registers a
 * `RemoteFileSource` here, and the Load nodes show a second button for it.
 *
 * Two shapes, because the hosts differ in what they offer:
 *
 * - `native`: the host has its own file dialog that already browses the
 *   remote side (VS Code's `showOpenDialog`); megane just asks it for a file.
 * - `browse`: the host exposes a directory tree (megane serve's `/api/files`,
 *   Jupyter's Contents API) and megane draws the dialog itself
 *   (`RemoteFileDialog`).
 *
 * The source is page-wide (one host per page), so a module-level slot is
 * enough; every viewer on the page reads the same one.
 */

import { useSyncExternalStore } from "react";

/** What a Load node is asking for, which picks the dialog's filter. */
export type RemoteFileKind = "structure" | "trajectory";

export interface RemoteFileRequest {
  kind: RemoteFileKind;
  /** Accepted extensions, with the dot (`.pdb`), for the dialog's filter. */
  extensions: readonly string[];
}

export interface RemoteFileEntry {
  name: string;
  /** The path to pass back to `list` / `read`. */
  path: string;
  isDir: boolean;
  /** Bytes, when the host reports it. */
  size?: number | null;
}

export interface RemoteDirListing {
  /** The listed directory's path ("" for the root). */
  path: string;
  /** The parent's path, or null at the root. */
  parent: string | null;
  entries: RemoteFileEntry[];
}

export interface NativeRemoteFileSource {
  mode: "native";
  /** The button's text, e.g. "Open from remote...". */
  label: string;
  /** Resolves to the chosen file, or null when the user cancels. */
  pick(request: RemoteFileRequest): Promise<File | null>;
}

export interface BrowsableRemoteFileSource {
  mode: "browse";
  label: string;
  /** Where the dialog opens the first time (the root when omitted). */
  initialPath?: () => string;
  list(path: string): Promise<RemoteDirListing>;
  read(path: string): Promise<File>;
}

export type RemoteFileSource = NativeRemoteFileSource | BrowsableRemoteFileSource;

let current: RemoteFileSource | null = null;
const listeners = new Set<() => void>();

/** Register the page's remote file source (null removes it). */
export function setRemoteFileSource(source: RemoteFileSource | null): void {
  if (current === source) return;
  current = source;
  for (const listener of listeners) listener();
}

export function getRemoteFileSource(): RemoteFileSource | null {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The registered source, re-rendering when a host registers one later. */
export function useRemoteFileSource(): RemoteFileSource | null {
  return useSyncExternalStore(subscribe, getRemoteFileSource, getRemoteFileSource);
}
