import { runJxa } from "../jxa/bridge.js";

export async function listRecipes(): Promise<Record<string, unknown>[]> {
  return runJxa<Record<string, unknown>[]>(`
    const d = requireDoc();
    const rs = d.recipes();
    const current = d.currentRecipe();
    const currentName = current ? String(current.name()) : null;
    const out = [];
    for (let i = 0; i < rs.length; i++) {
      const r = rs[i];
      out.push({
        name: String(r.name()),
        enabled: Boolean(r.enabled()),
        outputFormat: String(r.outputFormat()),
        isCurrent: String(r.name()) === currentName,
      });
    }
    return out;
  `);
}

export async function getRecipe(name: string): Promise<Record<string, unknown>> {
  return runJxa<Record<string, unknown>>(
    `
    const d = requireDoc();
    const wanted = String(args.name).toLowerCase();
    const rs = d.recipes();
    let r = null;
    for (let i = 0; i < rs.length; i++) {
      if (String(rs[i].name()).toLowerCase() === wanted) { r = rs[i]; break; }
    }
    if (!r) throw new Error("No recipe named '" + args.name + "'");
    // Normalise undefined to null as well as catching. JSON.stringify DROPS an
    // undefined-valued key entirely, so a property that returns undefined rather
    // than throwing would make the field vanish from the result instead of
    // reading null -- weaker than the null-plus-reason contract elsewhere.
    function safe(fn) { try { const v = fn(); return v === undefined ? null : v; } catch (e) { return null; } }

    return {
      name: String(r.name()),
      enabled: Boolean(r.enabled()),
      format: {
        outputFormat: safe(function () { return String(r.outputFormat()); }),
        bits: safe(function () { return r.bits(); }),
        jpegQuality: safe(function () { return r.jpegQuality(); }),
        tiffCompression: safe(function () { return String(r.tiffCompression()); }),
        colorProfile: safe(function () { return String(r.colorProfile()); }),
        pixelsPerInch: safe(function () { return r.pixelsPerInch(); }),
      },
      scaling: {
        method: safe(function () { return String(r.scalingMethod()); }),
        unit: safe(function () { return String(r.scalingUnit()); }),
        primaryValue: safe(function () { return r.primaryScalingValue(); }),
        secondaryValue: safe(function () { return r.secondaryScalingValue(); }),
        upscale: safe(function () { return r.upscale(); }),
      },
      sharpening: {
        type: safe(function () { return String(r.sharpening()); }),
        amount: safe(function () { return r.sharpeningAmount(); }),
        radius: safe(function () { return r.sharpeningRadius(); }),
        threshold: safe(function () { return r.sharpeningThreshold(); }),
      },
      destination: {
        rootFolderType: safe(function () { return String(r.rootFolderType()); }),
        rootFolderLocation: safe(function () { return String(r.rootFolderLocation()); }),
        outputSubFolder: safe(function () { return String(r.outputSubFolder()); }),
        outputNameFormat: safe(function () { return String(r.outputNameFormat()); }),
        existingFiles: safe(function () { return String(r.existingFiles()); }),
      },
      metadata: {
        includeRatings: safe(function () { return r.includeRatings(); }),
        includeCopyright: safe(function () { return r.includeCopyright(); }),
        includeGPS: safe(function () { return r.includeGPS(); }),
        includeCameraMetadata: safe(function () { return r.includeCameraMetadata(); }),
        includeOtherMetadata: safe(function () { return r.includeOtherMetadata(); }),
        includeKeywords: safe(function () { return r.includeKeywords(); }),
      },
      crop: {
        ignoreCrop: safe(function () { return r.ignoreCrop(); }),
        exportCropMethod: safe(function () { return String(r.exportCropMethod()); }),
      },
      watermark: safe(function () { const w = r.watermark(); return w ? String(w.kind()) : null; }),
    };
    `,
    { args: { name } },
  );
}

/** Style and preset names. The dictionary exposes names only -- there is no
 *  scriptable way to read a style's contents. */
export async function listStyles(): Promise<string[]> {
  return runJxa<string[]>(`return co.availableStyles().map(String);`);
}

export async function listKeywords(limit: number): Promise<{ total: number; keywords: string[] }> {
  return runJxa<{ total: number; keywords: string[] }>(
    `
    const d = requireDoc();
    const ks = d.keywords();
    const names = [];
    for (let i = 0; i < ks.length && i < args.limit; i++) names.push(String(ks[i].name()));
    return { total: ks.length, keywords: names };
    `,
    { args: { limit }, timeoutMs: 60_000 },
  );
}
