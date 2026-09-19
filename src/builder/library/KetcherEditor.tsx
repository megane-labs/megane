/**
 * Ketcher (EPAM's open-source 2D sketcher) mounted with its standalone
 * Indigo engine, so drawing needs no server. This module is loaded lazily
 * by `SketchModal`: the sketcher and its WASM engine are an order of
 * magnitude larger than the Builder itself and only needed when the user
 * opens the sketch dialog.
 */

import { Editor } from "ketcher-react";
import { StandaloneStructServiceProvider } from "ketcher-standalone/dist/binaryWasm";
import type { Ketcher } from "ketcher-core";
import "ketcher-react/dist/index.css";

const structServiceProvider = new StandaloneStructServiceProvider();

export interface KetcherEditorProps {
  /** Receives the Ketcher instance once the sketcher is ready. */
  onInit: (ketcher: Ketcher) => void;
  onError?: (message: string) => void;
}

export default function KetcherEditor({ onInit, onError }: KetcherEditorProps) {
  return (
    <Editor
      staticResourcesUrl=""
      structServiceProvider={structServiceProvider}
      errorHandler={(message) => onError?.(message)}
      onInit={onInit}
      disableMacromoleculesEditor
    />
  );
}
