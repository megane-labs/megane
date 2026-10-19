/**
 * Read a file from the Jupyter server as raw bytes.
 *
 * The `/files/` endpoint (`Contents.IManager.getDownloadUrl`) streams the file
 * as-is, where `contents.get(path, { format: "base64" })` wraps it in a JSON
 * string a third bigger that must then be decoded. A drive that cannot serve a
 * download URL falls back to that base64 read.
 */

import type { Contents } from "@jupyterlab/services";
import { decodeBase64 } from "@megane/utils/base64";

export type ServerRequest = (url: string) => Promise<Response>;

export async function readServerFileBytes(
  contents: Pick<Contents.IManager, "get" | "getDownloadUrl">,
  request: ServerRequest,
  path: string,
): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const resp = await request(await contents.getDownloadUrl(path));
    if (resp.ok) return new Uint8Array(await resp.arrayBuffer());
  } catch {
    // Fall through to the Contents API.
  }
  const model = await contents.get(path, { type: "file", format: "base64", content: true });
  return decodeBase64(String(model.content ?? ""));
}
