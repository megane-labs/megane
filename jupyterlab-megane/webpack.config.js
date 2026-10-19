/* eslint-disable */
const path = require("path");
const webpack = require("webpack");

module.exports = {
  experiments: {
    asyncWebAssembly: true
  },
  resolve: {
    alias: {
      "@megane": path.resolve(__dirname, "../src")
    },
    extensions: [".ts", ".tsx", ".mjs", ".js", ".jsx", "..."],
    modules: [
      path.resolve(__dirname, "node_modules"),
      path.resolve(__dirname, "../node_modules"),
      // Last, the usual nested lookup, for dependencies npm installed under
      // their dependent (Ketcher's `ketcher-react/node_modules/miew-react`).
      "node_modules"
    ]
  },
  plugins: [
    // src/ai/skillLoader.ts uses Vite's import.meta.glob which webpack
    // can't handle. Swap it for a stub that returns an empty skill set;
    // the DocWidget doesn't surface the AI chat box.
    new webpack.NormalModuleReplacementPlugin(
      /[\\/]src[\\/]ai[\\/]skillLoader\.ts$/,
      path.resolve(__dirname, "src/skillLoaderStub.ts")
    ),
    // parseClient.ts spawns its parse worker through a Vite `?worker` import;
    // webpack builds the same worker from the `new Worker(new URL(...))` form.
    // Parsing off the main thread is what turns on lazy trajectory streaming
    // (frame 0 first, the rest decoded on demand) in the DocWidget.
    new webpack.NormalModuleReplacementPlugin(/^\.\/parse\.worker\?worker$/, (resource) => {
      resource.request = path.resolve(__dirname, "../src/parsers/parseWorker.webpack.ts");
    }),
    // megane Builder's RDKit worker is a Vite `?worker` import; webpack builds
    // the same worker from the `new Worker(new URL(...))` form instead.
    new webpack.NormalModuleReplacementPlugin(/^\.\/embed\.worker\?worker$/, (resource) => {
      resource.request = path.resolve(__dirname, "../src/builder/library/embedWorker.webpack.ts");
    }),
    // ...and imports RDKit's `.wasm` by URL (Vite `?url`). megane-rdkit's
    // `exports` map does not list the file, so point at it directly.
    new webpack.NormalModuleReplacementPlugin(/^megane-rdkit\/dist\/megane-rdkit\.wasm\?url$/, (resource) => {
      resource.request =
        path.resolve(__dirname, "../node_modules/megane-rdkit/dist/megane-rdkit.wasm") + "?url";
    }),
    // megane-rdkit loads `node:module` only under Node; never in the browser.
    new webpack.IgnorePlugin({ resourceRegExp: /^node:module$/ })
  ],
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        include: [path.resolve(__dirname, "../src")],
        use: {
          loader: require.resolve("ts-loader"),
          options: {
            transpileOnly: true,
            configFile: path.resolve(__dirname, "tsconfig.webpack.json")
          }
        }
      },
      {
        test: /\.wasm$/,
        type: "asset/resource",
        generator: {
          filename: "[name].[hash][ext]"
        }
      },
      // Vite's `?url` suffix (megane Builder's RDKit `.wasm`): emit the file,
      // import its URL.
      {
        resourceQuery: /url/,
        type: "asset/resource",
        generator: {
          filename: "[name].[hash][ext]"
        }
      },
      {
        test: /megane-rdkit[\\/]dist[\\/]megane-rdkit\.mjs$/,
        loader: path.resolve(__dirname, "rdkit-no-default-wasm-loader.js")
      },
      // Vite's `?raw` suffix (src/renderer/RenderCapture.ts inlines the gif.js
      // worker with it) means "import this file as a string". `asset/source` is
      // webpack's equivalent; without this rule the labextension build fails to
      // resolve a file literally named `gif.worker.js?raw`.
      {
        resourceQuery: /raw/,
        type: "asset/source"
      }
    ]
  }
};
