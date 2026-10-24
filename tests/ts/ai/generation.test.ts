/**
 * The provider-agnostic generation loop and the reply helpers shared by the
 * viewer's pipeline generator and the Builder's Flow assistant. The provider
 * transports themselves are covered through `generatePipeline` in
 * `client.test.ts`.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  MAX_REPAIR_ROUNDS,
  hasClosedFence,
  lastFencedJSON,
  runGeneration,
  type GenerationSpec,
} from "@/ai/generation";
import type { AIConfig } from "@/ai/config";

const CONFIG: AIConfig = { provider: "openai", model: "gpt-4o", apiKey: "sk-test" };

/** An OpenAI-compatible streaming response whose text is `text`. */
function reply(text: string): Response {
  const body =
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n` +
    "data: [DONE]\n\n";
  return new Response(body, { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runGeneration", () => {
  it("repairs with the spec's diagnosis until it accepts the reply", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(`answer ${++n}`)),
    );
    const diagnose = vi.fn((text: string) =>
      text === "answer 2" ? null : { prompt: `fix ${text}`, errors: [`bad ${text}`] },
    );
    const spec: GenerationSpec = { systemPrompt: "be good", skills: [], diagnose };
    const rounds: [number, string[]][] = [];

    const text = await runGeneration(
      CONFIG,
      spec,
      "go",
      () => {},
      undefined,
      (round, errors) => rounds.push([round, errors]),
    );

    expect(text).toBe("answer 2");
    expect(rounds).toEqual([[1, ["bad answer 1"]]]);
    const last = JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string);
    expect(last.messages.map((m: { content: string }) => m.content)).toEqual([
      "be good",
      "go",
      "answer 1",
      "fix answer 1",
    ]);
  });

  it("stops after the last repair round", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply("never right")),
    );
    const spec: GenerationSpec = {
      systemPrompt: "",
      skills: [],
      diagnose: () => ({ prompt: "again", errors: ["wrong"] }),
    };
    expect(await runGeneration(CONFIG, spec, "go", () => {})).toBe("never right");
    expect(fetch).toHaveBeenCalledTimes(1 + MAX_REPAIR_ROUNDS);
  });
});

describe("reply helpers", () => {
  const isNumbered = (v: unknown): v is { n: number } =>
    typeof v === "object" && v !== null && typeof (v as { n?: unknown }).n === "number";

  it("takes the last fence the caller accepts", () => {
    const text =
      '```json\n{"n": 1}\n```\n```\n{"m": 2}\n```\n```json\nnot json\n```\n```\n{"n": 3}\n```';
    expect(lastFencedJSON(text, isNumbered)).toEqual({ n: 3 });
    expect(lastFencedJSON("no fences", isNumbered)).toBeNull();
  });

  it("tells a closed fence from an open one", () => {
    expect(hasClosedFence("```json\n{}\n```")).toBe(true);
    expect(hasClosedFence("```json\n{")).toBe(false);
  });
});
