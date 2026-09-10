#!/usr/bin/env node
/**
 * Snapshot / restore / diff harness for the standing test session.
 *
 * Phase 2 writes to real variant state, so nothing should be modified without a
 * recorded baseline. This deliberately talks to Capture One directly rather
 * than through the MCP server, so it still works when the server is in
 * read-only mode and cannot be broken by the code under test.
 *
 *   node scripts/testbed.mjs snapshot          record current state
 *   node scripts/testbed.mjs diff [file]       show what has changed since
 *   node scripts/testbed.mjs restore [file]    put everything back
 *
 * Hard-locked to ONE session path. Every client session and catalog on this
 * machine is off limits, so the guard refuses to run against anything else
 * rather than trusting the caller to have opened the right document.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runJxa } from "../dist/jxa/bridge.js";
import { ADJUSTMENT_PROPERTIES } from "../dist/co/adjustment-properties.js";
import { RECIPE_PROPERTIES } from "../dist/co/recipe-properties.js";

/** Every scalar adjustment property, so Phase 3 writes are restorable. */
const ADJ = ADJUSTMENT_PROPERTIES.map((p) => p.jxa);
/** Recipes are document-level config, not per-variant, so Phase 5 needs them
 *  snapshotted separately or a changed recipe would silently persist. */
const RECIPE = RECIPE_PROPERTIES.map((p) => p.jxa);

/**
 * The one document this harness is allowed to touch, as its document id (the
 * containing folder path). Supplied by the operator via CAPTURE_ONE_MCP_TESTBED_DOCUMENT,
 * never guessed and never defaulted: an unset value REFUSES rather than falling
 * back to whatever is frontmost. The point of this lock is that a write test can
 * never reach a client session or catalog, so it fails closed by construction.
 */
const ALLOWED_SESSION_ID = process.env["CAPTURE_ONE_MCP_TESTBED_DOCUMENT"]?.trim() ?? "";
const STATE_DIR = ".testbed";

/** Snapshotted fields. Anything Phase 2 can write must appear here, or a test
 *  could change something the restore step would silently leave changed. */
const TEXT_FIELDS = [
  "contentHeadline", "contentDescription", "contactCreator",
  "statusCopyrightNotice", "statusTitle", "statusInstructions",
  "statusRightsUsageTerms", "imageCity", "imageState", "imageCountry",
];

async function assertTestbed() {
  if (!ALLOWED_SESSION_ID) {
    console.error(
      `REFUSING TO RUN.\n` +
        `  CAPTURE_ONE_MCP_TESTBED_DOCUMENT is not set.\n` +
        `This harness writes to a real Capture One document, so it will not pick one on its own.\n` +
        `Point it at a DISPOSABLE session you are willing to have modified, e.g.\n` +
        `  export CAPTURE_ONE_MCP_TESTBED_DOCUMENT="/path/to/scratch session"\n` +
        `The value is the document id, which co_status reports (it is the containing folder path).`,
    );
    process.exit(2);
  }
  const doc = await runJxa(`
    const d = requireDoc();
    return { id: String(d.id()), name: String(d.name()), kind: String(d.kind()) };
  `);
  if (doc.id !== ALLOWED_SESSION_ID) {
    console.error(
      `REFUSING TO RUN.\n` +
        `  front document: ${doc.name}  (${doc.id})\n` +
        `  expected:       ${ALLOWED_SESSION_ID}\n` +
        `This harness only ever touches the document named by ` +
        `${"CAPTURE_ONE_MCP_TESTBED_DOCUMENT"}.`,
    );
    process.exit(2);
  }
  return doc;
}

