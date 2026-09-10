#!/usr/bin/env node
/**
 * Resolve every generated property name against the live app.
 *
 * A wrong JXA name fails as "Can't convert types.", which the defensive
 * try/catch wrappers this codebase uses turn into a silent null -- exactly how
 * `JPEGQuality` (correct name: `jpegQuality`) survived undetected in
 * co_get_recipe. Generated names must therefore be checked against a real
 * object, not just typechecked.
 *
 *   node scripts/verify-property-names.mjs
 */
import { runJxa } from "../dist/jxa/bridge.js";
import { ADJUSTMENT_PROPERTIES } from "../dist/co/adjustment-properties.js";
import { RECIPE_PROPERTIES } from "../dist/co/recipe-properties.js";

const results = await runJxa(
  `
  const d = requireDoc();
  const v = d.variants()[0];
  if (!v) throw new Error("Document has no variants to probe against.");
  const a = v.adjustments();
  const r = d.recipes()[0];
  if (!r) throw new Error("Document has no recipes to probe against.");

  function check(obj, names) {
    const bad = [];
    for (let i = 0; i < names.length; i++) {
      try { obj[names[i]](); } catch (e) { bad.push({ name: names[i], error: String(e).replace(/^Error:\\s*/, "").slice(0, 60) }); }
    }
    return bad;
  }

  return {
    adjustments: check(a, args.adj),
    recipes: check(r, args.recipe),
    adjCount: args.adj.length,
    recipeCount: args.recipe.length,
  };
  `,
  {
    args: {
      adj: ADJUSTMENT_PROPERTIES.map((p) => p.jxa),
      recipe: RECIPE_PROPERTIES.map((p) => p.jxa),
    },
    timeoutMs: 180_000,
  },
);

let failed = 0;
for (const [group, bad, total] of [
  ["adjustment", results.adjustments, results.adjCount],
  ["recipe", results.recipes, results.recipeCount],
]) {
  console.log(`${group}: ${total - bad.length}/${total} names resolve`);
  for (const b of bad) {
    console.error(`  FAIL ${b.name} -- ${b.error}`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
