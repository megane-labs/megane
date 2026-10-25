/**
 * Read `File`s whose bytes the host already holds in memory without going
 * back through the Blob API.
 *
 * The JupyterLab DocWidget (Contents model) and the VSCode webview (extension
 * host message) receive a document's bytes as a plain buffer and wrap them in a
 * `File` only because every parser takes one. Reading that File back
 * (`file.arrayBuffer()`, `file.slice().text()`) is an asynchronous round-trip
 * through the browser's blob storage: on a 73 MB trajectory it measured 0.7–2.2 s
 * in JupyterLab while the viewer's first frame was rendering, versus ~50 ms to
 * copy the buffer we already had. `fileFromBytes` remembers the buffer next to
 * the File it builds, and the `read*` helpers use it when it is there — any
 * other File (a user pick, a drag-drop) reads exactly as before.
 */

const resident = new WeakMap<Blob, Uint8Array>();

/** Wrap `bytes` in a `File` whose reads skip the Blob API (see module docs). */
export function fileFromBytes(bytes: Uint8Array, name: string, options?: FilePropertyBag): File {
  const file = new File([bytes as BlobPart], name, options);
  resident.set(file, bytes);
  return file;
}

/** Whether `blob` was built by {@link fileFromBytes} (its bytes are in memory). */
export function isResident(blob: Blob): boolean {
  return resident.has(blob);
}

function residentRange(blob: Blob, start: number, end: number | undefined): Uint8Array | null {
  const bytes = resident.get(blob);
  if (!bytes) return null;
  return bytes.subarray(start, end ?? bytes.length);
}

/**
 * The bytes of `blob[start, end)` as a fresh ArrayBuffer the caller owns (safe
 * to transfer to a worker; the resident copy stays intact).
 */
export function readBlobBuffer(blob: Blob, start = 0, end?: number): Promise<ArrayBuffer> {
  const range = residentRange(blob, start, end);
  if (range) return Promise.resolve(range.slice().buffer);
  const whole = start === 0 && end === undefined;
  return (whole ? blob : blob.slice(start, end)).arrayBuffer();
}

/** `blob[start, end)` decoded as UTF-8, like `blob.slice(start, end).text()`. */
export function readBlobText(blob: Blob, start = 0, end?: number): Promise<string> {
  const range = residentRange(blob, start, end);
  if (range) return Promise.resolve(new TextDecoder().decode(range));
  const whole = start === 0 && end === undefined;
  return (whole ? blob : blob.slice(start, end)).text();
}
