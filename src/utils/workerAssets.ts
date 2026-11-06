/**
 * Files a Web Worker must not fetch itself.
 *
 * A VS Code webview page runs on a `vscode-webview://` origin and the
 * extension's files are served from a resource origin
 * (`https://*.vscode-resource.vscode-cdn.net`) that exists only inside the
 * webview's service worker. The service worker routes the page's own requests
 * by the page's URL, but a Web Worker's requests through a message port it
 * keeps in memory. The browser stops an idle service worker after about 30 s,
 * and the port is not handed over again when it restarts, so from then on a
 * worker's request for such a URL hangs for 30 s and fails (HTTP 408). That
 * is why a worker that starts while the page is busy loading works, and the
 * same worker started after a minute of drawing in Ketcher does not.
 *
 * A worker in a webview therefore never fetches from that origin: its script
 * is inlined in the bundle (a `blob:` worker), and the page fetches the
 * `.wasm` it needs and hands it over (`fetchAsBlobUrl` here, or a compiled
 * module, see `parsers/parseClient.ts`).
 */

/** Whether `url` is on another origin than the page, so a worker of the page should not fetch it. */
export function isCrossOriginAsset(url: string, pageUrl: string | undefined): boolean {
  if (!pageUrl) return false;
  try {
    const resolved = new URL(url, pageUrl);
    if (resolved.protocol === "blob:" || resolved.protocol === "data:") return false;
    const pageOrigin = new URL(pageUrl).origin;
    // A custom-scheme page (`vscode-webview://…`) has an opaque origin.
    return pageOrigin === "null" || resolved.origin !== pageOrigin;
  } catch {
    return false;
  }
}

/** One `blob:` URL per fetched URL, kept for the page's lifetime (workers come and go). */
const blobUrls = new Map<string, Promise<string>>();

/**
 * Fetch `url` from the page and return a `blob:` URL of it, typed `type`,
 * which a worker of this page can fetch without the network. One fetch per
 * URL; a failed fetch is forgotten, so the next call tries again.
 */
export function fetchAsBlobUrl(url: string, type: string): Promise<string> {
  let blobUrl = blobUrls.get(url);
  if (!blobUrl) {
    blobUrl = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`failed to fetch ${url}: HTTP ${res.status}`);
        return res.blob();
      })
      // Typed, so a worker can stream-compile a `.wasm` from it.
      .then((blob) => URL.createObjectURL(new Blob([blob], { type })));
    blobUrl.catch(() => blobUrls.delete(url));
    blobUrls.set(url, blobUrl);
  }
  return blobUrl;
}
