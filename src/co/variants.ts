import { runJxa } from "../jxa/bridge.js";
import { ADJUSTMENT_PROPERTIES } from "./adjustment-properties.js";

export type VariantScope = "collection" | "document" | "selection";
export type FieldGroup = "exif" | "adjustments" | "crop" | "metadata";

export interface VariantFilter {
  minRating?: number;
  maxRating?: number;
  colorTags?: number[];
  pick?: boolean;
  nameContains?: string;
  extensions?: string[];
}

export interface ListVariantsInput {
  scope: VariantScope;
  collection?: string;
  filter?: VariantFilter;
  fields?: FieldGroup[];
  limit: number;
  offset: number;
}

export interface VariantSummary {
  id: string;
  name: string;
  rating: number;
  colorTag: number;
  extension: string;
  pick: boolean;
  selected: boolean;
  [extra: string]: unknown;
}

export interface ListVariantsResult {
  scopeDescription: string;
  totalInScope: number;
  matched: number;
  returned: number;
  offset: number;
  truncated: boolean;
  variants: VariantSummary[];
}

/**
 * Resolves the variant list for a scope, filters it, and hydrates the page.
 *
 * Performance, measured against a 138-variant session:
 *
 *  - Reading a property across a whole element specifier is ONE Apple Event:
 *    `collection.variants.rating()` -> number[]. ~24ms for 138 variants.
 *  - Cocoa scripting also chains through relationships in a single event:
 *    `collection.variants.parentImage.extension()` -> string[]. Also ~24ms.
 *    The naive two-step (fetch images, then map) costs 2313ms for the same
 *    data -- roughly 100x worse.
 *  - Per-variant hydration costs ~215ms EACH, so a page of 20 with EXIF takes
 *    over four seconds.
 *
 * So everything is read via bulk/chained specifiers where the source allows it.
 * `scope: "selection"` returns a plain array rather than a specifier, and very
 * large scopes make whole-collection reads wasteful, so both fall back to
 * per-item reads over the page only.
 */
const BULK_HYDRATE_MAX = 2000;

