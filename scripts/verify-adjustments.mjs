#!/usr/bin/env node
/**
 * Per-property round-trip verification for the adjustment surface.
 *
 * A write returning without error proves nothing -- Capture One silently
 * ignores some properties, clamps others, and rounds a few. So each property is
 * probed in three phases against a live variant:
 *
 *   identity  write the value it already has         -> catches write-only/ignored
 *   delta     write a small change                   -> catches silent no-ops
 *   extreme   write +/-99999                         -> discovers clamp bounds
 *
 * The original value is restored afterwards and re-read to confirm.
 *
 *   node scripts/verify-adjustments.mjs [variantId]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { runJxa } from "../dist/jxa/bridge.js";
import { ADJUSTMENT_PROPERTIES } from "../dist/co/adjustment-properties.js";

/** The one document this probe may write to. Operator-supplied and never
 *  defaulted -- see scripts/testbed.mjs for why this fails closed. */
const ALLOWED_SESSION_ID = process.env["CAPTURE_ONE_MCP_TESTBED_DOCUMENT"]?.trim() ?? "";
if (!ALLOWED_SESSION_ID) {
  console.error(
    `REFUSING: CAPTURE_ONE_MCP_TESTBED_DOCUMENT is not set. This probe writes real adjustment\n` +
      `values to a real variant, so it will not choose a document on its own. Point it at a\n` +
      `disposable session: export CAPTURE_ONE_MCP_TESTBED_DOCUMENT="/path/to/scratch session"`,
  );
  process.exit(2);
}
const VARIANT_ID = process.argv[2] ?? "641";

const doc = await runJxa(`
  const d = requireDoc();
  return { id: String(d.id()), name: String(d.name()) };
`);
if (doc.id !== ALLOWED_SESSION_ID) {
  console.error(`REFUSING: front document is ${doc.name} (${doc.id}), not the test session.`);
  process.exit(2);
}

console.log(`Probing ${ADJUSTMENT_PROPERTIES.length} adjustment properties on variant ${VARIANT_ID}\n`);

const results = await runJxa(
  `
  const d = requireDoc();
  const spec = d.variants;
  const ids = spec.id();
  let v = null;
  for (let i = 0; i < ids.length; i++) if (String(ids[i]) === String(args.variantId)) { v = spec[i]; break; }
  if (!v) throw new Error("Variant " + args.variantId + " not found");
  const a = v.adjustments();

  function get(p) { try { return { ok: true, value: a[p]() }; } catch (e) { return { ok: false, error: String(e) }; } }
  function set(p, val) { try { a[p] = val; return { ok: true }; } catch (e) { return { ok: false, error: String(e) }; } }

  function norm(x) {
    if (x === null || x === undefined) return null;
    if (typeof x === "number") return Math.round(x * 1e6) / 1e6;
    if (typeof x === "boolean") return x;
    return String(x);
  }
  function same(x, y) { return JSON.stringify(norm(x)) === JSON.stringify(norm(y)); }

  const out = [];

  for (let i = 0; i < args.props.length; i++) {
    const p = args.props[i];
    const rec = { param: p.param, jxa: p.jxa, kind: p.kind };

    const orig = get(p.jxa);
    if (!orig.ok) { rec.status = "read-failed"; rec.error = orig.error; out.push(rec); continue; }
    rec.original = norm(orig.value);

    // -- identity: write back what is already there ------------------------
    const wi = set(p.jxa, orig.value);
    const ri = get(p.jxa);
    rec.identity = wi.ok && ri.ok && same(ri.value, orig.value) ? "ok"
                 : !wi.ok ? "write-error" : "changed";
    if (!wi.ok) rec.identityError = wi.error;

    // -- delta: a small, type-appropriate change ---------------------------
    let target = null;
    if (p.kind === "boolean") target = !orig.value;
    else if (p.kind === "real" || p.kind === "integer") target = Number(orig.value) + 1;
    else if (p.kind === "enum") {
      for (let k = 0; k < p.values.length; k++) {
        if (String(p.values[k]) !== String(orig.value)) { target = p.values[k]; break; }
      }
    }

    if (target !== null) {
      const wd = set(p.jxa, target);
      const rd = get(p.jxa);
      rec.wrote = norm(target);
      rec.readBack = rd.ok ? norm(rd.value) : null;
      if (!wd.ok) { rec.status = "write-error"; rec.error = wd.error; }
      else if (!rd.ok) { rec.status = "read-failed"; rec.error = rd.error; }
      else if (same(rd.value, target)) rec.status = "round-trips";
      else if (same(rd.value, orig.value)) rec.status = "SILENT-NOOP";
      else rec.status = "COERCED";
    } else {
      rec.status = "skipped-no-delta";   // text: no safe invented value
    }

    // -- bounds: bisect for the values the app actually accepts -----------
    // Capture One's rejection messages cannot be trusted: level_highlight_rgb
    // accepts 0..255 but reports "Cannot set this value above 1." So the real
    // limits are found empirically -- a bound is accepted only if the write
    // succeeds AND the value reads back as what was written (a clamp shows up
    // as a successful write with a different read-back).
    if (p.kind === "real" || p.kind === "integer") {
      const isInt = p.kind === "integer";
      const round = function (x) { return isInt ? Math.round(x) : x; };

      const accepts = function (val) {
        const w = set(p.jxa, val);
        if (!w.ok) return false;
        const r = get(p.jxa);
        if (!r.ok || typeof r.value !== "number") return false;
        const tol = Math.max(1e-3, Math.abs(val) * 1e-5);
        return Math.abs(r.value - val) <= tol;
      };

      const bisect = function (good, bad) {
        for (let n = 0; n < 40; n++) {
          const mid = round((good + bad) / 2);
          if (mid === good || mid === bad) break;
          if (Math.abs(bad - good) <= (isInt ? 1 : Math.max(1e-4, Math.abs(good) * 1e-6))) break;
          if (accepts(mid)) good = mid; else bad = mid;
        }
        return good;
      };

      const base = Number(orig.value);
      const LIMIT = 1e6;

      // Keep the app's rejection text too: it is unreliable as a range (see
      // level_highlight_rgb) but it is the only source for properties that
      // accept a discrete set, e.g. "other than 0, 90, 180, or 270".
      const wHi = set(p.jxa, LIMIT);
      if (!wHi.ok) rec.rejectionMessage = wHi.error.replace(/^Error:\s*/, "").slice(0, 140);

      rec.maxAccepted = accepts(LIMIT) ? null : bisect(base, LIMIT);   // null = unbounded
      rec.minAccepted = accepts(-LIMIT) ? null : bisect(base, -LIMIT);
      // A span that collapses to a point means the property could not move from
      // where it was (the colour-balance hues wrap), so the bounds mean nothing.
      const span = Math.abs((rec.maxAccepted ?? LIMIT) - (rec.minAccepted ?? -LIMIT));
      rec.boundsUnreliable = span < Math.max(1e-6, Math.abs(base) * 0.01);
    }

    // -- restore -----------------------------------------------------------
    set(p.jxa, orig.value);
    const back = get(p.jxa);
    rec.restored = back.ok && same(back.value, orig.value);
    if (!rec.restored) rec.restoredTo = back.ok ? norm(back.value) : null;

    out.push(rec);
  }

  return out;
  `,
  {
    args: {
      variantId: VARIANT_ID,
      props: ADJUSTMENT_PROPERTIES.map((p) => ({
        param: p.param, jxa: p.jxa, kind: p.kind, values: p.values ?? null,
      })),
    },
    timeoutMs: 600_000,
  },
);

