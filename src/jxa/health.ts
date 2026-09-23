import { busyStatus, CaptureOneError, clearBusy, isRunning, runJxa } from "./bridge.js";

export interface HealthReport {
  processRunning: boolean;
  /** Apple Events actually round-tripping. The only trustworthy liveness signal. */
  eventsReachable: boolean;
  appVersion?: string;
  /** `id` is the document's own identity (its folder path) and is what a
   *  document pin is compared against; `path` is the folder CONTAINING it. */
  document?: { id: string; name: string; kind: "session" | "catalog"; path: string };
  problem?: { code: string; message: string };
  /** True while state-changing calls are refused with BUSY because an earlier
   *  one timed out. `busyReason` says which timeout and when. */
  busy: boolean;
  busyReason?: string;
  /** Present when THIS probe cleared a busy state: the app answers again, but
   *  the timed-out call may or may not have taken effect. */
  busyCleared?: { reason: string; since: string; note: string };
}

function busyFields(): Pick<HealthReport, "busy" | "busyReason"> {
  const b = busyStatus();
  return b.busy ? { busy: true, busyReason: `${b.reason} (since ${b.since})` } : { busy: false };
}

/**
 * Distinguishes "app not launched" from "app launched but Apple Events are
 * blocked" -- these need completely different fixes and both otherwise present
 * as a generic hang.
 */
export async function healthCheck(): Promise<HealthReport> {
  const processRunning = await isRunning();
  if (!processRunning) {
    return {
      processRunning: false,
      eventsReachable: false,
      problem: { code: "NOT_RUNNING", message: "Capture One is not running. Launch it first." },
      ...busyFields(),
    };
  }

  try {
    // `app version` is served by Capture One's own handler, unlike `version`,
    // which JXA answers from the bundle. Short budget: a healthy app replies in
    // milliseconds, so anything slow here means the event pipe is blocked.
    const info = await runJxa<{ appVersion: string; doc: HealthReport["document"] | null }>(
      `
      const out = { appVersion: co.appVersion(), doc: null };
      const d = co.currentDocument(); // null when nothing is open -- a normal state
      if (d) out.doc = { id: String(d.id()), name: d.name(), kind: String(d.kind()), path: String(d.path()) };
      return out;
      `,
      // observeOnly: a health check must not claim the server for a document.
      // Binding here latched onto whatever was frontmost at diagnosis time and
      // then refused every later call once the user focused the right document.
      { timeoutMs: 8_000, observeOnly: true },
    );

    // The app answered a real Apple Event within the fixed budget, so it is no
    // longer stuck on the call that timed out. That is all this proves: the
    // earlier write may have completed, partially applied, or never started.
    const cleared = clearBusy();
    return {
      processRunning: true,
      eventsReachable: true,
      appVersion: info.appVersion,
      ...(info.doc ? { document: info.doc } : {}),
      busy: false,
      ...(cleared
        ? {
            busyCleared: {
              ...cleared,
              note:
                "Capture One is responding again, so state-changing calls are allowed. The call " +
                "that timed out may have completed, partially applied, or not run at all: read " +
                "back the affected variants (or the processing queue and output files) before " +
                "retrying it.",
            },
          }
        : {}),
    };
  } catch (err) {
    const e = err as CaptureOneError;
    return {
      processRunning: true,
      eventsReachable: false,
      problem: { code: e.code ?? "SCRIPT_ERROR", message: e.message },
      ...busyFields(),
    };
  }
}
