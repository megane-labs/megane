import { usePipelineStore } from "@megane/pipeline/store";
import { capturePipelineStore, type PipelineStoreSnapshot } from "@megane/pipeline/storeSnapshot";

/** The tab whose state the shared store currently holds. */
let owner: TabStoreCache | null = null;

function setOwner(tab: TabStoreCache | null): void {
  owner = tab;
}

/** Hand the store to `next`, letting the current owner keep its edits first. */
function takeOver(next: TabStoreCache): void {
  owner?.save();
  setOwner(next);
}

/**
 * One document tab's copy of the pipeline store.
 *
 * Every Megane tab in JupyterLab (structure files and `.megane.json`
 * pipelines alike) renders from the same singleton pipeline store, so each tab
 * keeps its own copy and puts it back when it is shown again. That copy must
 * follow the edits made in the tab — a Filter node added, a structure
 * uploaded, a template applied — not only the state right after the file
 * loaded, so it is re-taken whenever the tab gives the store up: when it is
 * hidden, and when another tab loads its file or is shown.
 *
 * Only the tab that currently owns the store may re-take its copy. A tab
 * becomes the owner when it starts loading its file or is shown with a copy
 * to restore; a hidden tab whose store was taken over by another tab keeps
 * the copy it had.
 */
export class TabStoreCache {
  private snapshot: PipelineStoreSnapshot | null = null;

  /** The tab is about to load its file into the store. */
  claim(): void {
    takeOver(this);
  }

  /** The tab's file finished loading: the store now holds this tab's state. */
  capture(): void {
    setOwner(this);
    this.record();
  }

  /**
   * The tab was shown: put its state back into the store. Does nothing while
   * the first load is still running, since that load captures when it ends.
   */
  restore(): void {
    if (!this.snapshot) return;
    takeOver(this);
    usePipelineStore.setState(this.snapshot);
  }

  /** The tab is giving the store up: keep the edits made while it owned it. */
  save(): void {
    if (owner === this && this.snapshot) this.record();
  }

  /** The tab closed: nobody owns the store until another tab claims it. */
  release(): void {
    if (owner === this) setOwner(null);
  }

  private record(): void {
    this.snapshot = capturePipelineStore(usePipelineStore.getState());
  }
}