async function snapshot() {
  return runJxa(
    `
    const d = requireDoc();
    const spec = d.variants;
    function all(chain, fb) {
      try {
        let n = spec;
        for (let i = 0; i < chain.length - 1; i++) n = n[chain[i]];
        const v = n[chain[chain.length - 1]]();
        if (Object.prototype.toString.call(v) === "[object Array]") return v;
      } catch (e) {}
      const list = spec();
      const out = [];
      for (let i = 0; i < list.length; i++) {
        try {
          let n = list[i];
          for (let k = 0; k < chain.length - 1; k++) n = n[chain[k]]();
          out.push(n[chain[chain.length - 1]]());
        } catch (e) { out.push(fb); }
      }
      return out;
    }

    const ids = all(["id"], "");
    const names = all(["name"], "");
    const exts = all(["parentImage", "extension"], "");
    const ratings = all(["rating"], 0);
    const tags = all(["colorTag"], 0);
    const picks = all(["pick"], false);

    const text = {};
    const fields = args.textFields;
    for (let f = 0; f < fields.length; f++) text[fields[f]] = all([fields[f]], "");

    // Adjustments live on a sub-object, reachable by the same chained bulk read.
    const adj = {};
    const adjProps = args.adjProps;
    for (let a = 0; a < adjProps.length; a++) adj[adjProps[a]] = all(["adjustments", adjProps[a]], null);

    const list = spec();
    const rows = [];
    for (let i = 0; i < ids.length; i++) {
      const row = {
        id: String(ids[i]), name: String(names[i]), extension: String(exts[i]),
        rating: Number(ratings[i]) || 0, colorTag: Number(tags[i]) || 0,
        pick: Boolean(picks[i]), text: {},
      };
      for (let f = 0; f < fields.length; f++) {
        const v = text[fields[f]][i];
        row.text[fields[f]] = v == null ? "" : String(v);
      }
      row.adj = {};
      for (let a = 0; a < adjProps.length; a++) {
        const av = adj[adjProps[a]][i];
        row.adj[adjProps[a]] = av === undefined ? null : av;
      }
      try { row.keywords = list[i].keywords().map(function (k) { return String(k.name()); }); }
      catch (e) { row.keywords = []; }
      // Layers have no id, so they are tracked positionally.
      try {
        row.layers = list[i].layers().map(function (l) {
          return { name: String(l.name()), kind: String(l.kind()), enabled: Boolean(l.enabled()), opacity: l.opacity() };
        });
      } catch (e) { row.layers = []; }
      rows.push(row);
    }

    const recipes = d.recipes().map(function (r) {
      const row = {};
      for (let q = 0; q < args.recipeProps.length; q++) {
        try { row[args.recipeProps[q]] = r[args.recipeProps[q]](); }
        catch (e) { row[args.recipeProps[q]] = null; }
      }
      return row;
    });

    return {
      documentId: String(d.id()),
      documentName: String(d.name()),
      currentRecipe: (function () { try { return String(d.currentRecipe().name()); } catch (e) { return null; } })(),
      documentOutput: (function () { try { return String(d.output()); } catch (e) { return null; } })(),
      outputSubPath: (function () { try { return String(d.outputSubPath()); } catch (e) { return null; } })(),
      recipes: recipes,
      selectedIds: co.selectedVariants().map(function (v) { return String(v.id()); }),
      variants: rows,
    };
    `,
    { args: { textFields: TEXT_FIELDS, adjProps: ADJ, recipeProps: RECIPE }, timeoutMs: 300_000 },
  );
}

function latestSnapshot() {
  const files = readdirSync(STATE_DIR).filter((f) => f.endsWith(".json")).sort();
  if (!files.length) throw new Error(`No snapshots in ${STATE_DIR}/`);
  return join(STATE_DIR, files[files.length - 1]);
}

function diffRecipes(base, now) {
  const changes = [];
  const b = base.recipes ?? [], n = now.recipes ?? [];
  if (b.length !== n.length) {
    changes.push({ id: "-", name: "recipes", field: "count", from: b.length, to: n.length });
  }
  for (let i = 0; i < Math.min(b.length, n.length); i++) {
    for (const k of RECIPE) {
      if (JSON.stringify(b[i][k] ?? null) !== JSON.stringify(n[i][k] ?? null)) {
        changes.push({ id: "-", name: `recipe[${i}] ${b[i].name}`, field: k, from: b[i][k], to: n[i][k] });
      }
    }
  }
  for (const k of ["currentRecipe", "documentOutput", "outputSubPath"]) {
    if ((base[k] ?? null) !== (now[k] ?? null)) {
      changes.push({ id: "-", name: "document", field: k, from: base[k], to: now[k] });
    }
  }
  return changes;
}

