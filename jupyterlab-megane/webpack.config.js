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
      path.resolve(__dirname, "../node_modules")
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
    // parseClient.ts imports a Vite `?worker` module that webpack cannot
    // parse. Swap it for the synchronous main-thread parse client so the
    // labextension bundles cleanly (same pattern as skillLoaderStub above).
    new webpack.NormalModuleReplacementPlugin(
      /[\\/]src[\\/]parsers[\\/]parseClient\.ts$/,
      path.resolve(__dirname, "../src/parsers/parseClientSync.ts")
    )
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
