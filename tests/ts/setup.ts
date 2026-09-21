import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library's auto-cleanup relies on a global `afterEach`, which is not
// available because vitest runs with `globals` disabled. Without this hook,
// components stay mounted across tests within a file and their re-run effects
// can clobber module-level state registered by the next test's component
// (observed as stale-closure handler registrations under React 18).
afterEach(() => {
  cleanup();
});

// Mantine's components ask the environment for the reduced-motion preference
// and observe their own size; jsdom implements neither, so provide the two
// stubs every Mantine-rendering test would otherwise need.
if (typeof window !== "undefined") {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof window.ResizeObserver;
  }
  if (!window.scrollTo) {
    window.scrollTo = (() => {}) as unknown as typeof window.scrollTo;
  }
}
