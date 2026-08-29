import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const STORAGE_KEY = "megane-ai-config";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe("useAIConfigStore", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses anthropic defaults and forces useOwnKey when no demo proxy is configured", async () => {
    vi.stubEnv("VITE_LLM_PROXY_URL", "");
    const { useAIConfigStore } = await import("@/ai/config");
    const state = useAIConfigStore.getState();
    expect(state.provider).toBe("anthropic");
    expect(state.model).toBe("claude-opus-5");
    expect(state.apiKey).toBe("");
    expect(state.useOwnKey).toBe(true);
  });

  it("defaults to using the shared demo proxy (useOwnKey=false) when this build has a proxy configured", async () => {
    vi.stubEnv("VITE_LLM_PROXY_URL", "https://proxy.example.com/chat");
    const { useAIConfigStore } = await import("@/ai/config");
    const state = useAIConfigStore.getState();
    expect(state.provider).toBe("anthropic");
    expect(state.useOwnKey).toBe(false);
    expect(state.apiKey).toBe("");
  });

  it("loads persisted provider and model from localStorage", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ provider: "openai", model: "gpt-4o" }));
    const { useAIConfigStore } = await import("@/ai/config");
    const state = useAIConfigStore.getState();
    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-4o");
  });

  it("never loads apiKey from localStorage even when present", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ provider: "openai", model: "gpt-4o", apiKey: "sk-leak" }),
    );
    const { useAIConfigStore } = await import("@/ai/config");
    expect(useAIConfigStore.getState().apiKey).toBe("");
  });

  it("falls back to defaults when persisted JSON is malformed", async () => {
    vi.stubEnv("VITE_LLM_PROXY_URL", "");
    localStorage.setItem(STORAGE_KEY, "{not json");
    const { useAIConfigStore } = await import("@/ai/config");
    const state = useAIConfigStore.getState();
    expect(state.provider).toBe("anthropic");
    expect(state.model).toBe("claude-opus-5");
    expect(state.useOwnKey).toBe(true);
  });

  it("loads a persisted useOwnKey preference from localStorage", async () => {
    vi.stubEnv("VITE_LLM_PROXY_URL", "https://proxy.example.com/chat");
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ provider: "openai", model: "gpt-4o", useOwnKey: true }),
    );
    const { useAIConfigStore } = await import("@/ai/config");
    expect(useAIConfigStore.getState().useOwnKey).toBe(true);
  });

  it("setUseOwnKey updates and persists the preference", async () => {
    vi.stubEnv("VITE_LLM_PROXY_URL", "https://proxy.example.com/chat");
    const { useAIConfigStore } = await import("@/ai/config");
    useAIConfigStore.getState().setUseOwnKey(true);

    expect(useAIConfigStore.getState().useOwnKey).toBe(true);
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) as string);
    expect(persisted.useOwnKey).toBe(true);
  });

  it("setProvider switches to that provider's first model and persists", async () => {
    const { useAIConfigStore } = await import("@/ai/config");
    useAIConfigStore.getState().setProvider("openai");

    const state = useAIConfigStore.getState();
    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-4o");

    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) as string);
    expect(persisted.provider).toBe("openai");
    expect(persisted.model).toBe("gpt-4o");
  });

  it("setModel updates and persists the new model", async () => {
    const { useAIConfigStore } = await import("@/ai/config");
    useAIConfigStore.getState().setModel("claude-haiku-4-5");

    expect(useAIConfigStore.getState().model).toBe("claude-haiku-4-5");
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) as string);
    expect(persisted.model).toBe("claude-haiku-4-5");
  });

  it("setApiKey updates state but does NOT persist the apiKey", async () => {
    const { useAIConfigStore } = await import("@/ai/config");
    useAIConfigStore.getState().setApiKey("sk-secret");

    expect(useAIConfigStore.getState().apiKey).toBe("sk-secret");
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) as string);
    expect(persisted.apiKey).toBeUndefined();
  });
});

describe("PROVIDER_MODELS", () => {
  it("declares anthropic, openai, and demo with non-empty model lists", async () => {
    const { PROVIDER_MODELS } = await import("@/ai/config");
    for (const provider of ["anthropic", "openai", "demo"] as const) {
      expect(PROVIDER_MODELS[provider].length).toBeGreaterThan(0);
      for (const model of PROVIDER_MODELS[provider]) {
        expect(model.value).toBeTruthy();
        expect(model.label).toBeTruthy();
      }
    }
  });
});

describe("providerRequiresApiKey", () => {
  it("requires an API key for anthropic and openai but not demo", async () => {
    const { providerRequiresApiKey } = await import("@/ai/config");
    expect(providerRequiresApiKey("anthropic")).toBe(true);
    expect(providerRequiresApiKey("openai")).toBe(true);
    expect(providerRequiresApiKey("demo")).toBe(false);
  });
});

describe("isDemoProviderAvailable", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns false when VITE_LLM_PROXY_URL is not set", async () => {
    vi.stubEnv("VITE_LLM_PROXY_URL", "");
    const { isDemoProviderAvailable } = await import("@/ai/config");
    expect(isDemoProviderAvailable()).toBe(false);
  });

  it("returns true when VITE_LLM_PROXY_URL is set", async () => {
    vi.stubEnv("VITE_LLM_PROXY_URL", "https://proxy.example.com/chat");
    const { isDemoProviderAvailable } = await import("@/ai/config");
    expect(isDemoProviderAvailable()).toBe(true);
  });
});
