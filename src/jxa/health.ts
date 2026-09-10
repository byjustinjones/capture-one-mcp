import { CaptureOneError, isRunning, runJxa } from "./bridge.js";

export interface HealthReport {
  processRunning: boolean;
  /** Apple Events actually round-tripping. The only trustworthy liveness signal. */
  eventsReachable: boolean;
  appVersion?: string;
  /** `id` is the document's own identity (its folder path) and is what a
   *  document pin is compared against; `path` is the folder CONTAINING it. */
  document?: { id: string; name: string; kind: "session" | "catalog"; path: string };
  problem?: { code: string; message: string };
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

    return {
      processRunning: true,
      eventsReachable: true,
      appVersion: info.appVersion,
      ...(info.doc ? { document: info.doc } : {}),
    };
  } catch (err) {
    const e = err as CaptureOneError;
    return {
      processRunning: true,
      eventsReachable: false,
      problem: { code: e.code ?? "SCRIPT_ERROR", message: e.message },
    };
  }
}
