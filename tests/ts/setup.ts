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
