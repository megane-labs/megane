/**
 * The `megane serve` host's remote file source: the server's `/api/files`
 * endpoints (`python/megane/server.py`) list and read files under the folder
 * the server was started in (or `--files-root`).
 *
 * The standalone webapp is also served by Vite and by static hosting, where no
 * such API exists, so `detectServerFileSource` probes first and registers
 * nothing unless the answer is a real listing. The webapp calls it only when
 * `shouldProbeServerFiles` says the page came from a server that offers the
 * API, so other hosts never log the probe's 404 or 403.
 */

import type { BrowsableRemoteFileSource, RemoteDirListing } from "./fileSource";

/** The `<meta name>` megane serve adds to the page when it serves `/api/files` to this browser. */
export const SERVER_FILES_META = "megane-server-files";

/**
 * Whether to probe `/api/files`: when megane serve marked the page, or under
 * the Vite dev server, which serves its own page but proxies `/api` to a
 * megane serve on port 8765.
 */
export function shouldProbeServerFiles(
  doc: Pick<Document, "querySelector"> = document,
  dev: boolean = import.meta.env.DEV,
): boolean {
  return dev || doc.querySelector(`meta[name="${SERVER_FILES_META}"]`) !== null;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function isListing(body: unknown): body is RemoteDirListing {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return typeof b.path === "string" && Array.isArray(b.entries);
}

async function errorText(resp: Response): Promise<string> {
  try {
    const body = (await resp.json()) as { detail?: unknown };
    if (typeof body.detail === "string") return body.detail;
  } catch {
    // Not JSON: fall through to the status line.
  }
  return `${resp.status} ${resp.statusText}`.trim();
}

/** A source backed by `megane serve` at `base` ("" for the page's own origin). */
export function createServerFileSource(
  base = "",
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): BrowsableRemoteFileSource {
  return {
    mode: "browse",
    label: "Open from server...",
    async list(path) {
      const resp = await fetchImpl(`${base}/api/files?path=${encodeURIComponent(path)}`);
      if (!resp.ok) throw new Error(await errorText(resp));
      const body: unknown = await resp.json();
      if (!isListing(body)) throw new Error("Unexpected response from the server");
      return body;
    },
    async read(path) {
      const resp = await fetchImpl(`${base}/api/files/content?path=${encodeURIComponent(path)}`);
      if (!resp.ok) throw new Error(await errorText(resp));
      const bytes = await resp.arrayBuffer();
      return new File([bytes], path.split("/").pop() || path);
    },
  };
}

/**
 * The server's source when the page was served by `megane serve` with file
 * browsing on, else null. Never throws: a missing or refused API just means
 * the button stays hidden.
 */
export async function detectServerFileSource(
  base = "",
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<BrowsableRemoteFileSource | null> {
  try {
    const resp = await fetchImpl(`${base}/api/files?path=`, {
      headers: { Accept: "application/json" },
    });
    // Vite and static hosts answer unknown paths with index.html (200), so
    // the content type and the body's shape are checked too.
    if (!resp.ok || !(resp.headers.get("content-type") ?? "").includes("application/json")) {
      return null;
    }
    if (!isListing(await resp.json())) return null;
    return createServerFileSource(base, fetchImpl);
  } catch {
    return null;
  }
}