function diffRows(base, now) {
  const byId = new Map(now.variants.map((v) => [v.id, v]));
  const changes = [];
  for (const b of base.variants) {
    const n = byId.get(b.id);
    if (!n) { changes.push({ id: b.id, name: b.name, field: "*", from: "present", to: "MISSING" }); continue; }
    for (const k of ["rating", "colorTag", "pick"]) {
      if (b[k] !== n[k]) changes.push({ id: b.id, name: `${b.name}.${b.extension}`, field: k, from: b[k], to: n[k] });
    }
    for (const k of TEXT_FIELDS) {
      if ((b.text[k] ?? "") !== (n.text[k] ?? "")) {
        changes.push({ id: b.id, name: `${b.name}.${b.extension}`, field: k, from: b.text[k], to: n.text[k] });
      }
    }
    for (const k of ADJ) {
      const bv = b.adj?.[k], nv = n.adj?.[k];
      if (JSON.stringify(bv ?? null) !== JSON.stringify(nv ?? null)) {
        changes.push({ id: b.id, name: `${b.name}.${b.extension}`, field: `adj.${k}`, from: bv, to: nv });
      }
    }
    const bl = JSON.stringify(b.layers ?? []), nl = JSON.stringify(n.layers ?? []);
    if (bl !== nl) {
      changes.push({
        id: b.id, name: `${b.name}.${b.extension}`, field: "layers",
        from: `${(b.layers ?? []).length} [${(b.layers ?? []).map((l) => l.kind).join(",")}]`,
        to: `${(n.layers ?? []).length} [${(n.layers ?? []).map((l) => l.kind).join(",")}]`,
      });
    }
    const bk = (b.keywords ?? []).join("|"), nk = (n.keywords ?? []).join("|");
    if (bk !== nk) changes.push({ id: b.id, name: `${b.name}.${b.extension}`, field: "keywords", from: bk, to: nk });
  }
  return changes;
}

async function restore(base, changes) {
  const wanted = new Map();
  for (const c of changes) {
    if (c.field === "*") continue;
    if (!wanted.has(c.id)) wanted.set(c.id, base.variants.find((v) => v.id === c.id));
  }
  if (!wanted.size) return 0;
  const payload = [...wanted.values()];
  await runJxa(
    `
    const d = requireDoc();
    const list = d.variants();
    const byId = {};
    for (let i = 0; i < list.length; i++) byId[String(list[i].id())] = list[i];
    const fields = args.textFields;
    for (let r = 0; r < args.rows.length; r++) {
      const row = args.rows[r];
      const v = byId[row.id];
      if (!v) continue;
      v.rating = row.rating;
      v.colorTag = row.colorTag;
      v.pick = row.pick;
      for (let f = 0; f < fields.length; f++) v[fields[f]] = row.text[fields[f]];
      if (row.layers) {
        // Delete layers beyond the baseline count -- those were created by a
        // test. Deleting is destructive, so it is bounded to the surplus and
        // never touches a layer the baseline recorded.
        try {
          var cur = v.layers();
          for (var L = cur.length - 1; L >= row.layers.length; L--) co.delete(cur[L]);
          var after = v.layers();
          for (var L2 = 0; L2 < row.layers.length && L2 < after.length; L2++) {
            var want = row.layers[L2];
            if (String(after[L2].name()) !== want.name) after[L2].name = want.name;
            if (Boolean(after[L2].enabled()) !== want.enabled) after[L2].enabled = want.enabled;
            if (after[L2].opacity() !== want.opacity) after[L2].opacity = want.opacity;
          }
        } catch (e) { /* reported by the re-check diff */ }
      }
      if (row.adj) {
        const a = v.adjustments();
        const aps = args.adjProps;
        for (let q = 0; q < aps.length; q++) {
          const want = row.adj[aps[q]];
          if (want === null || want === undefined) continue;
          // Only write a property that is actually wrong. Writing a correct
          // value is not free: the colour-balance hue/saturation pairs cannot
          // absorb a write of 0 (hue comes back 360, saturation 3.3e-5), so an
          // unconditional restore dirtied variants it was meant to leave alone.
          try {
            var cur = a[aps[q]]();
            if (typeof cur === "number" && typeof want === "number") {
              if (Math.abs(cur - want) < 1e-9) continue;
            } else if (String(cur) === String(want)) continue;
          } catch (e) { /* unreadable -- fall through and attempt the write */ }
          try { a[aps[q]] = want; } catch (e) { /* reported by the re-check diff */ }
        }
      }
    }
    return args.rows.length;
    `,
    { args: { rows: payload, textFields: TEXT_FIELDS, adjProps: ADJ }, timeoutMs: 300_000 },
  );
  return payload.length;
}

/** Recipes are document config; restore them by name so a reordering cannot
 *  write one recipe's settings onto another. */
