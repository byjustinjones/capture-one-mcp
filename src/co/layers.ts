import { runJxa } from "../jxa/bridge.js";
import { ADJUSTMENT_PROPERTIES } from "./adjustment-properties.js";
import type { Target } from "./edit.js";

/**
 * Layers have no `id` property, so they are addressed positionally within a
 * variant. Index 0 is the background layer -- the dictionary notes that an
 * Image Layer reports its name and kind as "background" for backward
 * compatibility -- and it cannot be deleted.
 */
export interface LayerRef {
  variantId: string;
  layerIndex: number;
}

export const PEOPLE_MASK_AREAS = [
  "body skin", "face skin", "eyebrows", "lips", "hair",
  "iris and pupil", "sclera", "clothes",
] as const;

export const LUMA_RANGE_FIELDS = {
  range_low: "rangeLow",
  range_high: "rangeHigh",
  falloff_low: "falloffLow",
  falloff_high: "falloffHigh",
  invert: "invert",
  radius: "radius",
  sensitivity: "sensitivity",
} as const;

export async function listLayers(target: Target): Promise<unknown> {
  return runJxa(
    `
    // The same registry drives writers and readers. Preserve public camelCase
    // keys and retain unavailable values as null instead of losing coverage.
    function readAdjustments(owner) {
      const values = {};
      const errors = {};
      let a;
      try { a = owner.adjustments(); }
      catch (e) { return { values: null, errors: { adjustments: String(e) } }; }
      for (let i = 0; i < args.adjustmentProperties.length; i++) {
        const prop = args.adjustmentProperties[i];
        values[prop.jxa] = null;
        try {
          const value = a[prop.jxa]();
          if (value === undefined || value === null) throw new Error("Value unavailable");
          values[prop.jxa] = prop.kind === "text" || prop.kind === "enum" ? String(value) : value;
        } catch (e) { errors[prop.jxa] = String(e); }
      }
      return { values: values, errors: errors };
    }
    const resolved = resolveTargets(args.target);
    const out = [];
    for (let t = 0; t < resolved.targets.length; t++) {
      const v = resolved.targets[t];
      const info = describeVariant(v);
      info.layers = v.layers().map(function (l, i) {
        const snapshot = readAdjustments(l);
        const row = {
          adjustments: snapshot.values,
          adjustmentReadErrors: snapshot.errors,
          index: i,
          name: String(l.name()),
          kind: String(l.kind()),
          enabled: Boolean(l.enabled()),
          opacity: l.opacity(),
        };
        try {
          const lr = l.lumaRange();
          row.lumaRange = {
            rangeLow: lr.rangeLow(), rangeHigh: lr.rangeHigh(),
            falloffLow: lr.falloffLow(), falloffHigh: lr.falloffHigh(),
            invert: Boolean(lr.invert()), radius: lr.radius(), sensitivity: lr.sensitivity(),
          };
        } catch (e) { row.lumaRange = null; }
        return row;
      });
      out.push(info);
    }
    return { variants: out, notFound: resolved.notFound };
    `,
    { args: { target, adjustmentProperties: ADJUSTMENT_PROPERTIES }, timeoutMs: 120_000 },
  );
}

/**
 * Creates adjustment layers. `kind` is read-only on the layer class, so an
 * adjustment layer is the only type `make` can produce -- clone, heal and the
 * mask types cannot be created through the scripting interface.
 */
export async function createLayer(target: Target, name: string | null, count: number): Promise<unknown> {
  return runJxa(
    `
    const resolved = resolveTargets(args.target);
    const out = [];
    for (let t = 0; t < resolved.targets.length; t++) {
      const v = resolved.targets[t];
      const before = v.layers().length;
      const created = [];
      for (let n = 0; n < args.count; n++) {
        const props = {};
        if (args.name) props.name = args.count > 1 ? args.name + " " + (n + 1) : args.name;
        const made = Object.keys(props).length
          ? co.make({ new: "layer", at: v, withProperties: props })
          : co.make({ new: "layer", at: v });
        created.push(String(made.name()));
      }
      // Read the layer list back rather than trusting make's return value.
      const after = v.layers().map(function (l, i) {
        return { index: i, name: String(l.name()), kind: String(l.kind()) };
      });
      const info = describeVariant(v);
      info.layersBefore = before;
      info.layersAfter = after.length;
      info.created = created;
      info.layers = after;
      info.verified = after.length === before + args.count;
      out.push(info);
    }
    return { variants: out, notFound: resolved.notFound };
    `,
    { args: { target, name, count }, timeoutMs: 120_000, mutating: true },
  );
}

