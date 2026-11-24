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
import {
  PROGRESSIVE_HEAD_BYTES,
  PROGRESSIVE_TAIL_BYTES,
  receiveProgressiveFile,
  type ProgressiveFile,
} from "@megane/hosts/progressiveFile";

export type ServerRequest = (url: string, init?: RequestInit) => Promise<Response>;

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

/**
 * A document's bytes as the viewer receives them: the whole file, or — for a
 * file large enough to be worth it — its head and tail first and the rest
 * after (see `src/hosts/progressiveFile.ts`), so frame 0 can be drawn before
 * the whole file has crossed the network.
 */
export type ServerFile =
  | { kind: "whole"; bytes: Uint8Array<ArrayBuffer> }
  | { kind: "pieces"; file: ProgressiveFile };

/** How much of a file's start and end {@link readServerFile} fetches first. */
export interface ProgressivePieces {
  head: number;
  tail: number;
}

/**
 * The first pieces to fetch for a file named `name`. An ASE `.traj` needs
 * only its header and frame 0 for a first paint — about 80 kB for 1000 atoms
 * with forces — plus frame 0's offset, which `parse_traj_frame0` finds in the
 * head wherever ASE has since moved the offset table; so a 2 MB head and a
 * token tail let a 3–12 MB optimization trajectory, too small for the default
 * pieces, show frame 0 early. A frame 0 larger than the head (some 20k atoms
 * with forces) is simply drawn once the whole file is in, as before. Other
 * formats take the shared head and tail (src/hosts/progressiveFile.ts), which
 * the multi-frame text readers need.
 */
export function progressivePiecesFor(name: string): ProgressivePieces {
  if (name.toLowerCase().endsWith(".traj")) return { head: 2 * 1024 * 1024, tail: 64 * 1024 };
  return { head: PROGRESSIVE_HEAD_BYTES, tail: PROGRESSIVE_TAIL_BYTES };
}

/** The file's total size from a 206 response's `Content-Range: bytes a-b/total`. */
export function contentRangeTotal(resp: Response): number | null {
  const m = /\/(\d+)\s*$/.exec(resp.headers.get("Content-Range") ?? "");
  return m ? Number(m[1]) : null;
}

async function readRange(
  request: ServerRequest,
  url: string,
  first: number,
  last: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const resp = await request(url, { headers: { Range: `bytes=${first}-${last}` } });
  if (resp.status !== 206) throw new Error(`range ${first}-${last}: HTTP ${resp.status}`);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  if (bytes.length !== last - first + 1) {
    throw new Error(`range ${first}-${last}: got ${bytes.length} bytes`);
  }
  return bytes;
}

/**
 * Read a file from the Jupyter server the way the VS Code extension host
 * delivers one: a file larger than its head + tail ({@link progressivePiecesFor})
 * comes as those first and last bytes (two HTTP range requests), then the
 * middle (a third), so the viewer can draw frame 0 of an ASE `.traj` or a
 * multi-frame XYZ / PDB while the rest is still on its way. Over a remote
 * server that is the difference between waiting for the whole file and
 * waiting for a few megabytes of it.
 *
 * The first request asks for the head by range, which also reveals the size:
 * a smaller file comes back whole (200), or its remainder follows in one more
 * request. A server that ignores ranges, or anything that goes wrong before
 * the head and tail are in, falls back to {@link readServerFileBytes}.
 */
export async function readServerFile(
  contents: Pick<Contents.IManager, "get" | "getDownloadUrl">,
  request: ServerRequest,
  path: string,
  name: string,
  toFile: (bytes: Uint8Array<ArrayBuffer>, name: string) => File,
  pieces: ProgressivePieces = progressivePiecesFor(name),
): Promise<ServerFile> {
  try {
    const url = await contents.getDownloadUrl(path);
    const headResp = await request(url, {
      headers: { Range: `bytes=0-${pieces.head - 1}` },
    });
    if (headResp.status === 200) {
      return { kind: "whole", bytes: new Uint8Array(await headResp.arrayBuffer()) };
    }
    const total = headResp.status === 206 ? contentRangeTotal(headResp) : null;
    if (total === null) throw new Error(`no ranged head: HTTP ${headResp.status}`);
    const head = new Uint8Array(await headResp.arrayBuffer());
    if (total <= pieces.head + pieces.tail) {
      if (head.length >= total) return { kind: "whole", bytes: head };
      const rest = await readRange(request, url, head.length, total - 1);
      const bytes = new Uint8Array(total);
      bytes.set(head, 0);
      bytes.set(rest, head.length);
      return { kind: "whole", bytes };
    }
    const tail = await readRange(request, url, total - pieces.tail, total - 1);
    const { file, deliverMiddle, fail } = receiveProgressiveFile(name, total, head, tail, toFile);
    readRange(request, url, head.length, total - pieces.tail - 1).then(deliverMiddle, fail);
    return { kind: "pieces", file };
  } catch {
    return { kind: "whole", bytes: await readServerFileBytes(contents, request, path) };
  }
}
