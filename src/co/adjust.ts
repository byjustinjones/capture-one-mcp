import { runJxa } from "../jxa/bridge.js";
import { ADJUSTMENT_PROPERTIES } from "./adjustment-properties.js";
import { ADJUSTMENT_RANGES } from "./adjustment-ranges.js";
import type { Target } from "./edit.js";

const BY_PARAM = new Map(ADJUSTMENT_PROPERTIES.map((p) => [p.param, p]));

export interface AppliedProperty {
  requested: unknown;
  actual: unknown;
  matched: boolean;
  note?: string;
}

export interface AdjustResult {
  /** "incomplete" when a variant threw partway: see `error`, `unattemptedIds`. */
  status: "complete" | "incomplete";
  count: number;
  affected: {
    id: string;
    name: string;
    extension: string;
    /** Absent on the entry that failed, which carries `error` instead. */
    applied?: Record<string, AppliedProperty>;
    error?: string;
  }[];
  notFound: string[];
  unattemptedIds?: string[];
  guidance?: string;
  warnings: string[];
}

export function knownParams(): string[] {
  return ADJUSTMENT_PROPERTIES.map((p) => p.param).sort();
}

/**
 * Validates a patch before anything is written.
 *
 * Ranges come from `adjustment-ranges.ts`, recovered by probing the live app --
 * the dictionary declares none. Validating up front means a bad value fails the
 * whole call cleanly instead of leaving a variant half-adjusted.
 */
/**
 * Read-back comparison rules, keyed by snake_case param.
 *
 * `temperature` and `tint` are stored at lower precision than they are accepted
 * (5500 reads back as 5500.001465), so exact equality reported every white
 * balance write as a mismatch. They match within READBACK_TOLERANCE; every other
 * real value is float32 (rotation 2.6 reads 2.599998) and matches within a
 * relative 1e-5. The four
 * colour-balance hues wrap, and a written 0 reads back as 360, so they compare
 * modulo 360. Non-numeric values must read back exactly. See docs/ADJUSTMENTS.md.
 */
const READBACK_TOLERANCE: Record<string, number> = { temperature: 0.01, tint: 0.01 };

function comparisonArgs(jxa: Record<string, unknown>): {
  paramFor: Record<string, string>; tolerance: Record<string, number>; modular: Record<string, boolean>;
} {
  const paramFor: Record<string, string> = {};
  const tolerance: Record<string, number> = {};
  const modular: Record<string, boolean> = {};
  for (const j of Object.keys(jxa)) {
    const param = ADJUSTMENT_PROPERTIES.find((p) => p.jxa === j)?.param ?? j;
    paramFor[j] = param;
    if (READBACK_TOLERANCE[param] !== undefined) tolerance[j] = READBACK_TOLERANCE[param];
    if (ADJUSTMENT_RANGES[param]?.modular) modular[j] = true;
  }
  return { paramFor, tolerance, modular };
}

function validate(patch: Record<string, unknown>): { jxa: Record<string, unknown>; warnings: string[] } {
  const jxa: Record<string, unknown> = {};
  const warnings: string[] = [];

  for (const [param, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue;
    const prop = BY_PARAM.get(param);
    if (!prop) {
      const near = knownParams().filter((p) => p.includes(param) || param.includes(p)).slice(0, 5);
      throw new Error(
        `Unknown adjustment '${param}'.` + (near.length ? ` Did you mean: ${near.join(", ")}?` : "") +
          ` Use co_list_adjustments to see all ${ADJUSTMENT_PROPERTIES.length} properties.`,
      );
    }

    if (prop.kind === "enum") {
      if (!prop.values?.includes(String(value))) {
        throw new Error(`'${param}' must be one of: ${prop.values?.join(", ")}. Got ${JSON.stringify(value)}.`);
      }
    } else if (prop.kind === "boolean") {
      if (typeof value !== "boolean") throw new Error(`'${param}' must be a boolean. Got ${JSON.stringify(value)}.`);
    } else if (prop.kind === "text") {
      if (typeof value !== "string") throw new Error(`'${param}' must be a string. Got ${JSON.stringify(value)}.`);
    } else {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`'${param}' must be a number. Got ${JSON.stringify(value)}.`);
      }
      const range = ADJUSTMENT_RANGES[param];
      if (range?.allowed && !range.allowed.includes(value)) {
        throw new Error(`'${param}' accepts only ${range.allowed.join(", ")}. Got ${value}.`);
      }
      if (range?.min !== undefined && value < range.min) {
        throw new Error(`'${param}' must be >= ${range.min} (Capture One rejects lower). Got ${value}.`);
      }
      if (range?.max !== undefined && value > range.max) {
        throw new Error(`'${param}' must be <= ${range.max} (Capture One rejects higher). Got ${value}.`);
      }
      if (range?.modular) {
        // Capture One would accept and wrap anything, but a value outside one
        // turn is almost certainly a caller's mistake (degrees vs radians, a
        // delta passed as an absolute), and wrapping hides it.
        if (value < 0 || value > 360) {
          throw new Error(`'${param}' is a hue and must be between 0 and 360 degrees. Got ${value}.`);
        }
        warnings.push(
          `'${param}' is modular: Capture One wraps it rather than clamping, and once written it ` +
            `cannot be set back to 0 through scripting (0 reads back as 360). Read-back compares ` +
            `modulo 360, so 0 and 360 match.`,
        );
      }
    }
    jxa[prop.jxa] = value;
  }

  if (!Object.keys(jxa).length) throw new Error("No adjustments supplied.");
  return { jxa, warnings };
}

