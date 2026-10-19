/**
 * A file a host delivers in pieces so the viewer can draw frame 0 before the
 * whole file has arrived.
 *
 * The VS Code extension host posts a document to its webview as one message,
 * and a 73 MB trajectory took ~5 s to cross under code-server before parsing
 * could even start. For a file larger than {@link PROGRESSIVE_HEAD_BYTES} +
 * {@link PROGRESSIVE_TAIL_BYTES} it now posts the head and the tail first and
 * the middle after: frame 0 of a multi-frame XYZ / multi-MODEL PDB is in the
 * head (a PDB's CONECT records are in the tail), and an ASE `.traj` keeps
 * frame 0 in the head and the offset table that locates it in the tail
 * (`parseStructureHead`). The extension host mirrors the two sizes
 * (`vscode-megane/src/extension.ts`); a unit test pins them together.
 */

/** Bytes of the file's start sent first — the parse client's first prefix read. */
export const PROGRESSIVE_HEAD_BYTES = 8 * 1024 * 1024;
/** Bytes of the file's end sent first — the parse client's PDB tail read. */
export const PROGRESSIVE_TAIL_BYTES = 4 * 1024 * 1024;

/** The pieces of a progressively delivered file, as the viewer receives them. */
export interface ProgressiveFile {
  name: string;
  /** Size of the whole file. */
  size: number;
  /** The first {@link PROGRESSIVE_HEAD_BYTES} bytes. */
  head: Uint8Array;
  /** The last {@link PROGRESSIVE_TAIL_BYTES} bytes. */
  tail: Uint8Array;
  /** The whole file, once the middle has arrived (rejects if it never does). */
  file: Promise<File>;
}

/** Whether a host should deliver a file of `size` bytes in pieces. */
export function shouldDeliverProgressively(size: number): boolean {
  return size > PROGRESSIVE_HEAD_BYTES + PROGRESSIVE_TAIL_BYTES;
}

/** Rebuild the whole file's bytes from its head, middle and tail. */
export function assembleFileBytes(
  size: number,
  head: Uint8Array,
  middle: Uint8Array,
  tail: Uint8Array,
): Uint8Array<ArrayBuffer> {
  if (head.length + middle.length + tail.length !== size) {
    throw new Error(
      `file pieces do not add up: ${head.length} + ${middle.length} + ${tail.length} != ${size}`,
    );
  }
  const bytes = new Uint8Array(size);
  bytes.set(head, 0);
  bytes.set(middle, head.length);
  bytes.set(tail, size - tail.length);
  return bytes;
}

/**
 * Start receiving a file whose head and tail arrived first. Returns the
 * {@link ProgressiveFile} to load, and `deliverMiddle` to call when the rest
 * arrives; `fail` rejects the pending whole file instead (e.g. the host never
 * sends it). `toFile` wraps the assembled bytes (hosts pass `fileFromBytes`,
 * so the parsers read them without the Blob API).
 */
export function receiveProgressiveFile(
  name: string,
  size: number,
  head: Uint8Array,
  tail: Uint8Array,
  toFile: (bytes: Uint8Array<ArrayBuffer>, name: string) => File,
): {
  file: ProgressiveFile;
  deliverMiddle: (middle: Uint8Array) => void;
  fail: (reason: unknown) => void;
} {
  let resolve!: (file: File) => void;
  let reject!: (reason: unknown) => void;
  const whole = new Promise<File>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A caller that only ever awaits the head must not see an unhandled rejection.
  whole.catch(() => {});
  return {
    file: { name, size, head, tail, file: whole },
    deliverMiddle: (middle) => {
      try {
        resolve(toFile(assembleFileBytes(size, head, middle, tail), name));
      } catch (err) {
        reject(err);
      }
    },
    fail: reject,
  };
}
