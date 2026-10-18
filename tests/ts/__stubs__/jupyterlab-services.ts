// Test-only stub for `@jupyterlab/services`. `Contents.IManager` is referenced
// only as a type, which TypeScript's `import type` erases at runtime, so a
// namespace with the type alias is enough to satisfy import resolution.
// `ServerConnection.makeRequest` is the one runtime value the labextension
// uses; tests that exercise it mock it. See sibling jupyterlab-coreutils.ts
// for the rationale.

export namespace Contents {
  export type IManager = unknown;
}

export const ServerConnection = {
  makeRequest: (_url: string, _init: unknown, _settings: unknown): Promise<Response> =>
    Promise.reject(new Error("ServerConnection stub")),
};
