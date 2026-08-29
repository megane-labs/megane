/**
 * AI configuration store with localStorage persistence.
 * Manages provider, model, and API key settings.
 */

import { create } from "zustand";

export type AIProvider = "anthropic" | "openai" | "demo";

export interface AIConfig {
  provider: AIProvider;
  model: string;
  apiKey: string;
}

/**
 * Persisted user preferences layered on top of {@link AIConfig}: whether
 * to bring their own API key (BYOK) instead of the shared demo proxy.
 */
export interface AIPreferences extends AIConfig {
  useOwnKey: boolean;
}

/**
 * Selectable models per provider. The first entry is that provider's default.
 *
 * Anthropic leads with Opus because pipeline generation is a correctness task
 * with a self-check loop behind it (see `client.ts`): a stronger model both
 * produces fewer problems to repair and repairs them in fewer rounds, which
 * costs less overall than re-running a weaker one. Sonnet and Haiku stay
 * available for anyone who would rather trade accuracy for price.
 */
export const PROVIDER_MODELS: Record<AIProvider, { value: string; label: string }[]> = {
  anthropic: [
    { value: "claude-opus-5", label: "Claude Opus 5" },
    { value: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
  openai: [
    { value: "gpt-4o", label: "GPT-4o" },
    { value: "gpt-4o-mini", label: "GPT-4o Mini" },
  ],
  demo: [{ value: "demo", label: "Free Demo (no API key needed)" }],
};

/** True when `model` is one of `provider`'s selectable models. */
export function isKnownModel(provider: AIProvider, model: string): boolean {
  return PROVIDER_MODELS[provider].some((m) => m.value === model);
}

/**
 * The "demo" provider proxies through a Cloudflare Worker that holds its
 * own server-side API key, so it never needs one from the user.
 */
export function providerRequiresApiKey(provider: AIProvider): boolean {
  return provider !== "demo";
}

/**
 * The demo provider is only usable when the proxy URL was injected at
 * build time (currently only the docs demo build sets this).
 */
export function isDemoProviderAvailable(): boolean {
  return Boolean(import.meta.env.VITE_LLM_PROXY_URL);
}

const STORAGE_KEY = "megane-ai-config";

/**
 * The "demo" provider is selected exclusively via the `useOwnKey` toggle
 * (see {@link AIPreferences}), not through the provider dropdown — so the
 * persisted provider/model always represent the user's BYOK choice and
 * default to Anthropic.
 */
function defaultProviderAndModel(): { provider: AIProvider; model: string } {
  const provider: AIProvider = "anthropic";
  return { provider, model: PROVIDER_MODELS[provider][0].value };
}

function loadConfig(): AIPreferences {
  const fallback = defaultProviderAndModel();
  // Default to BYOK only when no demo proxy is available in this build.
  const fallbackUseOwnKey = !isDemoProviderAvailable();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const provider: AIProvider = parsed.provider ?? fallback.provider;
      const known = PROVIDER_MODELS[provider] ? provider : fallback.provider;
      // A model saved by an older build may no longer be offered (retired
      // model ids). Fall back to the provider's default rather than leaving the
      // dropdown blank and sending a dead id to the API.
      const model =
        typeof parsed.model === "string" && isKnownModel(known, parsed.model)
          ? parsed.model
          : PROVIDER_MODELS[known][0].value;
      return {
        provider: known,
        model,
        apiKey: "",
        useOwnKey: parsed.useOwnKey ?? fallbackUseOwnKey,
      };
    }
  } catch {
    // ignore parse errors
  }
  return { ...fallback, apiKey: "", useOwnKey: fallbackUseOwnKey };
}

function saveConfig(config: AIPreferences) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      provider: config.provider,
      model: config.model,
      useOwnKey: config.useOwnKey,
    }),
  );
}

interface AIConfigStore extends AIPreferences {
  setProvider: (provider: AIProvider) => void;
  setModel: (model: string) => void;
  setApiKey: (apiKey: string) => void;
  setUseOwnKey: (useOwnKey: boolean) => void;
}

export const useAIConfigStore = create<AIConfigStore>((set, get) => ({
  ...loadConfig(),

  setProvider: (provider) => {
    const defaultModel = PROVIDER_MODELS[provider][0].value;
    set({ provider, model: defaultModel });
    saveConfig({ ...get(), provider, model: defaultModel });
  },

  setModel: (model) => {
    set({ model });
    saveConfig({ ...get(), model });
  },

  setApiKey: (apiKey) => {
    set({ apiKey });
    saveConfig({ ...get(), apiKey });
  },

  setUseOwnKey: (useOwnKey) => {
    set({ useOwnKey });
    saveConfig({ ...get(), useOwnKey });
  },
}));