const by = (s) => results.filter((r) => r.status === s);
console.log(`round-trips cleanly : ${by("round-trips").length}`);
console.log(`SILENT NO-OP        : ${by("SILENT-NOOP").length}`);
console.log(`coerced/clamped     : ${by("COERCED").length}`);
console.log(`write error         : ${by("write-error").length}`);
console.log(`read failed         : ${by("read-failed").length}`);
console.log(`skipped (text)      : ${by("skipped-no-delta").length}`);

const notRestored = results.filter((r) => r.restored === false);
console.log(`\nNOT RESTORED        : ${notRestored.length}`);
for (const r of notRestored) console.log(`   ${r.param}: wanted ${JSON.stringify(r.original)} got ${JSON.stringify(r.restoredTo)}`);

for (const s of ["SILENT-NOOP", "COERCED", "write-error", "read-failed"]) {
  const rows = by(s);
  if (!rows.length) continue;
  console.log(`\n--- ${s} ---`);
  for (const r of rows) {
    console.log(`  ${r.param.padEnd(38)} orig=${JSON.stringify(r.original)} wrote=${JSON.stringify(r.wrote)} read=${JSON.stringify(r.readBack)}${r.error ? "  " + r.error.slice(0, 60) : ""}`);
  }
}

const idFail = results.filter((r) => r.identity && r.identity !== "ok");
console.log(`\n--- identity write-back FAILED (${idFail.length}) ---`);
for (const r of idFail) {
  console.log(`  ${r.param.padEnd(38)} read ${JSON.stringify(r.original)} but writing it back: ${r.identity}${r.identityError ? " -- " + r.identityError.replace(/^Error:\s*/, "").slice(0, 80) : ""}`);
}

const bounded = results.filter((r) => r.maxAccepted !== undefined);
console.log(`\n--- empirical accepted ranges (${bounded.length}) ---`);
for (const r of bounded) {
  const lo = r.minAccepted === null ? "unbounded" : r.minAccepted;
  const hi = r.maxAccepted === null ? "unbounded" : r.maxAccepted;
  console.log(`  ${r.param.padEnd(38)} [${lo}, ${hi}]`);
}

mkdirSync("docs", { recursive: true });
writeFileSync("docs/adjustment-round-trip.json", JSON.stringify(results, null, 2));
console.log(`\nfull report -> docs/adjustment-round-trip.json`);
