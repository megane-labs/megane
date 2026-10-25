/**
 * Test helper: build MSG_SNAPSHOT messages the way python/megane/protocol.py
 * encodes them (encode_snapshot).
 */

import { MSG_SNAPSHOT } from "@/protocol/protocol";

const MAGIC = 0x4e47454d; // "MEGN" little-endian

/** Build a MSG_SNAPSHOT message; each optional field sets its flag. */
export function makeSnapshotBuffer(opts: {
  nAtoms: number;
  nBonds: number;
  positions: number[];
  elements: number[];
  bonds: number[];
  bondOrders?: number[];
  box?: number[];
  boxOrigin?: number[];
  symmetryOps?: string[];
  nFileBonds?: number;
}): ArrayBuffer {
  const {
    nAtoms,
    nBonds,
    positions,
    elements,
    bonds,
    bondOrders,
    box,
    boxOrigin,
    symmetryOps,
    nFileBonds,
  } = opts;

  let flags = 0;
  if (bondOrders) flags |= 0x01; // HAS_BOND_ORDERS
  if (box) flags |= 0x02; // HAS_BOX
  if (boxOrigin) flags |= 0x08; // HAS_BOX_ORIGIN
  if (symmetryOps) flags |= 0x10; // HAS_SYMMETRY_OPS
  if (nFileBonds !== undefined) flags |= 0x20; // HAS_FILE_BOND_COUNT
  const symRaw = symmetryOps ? new TextEncoder().encode(symmetryOps.join("\n")) : null;

  // Calculate total size
  const elemPadding = (4 - ((8 + 4 + 4 + nAtoms * 12 + nAtoms) % 4)) % 4;
  let size = 8 + 4 + 4 + nAtoms * 12 + nAtoms + elemPadding + nBonds * 8;
  if (bondOrders) {
    const boPadding = (4 - ((size + nBonds) % 4)) % 4;
    size += nBonds + boPadding;
  }
  if (box) size += 36;
  if (boxOrigin) size += 12;
  if (symRaw) size += 4 + symRaw.length + ((4 - ((4 + symRaw.length) % 4)) % 4);
  if (nFileBonds !== undefined) size += 4;

  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  let offset = 0;

  // Header
  view.setUint32(offset, MAGIC, true);
  offset += 4;
  view.setUint8(offset, MSG_SNAPSHOT);
  offset += 1;
  view.setUint8(offset, flags);
  offset += 1;
  offset += 2; // reserved

  // nAtoms, nBonds
  view.setUint32(offset, nAtoms, true);
  offset += 4;
  view.setUint32(offset, nBonds, true);
  offset += 4;

  // Positions
  for (let i = 0; i < positions.length; i++) {
    view.setFloat32(offset, positions[i], true);
    offset += 4;
  }

  // Elements
  for (let i = 0; i < elements.length; i++) {
    view.setUint8(offset, elements[i]);
    offset += 1;
  }
  offset += elemPadding;

  // Bonds
  for (let i = 0; i < bonds.length; i++) {
    view.setUint32(offset, bonds[i], true);
    offset += 4;
  }

  // Bond orders
  if (bondOrders) {
    for (let i = 0; i < bondOrders.length; i++) {
      view.setUint8(offset, bondOrders[i]);
      offset += 1;
    }
    const boPadding = (4 - (offset % 4)) % 4;
    offset += boPadding;
  }

  // Box
  if (box) {
    for (let i = 0; i < 9; i++) {
      view.setFloat32(offset, box[i], true);
      offset += 4;
    }
  }

  // Box origin (follows the box)
  if (boxOrigin) {
    for (let i = 0; i < 3; i++) {
      view.setFloat32(offset, boxOrigin[i], true);
      offset += 4;
    }
  }

  // Symmetry ops (length-prefixed utf-8 blob, padded to 4 bytes)
  if (symRaw) {
    view.setUint32(offset, symRaw.length, true);
    offset += 4;
    new Uint8Array(buf, offset, symRaw.length).set(symRaw);
    offset += symRaw.length;
    offset += (4 - (offset % 4)) % 4;
  }

  // File-declared bond count (last field)
  if (nFileBonds !== undefined) {
    view.setUint32(offset, nFileBonds, true);
    offset += 4;
  }

  return buf;
}