/**
 * Applies an adjustment patch and reads every written property back.
 *
 * Capture One accepts some writes and then stores something else -- floats are
 * requantised, and a few properties are modular. A write that returns without
 * error therefore proves nothing, so each property is re-read after the write
 * and reported as requested/actual/matched rather than assumed to have landed.
 */
export async function adjustLayer(
  ref: { variantId: string; layerIndex: number },
  patch: Record<string, unknown>,
): Promise<{ variant: unknown; layerIndex: number; kind: string; applied: Record<string, AppliedProperty>; warnings: string[] }> {
  const { jxa, warnings } = validate(patch);

  const result = await runJxa<{
    variant: unknown; layerIndex: number; kind: string; applied: Record<string, AppliedProperty>;
  }>(
    `
    const picked = resolveLayer(args.ref);
    const layer = picked.layer;
    const a = layer.adjustments();
    const props = Object.keys(args.patch);

    function norm(x) {
      if (x === null || x === undefined) return null;
      if (typeof x === "number") return Math.round(x * 1e6) / 1e6;
      if (typeof x === "boolean") return x;
      return String(x);
    }

    // temperature/tint match within a tolerance (they are requantised on
    // store); the colour-balance hues compare modulo 360 (0 reads back as 360).
    function same(key, want, actual) {
      if (typeof want === "number" && typeof actual === "number") {
        if (args.modular && args.modular[key]) return norm(((want % 360) + 360) % 360) === norm(((actual % 360) + 360) % 360);
        // The epsilon absorbs float noise in the subtraction itself, so a
        // difference of exactly the tolerance is not rejected as 0.0100000001.
        if (args.tolerance && args.tolerance[key] !== undefined) return Math.abs(want - actual) <= args.tolerance[key] + 1e-9;
        // Everything else is stored as float32, so 2.6 reads back as 2.599998:
        // match within float precision rather than exactly.
        return Math.abs(want - actual) <= 1e-5 * Math.max(1, Math.abs(want)) + 1e-9;
      }
      return want === actual;
    }

    // Write the whole patch first, then read all of it back. Reading each
    // property straight after its own write missed a later write in the same
    // patch moving an earlier property, and reported the earlier one as landed.
    const writeErr = {};
    for (let p = 0; p < props.length; p++) {
      const key = props[p];
      try { a[key] = args.patch[key]; } catch (e) { writeErr[key] = String(e).replace(/^Error:\\s*/, ""); }
    }
    const applied = {};
    for (let p = 0; p < props.length; p++) {
      const key = props[p];
      const want = norm(args.patch[key]);
      let err = writeErr[key] || null;
      // Only report a value when the read SUCCEEDED, and keep the reason when it
      // did not. A null with no reason presents an unreadable property as a value
      // mismatch, which is the jpegQuality class of silent failure.
      let actual = null;
      let readOk = false;
      try { actual = norm(a[key]()); readOk = true; } catch (e) { err = err || "read-back failed: " + String(e); }
      const entry = { requested: want, actual: actual, matched: readOk && same(key, want, actual) };
      if (err) entry.note = err;
      applied[args.paramFor[key]] = entry;
    }

    return {
      variant: describeVariant(picked.variant),
      layerIndex: args.ref.layerIndex,
      kind: String(layer.kind()),
      applied: applied,
    };
    `,
    {
      args: {
        ref,
        patch: jxa,
        ...comparisonArgs(jxa),
      },
      timeoutMs: 120_000,
      mutating: true,
    },
  );

  for (const [param, entry] of Object.entries(result.applied)) {
    if (!entry.matched) {
      warnings.push(
        `layer ${result.layerIndex}: '${param}' requested ${JSON.stringify(entry.requested)} but reads ` +
          `back ${JSON.stringify(entry.actual)}${entry.note ? ` (${entry.note})` : ""}.`,
      );
    }
  }
  return { ...result, warnings };
}

