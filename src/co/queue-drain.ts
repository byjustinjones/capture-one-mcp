/**
 * Deciding that a processing queue has drained.
 *
 * `co.process` returns a batch id immediately, and the job does not necessarily
 * appear in `document.jobs` by the time the first poll reads it. Treating that
 * first empty read as "drained" declared a batch finished before it had started:
 * processVariants diffed output history that had not been written yet, and
 * renderPreview read a file that did not exist and then deleted the private
 * recipe the still-pending job was about to use.
 *
 * An empty queue therefore only counts as drained when one of these holds:
 *  - the queue was seen non-empty at least once, and is now empty;
 *  - the caller has independent evidence the work completed (the preview file
 *    exists; every requested variant has a new output event);
 *  - the queue has read empty on consecutive polls spanning DRAIN_QUIET_MS.
 *    This is the weakest signal and exists for jobs too quick to be observed
 *    that also leave no evidence (existing_files:"skip" writes nothing).
 */
export const DRAIN_QUIET_MS = 3_000;

export type DrainedBy = "queue-observed" | "completion-evidence" | "quiet-period";

export interface DrainTracker {
  /** True once any poll has seen a pending job. */
  readonly sawJobs: boolean;
  /** Record one poll. Returns how the queue is known to have drained, or null. */
  observe(pending: number, evidence: boolean): DrainedBy | null;
}

export function drainTracker(now: () => number = Date.now): DrainTracker {
  let sawJobs = false;
  let emptySince: number | null = null;
  return {
    get sawJobs() { return sawJobs; },
    observe(pending, evidence) {
      const t = now();
      if (pending > 0) {
        sawJobs = true;
        emptySince = null;
        return null;
      }
      if (sawJobs) return "queue-observed";
      if (evidence) return "completion-evidence";
      if (emptySince === null) emptySince = t;
      return t - emptySince >= DRAIN_QUIET_MS ? "quiet-period" : null;
    },
  };
}
