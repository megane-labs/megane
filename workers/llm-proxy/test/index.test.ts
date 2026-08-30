import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import worker from "../src/index";
import {
  isAllowedOrigin,
  corsHeaders,
  parseAllowedOrigins,
  sanitizeMessages,
  sanitizeTools,
  isRateLimited,
  PER_MINUTE_LIMIT,
  PER_DAY_LIMIT,
  DEFAULT_PLAMO_MODEL,
  DEFAULT_PLAMO_FALLBACK_MODELS,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_OPENROUTER_FALLBACK_MODELS,
  DEFAULT_PROVIDERS,
  MAX_MODELS,
  PLAMO_API_URL,
  OPENROUTER_API_URL,
  buildModelList,
  buildProviderList,
  buildAttempts,
  type Env,
} from "../src/proxy";

const ALLOWED_ORIGIN = "https://megane-labs.github.io";
const SECOND_ORIGIN = "https://megane.tech-office-mori.com";

class FakeKV {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string, _opts?: unknown): Promise<void> {
    this.store.set(key, value);
  }
}

/** Env with both provider keys set — the fully-configured deployment. */
function makeEnv(kv: FakeKV = new FakeKV()): Env {
  return {
    PLAMO_API_KEY: "plamo-test-key",
    OPENROUTER_API_KEY: "openrouter-test-key",
    ALLOWED_ORIGIN,
    RATE_LIMIT_KV: kv as unknown as Env["RATE_LIMIT_KV"],
  };
}

/** Env with only the PLaMo key — OpenRouter must be skipped. */
function makePlamoOnlyEnv(): Env {
  return { ...makeEnv(), OPENROUTER_API_KEY: undefined };
}

