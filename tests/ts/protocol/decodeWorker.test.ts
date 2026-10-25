import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import type { WorkerRequest, WorkerResponse } from "@/protocol/decode.worker";
import { makeSnapshotBuffer } from "./snapshotMessage";
import { frameMessage } from "./trajectoryMessage";

// The decode worker behind the public `WorkerPool`. Its replies go through a
// real structured clone with a transfer list, as a browser worker's do, so a
// transfer list that names one ArrayBuffer twice fails here the way it fails
// in the browser (DataCloneError).

const { port1, port2 } = new MessageChannel();
let replies: WorkerResponse[] = [];

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};
const windowPostMessage = scope.postMessage;

beforeAll(async () => {
  scope.postMessage = (message, transfer) => {
    port1.postMessage(message, transfer as never);
    replies.push(receiveMessageOnPort(port2)!.message as WorkerResponse);
  };
  await import("@/protocol/decode.worker");
});

afterAll(() => {
  scope.postMessage = windowPostMessage;
  scope.onmessage = null;
  port1.close();
  port2.close();
});

function decode(buffer: ArrayBuffer): WorkerResponse {
  replies = [];
  scope.onmessage!({ data: { id: 7, type: "decode", buffer } } as MessageEvent<WorkerRequest>);
  expect(replies).toHaveLength(1);
  expect(replies[0].id).toBe(7);
  return replies[0];
}

interface DecodedSnapshot {
  nAtoms: number;
  nBonds: number;
  nFileBonds: number;
  positions: Float32Array;
  elements: Uint8Array;
  bonds: Uint32Array;
  bondOrders: Uint8Array | null;
  box: Float32Array | null;
  boxOrigin: Float32Array | null;
  symmetryOps?: string[];
}

describe("decode worker", () => {
  it("decodes a snapshot with every optional section", () => {
    const buffer = makeSnapshotBuffer({
      nAtoms: 3,
      nBonds: 2,
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      elements: [8, 1, 1],
      bonds: [0, 1, 0, 2],
      bondOrders: [1, 2],
      box: [10, 0, 0, 0, 11, 0, 0, 0, 12],
      boxOrigin: [-1, -2, -3],
      symmetryOps: ["x,y,z", "-x,-y,z"],
    });
    const reply = decode(buffer);
    expect(reply.error).toBeUndefined();
    expect(reply.type).toBe("snapshot");
    const data = reply.data as DecodedSnapshot;
    expect(data.nAtoms).toBe(3);
    expect(data.nBonds).toBe(2);
    expect(data.nFileBonds).toBe(2);
    expect(Array.from(data.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Array.from(data.elements)).toEqual([8, 1, 1]);
    expect(Array.from(data.bonds)).toEqual([0, 1, 0, 2]);
    expect(Array.from(data.bondOrders!)).toEqual([1, 2]);
    expect(Array.from(data.box!)).toEqual([10, 0, 0, 0, 11, 0, 0, 0, 12]);
    expect(Array.from(data.boxOrigin!)).toEqual([-1, -2, -3]);
    expect(data.symmetryOps).toEqual(["x,y,z", "-x,-y,z"]);
  });

  it("decodes a bare snapshot and moves its buffer instead of copying it", () => {
    const buffer = makeSnapshotBuffer({
      nAtoms: 2,
      nBonds: 0,
      positions: [0, 0, 0, 1, 1, 1],
      elements: [6, 6],
      bonds: [],
    });
    const reply = decode(buffer);
    expect(reply.type).toBe("snapshot");
    const data = reply.data as DecodedSnapshot;
    expect(Array.from(data.positions)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(data.bonds.length).toBe(0);
    expect(data.bondOrders).toBeNull();
    expect(data.box).toBeNull();
    expect(data.boxOrigin).toBeNull();
    expect(data.symmetryOps).toBeUndefined();
    // Transferred to the receiver: the worker's copy is detached.
    expect(buffer.byteLength).toBe(0);
  });

  it("decodes a frame", () => {
    const message = frameMessage(4, [1, 2, 3, 4, 5, 6]);
    const reply = decode(message.buffer as ArrayBuffer);
    expect(reply.type).toBe("frame");
    const data = reply.data as { frameId: number; nAtoms: number; positions: Float32Array };
    expect(data.frameId).toBe(4);
    expect(data.nAtoms).toBe(2);
    expect(Array.from(data.positions)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("reports a message it cannot decode", () => {
    const reply = decode(new ArrayBuffer(8));
    expect(reply.type).toBe("error");
    expect(reply.error).toMatch(/magic/i);
  });
});