async function restoreRecipes(base) {
  await runJxa(
    `
    const d = requireDoc();
    const rs = d.recipes();
    for (let i = 0; i < rs.length && i < args.rows.length; i++) {
      const want = args.rows[i];
      for (let q = 0; q < args.props.length; q++) {
        const k = args.props[q];
        if (want[k] === null || want[k] === undefined) continue;
        try {
          const cur = rs[i][k]();
          if (typeof cur === "number" && typeof want[k] === "number") {
            if (Math.abs(cur - want[k]) < 1e-9) continue;
          } else if (String(cur) === String(want[k])) continue;
        } catch (e) {}
        try { rs[i][k] = want[k]; } catch (e) { /* reported by the re-check diff */ }
      }
    }
    if (args.currentRecipe) {
      for (let i = 0; i < rs.length; i++) {
        if (String(rs[i].name()) === args.currentRecipe) { d.currentRecipe = rs[i]; break; }
      }
    }
    return true;
    `,
    { args: { rows: base.recipes ?? [], props: RECIPE, currentRecipe: base.currentRecipe ?? null }, timeoutMs: 180_000 },
  );
}

/** Selection is view state, but a test still changes it, so put it back too. */
async function restoreSelection(base) {
  await runJxa(
    `
    const d = requireDoc();
    const current = co.selectedVariants();
    if (current.length) d.deselect({ variants: current });
    if (!args.ids.length) return 0;
    const spec = d.variants;
    const ids = spec.id();
    const index = {};
    for (let i = 0; i < ids.length; i++) index[String(ids[i])] = i;
    const targets = [];
    for (let w = 0; w < args.ids.length; w++) {
      const at = index[String(args.ids[w])];
      if (at !== undefined) targets.push(spec[at]);
    }
    if (targets.length) d.select({ variants: targets });
    return targets.length;
    `,
    { args: { ids: base.selectedIds || [] }, timeoutMs: 60_000 },
  );
}

const cmd = process.argv[2] ?? "snapshot";
const doc = await assertTestbed();

if (cmd === "snapshot") {
  mkdirSync(STATE_DIR, { recursive: true });
  const snap = await snapshot();
  const file = join(STATE_DIR, `baseline-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(snap, null, 2));
  const rated = snap.variants.filter((v) => v.rating > 0).length;
  const tagged = snap.variants.filter((v) => v.colorTag > 0).length;
  const picked = snap.variants.filter((v) => v.pick).length;
  const withText = snap.variants.filter((v) => Object.values(v.text).some((x) => x)).length;
  const withKw = snap.variants.filter((v) => v.keywords.length).length;
  console.log(`snapshot -> ${file}`);
  console.log(`  document: ${snap.documentName}`);
  console.log(`  variants: ${snap.variants.length}   selected: ${snap.selectedIds.length}`);
  console.log(`  rated: ${rated}   colorTagged: ${tagged}   picked: ${picked}   withMetadata: ${withText}   withKeywords: ${withKw}`);
} else if (cmd === "diff" || cmd === "restore") {
  const file = process.argv[3] ?? latestSnapshot();
  const base = JSON.parse(readFileSync(file, "utf8"));
  if (base.documentId !== doc.id) { console.error("Snapshot is for a different document."); process.exit(2); }
  const now = await snapshot();
  const selChanged = (base.selectedIds || []).join("|") !== (now.selectedIds || []).join("|");
  let changes = [...diffRows(base, now), ...diffRecipes(base, now)];
  console.log(`${changes.length} difference(s) vs ${file}${selChanged ? "  (+ selection differs)" : ""}`);
  for (const c of changes.slice(0, 40)) console.log(`  ${c.name}  ${c.field}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`);
  if (cmd === "restore" && (changes.length || selChanged)) {
    const n = await restore(base, changes.filter((c) => c.id !== "-"));
    if (changes.some((c) => c.id === "-")) { await restoreRecipes(base); console.log("restored recipe/document settings"); }
    if (selChanged) { await restoreSelection(base); console.log(`restored selection -> ${JSON.stringify(base.selectedIds)}`); }
    console.log(`restored ${n} variant(s); re-checking...`);
    const left = diffRows(base, await snapshot());
    console.log(left.length ? `STILL DIFFERENT: ${left.length}` : "clean -- session matches baseline");
    if (left.length) process.exit(1);
  }
} else {
  console.error("usage: testbed.mjs [snapshot|diff|restore] [file]");
  process.exit(1);
}
