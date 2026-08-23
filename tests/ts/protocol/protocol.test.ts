import { describe, it, expect } from "vitest";
import {
  decodeHeader,
  decodeSnapshot,
  decodeFrame,
  decodeMetadata,
  MSG_SNAPSHOT,
  MSG_FRAME,
  MSG_METADATA,
} from "@/protocol/protocol";

const MAGIC = 0x4e47454d; // "MEGN" little-endian

/** Build a valid binary header. */
function makeHeader(msgType: number, flags: number = 0): ArrayBuffer {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, MAGIC, true);
  view.setUint8(4, msgType);
  view.setUint8(5, flags);
  return buf;
}

describe("decodeHeader", () => {
  it("decodes a valid snapshot header", () => {
    const buf = makeHeader(MSG_SNAPSHOT);
    const { msgType, flags } = decodeHeader(buf);
    expect(msgType).toBe(MSG_SNAPSHOT);
    expect(flags).toBe(0);
  });

  it("decodes a valid frame header", () => {
    const buf = makeHeader(MSG_FRAME, 0x03);
    const { msgType, flags } = decodeHeader(buf);
    expect(msgType).toBe(MSG_FRAME);
    expect(flags).toBe(0x03);
  });

  it("throws on invalid magic", () => {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setUint32(0, 0xdeadbeef, true);
    expect(() => decodeHeader(buf)).toThrow("Invalid magic");
  });
});

