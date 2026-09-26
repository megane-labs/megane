/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** URL of the Cloudflare Worker that proxies free-tier demo chat requests. */
  readonly VITE_LLM_PROXY_URL?: string;
  /** GA4 measurement ID (`G-…`); set only for the public deploys. See src/analytics.ts. */
  readonly VITE_GA_MEASUREMENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Vite worker imports
declare module "*?worker" {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}

// Vite inlined worker imports (base64 blob worker; required for single-file
// bundles and the VSCode webview CSP which only allows `worker-src blob:`).
declare module "*?worker&inline" {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}

// ketcher-standalone's `binaryWasm` build ships the Indigo engine as a
// separate `.wasm` asset instead of a base64 string inside the JS, but its
// package exports carry no `types` condition for the sub-path.
declare module "ketcher-standalone/dist/binaryWasm" {
  export { StandaloneStructServiceProvider } from "ketcher-standalone";
}
