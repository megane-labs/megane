/**
 * The provider-agnostic generation loop and the reply helpers shared by the
 * viewer's pipeline generator and the Builder's Flow assistant. The provider
 * transports themselves are covered through `generatePipeline` in
 * `client.test.ts`.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  MAX_REPAIR_ROUNDS,
  fencePattern,
  lastJSONPayload,
  looksLikePayload,
  runGeneration,
  streamError,
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

  const value = (text: string) => lastJSONPayload(text, isNumbered)?.value ?? null;

  it("takes the last fence the caller accepts", () => {
    const text =
      '```json\n{"n": 1}\n```\n```\n{"m": 2}\n```\n```json\nnot json\n```\n```\n{"n": 3}\n```';
    expect(lastJSONPayload(text, isNumbered)).toEqual({ value: { n: 3 }, fenced: true });
    expect(value("no fences")).toBeNull();
  });

  it("reads a fence whatever its label and its case", () => {
    for (const label of ["JSON", "Json", "jsonc", "json5", "javascript", ""]) {
      expect(value("```" + label + '\n{"n": 1}\n```\nDone.')).toEqual({ n: 1 });
    }
    expect(value('```json {"n": 2}```')).toEqual({ n: 2 });
    expect(value('```{"n": 3}```')).toEqual({ n: 3 });
  });

  it("reads bare JSON, before or after prose, and marks it unfenced", () => {
    expect(lastJSONPayload('{"n": 1}\nFixed it.', isNumbered)).toEqual({
      value: { n: 1 },
      fenced: false,
    });
    expect(value('Here it is:\n{\n  "n": 2\n}\nDone.')).toEqual({ n: 2 });
    // Braces in strings and in prose do not confuse it.
    expect(value('Use {curly} braces. {"q": "}{", "n": 4}')).toEqual({ q: "}{", n: 4 });
    expect(value('{"q": "a \\" } b", "n": 5}')).toEqual({ q: 'a " } b', n: 5 });
    // A JSON value the caller does not take is skipped, with what it nests.
    expect(value('{"wrap": {"n": 1}}')).toBeNull();
  });

  it("prefers whichever payload comes last, fenced or bare", () => {
    expect(value('```json\n{"n": 1}\n```\n{"n": 2}')).toEqual({ n: 2 });
    expect(value('{"n": 1}\n```json\n{"n": 2}\n```')).toEqual({ n: 2 });
  });

  it("waits for an object that is still streaming", () => {
    expect(value('{"n": 1, "more": [')).toBeNull();
    expect(value('```json\n{"n": 1, "more": [')).toBeNull();
    // Once it closes it counts, even before the fence does.
    expect(value('```json\n{"n": 1}\n')).toEqual({ n: 1 });
    // A brace inside a string does not close the object.
    expect(value('{"n": 1, "s": "}')).toBeNull();
  });

  it("matches fences with any label", () => {
    expect("```JSON\n{}\n```".replace(fencePattern(), "")).toBe("");
    const bodies = [...'```jsonc\n{"a":1}\n``` ```\n2\n```'.matchAll(fencePattern())];
    expect(bodies.map((m) => m[1].trim())).toEqual(['{"a":1}', "2"]);
  });

  it("tells an attempted payload from prose", () => {
    expect(looksLikePayload("```json\n{}\n```")).toBe(true);
    expect(looksLikePayload("```json\n{")).toBe(true);
    expect(looksLikePayload('{ "version": 3, "nodes": [')).toBe(true);
    expect(looksLikePayload("There is no water here, so there is nothing to hide.")).toBe(false);
    expect(looksLikePayload("Use a {curly} brace.")).toBe(false);
  });
});

describe("streamError", () => {
  it("names what the provider reported, however it shaped it", () => {
    expect(streamError({ type: "overloaded_error", message: "Overloaded" }).message).toBe(
      "The provider stopped the reply with an error (overloaded_error: Overloaded). Please try again.",
    );
    expect(streamError({ code: 502, message: "Provider disconnected" }).message).toContain(
      "(502: Provider disconnected)",
    );
    expect(streamError({ code: "rate_limited" }).message).toContain("(rate_limited)");
    expect(streamError({ message: "boom" }).message).toContain("(boom)");
    for (const empty of [null, undefined, "oops", {}]) {
      expect(streamError(empty).message).toBe(
        "The provider stopped the reply with an error. Please try again.",
      );
    }
  });
});