/** Name, enabled and opacity, each read back after writing. */
export async function setLayer(
  ref: LayerRef,
  props: { name?: string; enabled?: boolean; opacity?: number },
): Promise<unknown> {
  return runJxa(
    `
    const picked = resolveLayer(args.ref);
    const v = picked.variant;
    const layers = picked.layers;
    const layer = picked.layer;
    // Per-field, so one rejected write does not abandon the call after earlier
    // fields were already written. The background layer refuses opacity, which
    // previously failed the whole call with name/enabled silently applied.
    const applied = {};
    const fields = [["name", "name"], ["enabled", "enabled"], ["opacity", "opacity"]];
    for (let f = 0; f < fields.length; f++) {
      const key = fields[f][0];
      const want = args.props[key];
      if (want === undefined) continue;
      let err = null;
      try { layer[key] = want; } catch (e) { err = String(e).replace(/^Error:\\s*/, ""); }
      let actual = null;
      let readOk = false;
      try { actual = layer[key](); readOk = true; } catch (e) { err = err || "read-back failed: " + String(e); }
      if (readOk) {
        if (key === "name") actual = String(actual);
        else if (key === "enabled") actual = Boolean(actual);
      }
      const entry = { requested: want, actual: actual, matched: readOk && actual === want };
      if (err) entry.note = err;
      applied[key] = entry;
    }
    return {
      variant: describeVariant(v),
      layerIndex: args.ref.layerIndex,
      kind: String(layer.kind()),
      applied: applied,
    };
    `,
    { args: { ref, props }, timeoutMs: 60_000, mutating: true },
  );
}

/**
 * Mask operations.
 *
 * NOTE ON VERIFICATION: the layer class exposes no mask property, and readouts
 * (the only pixel-sampling objects) cannot be created through scripting -- their
 * position is read-only. A mask's contents are therefore unobservable, so these
 * report only that the command was accepted. That is genuinely weaker than the
 * read-back verification everywhere else in this server, and is reported as
 * such rather than dressed up as confirmation.
 */
export async function maskOperation(
  ref: LayerRef,
  operation: "invert" | "fill" | "clear" | "rasterize" | "feather" | "refine",
  amount: number | null,
): Promise<unknown> {
  return runJxa(
    `
    const picked = resolveLayer(args.ref);
    const v = picked.variant;
    const layers = picked.layers;
    const layer = picked.layer;
    const op = args.operation;
    if (op === "invert") co.invertMask(layer);
    else if (op === "fill") co.fillMask(layer);
    else if (op === "clear") co.clearMask(layer);
    else if (op === "rasterize") co.rasterizeMask(layer);
    else if (op === "feather") co.featherMask(layer, { amount: args.amount });
    else if (op === "refine") co.refineMask(layer, { amount: args.amount });
    else throw new Error("Unknown mask operation '" + op + "'.");

    return {
      variant: describeVariant(v),
      layerIndex: args.ref.layerIndex,
      layerName: String(layer.name()),
      kind: String(layer.kind()),
      operation: op,
      amount: args.amount,
      accepted: true,
      verified: false,
      note:
        "Capture One exposes no way to read a mask, so this confirms only that the command " +
        "was accepted -- not that the mask changed as intended.",
    };
    `,
    { args: { ref, operation, amount }, timeoutMs: 120_000, mutating: true },
  );
}

export async function copyMask(from: LayerRef, to: LayerRef): Promise<unknown> {
  return runJxa(
    `
    const src = resolveLayer(args.from);
    const dst = resolveLayer(args.to);
    co.copyMask(src.layer, { toLayer: dst.layer });
    return {
      from: { variant: describeVariant(src.variant), layerIndex: args.from.layerIndex, name: String(src.layer.name()) },
      to: { variant: describeVariant(dst.variant), layerIndex: args.to.layerIndex, name: String(dst.layer.name()) },
      accepted: true,
      verified: false,
      note: "Mask contents are not readable, so the copy cannot be confirmed by read-back.",
    };
    `,
    { args: { from, to }, timeoutMs: 120_000, mutating: true },
  );
}

export async function setLumaRange(ref: LayerRef, fields: Record<string, number | boolean>): Promise<unknown> {
  return runJxa(
    `
    const picked = resolveLayer(args.ref);
    const v = picked.variant;
    const layers = picked.layers;
    const layer = picked.layer;
    const lr = layer.lumaRange();
    const applied = {};
    const keys = Object.keys(args.fields);
    for (let i = 0; i < keys.length; i++) {
      const jxaKey = args.map[keys[i]];
      const want = args.fields[keys[i]];
      let err = null;
      try { lr[jxaKey] = want; } catch (e) { err = String(e).replace(/^Error:\\s*/, ""); }
      let actual = null;
      let readOk = false;
      try { actual = lr[jxaKey](); readOk = true; } catch (e) { err = err || "read-back failed"; }
      if (readOk) {
        if (typeof actual === "number") actual = Math.round(actual * 1e6) / 1e6;
        if (typeof want === "boolean") actual = Boolean(actual);
      }
      const entry = { requested: want, actual: actual, matched: readOk && actual === want };
      if (err) entry.note = err;
      applied[keys[i]] = entry;
    }
    return { variant: describeVariant(v), layerIndex: args.ref.layerIndex, applied: applied };
    `,
    { args: { ref, fields, map: LUMA_RANGE_FIELDS }, timeoutMs: 60_000, mutating: true },
  );
}

