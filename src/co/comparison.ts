import { getVariant } from "./variants.js";
import { ADJUSTMENT_PROPERTIES } from "./adjustment-properties.js";

type Snapshot = Record<string, unknown>;
export interface VariantComparisonInput {
  documentId: string;
  sourceVariantId: string;
  candidateVariantId: string;
}
export interface SettingChange { path: string; source: unknown; candidate: unknown }
export interface UnavailableSetting { path: string; sourceError: string; candidateError: string }

function record(value: unknown): Snapshot {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Snapshot : {};
}

/** Pure, conservative comparison of read snapshots, never a restorable edit backup. */
export function compareVariantSnapshots(source: Snapshot, candidate: Snapshot) {
  const sd = record(source.document), cd = record(candidate.document);
  if (!sd.id || !sd.name || sd.id !== cd.id || sd.name !== cd.name) {
    throw new Error("Cannot compare variants without matching document identity.");
  }
  const sourcePath = record(source.image).path, candidatePath = record(candidate.image).path;
  if (typeof sourcePath !== "string" || !sourcePath || sourcePath !== candidatePath) {
    throw new Error("Cannot compare variants: source image paths are unavailable or different (including RAW/JPEG pairs).");
  }
  if (!source.id || !candidate.id || source.id === candidate.id) {
    throw new Error("Provide two distinct variant ids for the original and candidate.");
  }
  const changes: SettingChange[] = [];
  const unavailable: UnavailableSetting[] = [];
  let comparedSettings = 0;
  function compare(path: string, a: unknown, b: unknown, ae?: unknown, be?: unknown) {
    if (ae || be || a === null || a === undefined || b === null || b === undefined) {
      unavailable.push({ path, sourceError: String(ae || (a == null ? "Value unavailable" : "")), candidateError: String(be || (b == null ? "Value unavailable" : "")) });
      return;
    }
    if (!Array.isArray(a) && !Array.isArray(b) && typeof a === "object" && typeof b === "object") {
      const ar = record(a), br = record(b);
      for (const key of new Set([...Object.keys(ar), ...Object.keys(br)])) compare(`${path}.${key}`, ar[key], br[key]);
      return;
    }
    comparedSettings++;
    if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ path, source: a, candidate: b });
  }
  function adjustments(path: string, a: Snapshot, b: Snapshot) {
    const av = record(a.adjustments), bv = record(b.adjustments);
    const ae = record(a.adjustmentReadErrors), be = record(b.adjustmentReadErrors);
    for (const prop of ADJUSTMENT_PROPERTIES) compare(`${path}.${prop.jxa}`, av[prop.jxa], bv[prop.jxa], ae[prop.jxa] || ae.adjustments, be[prop.jxa] || be.adjustments);
  }
  adjustments("adjustments", source, candidate);
  for (const key of ["crop", "lensCorrection", "flags", "metadata", "engine", "processingMode", "styles", "keywords"]) compare(key, source[key], candidate[key]);
  const addedLayers: unknown[] = [], removedLayers: unknown[] = [];
  if (Array.isArray(source.layers) && Array.isArray(candidate.layers)) {
    for (let i = 0; i < Math.max(source.layers.length, candidate.layers.length); i++) {
      if (i >= source.layers.length) { addedLayers.push(candidate.layers[i]); continue; }
      if (i >= candidate.layers.length) { removedLayers.push(source.layers[i]); continue; }
      const a = record(source.layers[i]), b = record(candidate.layers[i]);
      for (const key of ["name", "kind", "enabled", "opacity"]) compare(`layers[${i}].${key}`, a[key], b[key]);
      adjustments(`layers[${i}].adjustments`, a, b);
    }
  } else compare("layers", source.layers, candidate.layers);
  return {
    document: sd,
    source: { variantId: source.id, name: source.name, imagePath: sourcePath },
    candidate: { variantId: candidate.id, name: candidate.name, imagePath: candidatePath },
    changes, addedLayers, removedLayers, unavailable, comparedSettings,
    hasComparableDifferences: changes.length > 0 || addedLayers.length > 0 || removedLayers.length > 0,
    completeEditComparison: false,
    limitations: [
      "Masks, curves, layer luma ranges, color-editor structures, and other settings absent from getVariant cannot be compared. No differences does not establish identical edits or appearance.",
      "Layers have no stable scripting id and are paired by position. Added/removed entries reflect stack positions; reordered layers may appear as setting changes.",
      "Snapshots are sequential reads, not an atomic transaction. Avoid concurrent manual or automated edits while comparing.",
      "Keep the candidate by using its variant id; revert by using the source id. This tool does not copy, delete, select, or restore variants.",
    ],
  };
}

/** Reads both variants sequentially and checks snapshot identities even when document pinning is disabled. */
export async function compareVariants(input: VariantComparisonInput) {
  if (typeof input.documentId !== "string" || !input.documentId.trim()) throw new Error("Provide the document id recorded with the variant ids.");
  if (!input.sourceVariantId || !input.candidateVariantId || input.sourceVariantId === input.candidateVariantId) {
    throw new Error("Provide two distinct variant ids for the original and candidate.");
  }
  const source = await getVariant(input.sourceVariantId);
  if (record(source.document).id !== input.documentId) throw new Error("Source snapshot does not match the expected document identity.");
  const candidate = await getVariant(input.candidateVariantId);
  if (record(candidate.document).id !== input.documentId) throw new Error("Candidate snapshot does not match the expected document identity.");
  if (source.id !== input.sourceVariantId || candidate.id !== input.candidateVariantId) throw new Error("Variant identity changed while reading comparison snapshots.");
  return compareVariantSnapshots(source, candidate);
}
