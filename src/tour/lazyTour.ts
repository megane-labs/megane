/**
 * The tour controller (`./MeganeTour`) pulls in driver.js and its stylesheet,
 * which only a first-time visitor or a click on Guide needs: it is loaded the
 * first time a tour starts, not with the viewer.
 */
type TourModule = typeof import("./MeganeTour");

let loaded: Promise<TourModule> | null = null;

function load(): Promise<TourModule> {
  loaded ??= import("./MeganeTour");
  return loaded;
}

/** Start the guided tour (loading it first if needed). */
export function startTour(): Promise<void> {
  return load().then((m) => m.startTour());
}

/** Start the pipeline tutorial (loading the tour first if needed). */
export function startPipelineTutorial(): Promise<void> {
  return load().then((m) => m.startPipelineTutorial());
}

/** Stop a running tour; nothing to do when none was ever loaded. */
export function stopTour(): void {
  if (loaded) void loaded.then((m) => m.stopTour());
}
