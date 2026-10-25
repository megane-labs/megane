/**
 * React hook that wires the tour into a host. It runs the auto-start gate once
 * per session (per host) and exposes `startTour` for manual triggers like the
 * Pipeline header Guide button.
 */
import { useCallback, useEffect } from "react";
import { isE2ETestMode } from "../testMode";
import { startTour, stopTour } from "./lazyTour";
import { shouldAutoStart, useTourStore, type TourHost } from "./tourStore";

interface UseTourOptions {
  host: TourHost;
  /** Delay before auto-start so the highlighted DOM has settled. */
  autoStartDelayMs?: number;
}

export function useTour({ host, autoStartDelayMs = 600 }: UseTourOptions) {
  const setHost = useTourStore((s) => s.setHost);
  const autoStartHandled = useTourStore((s) => s.autoStartHandled);
  const markAutoStartHandled = useTourStore((s) => s.markAutoStartHandled);

  useEffect(() => {
    setHost(host);
  }, [host, setHost]);

  useEffect(() => {
    if (autoStartHandled) return;
    // Suppress auto-start under E2E so the welcome modal doesn't capture
    // the page while tests interact with JupyterLab tabs / the viewer. Uses
    // the shared detector so the webapp `?test=1` path is honoured too, not
    // just an injected `__MEGANE_TEST__` global (VSCode / JupyterLab hosts).
    const isTestMode = isE2ETestMode();
    const { dontShowAgain } = useTourStore.getState();
    if (isTestMode || !shouldAutoStart(host, dontShowAgain)) {
      markAutoStartHandled();
      return;
    }
    const timer = window.setTimeout(() => {
      markAutoStartHandled();
      void startTour();
    }, autoStartDelayMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [host, autoStartHandled, markAutoStartHandled, autoStartDelayMs]);

  useEffect(() => {
    return () => {
      stopTour();
    };
  }, []);

  const start = useCallback(() => {
    void startTour();
  }, []);

  return { startTour: start };
}