describe("decodeSnapshot", () => {
  /** Build a minimal snapshot binary (no bond orders, no box). */
  function makeSnapshotBuffer(opts: {
    nAtoms: number;
    nBonds: number;
    positions: number[];
    elements: number[];
    bonds: number[];
    bondOrders?: number[];
    box?: number[];
    boxOrigin?: number[];
    symmetryOps?: string[];
  }): ArrayBuffer {
    const { nAtoms, nBonds, positions, elements, bonds, bondOrders, box, boxOrigin, symmetryOps } =
      opts;

    let flags = 0;
    if (bondOrders) flags |= 0x01; // HAS_BOND_ORDERS
    if (box) flags |= 0x02; // HAS_BOX
    if (boxOrigin) flags |= 0x08; // HAS_BOX_ORIGIN
    if (symmetryOps) flags |= 0x10; // HAS_SYMMETRY_OPS
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

    return buf;
  }

  it("decodes symmetry ops when the flag is set", () => {
    const buf = makeSnapshotBuffer({
      nAtoms: 1,
      nBonds: 0,
      positions: [0, 0, 0],
      elements: [6],
      bonds: [],
      symmetryOps: ["x, y, z", "-x+1/2,y+1/2,-z"],
    });
    const snap = decodeSnapshot(buf);
    expect(snap.symmetryOps).toEqual(["x, y, z", "-x+1/2,y+1/2,-z"]);
  });

  it("leaves symmetryOps unset without the flag", () => {
    const buf = makeSnapshotBuffer({
      nAtoms: 1,
      nBonds: 0,
      positions: [0, 0, 0],
      elements: [6],
      bonds: [],
    });
    expect(decodeSnapshot(buf).symmetryOps).toBeUndefined();
  });

  it("decodes atom and bond counts", () => {
    const buf = makeSnapshotBuffer({
      nAtoms: 3,
      nBonds: 2,
      positions: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      elements: [8, 1, 1],
      bonds: [0, 1, 0, 2],
    });
    const snap = decodeSnapshot(buf);
    expect(snap.nAtoms).toBe(3);
    expect(snap.nBonds).toBe(2);
  });

  it("decodes positions correctly", () => {
    const pos = [1.5, 2.5, 3.5, 4.5, 5.5, 6.5];
    const buf = makeSnapshotBuffer({
      nAtoms: 2,
      nBonds: 0,
      positions: pos,
      elements: [6, 8],
      bonds: [],
    });
    const snap = decodeSnapshot(buf);
    for (let i = 0; i < pos.length; i++) {
      expect(snap.positions[i]).toBeCloseTo(pos[i], 5);
    }
  });

  it("decodes elements correctly", () => {
    const buf = makeSnapshotBuffer({
      nAtoms: 3,
      nBonds: 0,
      positions: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      elements: [8, 1, 1],
      bonds: [],
    });
    const snap = decodeSnapshot(buf);
    expect(snap.elements[0]).toBe(8); // O
    expect(snap.elements[1]).toBe(1); // H
    expect(snap.elements[2]).toBe(1); // H
  });

  it("decodes bonds correctly", () => {
    const buf = makeSnapshotBuffer({
      nAtoms: 3,
      nBonds: 2,
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      elements: [8, 1, 1],
      bonds: [0, 1, 0, 2],
    });
    const snap = decodeSnapshot(buf);
    expect(snap.bonds[0]).toBe(0);
    expect(snap.bonds[1]).toBe(1);
    expect(snap.bonds[2]).toBe(0);
    expect(snap.bonds[3]).toBe(2);
  });

  it("decodes bond orders when flag is set", () => {
    const buf = makeSnapshotBuffer({
      nAtoms: 3,
      nBonds: 2,
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      elements: [8, 1, 1],
      bonds: [0, 1, 0, 2],
      bondOrders: [1, 2],
    });
    const snap = decodeSnapshot(buf);
    expect(snap.bondOrders).not.toBeNull();
    expect(snap.bondOrders![0]).toBe(1);
    expect(snap.bondOrders![1]).toBe(2);
  });

  it("decodes box when flag is set", () => {
    const boxValues = [10, 0, 0, 0, 10, 0, 0, 0, 10];
    const buf = makeSnapshotBuffer({
      nAtoms: 1,
      nBonds: 0,
      positions: [0, 0, 0],
      elements: [6],
      bonds: [],
      box: boxValues,
    });
    const snap = decodeSnapshot(buf);
    expect(snap.box).not.toBeNull();
    for (let i = 0; i < 9; i++) {
      expect(snap.box![i]).toBeCloseTo(boxValues[i], 5);
    }
  });

  it("decodes box origin when flag is set", () => {
    const boxValues = [10, 0, 0, 0, 10, 0, 0, 0, 10];
    const originValues = [160, 0, 600];
    const buf = makeSnapshotBuffer({
      nAtoms: 1,
      nBonds: 0,
      positions: [0, 0, 0],
      elements: [6],
      bonds: [],
      box: boxValues,
      boxOrigin: originValues,
    });
    const snap = decodeSnapshot(buf);
    expect(snap.boxOrigin).not.toBeNull();
    for (let i = 0; i < 3; i++) {
      expect(snap.boxOrigin![i]).toBeCloseTo(originValues[i], 5);
    }
    // Box still decodes correctly alongside the origin.
    expect(snap.box![0]).toBeCloseTo(10, 5);
  });

  it("returns null boxOrigin when flag is not set", () => {
    const buf = makeSnapshotBuffer({
      nAtoms: 1,
      nBonds: 0,
      positions: [0, 0, 0],
      elements: [6],
      bonds: [],
      box: [10, 0, 0, 0, 10, 0, 0, 0, 10],
    });
    const snap = decodeSnapshot(buf);
    expect(snap.boxOrigin).toBeNull();
  });

  it("returns null bondOrders when flag is not set", () => {
    const buf = makeSnapshotBuffer({
      nAtoms: 2,
      nBonds: 1,
      positions: [0, 0, 0, 1, 0, 0],
      elements: [6, 6],
      bonds: [0, 1],
    });
    const snap = decodeSnapshot(buf);
    expect(snap.bondOrders).toBeNull();
  });

  it("returns null atomChainIds and atomBFactors (wire format does not yet carry them)", () => {
    const buf = makeSnapshotBuffer({
      nAtoms: 2,
      nBonds: 1,
      positions: [0, 0, 0, 1, 0, 0],
      elements: [6, 6],
      bonds: [0, 1],
    });
    const snap = decodeSnapshot(buf);
    expect(snap.atomChainIds).toBeNull();
    expect(snap.atomBFactors).toBeNull();
  });
});

