/**
 * Binary protocol decoder for megane.
 *
 * Format matches python/megane/protocol.py.
 * Header: "MEGN" (4 bytes) + msg_type (u8) + flags (u8) + reserved (u16)
 */

import type { Snapshot, Frame, TrajectoryMeta } from "../types";

const MAGIC = 0x4e47454d; // "MEGN" in little-endian

export const MSG_SNAPSHOT = 0;
export const MSG_FRAME = 1;
export const MSG_METADATA = 2;

const HAS_BOND_ORDERS = 0x01;
const HAS_BOX = 0x02;
const HAS_FRAME_ELEMENTS = 0x04;
const HAS_BOX_ORIGIN = 0x08;
const HAS_SYMMETRY_OPS = 0x10;

export function decodeHeader(buffer: ArrayBuffer): {
  msgType: number;
  flags: number;
} {
  const view = new DataView(buffer);
  const magic = view.getUint32(0, true);
  if (magic !== MAGIC) {
    throw new Error(`Invalid magic: 0x${magic.toString(16)}, expected 0x${MAGIC.toString(16)}`);
  }
  return {
    msgType: view.getUint8(4),
    flags: view.getUint8(5),
  };
}

export function decodeSnapshot(buffer: ArrayBuffer): Snapshot {
  const view = new DataView(buffer);
  const flags = view.getUint8(5);
  let offset = 8; // skip header

  const nAtoms = view.getUint32(offset, true);
  offset += 4;
  const nBonds = view.getUint32(offset, true);
  offset += 4;

  // Positions: Float32Array[nAtoms * 3]
  const positions = new Float32Array(buffer, offset, nAtoms * 3);
  offset += nAtoms * 3 * 4;

  // Elements: Uint8Array[nAtoms], padded to 4-byte alignment
  const elements = new Uint8Array(buffer, offset, nAtoms);
  offset += nAtoms;
  offset += (4 - (offset % 4)) % 4; // alignment padding

  // Bonds: Uint32Array[nBonds * 2]
  const bonds = new Uint32Array(buffer, offset, nBonds * 2);
  offset += nBonds * 2 * 4;

  // Bond orders (optional, if HAS_BOND_ORDERS flag)
  let bondOrders: Uint8Array | null = null;
  if (flags & HAS_BOND_ORDERS) {
    bondOrders = new Uint8Array(buffer, offset, nBonds);
    offset += nBonds;
    offset += (4 - (offset % 4)) % 4; // alignment padding
  }

  // Box (optional, if HAS_BOX flag)
  let box: Float32Array | null = null;
  if (flags & HAS_BOX) {
    box = new Float32Array(buffer, offset, 9);
    offset += 9 * 4;
  }

  // Box origin (optional, if HAS_BOX_ORIGIN flag) — follows the box.
  let boxOrigin: Float32Array | null = null;
  if (flags & HAS_BOX_ORIGIN) {
    boxOrigin = new Float32Array(buffer, offset, 3);
    offset += 3 * 4;
  }

  // Symmetry operations (optional, if HAS_SYMMETRY_OPS flag): u32 byte length
  // + newline-joined utf-8 `x,y,z` strings. The snapshot stays the asymmetric
  // unit; the pipeline's symmetry node applies these downstream.
  let symmetryOps: string[] | undefined;
  if (flags & HAS_SYMMETRY_OPS) {
    const byteLen = view.getUint32(offset, true);
    offset += 4;
    const raw = new Uint8Array(buffer, offset, byteLen);
    symmetryOps = new TextDecoder().decode(raw).split("\n");
    offset += byteLen;
    offset += (4 - (offset % 4)) % 4; // alignment padding
  }

  return {
    nAtoms,
    nBonds,
    nFileBonds: nBonds,
    positions,
    elements,
    bonds,
    bondOrders,
    box,
    boxOrigin,
    atomChainIds: null,
    atomBFactors: null,
    ...(symmetryOps && { symmetryOps }),
  };
}

export function decodeFrame(buffer: ArrayBuffer): Frame {
  const view = new DataView(buffer);
  const flags = view.getUint8(5);
  let offset = 8; // skip header

  const frameId = view.getUint32(offset, true);
  offset += 4;
  const nAtoms = view.getUint32(offset, true);
  offset += 4;

  const positions = new Float32Array(buffer, offset, nAtoms * 3);
  offset += nAtoms * 3 * 4;

  // Optional per-frame elements (heterogeneous topology), padded to 4 bytes.
  let elements: Uint8Array | undefined;
  if (flags & HAS_FRAME_ELEMENTS) {
    elements = new Uint8Array(buffer, offset, nAtoms);
    offset += Math.ceil(nAtoms / 4) * 4;
  }

  // Optional per-frame unit cell (heterogeneous cell).
  let box: Float32Array | undefined;
  if (flags & HAS_BOX) {
    box = new Float32Array(buffer, offset, 9);
    offset += 9 * 4;
  }

  return { frameId, nAtoms, positions, ...(elements ? { elements } : {}), ...(box ? { box } : {}) };
}

export function decodeMetadata(buffer: ArrayBuffer): TrajectoryMeta {
  const view = new DataView(buffer);
  const offset = 8; // skip header

  const nFrames = view.getUint32(offset, true);
  const timestepPs = view.getFloat32(offset + 4, true);
  const nAtoms = view.getUint32(offset + 8, true);

  let pdbName: string | undefined;
  let xtcName: string | undefined;

  // Parse file names if buffer has extended data (backward compatible)
  if (buffer.byteLength > 20) {
    const decoder = new TextDecoder();
    let pos = 20;
    const pdbLen = view.getUint16(pos, true);
    pos += 2;
    if (pdbLen > 0) {
      pdbName = decoder.decode(new Uint8Array(buffer, pos, pdbLen));
    }
    pos += pdbLen;
    const xtcLen = view.getUint16(pos, true);
    pos += 2;
    if (xtcLen > 0) {
      xtcName = decoder.decode(new Uint8Array(buffer, pos, xtcLen));
    }
  }

  return { nFrames, timestepPs, nAtoms, pdbName, xtcName };
}
