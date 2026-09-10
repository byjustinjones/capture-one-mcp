import { constants } from "node:fs";
import { mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CaptureOneError, runJxa } from "../jxa/bridge.js";

export interface PreviewOptions { documentId: string; variantId: string; maxEdge?: number; waitSeconds?: number }
export interface PreviewResult {
  documentId: string; variantId: string; batchId: string; width: number; height: number;
  maxEdge: number; bytes: number; mimeType: "image/jpeg"; data: string;
  colorProfile: string; cleanupWarning?: string;
}
const MAX_BYTES = 8 * 1024 * 1024;

/** Reads the JPEG frame dimensions without decoding or trusting the extension. */
export function jpegDimensions(data: Buffer): { width: number; height: number } {
  if (data.length < 4 || data.readUInt16BE(0) !== 0xffd8 || data.readUInt16BE(data.length - 2) !== 0xffd9)
    throw new Error("Preview is not a complete JPEG.");
  let offset = 2;
  while (offset + 3 < data.length) {
    if (data[offset++] !== 0xff) throw new Error("Invalid JPEG marker.");
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > data.length) break;
    const size = data.readUInt16BE(offset);
    if (size < 2 || offset + size > data.length) break;
    if (marker !== undefined && [0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
      if (size < 8) break;
      const height = data.readUInt16BE(offset + 3), width = data.readUInt16BE(offset + 5);
      if (!width || !height) break;
      return { width, height };
    }
    offset += size;
  }
  throw new Error("Cannot read preview JPEG dimensions.");
}

