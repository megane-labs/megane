import { describe, it, expect, vi } from "vitest";
import { createMessageFileSource } from "@/remote/messageFiles";

function reply(data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { data }));
}

describe("createMessageFileSource", () => {
  it("posts a pickFile request and resolves with the host's file", async () => {
    const post = vi.fn();
    const source = createMessageFileSource(post);
    expect(source.mode).toBe("native");
    expect(source.label).toBe("Open from remote...");

    const pending = source.pick({ kind: "structure", extensions: [".pdb", ".gro"] });
    expect(post).toHaveBeenCalledWith({
      type: "pickFile",
      id: 1,
      kind: "structure",
      extensions: [".pdb", ".gro"],
    });
    // Unrelated messages and other ids are ignored.
    reply(undefined);
    reply({ type: "loadFile" });
    reply({ type: "pickFileResult", id: 99 });
    reply({
      type: "pickFileResult",
      id: 1,
      filename: "a.pdb",
      contentBytes: new TextEncoder().encode("ATOM").buffer,
    });
    const file = await pending;
    expect(file?.name).toBe("a.pdb");
    expect(file?.size).toBe(4);
  });

  it("resolves null when the user cancels", async () => {
    const source = createMessageFileSource(vi.fn(), window, "Pick");
    expect(source.label).toBe("Pick");
    const pending = source.pick({ kind: "trajectory", extensions: [] });
    reply({ type: "pickFileResult", id: 1 });
    await expect(pending).resolves.toBeNull();
  });

  it("rejects with the host's error", async () => {
    const post = vi.fn();
    const source = createMessageFileSource(post);
    const first = source.pick({ kind: "structure", extensions: [] });
    reply({ type: "pickFileResult", id: 1 });
    await first;
    const second = source.pick({ kind: "structure", extensions: [] });
    expect(post.mock.calls[1][0].id).toBe(2);
    reply({ type: "pickFileResult", id: 2, error: "EACCES" });
    await expect(second).rejects.toThrow("EACCES");
  });
});