/** An env whose ALLOWED_ORIGIN lists two comma-separated origins. */
function makeMultiOriginEnv(kv: FakeKV = new FakeKV()): Env {
  return { ...makeEnv(kv), ALLOWED_ORIGIN: `${ALLOWED_ORIGIN}, ${SECOND_ORIGIN}` };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ─── CORS helpers ────────────────────────────────────────────────────

describe("parseAllowedOrigins", () => {
  it("returns a single-element list for one origin", () => {
    expect(parseAllowedOrigins(makeEnv())).toEqual([ALLOWED_ORIGIN]);
  });

  it("splits, trims, and drops blank entries for a comma-separated list", () => {
    const env = { ...makeEnv(), ALLOWED_ORIGIN: ` ${ALLOWED_ORIGIN} , ,${SECOND_ORIGIN}, ` };
    expect(parseAllowedOrigins(env)).toEqual([ALLOWED_ORIGIN, SECOND_ORIGIN]);
  });
});

describe("isAllowedOrigin", () => {
  it("accepts the configured origin", () => {
    expect(isAllowedOrigin(ALLOWED_ORIGIN, makeEnv())).toBe(true);
  });

  it("rejects other origins", () => {
    expect(isAllowedOrigin("https://evil.example", makeEnv())).toBe(false);
  });

  it("rejects a missing origin", () => {
    expect(isAllowedOrigin(null, makeEnv())).toBe(false);
  });

  it("accepts any origin in a comma-separated list", () => {
    const env = makeMultiOriginEnv();
    expect(isAllowedOrigin(ALLOWED_ORIGIN, env)).toBe(true);
    expect(isAllowedOrigin(SECOND_ORIGIN, env)).toBe(true);
    expect(isAllowedOrigin("https://evil.example", env)).toBe(false);
  });
});

describe("corsHeaders", () => {
  it("returns Access-Control headers for the allowed origin", () => {
    const headers = corsHeaders(ALLOWED_ORIGIN, makeEnv());
    expect(headers["Access-Control-Allow-Origin"]).toBe(ALLOWED_ORIGIN);
    expect(headers.Vary).toBe("Origin");
  });

  it("returns no headers for a disallowed origin", () => {
    expect(corsHeaders("https://evil.example", makeEnv())).toEqual({});
  });

  it("echoes back the matching origin from a multi-origin list", () => {
    const env = makeMultiOriginEnv();
    expect(corsHeaders(SECOND_ORIGIN, env)["Access-Control-Allow-Origin"]).toBe(SECOND_ORIGIN);
    expect(corsHeaders(ALLOWED_ORIGIN, env)["Access-Control-Allow-Origin"]).toBe(ALLOWED_ORIGIN);
  });
});

// ─── Message sanitization ────────────────────────────────────────────

describe("sanitizeMessages", () => {
  it("passes through a well-formed messages array", () => {
    const result = sanitizeMessages({
      messages: [
        { role: "system", content: "You are an assistant." },
        { role: "user", content: "Build me a pipeline." },
      ],
    });
    expect(result).toEqual([
      { role: "system", content: "You are an assistant." },
      { role: "user", content: "Build me a pipeline." },
    ]);
  });

  it("rejects a non-object payload", () => {
    expect(sanitizeMessages("nope")).toBeNull();
    expect(sanitizeMessages(null)).toBeNull();
  });

  it("rejects a missing or empty messages array", () => {
    expect(sanitizeMessages({})).toBeNull();
    expect(sanitizeMessages({ messages: [] })).toBeNull();
    expect(sanitizeMessages({ messages: "not-an-array" })).toBeNull();
  });

  it("rejects more than the maximum number of messages", () => {
    const messages = Array.from({ length: 13 }, () => ({ role: "user", content: "hi" }));
    expect(sanitizeMessages({ messages })).toBeNull();
  });

  it("rejects an unknown role", () => {
    expect(sanitizeMessages({ messages: [{ role: "system_admin", content: "hi" }] })).toBeNull();
  });

  it("rejects non-string or empty content", () => {
    expect(sanitizeMessages({ messages: [{ role: "user", content: 42 }] })).toBeNull();
    expect(sanitizeMessages({ messages: [{ role: "user", content: "" }] })).toBeNull();
  });

  it("rejects user content longer than the maximum length", () => {
    const huge = "x".repeat(8001);
    expect(sanitizeMessages({ messages: [{ role: "user", content: huge }] })).toBeNull();
  });

  it("allows a large system message but caps it at the system limit", () => {
    // A system prompt over the user limit (8000) but within the system
    // limit (48000) must be accepted. The real frontend prompt
    // (buildSystemPrompt) is ~24k chars before the loaded-structure summary
    // is appended, so the cap must comfortably clear that.
    const bigSystem = "s".repeat(30000);
    const ok = sanitizeMessages({
      messages: [
        { role: "system", content: bigSystem },
        { role: "user", content: "hi" },
      ],
    });
    expect(ok).not.toBeNull();
    expect(ok?.[0].content).toHaveLength(30000);

    const tooBigSystem = "s".repeat(48001);
    expect(sanitizeMessages({ messages: [{ role: "system", content: tooBigSystem }] })).toBeNull();
  });

  it("accepts a system message at the real frontend prompt size (~24k)", () => {
    // Regression: the base system prompt grew past the old 24000 cap, which
    // made sanitizeMessages reject every demo-proxy request with "Missing or
    // invalid 'messages' array". A ~24k system message plus a structure
    // summary must stay under the limit.
    const realisticSystem =
      "s".repeat(24108) + "\n## Currently Loaded Structure\n" + "x".repeat(2000);
    const ok = sanitizeMessages({
      messages: [
        { role: "system", content: realisticSystem },
        { role: "user", content: "show carbons" },
      ],
    });
    expect(ok).not.toBeNull();
  });

  it("rejects malformed message entries", () => {
    expect(sanitizeMessages({ messages: [null] })).toBeNull();
    expect(sanitizeMessages({ messages: [{ role: "user" }] })).toBeNull();
  });

  it("accepts an assistant message carrying tool_calls with null content", () => {
    const out = sanitizeMessages({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "get_x", arguments: "{}" } },
          ],
        },
      ],
    });
    expect(out).not.toBeNull();
    expect(out?.[1].tool_calls).toHaveLength(1);
    expect(out?.[1].content).toBeNull();
  });

  it("accepts a tool message with a tool_call_id and large content", () => {
    const out = sanitizeMessages({
      messages: [{ role: "tool", content: "x".repeat(13000), tool_call_id: "call_1" }],
    });
    expect(out).not.toBeNull();
    expect(out?.[0].tool_call_id).toBe("call_1");
  });

  it("rejects null content on a non-assistant message", () => {
    expect(sanitizeMessages({ messages: [{ role: "user", content: null }] })).toBeNull();
  });

  it("rejects assistant null content without tool_calls", () => {
    expect(sanitizeMessages({ messages: [{ role: "assistant", content: null }] })).toBeNull();
  });

  it("rejects tool_calls on a non-assistant message", () => {
    expect(
      sanitizeMessages({
        messages: [
          {
            role: "user",
            content: "hi",
            tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }],
          },
        ],
      }),
    ).toBeNull();
  });

  it("rejects a tool message without a tool_call_id", () => {
    expect(sanitizeMessages({ messages: [{ role: "tool", content: "result" }] })).toBeNull();
  });

  it("rejects tool_call_id on a non-tool message", () => {
    expect(
      sanitizeMessages({
        messages: [{ role: "user", content: "hi", tool_call_id: "c1" }],
      }),
    ).toBeNull();
  });

  it("rejects malformed tool_calls", () => {
    const wrap = (toolCalls: unknown) =>
      sanitizeMessages({
        messages: [{ role: "assistant", content: null, tool_calls: toolCalls }],
      });
    expect(wrap([])).toBeNull(); // empty
    expect(
      wrap([{ id: "c1", type: "not_function", function: { name: "x", arguments: "{}" } }]),
    ).toBeNull();
    expect(
      wrap([{ id: "", type: "function", function: { name: "x", arguments: "{}" } }]),
    ).toBeNull();
    expect(
      wrap([{ id: "c1", type: "function", function: { name: "", arguments: "{}" } }]),
    ).toBeNull();
    expect(
      wrap([{ id: "c1", type: "function", function: { name: "x", arguments: 5 } }]),
    ).toBeNull();
    expect(wrap([{ id: "c1", type: "function" }])).toBeNull();
  });
});

