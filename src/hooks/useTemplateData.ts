/**
 * Load a pipeline template's demo files once the editor applies it.
 *
 * `applyTemplate` only installs the graph and raises `pendingTemplateId`: the
 * loader nodes name their fixtures but hold no data. Every host that mounts
 * the pipeline editor (webapp, JupyterLab viewers, VSCode webview) calls this
 * hook with its own structure loader so the template's scene actually loads —
 * without it the viewer kept drawing whatever was open before.
 */

import { useEffect, useRef } from "react";
import { usePipelineStoreApi, useScopedPipelineStore } from "../stores/MeganeProvider";
import { loadTemplateData, type TemplateDataLoader } from "../pipeline/templateAssets";
import { TEMPLATE_FIXTURE_URLS } from "../pipeline/templateFixtures";

/**
 * @param loader  The host's `useMeganeLocal()` (or anything with its
 *   `loadText` / `loadXtc`), so the template's structure replaces the opened
 *   file through the same path a file open takes.
 * @param onApply Called once per applied template, before its files load.
 */
export function useTemplateData(
  loader: TemplateDataLoader,
  onApply?: (templateId: string) => void,
): void {
  const pipelineApi = usePipelineStoreApi();
  const pendingTemplateId = useScopedPipelineStore((s) => s.pendingTemplateId);
  // `useMeganeLocal` returns a fresh object every render; read the latest one
  // when a template lands instead of re-running the effect for each.
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const onApplyRef = useRef(onApply);
  onApplyRef.current = onApply;

  useEffect(() => {
    if (!pendingTemplateId) return;
    onApplyRef.current?.(pendingTemplateId);
    loadTemplateData(
      pendingTemplateId,
      TEMPLATE_FIXTURE_URLS,
      pipelineApi.getState,
      loaderRef.current,
    )
      .catch((err) => {
        console.error(`Failed to load the "${pendingTemplateId}" template's files:`, err);
      })
      .finally(() => {
        // Cleared even on failure, so picking the same template again
        // retries; but not if another template was applied meanwhile.
        const store = pipelineApi.getState();
        if (store.pendingTemplateId === pendingTemplateId) store.clearPendingTemplate();
      });
  }, [pendingTemplateId, pipelineApi]);
}
