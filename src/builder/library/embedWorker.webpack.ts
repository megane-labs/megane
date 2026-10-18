/**
 * webpack's counterpart of Vite's `./embed.worker?worker` import, swapped in
 * by the JupyterLab labextension build (jupyterlab-megane/webpack.config.js).
 * webpack bundles a worker from the literal `new Worker(new URL(…,
 * import.meta.url))` form, so the constructor is spelled out here; calling it
 * with `new` returns the worker, as Vite's generated class does.
 */
export default function EmbedWorker(): Worker {
  return new Worker(new URL("./embed.worker.ts", import.meta.url));
}