describe("sanitizeTools", () => {
  const validTool = {
    type: "function",
    function: {
      name: "get_molecule_template",
      description: "desc",
      parameters: { type: "object", properties: {} },
    },
  };

  it("returns undefined when no tools key is present", () => {
    expect(sanitizeTools({ messages: [] })).toBeUndefined();
    expect(sanitizeTools("nope")).toBeUndefined();
    expect(sanitizeTools(null)).toBeUndefined();
  });

  it("returns the sanitized tools when valid", () => {
    const out = sanitizeTools({ tools: [validTool] });
    expect(out).toHaveLength(1);
    expect(out?.[0].function.name).toBe("get_molecule_template");
  });

  it("accepts a function tool without description or parameters", () => {
    const out = sanitizeTools({ tools: [{ type: "function", function: { name: "x" } }] });
    expect(out).toHaveLength(1);
    expect(out?.[0].function.description).toBeUndefined();
  });

  it("returns null for more than the maximum number of tools", () => {
    const tools = Array.from({ length: 17 }, () => validTool);
    expect(sanitizeTools({ tools })).toBeNull();
  });

  it("returns null for malformed tool entries", () => {
    expect(sanitizeTools({ tools: "not-an-array" })).toBeNull();
    expect(sanitizeTools({ tools: [null] })).toBeNull();
    expect(
      sanitizeTools({ tools: [{ type: "not_function", function: { name: "x" } }] }),
    ).toBeNull();
    expect(sanitizeTools({ tools: [{ type: "function", function: null }] })).toBeNull();
    expect(sanitizeTools({ tools: [{ type: "function", function: { name: "" } }] })).toBeNull();
    expect(
      sanitizeTools({ tools: [{ type: "function", function: { name: "x", description: 5 } }] }),
    ).toBeNull();
    expect(
      sanitizeTools({ tools: [{ type: "function", function: { name: "x", parameters: "no" } }] }),
    ).toBeNull();
  });
});

// ─── Rate limiting ───────────────────────────────────────────────────

describe("isRateLimited", () => {
  it("allows requests under both the per-minute and per-day limits", async () => {
    const env = makeEnv();
    for (let i = 0; i < PER_MINUTE_LIMIT; i++) {
      expect(await isRateLimited("1.2.3.4", env)).toBe(false);
    }
  });

  it("blocks once the per-minute limit is reached", async () => {
    const env = makeEnv();
    for (let i = 0; i < PER_MINUTE_LIMIT; i++) {
      await isRateLimited("1.2.3.4", env);
    }
    expect(await isRateLimited("1.2.3.4", env)).toBe(true);
  });

  it("tracks separate counters per IP", async () => {
    const env = makeEnv();
    for (let i = 0; i < PER_MINUTE_LIMIT; i++) {
      await isRateLimited("1.2.3.4", env);
    }
    expect(await isRateLimited("5.6.7.8", env)).toBe(false);
  });

  it("caps the free demo at 30 requests per day", () => {
    expect(PER_DAY_LIMIT).toBe(30);
  });

  it("allows a request while still under the per-day limit", async () => {
    const env = makeEnv();
    const kv = env.RATE_LIMIT_KV as unknown as FakeKV;
    const dayKey = `rl:d:9.9.9.9:${Math.floor(Date.now() / 86_400_000)}`;
    await kv.put(dayKey, String(PER_DAY_LIMIT - 1), {});
    expect(await isRateLimited("9.9.9.9", env)).toBe(false);
  });

  it("blocks once the per-day limit is reached even under the per-minute limit", async () => {
    const env = makeEnv();
    const kv = env.RATE_LIMIT_KV as unknown as FakeKV;
    const dayKey = `rl:d:9.9.9.9:${Math.floor(Date.now() / 86_400_000)}`;
    await kv.put(dayKey, String(PER_DAY_LIMIT), {});
    expect(await isRateLimited("9.9.9.9", env)).toBe(true);
  });
});