export async function listVariants(input: ListVariantsInput): Promise<ListVariantsResult> {
  return runJxa<ListVariantsResult>(
    `
    const doc = requireDoc();
    let source, scopeDescription, isSpec;

    if (args.scope === "selection") {
      source = co.selectedVariants();   // plain array -- no bulk reads possible
      isSpec = false;
      scopeDescription = "current selection";
    } else if (args.scope === "document") {
      source = doc.variants;
      isSpec = true;
      scopeDescription = "document " + doc.name();
    } else {
      let col = null;
      if (args.collection) {
        const wanted = String(args.collection).toLowerCase();
        const all = doc.collections();
        for (let i = 0; i < all.length; i++) {
          if (String(all[i].name()).toLowerCase() === wanted || String(all[i].id()) === args.collection) {
            col = all[i];
            break;
          }
        }
        if (!col) throw new Error("No collection named or with id '" + args.collection + "'");
      } else {
        col = doc.currentCollection();
        if (!col) throw new Error("No current collection in this document.");
      }
      source = col.variants;
      isSpec = true;
      scopeDescription = "collection " + col.name();
    }

    const items = isSpec ? null : source;

    /**
     * Reads one property across every element in one Apple Event, following a
     * relationship chain if given (e.g. ["parentImage","extension"]).
     * Falls back to per-item reads when the source is an array or the app
     * refuses the bulk read, so one awkward property cannot fail the call.
     */
    function readAll(chain, fallback) {
      if (isSpec) {
        try {
          let node = source;
          for (let i = 0; i < chain.length - 1; i++) node = node[chain[i]];
          const v = node[chain[chain.length - 1]]();
          if (Object.prototype.toString.call(v) === "[object Array]") return v;
        } catch (e) { /* fall through to per-item */ }
      }
      const list = items || source();
      const out = [];
      for (let i = 0; i < list.length; i++) {
        try {
          let node = list[i];
          for (let k = 0; k < chain.length - 1; k++) node = node[chain[k]]();
          out.push(node[chain[chain.length - 1]]());
        } catch (e) { out.push(fallback); }
      }
      return out;
    }

    const ids = readAll(["id"], "");
    const names = readAll(["name"], "");
    const ratings = readAll(["rating"], 0);
    const colorTags = readAll(["colorTag"], 0);
    const picks = readAll(["pick"], false);
    const selecteds = readAll(["selected"], false);
    // Variant name carries no extension and is NOT unique -- a RAW+JPEG pair
    // yields two variants both named e.g. "DSC_1950". Extension is what makes
    // a row identifiable, and it is one cheap chained read, so always fetch it.
    const extensions = readAll(["parentImage", "extension"], "");

    const totalInScope = ids.length;
    const f = args.filter || {};
    const rows = [];

    for (let i = 0; i < totalInScope; i++) {
      const name = String(names[i] == null ? "" : names[i]);
      const rating = Number(ratings[i]) || 0;
      const colorTag = Number(colorTags[i]) || 0;
      const ext = String(extensions[i] == null ? "" : extensions[i]).toLowerCase();

      if (f.minRating != null && rating < f.minRating) continue;
      if (f.maxRating != null && rating > f.maxRating) continue;
      if (f.colorTags != null && f.colorTags.indexOf(colorTag) === -1) continue;
      if (f.pick != null && Boolean(picks[i]) !== f.pick) continue;
      if (f.nameContains && name.toLowerCase().indexOf(String(f.nameContains).toLowerCase()) === -1) continue;
      if (f.extensions != null && f.extensions.indexOf(ext) === -1) continue;

      rows.push({
        index: i,
        id: String(ids[i]),
        name: name,
        extension: String(extensions[i] == null ? "" : extensions[i]),
        rating: rating,
        colorTag: colorTag,
        pick: Boolean(picks[i]),
        selected: Boolean(selecteds[i]),
      });
    }

    const matched = rows.length;
    const page = rows.slice(args.offset, args.offset + args.limit);
    const fields = args.fields || [];

    function dim(d) {
      if (d && typeof d === "object" && d.x != null) return { width: d.x, height: d.y };
      return null;
    }

    if (fields.length && page.length) {
      // Bulk reads cover the whole scope, so they only pay off while the scope
      // is modest. Past that, read the (capped) page per-variant instead.
      const useBulk = isSpec && totalInScope <= args.bulkHydrateMax;

      if (fields.indexOf("exif") !== -1) {
        if (useBulk) {
          const paths = readAll(["parentImage", "path"], null);
          const sizes = readAll(["parentImage", "fileSize"], null);
          const dims = readAll(["parentImage", "dimensions"], null);
          const dates = readAll(["parentImage", "exifCaptureDate"], null);
          const makes = readAll(["parentImage", "exifCameraMake"], null);
          const models = readAll(["parentImage", "exifCameraModel"], null);
          const isos = readAll(["parentImage", "exifISO"], null);
          const shutters = readAll(["parentImage", "exifShutterSpeed"], null);
          const apertures = readAll(["parentImage", "exifAperture"], null);
          const focals = readAll(["parentImage", "exifFocalLength"], null);
          for (let p = 0; p < page.length; p++) {
            const i = page[p].index;
            page[p].image = {
              path: paths[i] == null ? null : String(paths[i]),
              fileSize: sizes[i], dimensions: dim(dims[i]), captureDate: dates[i],
              cameraMake: makes[i] == null ? null : String(makes[i]),
              cameraModel: models[i] == null ? null : String(models[i]),
              iso: isos[i] == null ? null : String(isos[i]),
              shutterSpeed: shutters[i] == null ? null : String(shutters[i]),
              aperture: apertures[i] == null ? null : String(apertures[i]),
              focalLength: focals[i] == null ? null : String(focals[i]),
            };
          }
        } else {
          const list = items || source();
          for (let p = 0; p < page.length; p++) {
            try {
              const img = list[page[p].index].parentImage();
              page[p].image = {
                path: String(img.path()), fileSize: img.fileSize(),
                dimensions: dim(img.dimensions()), captureDate: img.exifCaptureDate(),
                cameraMake: String(img.exifCameraMake()), cameraModel: String(img.exifCameraModel()),
                iso: String(img.exifISO()), shutterSpeed: String(img.exifShutterSpeed()),
                aperture: String(img.exifAperture()), focalLength: String(img.exifFocalLength()),
              };
            } catch (e) { page[p].imageError = String(e); }
          }
        }
      }

      // readAll() reads across the WHOLE scope. That is the cheap path for a
      // specifier, but for a plain array (scope:"selection") or a scope past the
      // bulk threshold it degenerates to a round trip per variant across every
      // variant in scope -- not just the page. So fall back to reading the page
      // directly in exactly the cases the exif branch already handled.
      const pageRead = function (chain, fallback) {
        if (useBulk) return readAll(chain, fallback);
        const list = items || source();
        const out = {};
        for (let p = 0; p < page.length; p++) {
          const i = page[p].index;
          try {
            let node = list[i];
            for (let k = 0; k < chain.length - 1; k++) node = node[chain[k]]();
            out[i] = node[chain[chain.length - 1]]();
          } catch (e) { out[i] = fallback; }
        }
        return out;
      };

      if (fields.indexOf("crop") !== -1) {
        const w = pageRead(["cropWidth"], null), h = pageRead(["cropHeight"], null);
        const cx = pageRead(["cropCenterX"], null), cy = pageRead(["cropCenterY"], null);
        const ar = pageRead(["cropAspectRatio"], null), or = pageRead(["cropOrientation"], null);
        for (let p = 0; p < page.length; p++) {
          const i = page[p].index;
          page[p].crop = {
            width: w[i], height: h[i], centerX: cx[i], centerY: cy[i],
            aspectRatio: ar[i] == null ? null : String(ar[i]),
            orientation: or[i] == null ? null : String(or[i]),
          };
        }
      }

      if (fields.indexOf("adjustments") !== -1) {
        const ex = pageRead(["adjustments", "exposure"], null);
        const co_ = pageRead(["adjustments", "contrast"], null);
        const sa = pageRead(["adjustments", "saturation"], null);
        const te = pageRead(["adjustments", "temperature"], null);
        const ti = pageRead(["adjustments", "tint"], null);
        const cl = pageRead(["adjustments", "clarityAmount"], null);
        const de = pageRead(["adjustments", "dehazeAmount"], null);
        const bw = pageRead(["adjustments", "blackAndWhite"], null);
        const ro = pageRead(["adjustments", "rotation"], null);
        for (let p = 0; p < page.length; p++) {
          const i = page[p].index;
          page[p].adjustments = {
            exposure: ex[i], contrast: co_[i], saturation: sa[i], temperature: te[i],
            tint: ti[i], clarityAmount: cl[i], dehazeAmount: de[i],
            blackAndWhite: bw[i], rotation: ro[i],
          };
        }
      }

      if (fields.indexOf("metadata") !== -1) {
        const hl = pageRead(["contentHeadline"], null);
        const ds = pageRead(["contentDescription"], null);
        const cr = pageRead(["contactCreator"], null);
        const cp = pageRead(["statusCopyrightNotice"], null);
        const list = items || source();
        for (let p = 0; p < page.length; p++) {
          const i = page[p].index;
          page[p].metadata = {
            headline: hl[i] == null ? null : String(hl[i]),
            description: ds[i] == null ? null : String(ds[i]),
            creator: cr[i] == null ? null : String(cr[i]),
            copyrightNotice: cp[i] == null ? null : String(cp[i]),
            // Keywords are an element list, not a property, so there is no
            // bulk form -- read them for the page only.
            keywords: (function () {
              try { return list[i].keywords().map(function (k) { return String(k.name()); }); }
              catch (e) { return null; }
            })(),
          };
        }
      }
    }

    for (let p = 0; p < page.length; p++) delete page[p].index;

    return {
      scopeDescription: scopeDescription,
      totalInScope: totalInScope,
      matched: matched,
      returned: page.length,
      offset: args.offset,
      truncated: args.offset + page.length < matched,
      variants: page,
    };
    `,
    { args: { ...input, bulkHydrateMax: BULK_HYDRATE_MAX }, timeoutMs: 120_000 },
  );
}

