import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// Run the actual TypeScript tool bodies against in-memory JXA objects. Never
// import the real bridge or start osascript/Capture One.
const registrySource = await readFile(new URL("../src/co/adjustment-properties.ts", import.meta.url), "utf8");
const registryJs = ts.transpileModule(registrySource, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const registryUrl = `data:text/javascript;base64,${Buffer.from(registryJs).toString("base64")}`;
const { ADJUSTMENT_PROPERTIES } = await import(registryUrl);
let currentVariant;
let seenArgs;
globalThis.__adjustmentReadersMock = async (body, options) => {
  seenArgs = options.args;
  return new Function("args", "resolveTargets", "describeVariant", body)(
    options.args,
    () => ({ targets: [currentVariant], notFound: [], doc: { id: () => "doc", name: () => "Test" } }),
    v => ({ id: v.id(), name: v.name() }),
  );
};
async function loadTool(name) {
  let source = await readFile(new URL(`../src/co/${name}.ts`, import.meta.url), "utf8");
  source = source.replace('import { runJxa } from "../jxa/bridge.js";', 'const runJxa = globalThis.__adjustmentReadersMock;');
  source = source.replace('"./adjustment-properties.js"', JSON.stringify(registryUrl));
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}
const { getVariant } = await loadTool("variants");
const { listLayers } = await loadTool("layers");
function values(seed) {
  return Object.fromEntries(ADJUSTMENT_PROPERTIES.map((p, i) => [p.jxa,
    p.kind === "boolean" ? false : p.kind === "enum" ? p.values[0] : p.kind === "text" ? `${p.jxa}-${seed}` : seed + i / 100,
  ]));
}
function adjustments(expected) {
  return Object.fromEntries(Object.entries(expected).map(([k, value]) => [k, () => value]));
}
function fixture() {
  const base = values(0);
  const local = values(5);
  const baseAccessors = adjustments(base);
  const layerAccessors = adjustments(local);
  const layer = { name: () => "Local contrast", kind: () => "adjustment", enabled: () => true, opacity: () => 75, adjustments: () => layerAccessors };
  currentVariant = { id: () => "123", name: () => "test", adjustments: () => baseAccessors, layers: () => [layer] };
  return { base, local, baseAccessors, layerAccessors, layer };
}

test("variant and layer snapshots cover every writable scalar with compatible keys", async () => {
  const { base, local } = fixture();
  const result = await getVariant("123");
  assert.deepEqual(seenArgs.adjustmentProperties, ADJUSTMENT_PROPERTIES);
  assert.deepEqual(result.adjustments, base);
  assert.deepEqual(result.adjustmentReadErrors, {});
  assert.deepEqual(result.layers[0].adjustments, local);
  assert.deepEqual(result.layers[0].adjustmentReadErrors, {});
  assert.equal(result.layers[0].index, 0);
  // Formerly omitted controls, existing camelCase names, false and numeric zero.
  assert.equal(result.adjustments.levelMidtoneRgb, base.levelMidtoneRgb);
  assert.equal(result.adjustments.colorBalanceHighlightHue, base.colorBalanceHighlightHue);
  assert.equal(result.adjustments.blackAndWhite, false);
  assert.equal(result.adjustments.orientation, 0);
  assert.equal(result.adjustments.whiteBalancePreset, base.whiteBalancePreset);
});

test("listLayers exposes each layer's adjustments rather than variant adjustments", async () => {
  const { local } = fixture();
  const result = await listLayers({ variantIds: ["123"] });
  assert.deepEqual(seenArgs.adjustmentProperties, ADJUSTMENT_PROPERTIES);
  assert.deepEqual(result.variants[0].layers[0].adjustments, local);
  assert.deepEqual(result.variants[0].layers[0].adjustmentReadErrors, {});
});

test("failed and unavailable properties remain explicit nulls without dropping other values", async () => {
  const { base, local, baseAccessors, layerAccessors } = fixture();
  baseAccessors.levelMidtoneRgb = () => { throw new Error("Unsupported"); };
  layerAccessors.colorBalanceMasterHue = () => undefined;
  layerAccessors.levelHighlightRgb = () => null;
  const result = await getVariant("123");
  assert.deepEqual(result.adjustments, { ...base, levelMidtoneRgb: null });
  assert.match(result.adjustmentReadErrors.levelMidtoneRgb, /Unsupported/);
  for (const row of [result.layers[0], (await listLayers({ variantIds: ["123"] })).variants[0].layers[0]]) {
    assert.deepEqual(row.adjustments, { ...local, colorBalanceMasterHue: null, levelHighlightRgb: null });
    assert.match(row.adjustmentReadErrors.colorBalanceMasterHue, /unavailable/);
    assert.match(row.adjustmentReadErrors.levelHighlightRgb, /unavailable/);
  }
});

test("unreadable adjustment object reports incompleteness and preserves layer metadata", async () => {
  const { layer } = fixture();
  currentVariant.adjustments = () => { throw new Error("Offline"); };
  layer.adjustments = () => { throw new Error("No local adjustments"); };
  const result = await getVariant("123");
  assert.equal(result.adjustments, null);
  assert.match(result.adjustmentReadErrors.adjustments, /Offline/);
  for (const row of [result.layers[0], (await listLayers({ variantIds: ["123"] })).variants[0].layers[0]]) {
    assert.equal(row.adjustments, null);
    assert.match(row.adjustmentReadErrors.adjustments, /No local adjustments/);
    assert.equal(row.name, "Local contrast");
  }
});
