import React from "react";
import Layout from "@theme/Layout";
import GalleryIndex from "../components/GalleryIndex";

export default function GalleryPage() {
  return (
    <Layout title="Gallery" description="A collection of megane visualization examples">
      <main className="container margin-vert--lg">
        <h1>Gallery</h1>
        <p>
          A collection of visualization examples. Each example shows a live 3D preview
          and the code needed to reproduce it in the Jupyter widget, React component (npm), or the VS Code extension.
        </p>

        <GalleryIndex />

        <hr />
        <h2>Adding Your Own Example</h2>
        <p>
          To contribute a new gallery example, edit{" "}
          <a
            href="https://github.com/megane-labs/megane/blob/main/docs/src/gallery/registry.ts"
            target="_blank"
            rel="noreferrer"
          >
            <code>docs/src/gallery/registry.ts</code>
          </a>{" "}
          and add an entry to the <code>galleryExamples</code> array.
        </p>
        <table>
          <thead>
            <tr>
              <th>Field</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>id</code></td>
              <td>Unique kebab-case identifier (used as HTML anchor)</td>
            </tr>
            <tr>
              <td><code>title</code></td>
              <td>Short display name</td>
            </tr>
            <tr>
              <td><code>description</code></td>
              <td>One-sentence description</td>
            </tr>
            <tr>
              <td><code>tags</code></td>
              <td>Array of lowercase tag strings</td>
            </tr>
            <tr>
              <td><code>snapshotUrl</code></td>
              <td>Path to a snapshot JSON in <code>docs/public/data/</code></td>
            </tr>
            <tr>
              <td><code>code.jupyter</code></td>
              <td>Python snippet for Jupyter</td>
            </tr>
            <tr>
              <td><code>code.react</code></td>
              <td>TSX snippet using <code>PipelineViewer</code></td>
            </tr>
            <tr>
              <td><code>code.vscode</code></td>
              <td><code>megane.json</code> content (SerializedPipeline JSON)</td>
            </tr>
          </tbody>
        </table>
      </main>
    </Layout>
  );
}
