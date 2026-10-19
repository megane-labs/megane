/**
 * webpack's counterpart of Vite's `./parse.worker?worker` import, swapped in by
 * the JupyterLab labextension build (jupyterlab-megane/webpack.config.js), the
 * same way `src/builder/library/embedWorker.webpack.ts` stands in for the
 * Builder's RDKit worker. webpack bundles a worker from the literal
 * `new Worker(new URL(…, import.meta.url))` form, so the constructor is spelled
 * out here; calling it with `new` returns the worker, as Vite's generated
 * class does.
 */
export default function ParseWorker(): Worker {
  return new Worker(new URL("./parse.worker.ts", import.meta.url));
}