/** Everything scriptable about a single variant: image/EXIF, adjustments,
 *  crop, lens correction, IPTC metadata, keywords, layers and output history. */
export async function getVariant(id: string): Promise<Record<string, unknown>> {
  return runJxa<Record<string, unknown>>(
    `
    // resolveTargets indexes ids from ONE bulk read; the previous loop called
    // .id() per variant, which is a round trip each and unusable on a catalog.
    const picked = resolveTargets({ variantIds: [args.id] });
    if (!picked.targets.length) {
      throw new Error("No variant with id '" + args.id + "' in the current document.");
    }
    const v = picked.targets[0];

    function safe(fn) { try { const r = fn(); return r === undefined ? null : r; } catch (e) { return null; } }
    function str(fn) { const r = safe(fn); return r === null ? null : String(r); }

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

    const adjustmentSnapshot = readAdjustments(v);
    const lc = safe(function () { return v.lensCorrection(); });
    const img = safe(function () { return v.parentImage(); });

    return {
      document: { id: String(picked.doc.id()), name: String(picked.doc.name()) },
      id: String(v.id()),
      name: str(function () { return v.name(); }),
      file: str(function () { return v.file(); }),
      // Position within its own clone stack, NOT an index in the collection --
      // it is 1 for every unstacked variant.
      positionInStack: safe(function () { return v.position(); }),
      selected: safe(function () { return v.selected(); }),
      queued: safe(function () { return v.queued(); }),
      processingMode: str(function () { return v.processingMode(); }),
      engine: safe(function () { return v.engine(); }),
      flags: {
        rating: safe(function () { return v.rating(); }),
        colorTag: safe(function () { return v.colorTag(); }),
        pick: safe(function () { return v.pick(); }),
      },
      styles: safe(function () { return v.styles().map(String); }),
      image: img === null ? null : {
        path: str(function () { return img.path(); }),
        extension: str(function () { return img.extension(); }),
        fileSize: safe(function () { return img.fileSize(); }),
        // dimensions is a point record {x, y}, not a string.
        dimensions: safe(function () { const d = img.dimensions(); return d ? { width: d.x, height: d.y } : null; }),
        captureDate: str(function () { return img.exifCaptureDate(); }),
        cameraMake: str(function () { return img.exifCameraMake(); }),
        cameraModel: str(function () { return img.exifCameraModel(); }),
        lensFocalLength: str(function () { return img.exifFocalLength(); }),
        iso: str(function () { return img.exifISO(); }),
        shutterSpeed: str(function () { return img.exifShutterSpeed(); }),
        aperture: str(function () { return img.exifAperture(); }),
        whiteBalance: str(function () { return img.exifWhiteBalance(); }),
        exposureProgram: str(function () { return img.exifExposureProgram(); }),
        meteringMode: str(function () { return img.exifMeteringMode(); }),
      },
      crop: {
        width: safe(function () { return v.cropWidth(); }),
        height: safe(function () { return v.cropHeight(); }),
        centerX: safe(function () { return v.cropCenterX(); }),
        centerY: safe(function () { return v.cropCenterY(); }),
        aspectRatio: str(function () { return v.cropAspectRatio(); }),
        orientation: str(function () { return v.cropOrientation(); }),
        outsideImage: safe(function () { return v.cropOutsideImage(); }),
      },
      adjustments: adjustmentSnapshot.values,
      adjustmentReadErrors: adjustmentSnapshot.errors,
      lensCorrection: lc === null ? null : {
        profile: str(function () { return lc.lensProfile(); }),
        chromaticAberration: safe(function () { return lc.chromaticAberration(); }),
        diffractionCorrection: safe(function () { return lc.diffractionCorrection(); }),
        distortion: safe(function () { return lc.distortion(); }),
        lightFalloff: safe(function () { return lc.lightFalloff(); }),
      },
      metadata: {
        headline: str(function () { return v.contentHeadline(); }),
        description: str(function () { return v.contentDescription(); }),
        creator: str(function () { return v.contactCreator(); }),
        copyrightNotice: str(function () { return v.statusCopyrightNotice(); }),
        rightsUsageTerms: str(function () { return v.statusRightsUsageTerms(); }),
        title: str(function () { return v.statusTitle(); }),
        instructions: str(function () { return v.statusInstructions(); }),
        city: str(function () { return v.imageCity(); }),
        state: str(function () { return v.imageState(); }),
        country: str(function () { return v.imageCountry(); }),
        latitude: safe(function () { return v.latitude(); }),
        longitude: safe(function () { return v.longitude(); }),
      },
      keywords: safe(function () { return v.keywords().map(function (k) { return String(k.name()); }); }),
      layers: safe(function () {
        return v.layers().map(function (l, i) {
          const snapshot = readAdjustments(l);
          return {
            index: i,
            adjustments: snapshot.values,
            adjustmentReadErrors: snapshot.errors,
            name: String(l.name()),
            kind: String(l.kind()),
            enabled: Boolean(l.enabled()),
            opacity: l.opacity(),
          };
        });
      }),
      outputFiles: safe(function () {
        return v.outputEvents().map(function (o) {
          return { path: String(o.path()), date: String(o.date()), exists: Boolean(o.exists()) };
        });
      }),
    };
    `,
    { args: { id, adjustmentProperties: ADJUSTMENT_PROPERTIES }, timeoutMs: 120_000 },
  );
}
