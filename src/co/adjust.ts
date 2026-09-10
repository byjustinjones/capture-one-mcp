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
  count: number;
  affected: {
    id: string;
    name: string;
    extension: string;
    applied: Record<string, AppliedProperty>;
  }[];
  notFound: string[];
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
        warnings.push(
          `'${param}' is modular: Capture One wraps it rather than clamping, and once written it ` +
            `cannot be set back to 0 through scripting (0 reads back as 360). Its bounds could ` +
            `not be measured, so this value is not range-checked.`,
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

    const applied = {};
    for (let p = 0; p < props.length; p++) {
      const key = props[p];
      const want = args.patch[key];
      let err = null;
      try { a[key] = want; } catch (e) { err = String(e).replace(/^Error:\\s*/, ""); }
      // Only report a value when the read SUCCEEDED, and keep the reason when it
      // did not. A null with no reason presents an unreadable property as a value
      // mismatch, which is the jpegQuality class of silent failure.
      let actual = null;
      let readOk = false;
      try { actual = norm(a[key]()); readOk = true; } catch (e) { err = err || "read-back failed: " + String(e); }
      const entry = { requested: norm(want), actual: actual, matched: readOk && norm(want) === actual };
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
        paramFor: Object.fromEntries(
          Object.keys(jxa).map((j) => [j, ADJUSTMENT_PROPERTIES.find((p) => p.jxa === j)?.param ?? j]),
        ),
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

    const affected = [];
    for (let t = 0; t < targets.length; t++) {
      const v = targets[t];
      const a = v.adjustments();
      const applied = {};

      for (let p = 0; p < props.length; p++) {
        const key = props[p];
        const want = args.patch[key];
        let err = null;
        try { a[key] = want; } catch (e) { err = String(e).replace(/^Error:\\s*/, ""); }

        let actual = null;
        let readOk = false;
        try { actual = norm(a[key]()); readOk = true; } catch (e) { err = err || "read-back failed: " + String(e); }

        const entry = { requested: norm(want), actual: actual, matched: readOk && norm(want) === actual };
        if (err) entry.note = err;
        applied[args.paramFor[key]] = entry;
      }

      const info = describeVariant(v);
      info.applied = applied;
      affected.push(info);
    }

    return { count: affected.length, affected: affected, notFound: notFound };
    `,
    {
      args: {
        target,
        patch: jxa,
        paramFor: Object.fromEntries(
          Object.keys(jxa).map((j) => [j, ADJUSTMENT_PROPERTIES.find((p) => p.jxa === j)?.param ?? j]),
        ),
      },
      timeoutMs: 180_000,
      mutating: true,
    },
  );

  // Surface anything that did not land, so a caller cannot read a bare success.
  for (const v of result.affected) {
    for (const [param, entry] of Object.entries(v.applied)) {
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
