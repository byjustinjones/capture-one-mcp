import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { ADJUSTMENT_PROPERTIES } from "../dist/co/adjustment-properties.js";
import { compareVariantSnapshots } from "../dist/co/comparison.js";

function fixture(id = "1") {
  const adjustments = Object.fromEntries(ADJUSTMENT_PROPERTIES.map(p => [p.jxa, p.kind === "boolean" ? false : p.kind === "text" || p.kind === "enum" ? "value" : 0]));
  return { id, name: "photo", document: { id: "/photos", name: "test.cosessiondb" }, image: { path: "/photos/photo.RAF" }, adjustments, adjustmentReadErrors: {}, layers: [{ index: 0, name: "Background", kind: "background", enabled: true, opacity: 100, adjustments: { ...adjustments }, adjustmentReadErrors: {} }], crop: { width: 100, height: 100 }, lensCorrection: { distortion: 0 }, flags: { rating: 0 }, metadata: { title: "" }, engine: 1, processingMode: "normal", styles: [], keywords: [] };
}
test("identical readable settings are explicitly not proof of identical edits", () => {
  const result = compareVariantSnapshots(fixture(), fixture("2"));
  assert.equal(result.hasComparableDifferences, false);
  assert.equal(result.completeEditComparison, false);
  assert.deepEqual(result.unavailable, []);
  assert.ok(result.comparedSettings >= ADJUSTMENT_PROPERTIES.length * 2);
  assert.match(result.limitations.join(" "), /Masks, curves/);
});
test("diff includes formerly omitted scalar settings, layer settings and metadata without mutation", () => {
  const source = fixture(), candidate = fixture("2");
  candidate.adjustments.levelMidtoneRgb = 0.2;
  candidate.layers[0].adjustments.colorBalanceMasterHue = 90;
  candidate.layers[0].enabled = false;
  candidate.metadata.title = "Candidate";
  const before = structuredClone([source, candidate]);
  const result = compareVariantSnapshots(source, candidate);
  assert.deepEqual(result.changes.map(c => c.path).sort(), ["adjustments.levelMidtoneRgb", "layers[0].adjustments.colorBalanceMasterHue", "layers[0].enabled", "metadata.title"].sort());
  assert.equal(result.hasComparableDifferences, true);
  assert.deepEqual([source, candidate], before);
});
test("unreadable values cannot be mistaken for equality or changes", () => {
  const source = fixture(), candidate = fixture("2");
  source.adjustments.exposure = null;
  candidate.adjustments.exposure = null;
  candidate.adjustments.contrast = 10;
  source.adjustmentReadErrors.contrast = "Unsupported";
  candidate.layers[0].adjustments = null;
  candidate.layers[0].adjustmentReadErrors = { adjustments: "No local settings" };
  const result = compareVariantSnapshots(source, candidate);
  assert.equal(result.changes.length, 0);
  assert.equal(result.unavailable.length, 2 + ADJUSTMENT_PROPERTIES.length);
  assert.ok(result.unavailable.some(v => v.sourceError === "Unsupported"));
});
test("different documents, sibling documents in one folder, images and RAW/JPEG pairs fail closed", () => {
  for (const change of [v => { v.document.id = "/other"; }, v => { v.document.name = "other.cosessiondb"; }, v => { delete v.document; }, v => { v.image.path = "/photos/photo.JPG"; }, v => { v.image.path = null; }]) {
    const candidate = fixture("2"); change(candidate);
    assert.throws(() => compareVariantSnapshots(fixture(), candidate), /Cannot compare/);
  }
  assert.throws(() => compareVariantSnapshots(fixture(), fixture()), /distinct/);
});
test("added and removed layers are reported separately with positional limitations", () => {
  const source = fixture(), candidate = fixture("2");
  candidate.layers.push({ ...structuredClone(candidate.layers[0]), index: 1, name: "Local" });
  assert.equal(compareVariantSnapshots(source, candidate).addedLayers.length, 1);
  assert.equal(compareVariantSnapshots(candidate, source).removedLayers.length, 1);
});
test("tool reads supplied ids sequentially and catches a document switch without pinning", async () => {
  const reads = [];
  globalThis.__comparisonReader = async id => {
    reads.push(id);
    const value = fixture(id);
    if (id === "2") value.document.name = "switched.cosessiondb";
    return value;
  };
  let source = await readFile(new URL("../src/co/comparison.ts", import.meta.url), "utf8");
  source = source.replace('import { getVariant } from "./variants.js";', 'const getVariant = globalThis.__comparisonReader;').replace('"./adjustment-properties.js"', JSON.stringify(new URL("../dist/co/adjustment-properties.js", import.meta.url).href));
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { compareVariants } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
  await assert.rejects(compareVariants({ documentId: "/photos", sourceVariantId: "1", candidateVariantId: "2" }), /document identity/);
  assert.deepEqual(reads, ["1", "2"]);
  await assert.rejects(compareVariants({ documentId: "/photos", sourceVariantId: "1", candidateVariantId: "1" }), /distinct/);
  assert.deepEqual(reads, ["1", "2"]);
  await assert.rejects(compareVariants({ documentId: "/original-document", sourceVariantId: "1", candidateVariantId: "2" }), /expected document identity/);
  assert.deepEqual(reads, ["1", "2", "1"]);
  await assert.rejects(compareVariants({ sourceVariantId: "1", candidateVariantId: "2" }), /document id/);
  assert.deepEqual(reads, ["1", "2", "1"]);
});