/** Export one explicitly identified variant through a private recipe. Requires write access. */
export async function renderPreview(options: PreviewOptions): Promise<PreviewResult> {
  const { documentId, variantId, maxEdge = 1600, waitSeconds = 60 } = options;
  if (!documentId?.trim() || !variantId?.trim()) throw new Error("Explicit documentId and variantId are required.");
  if (!Number.isInteger(maxEdge) || maxEdge < 64 || maxEdge > 2560) throw new Error("maxEdge must be an integer from 64 to 2560.");
  if (!Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 120) throw new Error("waitSeconds must be an integer from 1 to 120.");
  const folder = await realpath(await mkdtemp(join(tmpdir(), "capture-one-mcp-preview-")));
  const recipeName = "MCP Preview " + randomUUID();
  const args = { documentId, variantId, maxEdge, folder, recipeName };
  let drained = false;
  let batchId = "";
  let result: PreviewResult | undefined;
  let failure: unknown;
  try {
    const started = await runJxa<{batchId: string}>(`
      const resolved = resolveTargets({variantIds: [args.variantId]});
      const d = resolved.doc;
      if (String(d.id()) !== args.documentId) throw new Error("Preview document does not match the front document.");
      if (resolved.targets.length !== 1 || resolved.notFound.length) throw new Error("Preview variant was not found.");
      const current = d.currentRecipe();
      const currentName = current ? String(current.name()) : null;
      const r = co.make({new: "recipe", at: d, withProperties: {name: args.recipeName, enabled: false}});
      // Everything up to co.process is provably PRE-submission: if it fails,
      // nothing was queued, so the private recipe must be removed here. Leaving
      // it to the caller's cleanup -- which only runs once the queue has drained
      // -- leaked one "MCP Preview <uuid>" recipe into the user's document on
      // every failed configuration, permanently.
      try {
        // Some versions select newly created recipes. Restore immediately, before processing.
        if (currentName && String(d.currentRecipe().name()) !== currentName) d.currentRecipe = current;
        const settings = {enabled:false, outputFormat:"JPEG", jpegQuality:85,
          colorProfile:"sRGB Color Space Profile", scalingMethod:"Long_Edge", scalingUnit:"pixels",
          primaryScalingValue:args.maxEdge, upscale:false, rootFolderType:"custom location",
          outputSubFolder:"", outputNameFormat:"preview", existingFiles:"skip",
          exportCropMethod:"respect", sharpening:"no output sharpening"};
        Object.keys(settings).forEach(function(key) { if (key !== "rootFolderType") r[key] = settings[key]; });
        r.rootFolderLocation = Path(args.folder);
        r.rootFolderType = settings.rootFolderType;
        Object.keys(settings).forEach(function(key) {
          if (r[key]() !== settings[key]) throw new Error("Preview recipe read-back failed for " + key + "; no processing submitted.");
        });
        let destination = String(r.rootFolderLocation());
        if (destination.slice(-1) === "/") destination = destination.slice(0, -1);
        if (destination !== args.folder) throw new Error("Preview destination read-back mismatch; no processing submitted.");
      } catch (e) {
        try { co.delete(r); } catch (e2) {}
        throw e;
      }
      // From here submission is uncertain, so the recipe is never removed on a
      // failure path -- deleting a recipe with work possibly queued against it
      // is the worse mistake.
      const batch = co.process(resolved.targets, {recipe: args.recipeName});
      if (typeof batch !== "string" || !batch.trim() || /^ERROR/i.test(batch.trim()))
        throw new Error("Preview processing not confirmed: " + String(batch) + ". Inspect queue before retrying.");
      return {batchId: batch.trim()};
    `, {args, mutating: true, timeoutMs: 60_000});
    batchId = started.batchId;
    const deadline = Date.now() + waitSeconds * 1000;
    do {
      const pending = await runJxa<number>(`
        const d = requireDoc();
        if (String(d.id()) !== args.documentId) throw new Error("Preview document changed while waiting.");
        return d.jobs().length;
      // Floor the Apple Event budget. Deriving it from the REMAINING wait meant
      // the final poll often started with tens of milliseconds left, so osascript
      // was killed and the call reported "did not respond within 0s" instead of
      // the honest "queue did not drain before the deadline" below. The loop
      // condition, not this timeout, is what bounds the total wait.
      `, {args, timeoutMs: Math.min(10_000, Math.max(5_000, deadline - Date.now()))});
      if (pending === 0) { drained = true; break; }
      if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, Math.min(500, deadline - Date.now())));
    } while (Date.now() < deadline);
    if (!drained) throw new Error("Preview queue did not drain before the deadline; do not retry blindly.");
    const file = await open(join(folder, "preview.jpg"), constants.O_RDONLY | constants.O_NOFOLLOW);
    let data: Buffer;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 4 || stat.size > MAX_BYTES) throw new Error("Preview file is missing, invalid, or exceeds 8 MiB.");
      // Bounded read even if another process changes the size after stat.
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!chunk.bytesRead) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead > MAX_BYTES) throw new Error("Preview exceeds 8 MiB.");
      data = buffer.subarray(0, bytesRead);
    } finally { await file.close(); }
    const dimensions = jpegDimensions(data);
    if (Math.max(dimensions.width, dimensions.height) > maxEdge) throw new Error("Preview exceeds the requested pixel bound.");
    result = {documentId, variantId, batchId, ...dimensions, maxEdge, bytes:data.length,
      mimeType:"image/jpeg", data:data.toString("base64"), colorProfile:"sRGB Color Space Profile"};
  } catch (error) { failure = error; }
  // Never delete a recipe/folder after uncertain submission or while jobs may remain.
  let cleanupWarning: string | undefined;
  if (drained) {
    try {
      await runJxa(`
        const d = requireDoc();
        if (String(d.id()) !== args.documentId) throw new Error("Preview document changed before cleanup.");
        if (d.jobs().length) throw new Error("Queue became active; retaining preview recipe.");
        const rs = d.recipes();
        for (let i=0; i<rs.length; i++) if (String(rs[i].name()) === args.recipeName) co.delete(rs[i]);
        return true;
      `, {args, mutating:true, timeoutMs:10_000});
      await rm(folder, {recursive:true, force:true});
    } catch (error) { cleanupWarning = `Retained recipe '${recipeName}' and folder '${folder}': ${String(error)}`; }
  } else {
    cleanupWarning =
      `Temp folder '${folder}' retained. If processing was submitted, recipe '${recipeName}' is ` +
      "also retained deliberately — inspect the processing queue before removing either or retrying. " +
      "(A failure during recipe setup removes the recipe itself, since nothing was submitted.)";
  }
  if (failure) {
    // Preserve the bridge's error code. Rewrapping in a plain Error made every
    // preview failure surface as UNEXPECTED, so a client lost the one code it
    // would branch on -- WRONG_DOCUMENT -- to stop and re-bind.
    const detail = `${cleanupWarning ?? "Preview resources cleaned up."}`;
    if (failure instanceof CaptureOneError) {
      throw new CaptureOneError(`${failure.message} ${detail}`, failure.code, failure.detail ?? detail);
    }
    throw new Error(`${String(failure)} ${detail}`);
  }
  if (!result) throw new Error("No preview result.");
  return {...result, ...(cleanupWarning ? {cleanupWarning} : {})};
}