// ─── fetch handler ───────────────────────────────────────────────────

function makeRequest(init: { method?: string; origin?: string | null; body?: unknown }): Request {
  const headers = new Headers();
  if (init.origin !== undefined && init.origin !== null) headers.set("Origin", init.origin);
  headers.set("CF-Connecting-IP", "1.2.3.4");
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  return new Request("https://proxy.example/", {
    method: init.method ?? "POST",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

describe("buildModelList", () => {
  it("defaults each provider to its primary model followed by its default fallbacks", () => {
    const plamo = buildModelList(makeEnv(), "plamo");
    expect(plamo[0]).toBe(DEFAULT_PLAMO_MODEL);
    expect(plamo.slice(1)).toEqual(DEFAULT_PLAMO_FALLBACK_MODELS);

    const openrouter = buildModelList(makeEnv(), "openrouter");
    expect(openrouter[0]).toBe(DEFAULT_OPENROUTER_MODEL);
    expect(openrouter.slice(1)).toEqual(DEFAULT_OPENROUTER_FALLBACK_MODELS);
  });

  it("puts the per-provider model override first", () => {
    const env = {
      ...makeEnv(),
      PLAMO_MODEL: "plamo-2.2-prime",
      OPENROUTER_MODEL: "anthropic/claude-3.5-haiku",
    };
    expect(buildModelList(env, "plamo")[0]).toBe("plamo-2.2-prime");
    expect(buildModelList(env, "openrouter")[0]).toBe("anthropic/claude-3.5-haiku");
  });

  it("keeps the two providers' overrides independent", () => {
    const env = { ...makeEnv(), OPENROUTER_MODEL: "vendor/model-x" };
    expect(buildModelList(env, "plamo")[0]).toBe(DEFAULT_PLAMO_MODEL);
    expect(buildModelList(env, "openrouter")[0]).toBe("vendor/model-x");
  });

  it("de-duplicates when the primary also appears in the fallback list", () => {
    const list = buildModelList(
      {
        ...makeEnv(),
        PLAMO_MODEL: "model-a",
        PLAMO_FALLBACK_MODELS: "model-a, model-b",
      },
      "plamo",
    );
    expect(list).toEqual(["model-a", "model-b"]);
  });

  it("ignores blank entries in the fallback list", () => {
    const list = buildModelList(
      {
        ...makeEnv(),
        PLAMO_MODEL: "model-p",
        PLAMO_FALLBACK_MODELS: " , model-a ,, ",
      },
      "plamo",
    );
    expect(list).toEqual(["model-p", "model-a"]);
  });

  it("returns only the primary when fallbacks are explicitly empty", () => {
    const list = buildModelList(
      {
        ...makeEnv(),
        PLAMO_MODEL: "model-p",
        PLAMO_FALLBACK_MODELS: "",
      },
      "plamo",
    );
    expect(list).toEqual(["model-p"]);
  });

  it("caps the list at MAX_MODELS so one request can't fan out unboundedly", () => {
    const list = buildModelList(
      {
        ...makeEnv(),
        PLAMO_MODEL: "model-p",
        PLAMO_FALLBACK_MODELS: "model-a, model-b, model-c, model-d",
      },
      "plamo",
    );
    expect(list).toEqual(["model-p", "model-a", "model-b"]);
    expect(list.length).toBe(MAX_MODELS);
  });

  it("keeps both default lists within the MAX_MODELS cap", () => {
    expect(buildModelList(makeEnv(), "plamo").length).toBeLessThanOrEqual(MAX_MODELS);
    expect(buildModelList(makeEnv(), "openrouter").length).toBeLessThanOrEqual(MAX_MODELS);
  });
});

describe("buildProviderList", () => {
  it("defaults to PLaMo first with OpenRouter as the cross-provider fallback", () => {
    expect(buildProviderList(makeEnv())).toEqual(DEFAULT_PROVIDERS);
    expect(buildProviderList(makeEnv())).toEqual(["plamo", "openrouter"]);
  });

  it("respects the LLM_PROVIDERS order", () => {
    const env = { ...makeEnv(), LLM_PROVIDERS: "openrouter, plamo" };
    expect(buildProviderList(env)).toEqual(["openrouter", "plamo"]);
  });

  it("allows restricting to a single provider", () => {
    expect(buildProviderList({ ...makeEnv(), LLM_PROVIDERS: "openrouter" })).toEqual([
      "openrouter",
    ]);
    expect(buildProviderList({ ...makeEnv(), LLM_PROVIDERS: "plamo" })).toEqual(["plamo"]);
  });

  it("drops unknown provider names and de-duplicates", () => {
    const env = { ...makeEnv(), LLM_PROVIDERS: "gemini, plamo, plamo, openrouter" };
    expect(buildProviderList(env)).toEqual(["plamo", "openrouter"]);
  });

  it("skips a provider whose API key is unset", () => {
    expect(buildProviderList(makePlamoOnlyEnv())).toEqual(["plamo"]);
    expect(buildProviderList({ ...makeEnv(), PLAMO_API_KEY: undefined })).toEqual(["openrouter"]);
  });

  it("returns an empty list when no provider has a key", () => {
    const env = { ...makeEnv(), PLAMO_API_KEY: undefined, OPENROUTER_API_KEY: undefined };
    expect(buildProviderList(env)).toEqual([]);
  });
});

describe("buildAttempts", () => {
  const baseBody = { messages: [{ role: "user", content: "hi" }], max_tokens: 4096, stream: true };

  it("expands PLaMo into one attempt per model and OpenRouter into one routed attempt", () => {
    const attempts = buildAttempts(makeEnv(), ALLOWED_ORIGIN, baseBody);
    // PLaMo walks its models client-side; OpenRouter routes server-side.
    expect(attempts.map((a) => a.provider)).toEqual(["plamo", "plamo", "openrouter"]);
    expect(attempts[0].url).toBe(PLAMO_API_URL);
    expect(attempts[0].body.model).toBe(DEFAULT_PLAMO_MODEL);
    expect(attempts[0].body.models).toBeUndefined();
    expect(attempts[1].body.model).toBe(DEFAULT_PLAMO_FALLBACK_MODELS[0]);

    const openrouter = attempts[2];
    expect(openrouter.url).toBe(OPENROUTER_API_URL);
    expect(openrouter.body.model).toBeUndefined();
    expect(openrouter.body.models).toEqual([
      DEFAULT_OPENROUTER_MODEL,
      ...DEFAULT_OPENROUTER_FALLBACK_MODELS,
    ]);
  });

  it("sends each provider its own API key and gives only OpenRouter attribution headers", () => {
    const env = makeEnv();
    const attempts = buildAttempts(env, ALLOWED_ORIGIN, baseBody);
    const plamo = attempts[0];
    expect(plamo.headers.Authorization).toBe(`Bearer ${env.PLAMO_API_KEY}`);
    expect(plamo.headers["HTTP-Referer"]).toBeUndefined();
    expect(plamo.headers["X-Title"]).toBeUndefined();

    const openrouter = attempts[attempts.length - 1];
    expect(openrouter.headers.Authorization).toBe(`Bearer ${env.OPENROUTER_API_KEY}`);
    expect(openrouter.headers["HTTP-Referer"]).toBe(ALLOWED_ORIGIN);
    expect(openrouter.headers["X-Title"]).toBe("megane demo");
  });

  it("returns no attempts when no provider is configured", () => {
    const env = { ...makeEnv(), PLAMO_API_KEY: undefined, OPENROUTER_API_KEY: undefined };
    expect(buildAttempts(env, ALLOWED_ORIGIN, baseBody)).toEqual([]);
  });
});

describe("worker fetch handler", () => {
  it("responds to a CORS preflight from the allowed origin", async () => {
    const env = makeEnv();
    const res = await worker.fetch(makeRequest({ method: "OPTIONS", origin: ALLOWED_ORIGIN }), env);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("rejects a CORS preflight from a disallowed origin", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      makeRequest({ method: "OPTIONS", origin: "https://evil.example" }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it("rejects non-POST methods", async () => {
    const env = makeEnv();
    const res = await worker.fetch(makeRequest({ method: "GET", origin: ALLOWED_ORIGIN }), env);
    expect(res.status).toBe(405);
  });

  it("rejects requests from a disallowed origin", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      makeRequest({ method: "POST", origin: "https://evil.example", body: { messages: [] } }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it("rejects malformed JSON bodies", async () => {
    const env = makeEnv();
    const req = new Request("https://proxy.example/", {
      method: "POST",
      headers: { Origin: ALLOWED_ORIGIN, "CF-Connecting-IP": "1.2.3.4" },
      body: "not json",
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
  });

  it("rejects invalid message payloads", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      makeRequest({ origin: ALLOWED_ORIGIN, body: { messages: [{ role: "tool", content: "x" }] } }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 429 once the per-IP rate limit is exceeded", async () => {
    const env = makeEnv();
    const body = { messages: [{ role: "user", content: "hi" }] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );

    for (let i = 0; i < PER_MINUTE_LIMIT; i++) {
      await worker.fetch(makeRequest({ origin: ALLOWED_ORIGIN, body }), env);
    }
    const res = await worker.fetch(makeRequest({ origin: ALLOWED_ORIGIN, body }), env);
    expect(res.status).toBe(429);
  });

  it("forwards sanitized messages to PLaMo first and streams the response back", async () => {
    const env = makeEnv();
    const upstreamBody = "data: hello\n\n";
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(PLAMO_API_URL);
      const sentBody = JSON.parse(init.body as string);
      // PLaMo takes a single `model`; the OpenRouter-only `models` routing
      // array must not be sent (it would be rejected as an unknown field).
      expect(sentBody.model).toBe(DEFAULT_PLAMO_MODEL);
      expect(sentBody.models).toBeUndefined();
      expect(sentBody.stream).toBe(true);
      // The completion cap must match the direct-provider client (4096); a
      // smaller value truncated larger multi-branch pipelines mid-JSON.
      expect(sentBody.max_tokens).toBe(4096);
      expect(sentBody.messages).toEqual([{ role: "user", content: "hi" }]);
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${env.PLAMO_API_KEY}`);
      expect(headers["Content-Type"]).toBe("application/json");
      // OpenRouter-only attribution headers must not go to PLaMo.
      expect(headers["HTTP-Referer"]).toBeUndefined();
      expect(headers["X-Title"]).toBeUndefined();
      return new Response(upstreamBody, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      makeRequest({
        origin: ALLOWED_ORIGIN,
        body: { messages: [{ role: "user", content: "hi" }] },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
    expect(await res.text()).toBe(upstreamBody);
    // Only the primary model is tried when it succeeds.
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("accepts a request from a second allowed origin and echoes it in CORS", async () => {
    const env = makeMultiOriginEnv();
    const fetchMock = vi.fn(async () => new Response("data: ok\n\n", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      makeRequest({ origin: SECOND_ORIGIN, body: { messages: [{ role: "user", content: "hi" }] } }),
      env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(SECOND_ORIGIN);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("forwards a valid tools array to PLaMo", async () => {
    const env = makeEnv();
    const tool = {
      type: "function",
      function: { name: "get_x", description: "d", parameters: { type: "object", properties: {} } },
    };
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const sentBody = JSON.parse(init.body as string);
      expect(sentBody.tools).toHaveLength(1);
      expect(sentBody.tools[0].function.name).toBe("get_x");
      return new Response("data: ok\n\n", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      makeRequest({
        origin: ALLOWED_ORIGIN,
        body: { messages: [{ role: "user", content: "hi" }], tools: [tool] },
      }),
      env,
    );
    expect(res.status).toBe(200);
  });

  it("returns 400 when the tools array is malformed", async () => {
    const env = makeEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    const res = await worker.fetch(
      makeRequest({
        origin: ALLOWED_ORIGIN,
        body: { messages: [{ role: "user", content: "hi" }], tools: [{ type: "function" }] },
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("uses the PLAMO_MODEL override as the model", async () => {
    const env = { ...makeEnv(), PLAMO_MODEL: "plamo-2.2-prime" };
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const sentBody = JSON.parse(init.body as string);
      expect(sentBody.model).toBe("plamo-2.2-prime");
      return new Response("data: ok\n\n", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      makeRequest({
        origin: ALLOWED_ORIGIN,
        body: { messages: [{ role: "user", content: "hi" }] },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("falls back to the next model when the primary errors, and streams that one", async () => {
    const env = {
      ...makeEnv(),
      PLAMO_MODEL: "primary-model",
      PLAMO_FALLBACK_MODELS: "fallback-a, fallback-b",
    };
    const tried: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const model = JSON.parse(init.body as string).model as string;
      tried.push(model);
      if (model === "primary-model") return new Response("model unavailable", { status: 404 });
      return new Response("data: ok\n\n", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      makeRequest({
        origin: ALLOWED_ORIGIN,
        body: { messages: [{ role: "user", content: "hi" }] },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("data: ok\n\n");
    // Stops at the first model that works — "fallback-b" is never tried.
    expect(tried).toEqual(["primary-model", "fallback-a"]);
  });

  it("falls back to OpenRouter once every PLaMo model has failed", async () => {
    const env = makeEnv();
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      urls.push(url);
      if (url === PLAMO_API_URL) return new Response("plamo down", { status: 503 });
      const sentBody = JSON.parse(init.body as string);
      // The OpenRouter attempt carries the server-side `models` routing
      // array (no single `model`) plus its attribution headers.
      expect(sentBody.model).toBeUndefined();
      expect(sentBody.models).toEqual([
        DEFAULT_OPENROUTER_MODEL,
        ...DEFAULT_OPENROUTER_FALLBACK_MODELS,
      ]);
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${env.OPENROUTER_API_KEY}`);
      expect(headers["HTTP-Referer"]).toBe(ALLOWED_ORIGIN);
      expect(headers["X-Title"]).toBe("megane demo");
      return new Response("data: rescued\n\n", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      makeRequest({
        origin: ALLOWED_ORIGIN,
        body: { messages: [{ role: "user", content: "hi" }] },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("data: rescued\n\n");
    expect(urls).toEqual([PLAMO_API_URL, PLAMO_API_URL, OPENROUTER_API_URL]);
  });

  it("goes straight to OpenRouter when LLM_PROVIDERS selects only it", async () => {
    const env = { ...makeEnv(), LLM_PROVIDERS: "openrouter" };
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(OPENROUTER_API_URL);
      return new Response("data: ok\n\n", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      makeRequest({
        origin: ALLOWED_ORIGIN,
        body: { messages: [{ role: "user", content: "hi" }] },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("tries OpenRouter before PLaMo when LLM_PROVIDERS reverses the order", async () => {
    const env = { ...makeEnv(), LLM_PROVIDERS: "openrouter,plamo" };
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(url);
      if (url === OPENROUTER_API_URL) return new Response("router down", { status: 503 });
      return new Response("data: ok\n\n", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      makeRequest({
        origin: ALLOWED_ORIGIN,
        body: { messages: [{ role: "user", content: "hi" }] },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(urls[0]).toBe(OPENROUTER_API_URL);
    expect(urls[1]).toBe(PLAMO_API_URL);
  });

  it("returns 500 when no provider API key is configured", async () => {
    const env = { ...makeEnv(), PLAMO_API_KEY: undefined, OPENROUTER_API_KEY: undefined };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      makeRequest({
        origin: ALLOWED_ORIGIN,
        body: { messages: [{ role: "user", content: "hi" }] },
      }),
      env,
    );

    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("No LLM provider is configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates upstream errors as JSON once every attempt has failed", async () => {
    const env = makeEnv();
    const fetchMock = vi.fn(async () => new Response("boom", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      makeRequest({
        origin: ALLOWED_ORIGIN,
        body: { messages: [{ role: "user", content: "hi" }] },
      }),
      env,
    );

    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("boom");
    // Every attempt across both providers is tried before giving up.
    expect(fetchMock).toHaveBeenCalledTimes(buildAttempts(env, ALLOWED_ORIGIN, {}).length);
  });

  it("returns 502 when every upstream fetch throws", async () => {
    const env = makeEnv();
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      makeRequest({
        origin: ALLOWED_ORIGIN,
        body: { messages: [{ role: "user", content: "hi" }] },
      }),
      env,
    );

    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Upstream request failed");
    expect(fetchMock).toHaveBeenCalledTimes(buildAttempts(env, ALLOWED_ORIGIN, {}).length);
  });

  it("recovers when the primary throws but a fallback answers", async () => {
    const env = makePlamoOnlyEnv();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const model = JSON.parse(init.body as string).model as string;
      if (model === DEFAULT_PLAMO_MODEL) throw new Error("network down");
      return new Response("data: ok\n\n", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      makeRequest({
        origin: ALLOWED_ORIGIN,
        body: { messages: [{ role: "user", content: "hi" }] },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("data: ok\n\n");
  });
});

describe("wrangler.toml model configuration", () => {
  // Read the deployed config the Worker ships with so a bad model id can't
  // pass CI and silently break every demo prompt once deployed.
  // vitest runs with cwd at the worker package root (where vitest.config.ts
  // and wrangler.toml live), so a cwd-relative read keeps this independent of
  // @types/node's import.meta typings.
  const toml = readFileSync(`${process.cwd()}/wrangler.toml`, "utf8");

  function tomlVar(name: string): string | null {
    const m = toml.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m"));
    return m ? m[1] : null;
  }

  function tomlList(name: string): string[] {
    return (tomlVar(name) ?? "")
      .split(",")
      .map((m) => m.trim())
      .filter((m) => m.length > 0);
  }

  /**
   * PLaMo model ids are bare (`plamo-3.0-prime`) — unlike OpenRouter slugs
   * they carry no `vendor/` prefix and no `:free` suffix, and they spell the
   * version with a DOT, never a hyphen. Any of those mistakes is an unknown
   * model id that PLaMo rejects with a 400, which used to break the demo on
   * even the shortest prompt. Guard against that exact class of regression.
   */
  function assertValidPlamoModel(id: string) {
    expect(id.includes("/"), `model id "${id}" must not carry a vendor prefix`).toBe(false);
    expect(id.includes(":"), `model id "${id}" must not carry a ":" suffix`).toBe(false);
    expect(
      /^plamo-\d+\.\d+-prime(-[a-z]+)?$/.test(id),
      `model id "${id}" does not look like a PLaMo model (expected e.g. "plamo-3.0-prime"); ` +
        `verify it at https://docs.plamo.preferredai.jp/en/api`,
    ).toBe(true);
  }

  /**
   * OpenRouter slugs are vendor-prefixed (`anthropic/claude-sonnet-4.6`,
   * optionally `:free`-suffixed) and spell minor versions with a DOT — a
   * hyphenated version like "claude-sonnet-4-6" is an unknown model id
   * that OpenRouter rejects with a 400, breaking every demo prompt.
   */
  function assertValidOpenRouterModel(slug: string) {
    expect(slug.includes("/"), `slug "${slug}" must carry a vendor prefix`).toBe(true);
    expect(
      /-\d+-\d+(:|$)/.test(slug),
      `slug "${slug}" spells the version with a hyphen; OpenRouter uses a DOT ` +
        `(e.g. "anthropic/claude-sonnet-4.6") — verify at https://openrouter.ai/<id>`,
    ).toBe(false);
  }

  it("configures both providers, PLaMo first", () => {
    const providers = tomlList("LLM_PROVIDERS");
    expect(providers).toEqual(["plamo", "openrouter"]);
  });

  it("sets the primary PLaMo model to a valid id", () => {
    const model = tomlVar("PLAMO_MODEL");
    expect(model).toBeTruthy();
    assertValidPlamoModel(model!);
  });

  it("uses valid ids for every configured PLaMo fallback model", () => {
    const fallbacks = tomlList("PLAMO_FALLBACK_MODELS");
    expect(fallbacks.length).toBeGreaterThan(0);
    for (const id of fallbacks) {
      assertValidPlamoModel(id);
    }
  });

  it("sets the primary OpenRouter model to a valid slug", () => {
    const model = tomlVar("OPENROUTER_MODEL");
    expect(model).toBeTruthy();
    assertValidOpenRouterModel(model!);
  });

  it("uses valid slugs for every configured OpenRouter fallback model", () => {
    const fallbacks = tomlList("OPENROUTER_FALLBACK_MODELS");
    expect(fallbacks.length).toBeGreaterThan(0);
    for (const slug of fallbacks) {
      assertValidOpenRouterModel(slug);
    }
  });

  it("keeps both shipped model lists within the MAX_MODELS cap", () => {
    const env = {
      ...makeEnv(),
      PLAMO_MODEL: tomlVar("PLAMO_MODEL") ?? undefined,
      PLAMO_FALLBACK_MODELS: tomlVar("PLAMO_FALLBACK_MODELS") ?? undefined,
      OPENROUTER_MODEL: tomlVar("OPENROUTER_MODEL") ?? undefined,
      OPENROUTER_FALLBACK_MODELS: tomlVar("OPENROUTER_FALLBACK_MODELS") ?? undefined,
    };
    expect(buildModelList(env, "plamo").length).toBeLessThanOrEqual(MAX_MODELS);
    expect(buildModelList(env, "openrouter").length).toBeLessThanOrEqual(MAX_MODELS);
  });
});