describe("decodeFrame", () => {
  it("decodes frame id and positions", () => {
    const nAtoms = 3;
    const buf = new ArrayBuffer(8 + 4 + 4 + nAtoms * 12);
    const view = new DataView(buf);
    let offset = 0;

    // Header
    view.setUint32(offset, MAGIC, true);
    offset += 4;
    view.setUint8(offset, MSG_FRAME);
    offset += 1;
    view.setUint8(offset, 0);
    offset += 1;
    offset += 2; // reserved

    // frameId
    view.setUint32(offset, 42, true);
    offset += 4;
    // nAtoms
    view.setUint32(offset, nAtoms, true);
    offset += 4;
    // positions
    const positions = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0];
    for (const p of positions) {
      view.setFloat32(offset, p, true);
      offset += 4;
    }

    const frame = decodeFrame(buf);
    expect(frame.frameId).toBe(42);
    expect(frame.nAtoms).toBe(3);
    for (let i = 0; i < positions.length; i++) {
      expect(frame.positions[i]).toBeCloseTo(positions[i], 5);
    }
    // No flags → no per-frame elements/box.
    expect(frame.elements).toBeUndefined();
    expect(frame.box).toBeUndefined();
  });

  it("decodes per-frame elements and box behind flags", () => {
    const nAtoms = 2;
    const HAS_BOX = 0x02;
    const HAS_FRAME_ELEMENTS = 0x04;
    const elemPad = Math.ceil(nAtoms / 4) * 4; // padded elements block
    const buf = new ArrayBuffer(8 + 4 + 4 + nAtoms * 12 + elemPad + 9 * 4);
    const view = new DataView(buf);
    let offset = 0;
    view.setUint32(offset, MAGIC, true);
    offset += 4;
    view.setUint8(offset, MSG_FRAME);
    offset += 1;
    view.setUint8(offset, HAS_BOX | HAS_FRAME_ELEMENTS);
    offset += 1;
    offset += 2; // reserved
    view.setUint32(offset, 7, true);
    offset += 4; // frameId
    view.setUint32(offset, nAtoms, true);
    offset += 4; // nAtoms
    for (const p of [1, 2, 3, 4, 5, 6]) {
      view.setFloat32(offset, p, true);
      offset += 4;
    }
    // elements (padded): C(6), O(8)
    view.setUint8(offset, 6);
    view.setUint8(offset + 1, 8);
    offset += elemPad;
    // box diagonal 11
    for (let i = 0; i < 9; i++) {
      view.setFloat32(offset, i === 0 || i === 4 || i === 8 ? 11 : 0, true);
      offset += 4;
    }

    const frame = decodeFrame(buf);
    expect(frame.nAtoms).toBe(2);
    expect(Array.from(frame.elements!)).toEqual([6, 8]);
    expect(frame.box![0]).toBeCloseTo(11, 5);
    expect(frame.box![4]).toBeCloseTo(11, 5);
  });
});

describe("decodeMetadata", () => {
  it("decodes basic metadata", () => {
    const buf = new ArrayBuffer(20);
    const view = new DataView(buf);

    // Header
    view.setUint32(0, MAGIC, true);
    view.setUint8(4, MSG_METADATA);
    view.setUint8(5, 0);

    // Metadata
    view.setUint32(8, 100, true); // nFrames
    view.setFloat32(12, 2.0, true); // timestepPs
    view.setUint32(16, 327, true); // nAtoms

    const meta = decodeMetadata(buf);
    expect(meta.nFrames).toBe(100);
    expect(meta.timestepPs).toBeCloseTo(2.0);
    expect(meta.nAtoms).toBe(327);
    expect(meta.pdbName).toBeUndefined();
    expect(meta.xtcName).toBeUndefined();
  });

  it("decodes metadata with file names", () => {
    const encoder = new TextEncoder();
    const pdbName = "test.pdb";
    const xtcName = "traj.xtc";
    const pdbBytes = encoder.encode(pdbName);
    const xtcBytes = encoder.encode(xtcName);

    const totalSize = 20 + 2 + pdbBytes.length + 2 + xtcBytes.length;
    const buf = new ArrayBuffer(totalSize);
    const view = new DataView(buf);

    // Header
    view.setUint32(0, MAGIC, true);
    view.setUint8(4, MSG_METADATA);

    // Metadata
    view.setUint32(8, 50, true);
    view.setFloat32(12, 1.0, true);
    view.setUint32(16, 100, true);

    // File names
    let pos = 20;
    view.setUint16(pos, pdbBytes.length, true);
    pos += 2;
    new Uint8Array(buf, pos, pdbBytes.length).set(pdbBytes);
    pos += pdbBytes.length;
    view.setUint16(pos, xtcBytes.length, true);
    pos += 2;
    new Uint8Array(buf, pos, xtcBytes.length).set(xtcBytes);

    const meta = decodeMetadata(buf);
    expect(meta.nFrames).toBe(50);
    expect(meta.pdbName).toBe("test.pdb");
    expect(meta.xtcName).toBe("traj.xtc");
  });
});