export async function adjustVariants(
  target: Target,
  patch: Record<string, unknown>,
): Promise<AdjustResult> {
  const { jxa, warnings } = validate(patch);

  const result = await runJxa<Omit<AdjustResult, "warnings">>(
    `
    const resolved = resolveTargets(args.target);
    const targets = resolved.targets;
    const notFound = resolved.notFound;
    const props = Object.keys(args.patch);

    function norm(x) {
      if (x === null || x === undefined) return null;
      if (typeof x === "number") return Math.round(x * 1e6) / 1e6;
      if (typeof x === "boolean") return x;
      return String(x);
    }

    // temperature/tint match within a tolerance (they are requantised on
    // store); the colour-balance hues compare modulo 360 (0 reads back as 360).
    function same(key, want, actual) {
      if (typeof want === "number" && typeof actual === "number") {
        if (args.modular && args.modular[key]) return norm(((want % 360) + 360) % 360) === norm(((actual % 360) + 360) % 360);
        // The epsilon absorbs float noise in the subtraction itself, so a
        // difference of exactly the tolerance is not rejected as 0.0100000001.
        if (args.tolerance && args.tolerance[key] !== undefined) return Math.abs(want - actual) <= args.tolerance[key] + 1e-9;
        // Everything else is stored as float32, so 2.6 reads back as 2.599998:
        // match within float precision rather than exactly.
        return Math.abs(want - actual) <= 1e-5 * Math.max(1, Math.abs(want)) + 1e-9;
      }
      return want === actual;
    }

    const affected = [];
    let stopped = null;
    for (let t = 0; t < targets.length; t++) {
      try {
        const v = targets[t];
        const a = v.adjustments();
        const applied = {};

        // Whole patch first, then the read-back -- see adjustLayer.
        const writeErr = {};
        for (let p = 0; p < props.length; p++) {
          const key = props[p];
          try { a[key] = args.patch[key]; } catch (e) { writeErr[key] = String(e).replace(/^Error:\\s*/, ""); }
        }
        for (let p = 0; p < props.length; p++) {
          const key = props[p];
          const want = norm(args.patch[key]);
          let err = writeErr[key] || null;
          let actual = null;
          let readOk = false;
          try { actual = norm(a[key]()); readOk = true; } catch (e) { err = err || "read-back failed: " + String(e); }

          const entry = { requested: want, actual: actual, matched: readOk && same(key, want, actual) };
          if (err) entry.note = err;
          applied[args.paramFor[key]] = entry;
        }

        const info = describeVariant(v);
        info.applied = applied;
        affected.push(info);
      } catch (e) {
        stopped = stopBatch(targets, t, e);
        affected.push(stopped.entry);
        break;
      }
    }

    const out = { status: stopped ? "incomplete" : "complete", count: affected.length, affected: affected, notFound: notFound };
    if (stopped) { out.unattemptedIds = stopped.unattemptedIds; out.guidance = stopped.guidance; }
    return out;
    `,
    {
      args: {
        target,
        patch: jxa,
        ...comparisonArgs(jxa),
      },
      timeoutMs: 180_000,
      mutating: true,
    },
  );

  // Surface anything that did not land, so a caller cannot read a bare success.
  for (const v of result.affected) {
    if (v.error) warnings.push(`${v.name}.${v.extension}: failed and stopped the batch: ${v.error}`);
    for (const [param, entry] of Object.entries(v.applied ?? {})) {
      if (!entry.matched) {
        warnings.push(
          `${v.name}.${v.extension}: '${param}' requested ${JSON.stringify(entry.requested)} but reads back ` +
            `${JSON.stringify(entry.actual)}${entry.note ? ` (${entry.note})` : ""}.`,
        );
      }
    }
  }

  return { ...result, warnings };
}
