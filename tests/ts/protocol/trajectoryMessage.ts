/**
 * Test helper: build MSG_FRAME / MSG_TRAJECTORY messages the way
 * python/megane/protocol.py encodes them (encode_frame / encode_trajectory).
 */

const MAGIC = 0x4e47454d; // "MEGN" little-endian
const MSG_FRAME = 1;
const MSG_TRAJECTORY = 3;

/** A positions-only frame message. */
export function frameMessage(frameId: number, positions: number[]): Uint8Array {
  const nAtoms = positions.length / 3;
  const buf = new ArrayBuffer(16 + positions.length * 4);
  const view = new DataView(buf);
  view.setUint32(0, MAGIC, true);
  view.setUint8(4, MSG_FRAME);
  view.setUint32(8, frameId, true);
  view.setUint32(12, nAtoms, true);
  positions.forEach((p, i) => view.setFloat32(16 + i * 4, p, true));
  return new Uint8Array(buf);
}

/** Bundle frame messages into one trajectory message. */
export function trajectoryMessage(frames: Uint8Array[]): ArrayBuffer {
  const tableEnd = 12 + 4 * (frames.length + 1);
  const total = frames.reduce((n, f) => n + f.byteLength, tableEnd);
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  view.setUint32(0, MAGIC, true);
  view.setUint8(4, MSG_TRAJECTORY);
  view.setUint32(8, frames.length, true);
  let offset = tableEnd;
  frames.forEach((f, i) => {
    view.setUint32(12 + 4 * i, offset, true);
    new Uint8Array(buf, offset, f.byteLength).set(f);
    offset += f.byteLength;
  });
  view.setUint32(12 + 4 * frames.length, offset, true);
  return buf;
}
