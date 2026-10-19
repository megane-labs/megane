/**
 * A document model that never holds the file's contents.
 *
 * The megane viewers only read a structure file, and they read it as raw bytes
 * from the Jupyter server (`readServerFileBytes`). Opening it through the
 * stock `text` / `base64` model factories made JupyterLab download it first as
 * a JSON string (base64 for binary files, a third bigger), load that into the
 * document's shared model, and hand it back as one string the viewer then
 * re-encoded — 2–3 s of a 73 MB trajectory's open time, all before parsing.
 *
 * `fileFormat: null` tells the document context to fetch the file's metadata
 * only (JupyterLab 4.1+; an older JupyterLab still sends the content, which
 * `fromString` drops). The model refuses to serialize, so a Save on the viewer
 * tab fails instead of writing an empty file over the user's data.
 */

import { DocumentModel } from "@jupyterlab/docregistry";
import type { DocumentRegistry } from "@jupyterlab/docregistry";

/** Name the megane structure viewers register their widget factories against. */
export const RAW_MODEL_NAME = "megane-raw";

export const READ_ONLY_MESSAGE =
  "megane opens this file read-only; edit it with the text editor (Open With → Editor).";

export class MeganeRawModel extends DocumentModel {
  constructor(options?: DocumentRegistry.IModelOptions) {
    super(options as never);
    this.readOnly = true;
  }

  /** The content is never loaded, so there is nothing to keep. */
  fromString(_value: string): void {
    // Intentionally empty (see module docs).
  }

  /** Saving would write an empty file over the user's data: refuse. */
  toString(): string {
    throw new Error(READ_ONLY_MESSAGE);
  }

  /** As {@link toString}: never serialize. */
  toJSON(): never {
    throw new Error(READ_ONLY_MESSAGE);
  }
}

export class MeganeRawModelFactory implements DocumentRegistry.IModelFactory<MeganeRawModel> {
  readonly name = RAW_MODEL_NAME;
  readonly contentType = "file" as const;
  readonly fileFormat = null;
  readonly collaborative = false;
  private _isDisposed = false;

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  dispose(): void {
    this._isDisposed = true;
  }

  createNew(options: DocumentRegistry.IModelOptions = {}): MeganeRawModel {
    return new MeganeRawModel({ ...options, collaborationEnabled: false });
  }

  preferredLanguage(_path: string): string {
    return "";
  }
}
