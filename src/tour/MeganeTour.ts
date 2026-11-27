/**
 * Thin wrapper around driver.js that owns tour lifecycle: configuring steps,
 * rendering a "don't show again" checkbox in the footer, and forwarding state
 * changes to the tour store so React components stay in sync.
 */
import { driver, type Driver } from "driver.js";
import "driver.js/dist/driver.css";
import "./tour.css";
import { useTourStore } from "./tourStore";
import { buildTourSteps, buildPipelineTutorialSteps } from "./tourSteps";
import { followActiveElement, presentSteps } from "./followTarget";

const CHECKBOX_ID = "megane-tour-dont-show";

let activeDriver: Driver | null = null;
/** Stops keeping the active tour's callout on its target (`followActiveElement`). */
let stopFollowing: (() => void) | null = null;

function injectDontShowCheckbox(footer: HTMLElement): void {
  if (footer.querySelector(`#${CHECKBOX_ID}`)) return;

  const wrapper = document.createElement("label");
  wrapper.className = "megane-tour-dont-show";
  wrapper.htmlFor = CHECKBOX_ID;

  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = CHECKBOX_ID;
  input.checked = useTourStore.getState().dontShowAgain;
  input.addEventListener("change", () => {
    useTourStore.getState().setDontShowAgain(input.checked);
  });

  const text = document.createElement("span");
  text.textContent = "Don't show this again";

  wrapper.appendChild(input);
  wrapper.appendChild(text);

  // Place the checkbox at the very start of the footer so it sits left of
  // the progress text and navigation buttons.
  footer.insertBefore(wrapper, footer.firstChild);
}

interface RunTourOptions {
  steps: ReturnType<typeof buildTourSteps>;
  showProgress: boolean;
}

function runTour({ steps, showProgress }: RunTourOptions): void {
  // Re-create the driver on every start so steps reflect the latest DOM
  // (panels can be collapsed/expanded between sessions).
  if (activeDriver) {
    activeDriver.destroy();
    activeDriver = null;
  }
  // A step whose target is not on screen (the pipeline panel's rail while
  // the panel is collapsed) would be drawn mid-page under text about a
  // highlighted control.
  const shown = presentSteps(steps);

  const tour = driver({
    showProgress,
    progressText: "{{current}} / {{total}}",
    nextBtnText: "Next",
    prevBtnText: "Back",
    doneBtnText: "Done",
    allowClose: true,
    overlayOpacity: 0.55,
    overlayColor: "#0f172a",
    stagePadding: 6,
    stageRadius: 10,
    popoverClass: "megane-tour",
    steps: shown,
    onPopoverRender: (popover) => {
      injectDontShowCheckbox(popover.footer);
    },
    onDestroyed: () => {
      stopFollowing?.();
      stopFollowing = null;
      useTourStore.getState().setActive(false);
      activeDriver = null;
    },
  });

  activeDriver = tour;
  useTourStore.getState().setActive(true);
  tour.drive();
  // driver.js re-places a callout only on a window resize or scroll; keep it
  // on its target through every other layout change.
  stopFollowing = followActiveElement(tour);
}

export function startTour(): void {
  runTour({ steps: buildTourSteps(), showProgress: true });
}

export function startPipelineTutorial(): void {
  runTour({ steps: buildPipelineTutorialSteps(), showProgress: true });
}

export function stopTour(): void {
  activeDriver?.destroy();
  activeDriver = null;
}