export async function clearLumaRange(ref: LayerRef): Promise<unknown> {
  return runJxa(
    `
    const picked = resolveLayer(args.ref);
    const v = picked.variant;
    const layers = picked.layers;
    const layer = picked.layer;
    co.clearLumaRange(layer);
    const lr = layer.lumaRange();
    return {
      variant: describeVariant(v),
      layerIndex: args.ref.layerIndex,
      after: {
        rangeLow: lr.rangeLow(), rangeHigh: lr.rangeHigh(),
        falloffLow: lr.falloffLow(), falloffHigh: lr.falloffHigh(),
        invert: Boolean(lr.invert()), radius: lr.radius(), sensitivity: lr.sensitivity(),
      },
    };
    `,
    { args: { ref }, timeoutMs: 60_000, mutating: true },
  );
}

export async function applyStyleToLayer(ref: LayerRef, named: string): Promise<unknown> {
  return runJxa(
    `
    const picked = resolveLayer(args.ref);
    const v = picked.variant;
    const layers = picked.layers;
    const layer = picked.layer;
    co.applyStyle(layer, { named: args.named });
    return {
      variant: describeVariant(v),
      layerIndex: args.ref.layerIndex,
      style: args.named,
      accepted: true,
      note: "Styles are opaque -- the dictionary exposes names only, so the resulting adjustment " +
            "values are the only observable effect. Read them with co_list_layers.",
    };
    `,
    { args: { ref, named }, timeoutMs: 120_000, mutating: true },
  );
}

/** AI people masking. Verified by the layers it produces, which ARE readable. */
export async function createPeopleMask(
  target: Target,
  areas: string[] | null,
  separateLayers: boolean | null,
): Promise<unknown> {
  return runJxa(
    `
    const resolved = resolveTargets(args.target);
    const out = [];
    for (let t = 0; t < resolved.targets.length; t++) {
      const v = resolved.targets[t];
      const before = v.layers().length;
      const params = {};
      if (args.areas) params.areas = args.areas;
      if (args.separateLayers !== null) params.separateLayers = args.separateLayers;

      let error = null;
      try {
        if (Object.keys(params).length) co.createPeopleMask(v, params);
        else co.createPeopleMask(v);
      } catch (e) { error = String(e).replace(/^Error:\\s*/, ""); }

      const after = v.layers().map(function (l, i) {
        return { index: i, name: String(l.name()), kind: String(l.kind()), enabled: Boolean(l.enabled()) };
      });
      const info = describeVariant(v);
      info.layersBefore = before;
      info.layersAfter = after.length;
      info.createdLayers = after.slice(before).map(function (l) { return l.name + " (" + l.kind + ")"; });
      info.layers = after;
      if (error) info.error = error;
      info.requestedAreas = args.areas || ["body skin", "face skin"];
      // Capture One creates a layer per area it actually DETECTS, not per area
      // requested, so asking for three areas and getting two layers is a normal
      // partial detection rather than a failure. Say which is which.
      if (after.length === before) {
        info.note = error
          ? "No layers created: " + error
          : "No layers were created and Capture One reported no error.";
      } else if (args.separateLayers && info.createdLayers.length < info.requestedAreas.length) {
        info.note =
          "Partial detection: " + info.createdLayers.length + " layer(s) for " +
          info.requestedAreas.length + " requested area(s). Areas Capture One did not find in " +
          "this image produce no layer.";
      }
      out.push(info);
    }
    return { variants: out, notFound: resolved.notFound };
    `,
    { args: { target, areas, separateLayers }, timeoutMs: 300_000, mutating: true },
  );
}

export async function deleteLayer(ref: LayerRef): Promise<unknown> {
  return runJxa(
    `
    const picked = resolveLayer(args.ref);
    const v = picked.variant;
    const layers = picked.layers;
    const layer = picked.layer;
    if (String(layer.kind()) === "background") {
      throw new Error("The background layer cannot be deleted.");
    }
    const removedName = String(layer.name());
    const before = layers.length;
    co.delete(layer);
    const after = v.layers();
    return {
      variant: describeVariant(v),
      removed: { index: args.ref.layerIndex, name: removedName },
      layersBefore: before,
      layersAfter: after.length,
      verified: after.length === before - 1,
      layers: after.map(function (l, i) { return { index: i, name: String(l.name()), kind: String(l.kind()) }; }),
    };
    `,
    { args: { ref }, timeoutMs: 60_000, mutating: true },
  );
}
