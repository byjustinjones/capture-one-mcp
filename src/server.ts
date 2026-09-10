import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { CaptureOneError, documentLock } from "./jxa/bridge.js";
import { healthCheck } from "./jxa/health.js";
import { isAllowed, loadConfig, type RiskLevel, type ServerConfig } from "./config.js";
import { getDocument, listDocuments, openDocument } from "./co/documents.js";
import { listCollections, setCurrentCollection } from "./co/collections.js";
import { createCandidates } from "./co/candidates.js";
import { compareVariants } from "./co/comparison.js";
import { renderPreview, type PreviewResult } from "./co/preview.js";
import { getVariant, listVariants } from "./co/variants.js";
import { getRecipe, listKeywords, listRecipes, listStyles } from "./co/output.js";
import {
  applyKeyword, removeKeyword, setFlags, setMetadata, setSelection,
  type MetadataField, type Target,
} from "./co/edit.js";
import { adjustLayer, adjustVariants } from "./co/adjust.js";
import {
  batchRename, configureRecipe, exportOriginals, importImages, outputFiles,
  processVariants, queueStatus,
} from "./co/process.js";
import { RECIPE_PROPERTIES, RECIPE_UNSUPPORTED } from "./co/recipe-properties.js";
import {
  applyStyleToLayer, clearLumaRange, copyMask, createLayer, createPeopleMask,
  deleteLayer, listLayers, maskOperation, setLayer, setLumaRange,
  LUMA_RANGE_FIELDS, PEOPLE_MASK_AREAS, type LayerRef,
} from "./co/layers.js";
import { ADJUSTMENT_PROPERTIES, COMPLEX_ADJUSTMENTS } from "./co/adjustment-properties.js";
import { ADJUSTMENT_RANGES } from "./co/adjustment-ranges.js";

export const SERVER_NAME = "capture-one-mcp";
export const SERVER_VERSION = "0.1.0";

/** Reads expose Capture One's own camelCase property names; writes take the
 *  snake_case parameter names. They differ for 74 of the 83 adjustments, so a
 *  model round-tripping a read into a write fails on nearly every key unless the
 *  schema says so. */
const ADJUSTMENT_CASING_NOTE =
  "Names are snake_case (e.g. level_midtone_rgb), NOT the camelCase spelling that " +
  "co_get_variant and co_list_layers read back (levelMidtoneRgb) — 74 of the 83 differ, so " +
  "an adjustment map copied straight from a read will be rejected. ";

type ToolResult = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean };

export function previewToolResult(value: PreviewResult): ToolResult {
  const { data, ...metadata } = value;
  return { content: [
    { type: "text", text: JSON.stringify(metadata, null, 2) },
    { type: "image", data, mimeType: value.mimeType },
  ] };
}

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(err: unknown): ToolResult {
  const e = err as CaptureOneError;
  const payload =
    e instanceof CaptureOneError
      ? { error: e.code, message: e.message, ...(e.detail ? { detail: e.detail } : {}) }
      : { error: "UNEXPECTED", message: String((err as Error)?.message ?? err) };
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true };
}

/** Editing tools address variants either explicitly or via the app's current
 *  selection. Nothing applies to "everything" implicitly. */
function toTarget(a: {
  variant_ids?: string[] | undefined;
  use_current_selection?: boolean | undefined;
}): Target {
  if (a.use_current_selection) return { useCurrentSelection: true };
  if (!a.variant_ids?.length) {
    throw new Error(
      "Provide variant_ids, or set use_current_selection. Editing tools never apply to the " +
        "whole document implicitly.",
    );
  }
  return { variantIds: a.variant_ids };
}

export function createServer(config: ServerConfig = loadConfig()): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  /** Registers a tool only if its risk level is permitted by the current
   *  configuration, so a blocked tool is invisible rather than present-and-
   *  failing. Also derives the MCP `readOnlyHint`/`destructiveHint` annotations
   *  from the same risk level, so clients see one consistent story. */
  function tool<S extends z.ZodRawShape, R>(
    name: string,
    risk: RiskLevel,
    description: string,
    inputSchema: S,
    handler: (input: z.objectOutputType<S, z.ZodTypeAny>) => Promise<R>,
    format: (value: R) => ToolResult = ok,
  ): void {
    if (!isAllowed(risk, config)) return;
    server.registerTool(
      name,
      {
        description,
        inputSchema,
        annotations: {
          readOnlyHint: risk === "read",
          // MCP's destructiveHint defaults to true and means "may perform
          // destructive updates", not "irreversible". Every non-read tier here
          // overwrites values or app state, so only pure reads may claim false.
          destructiveHint: risk !== "read",
          idempotentHint: risk === "read" || risk === "view",
        },
      },
      (async (input: z.objectOutputType<S, z.ZodTypeAny>) => {
        try {
          return format(await handler(input));
        } catch (err) {
          return fail(err);
        }
        // The SDK's ToolCallback generic does not flow through this wrapper;
        // the schema and handler are declared together at each call site, so
        // the cast does not weaken anything the caller relies on.
      }) as unknown as Parameters<typeof server.registerTool<z.ZodRawShape, S>>[2],
    );
  }

  tool(
    "co_status",
    "read",
    "Health and context for Capture One: whether it is running, whether Apple Events are " +
      "actually getting through, the reported app version, the open document, and which write " +
      "tiers are enabled. Call this first when anything else times out.",
    {},
    async () => {
      const health = await healthCheck();
      return {
        ...health,
        writeEnabled: config.allowData,
        destructiveEnabled: config.allowDestructive,
        documentLock: (() => {
          const lock = documentLock();
          if (lock.mode === "off") {
            return {
              mode: "off",
              note:
                "Not bound to a document. Variant ids are per-document, so if the frontmost " +
                "Capture One document changes, ids from an earlier call can resolve to different " +
                "images in the new document. Set CAPTURE_ONE_MCP_DOCUMENT=auto to bind on first use.",
            };
          }
          if (lock.mode === "auto" && !lock.documentId) {
            return { mode: "auto", documentId: null, note: "Will bind to the first document it touches." };
          }
          const mismatch =
            lock.documentId && health.document && health.document.id !== lock.documentId;
          return {
            mode: lock.mode,
            documentId: lock.documentId,
            ...(mismatch
              ? {
                  warning:
                    `Bound to '${lock.documentId}' but the front document is ` +
                    `'${health.document?.id}'. Calls will be refused until they match; ` +
                    `reconnect this server to bind to the current document.`,
                }
              : {}),
          };
        })(),
        note: config.allowData
          ? undefined
          : "Server is in read-only mode. Set CAPTURE_ONE_MCP_ALLOW_WRITE=1 to enable editing tools.",
      };
    },
  );

  tool(
    "co_list_documents",
    "read",
    "List the Capture One sessions and catalogs that are currently open, and which one is frontmost.",
    {},
    async () => ({ documents: await listDocuments() }),
  );

  tool(
    "co_get_document",
    "read",
    "Detailed settings for the current document: kind (session or catalog), paths, session " +
      "folders, naming/token formats, counters, current collection and recipe, and processing " +
      "queue depth.",
    {},
    async () => getDocument(),
  );

  tool(
    "co_open_document",
    "data",
    "Open a Capture One session (.cosessiondb) or catalog (.cocatalogdb) by path and make it " +
      "current. Requires write access, for two reasons: opening an older document can trigger " +
      "an irreversible format migration, and it changes which document every subsequent variant " +
      "id resolves against — ids are per-document, so switching mid-task can direct later edits " +
      "at a different catalog.",
    {
      path: z
        .string()
        .describe("Absolute path to the .cosessiondb or .cocatalogdb file")
        .refine((p) => p.startsWith("/"), "Path must be absolute")
        .refine(
          (p) => /\.(cosessiondb|cocatalogdb)$/i.test(p),
          "Must be a .cosessiondb or .cocatalogdb file",
        ),
    },
    async ({ path }) => openDocument(path),
  );

  tool(
    "co_list_collections",
    "read",
    "List the collections in the current document: albums, projects, groups, smart albums, " +
      "catalog folders and session favorites.",
    {
      include_counts: z
        .boolean()
        .default(false)
        .describe(
          "Also count variants per collection. Off by default because it forces every " +
            "collection (including smart albums) to resolve its contents, which is slow.",
        ),
    },
    async ({ include_counts }) => ({ collections: await listCollections(include_counts) }),
  );

  tool(
    "co_set_current_collection",
    "view",
    "Focus a collection in the Capture One browser by name or id. Changes only what is " +
      "displayed; no image data is touched.",
    { name_or_id: z.string().describe("Collection name (case-insensitive) or its id") },
    async ({ name_or_id }) => setCurrentCollection(name_or_id),
  );

  tool(
    "co_list_variants",
    "read",
    "List variants (the editable instances of images) with filtering and pagination. This is " +
      "the main way to find images. Filter by rating, color tag, pick flag, filename or " +
      "extension; request extra field groups only when needed, since those cost a round trip " +
      "per variant.",
    {
      scope: z
        .enum(["collection", "document", "selection"])
        .default("collection")
        .describe("Where to look: a collection, the whole document, or the user's current selection"),
      collection: z
        .string()
        .optional()
        .describe("Collection name or id when scope is 'collection'. Defaults to the current collection."),
      min_rating: z.number().int().min(0).max(5).optional(),
      max_rating: z.number().int().min(0).max(5).optional(),
      color_tags: z
        .array(z.number().int())
        .optional()
        .describe("Match any of these color tag indices (0 = none)"),
      pick: z.boolean().optional().describe("Filter on the pick flag"),
      name_contains: z.string().optional(),
      extensions: z
        .array(z.string())
        .optional()
        .describe("Lower-case file extensions without the dot, e.g. ['cr3','jpg']"),
      fields: z
        .array(z.enum(["exif", "adjustments", "crop", "metadata"]))
        .default([])
        .describe("Extra field groups to hydrate for the returned page only"),
      limit: z.number().int().min(1).max(500).default(50),
      offset: z.number().int().min(0).default(0),
    },
    async (a) =>
      listVariants({
        scope: a.scope,
        ...(a.collection !== undefined ? { collection: a.collection } : {}),
        filter: {
          ...(a.min_rating !== undefined ? { minRating: a.min_rating } : {}),
          ...(a.max_rating !== undefined ? { maxRating: a.max_rating } : {}),
          ...(a.color_tags !== undefined ? { colorTags: a.color_tags } : {}),
          ...(a.pick !== undefined ? { pick: a.pick } : {}),
          ...(a.name_contains !== undefined ? { nameContains: a.name_contains } : {}),
          ...(a.extensions !== undefined ? { extensions: a.extensions } : {}),
        },
        fields: a.fields,
        limit: Math.min(a.limit, config.maxVariants),
        offset: a.offset,
      }),
  );

  tool(
    "co_get_variant",
    "read",
    "Everything scriptable about one variant: source image and EXIF, all adjustment values, " +
      "crop, lens correction, IPTC metadata, keywords, layers, and previously written output files.",
    { id: z.string().describe("Variant id, as returned by co_list_variants") },
    async ({ id }) => getVariant(id),
  );

  tool(
    "co_list_recipes",
    "read",
    "List the output recipes in the current document, with format and enabled state.",
    {},
    async () => ({ recipes: await listRecipes() }),
  );

  tool(
    "co_get_recipe",
    "read",
    "Full settings for one output recipe: file format and quality, scaling, output sharpening, " +
      "destination and naming, metadata inclusion, crop handling and watermark.",
    { name: z.string().describe("Recipe name (case-insensitive)") },
    async ({ name }) => getRecipe(name),
  );

  tool(
    "co_list_styles",
    "read",
    "Names of the styles and presets available in Capture One. The scripting interface exposes " +
      "names only, not their contents.",
    {},
    async () => {
      const styles = await listStyles();
      return { total: styles.length, styles };
    },
  );

  tool(
    "co_list_keywords",
    "read",
    "Keywords defined in the current document.",
    { limit: z.number().int().min(1).max(5000).default(500) },
    async ({ limit }) => listKeywords(limit),
  );

  // ---------------------------------------------------------------- Phase 2

  tool(
    "co_select_variants",
    "view",
    "Change which variants are selected in Capture One. Selection is view state — no image " +
      "data, metadata or library structure is modified. Useful to stage a set for the user to " +
      "look at, or to set up a subsequent selection-scoped call.",
    {
      variant_ids: z.array(z.string()).describe("Variant ids from co_list_variants"),
      mode: z
        .enum(["replace", "add", "remove"])
        .default("replace")
        .describe("replace the current selection, add to it, or remove from it"),
    },
    async ({ variant_ids, mode }) => setSelection(variant_ids, mode),
  );

  tool(
    "co_set_flags",
    "data",
    "Set rating (0-5), color tag and/or pick flag on variants. Only the values supplied are " +
      "written. Reversible — Capture One's undo applies, and the previous values are reported " +
      "in the result.",
    {
      variant_ids: z
        .array(z.string())
        .optional()
        .describe("Explicit variant ids from co_list_variants"),
      use_current_selection: z
        .boolean()
        .default(false)
        .describe("Operate on whatever is selected in Capture One instead of explicit ids"),
      rating: z.number().int().min(0).max(5).optional(),
      color_tag: z.number().int().min(0).max(8).optional().describe("0 clears the color tag"),
      pick: z.boolean().optional(),
    },
    async (a) => {
      if (a.rating === undefined && a.color_tag === undefined && a.pick === undefined) {
        throw new Error("Supply at least one of rating, color_tag or pick.");
      }
      return setFlags(toTarget(a), {
        ...(a.rating !== undefined ? { rating: a.rating } : {}),
        ...(a.color_tag !== undefined ? { colorTag: a.color_tag } : {}),
        ...(a.pick !== undefined ? { pick: a.pick } : {}),
      });
    },
  );

  tool(
    "co_set_metadata",
    "data",
    "Write IPTC metadata fields on variants. Only the fields supplied are written; omitted " +
      "fields are left alone. Passing an empty string clears a field, which overwrites whatever " +
      "was there — read the current values with co_get_variant first if that matters.",
    {
      variant_ids: z
        .array(z.string())
        .optional()
        .describe("Explicit variant ids from co_list_variants"),
      use_current_selection: z
        .boolean()
        .default(false)
        .describe("Operate on whatever is selected in Capture One instead of explicit ids"),
      headline: z.string().optional(),
      description: z.string().optional(),
      creator: z.string().optional(),
      copyright_notice: z.string().optional(),
      rights_usage_terms: z.string().optional(),
      title: z.string().optional(),
      instructions: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      country: z.string().optional(),
    },
    async (a) => {
      const map: Record<string, MetadataField> = {
        headline: "headline", description: "description", creator: "creator",
        copyright_notice: "copyrightNotice", rights_usage_terms: "rightsUsageTerms",
        title: "title", instructions: "instructions",
        city: "city", state: "state", country: "country",
      };
      const fields: Partial<Record<MetadataField, string>> = {};
      for (const [snake, camel] of Object.entries(map)) {
        const v = (a as Record<string, unknown>)[snake];
        if (typeof v === "string") fields[camel] = v;
      }
      return setMetadata(toTarget(a), fields);
    },
  );

  tool(
    "co_apply_keyword",
    "data",
    "Apply an EXISTING keyword to variants. Capture One's scripting interface cannot create " +
      "keywords, so the keyword must already exist in the document — add it in the Capture One " +
      "UI or import a keyword list first. Use co_list_keywords to see what is available.",
    {
      variant_ids: z
        .array(z.string())
        .optional()
        .describe("Explicit variant ids from co_list_variants"),
      use_current_selection: z
        .boolean()
        .default(false)
        .describe("Operate on whatever is selected in Capture One instead of explicit ids"),
      keyword: z.string().describe("Must already exist in the document"),
    },
    async (a) => applyKeyword(toTarget(a), a.keyword),
  );

  tool(
    "co_remove_keyword",
    "data",
    "Remove a keyword from variants. Intended to remove it from those variants only, leaving " +
      "the keyword in the document's keyword list; the result reports whether that held. NOTE: " +
      "not yet verified against a real keyword, so confirm the result before using it broadly.",
    {
      variant_ids: z
        .array(z.string())
        .optional()
        .describe("Explicit variant ids from co_list_variants"),
      use_current_selection: z
        .boolean()
        .default(false)
        .describe("Operate on whatever is selected in Capture One instead of explicit ids"),
      keyword: z.string(),
    },
    async (a) => removeKeyword(toTarget(a), a.keyword),
  );

  // ---------------------------------------------------------------- Phase 3

  tool(
    "co_list_adjustments",
    "read",
    "List every writable adjustment property with its type, valid range and any quirks. " +
      "Ranges were recovered by probing the live app — the scripting dictionary declares none. " +
      "Call this before co_adjust_variants to get exact parameter names and limits.",
    {
      filter: z.string().optional().describe("Substring match on the property name"),
    },
    async ({ filter }) => {
      const rows = ADJUSTMENT_PROPERTIES.filter(
        (p) => !filter || p.param.includes(filter.toLowerCase()),
      ).map((p) => ({
        param: p.param,
        kind: p.kind,
        ...(p.values ? { values: p.values } : {}),
        ...(ADJUSTMENT_RANGES[p.param] ? { range: ADJUSTMENT_RANGES[p.param] } : {}),
      }));
      return {
        total: ADJUSTMENT_PROPERTIES.length,
        returned: rows.length,
        properties: rows,
        unsupported: COMPLEX_ADJUSTMENTS.map((c) => c.dictionary),
        note:
          "Curves, the colour editor and dehaze colour are structured objects and are not yet " +
          "settable through this tool.",
      };
    },
  );

  tool(
    "co_adjust_variants",
    "data",
    "Apply adjustments to variants — exposure, contrast, white balance, HDR recovery, clarity, " +
      "dehaze, vignetting, sharpening, noise reduction, grain, black & white, colour balance, " +
      "levels, keystone and rotation. Values are validated against the app's real limits before " +
      "anything is written. Every property is read back afterwards and reported as " +
      "requested/actual/matched, so a write that Capture One quietly stored differently is " +
      "visible rather than reported as success.",
    {
      variant_ids: z.array(z.string()).optional(),
      use_current_selection: z.boolean().default(false),
      adjustments: z
        .record(z.union([z.number(), z.boolean(), z.string()]))
        .describe(
          "Map of property name to value, e.g. {\"exposure\": 0.35, \"contrast\": 12, " +
            "\"black_and_white\": true}. " + ADJUSTMENT_CASING_NOTE +
            "See co_list_adjustments for names and ranges.",
        ),
    },
    async (a) => adjustVariants(toTarget(a), a.adjustments),
  );

  // ---------------------------------------------------------------- Phase 4

  const layerRef = {
    variant_id: z.string().describe("Variant id from co_list_variants"),
    layer_index: z
      .number()
      .int()
      .min(0)
      .describe("Position in the variant's layer list. 0 is the background layer."),
  };
  const toRef = (a: { variant_id: string; layer_index: number }): LayerRef => ({
    variantId: a.variant_id,
    layerIndex: a.layer_index,
  });

  tool(
    "co_list_layers",
    "read",
    "List the layers on variants, with kind, enabled state, opacity and luma-range settings. " +
      "Layers have no id and are addressed by index; index 0 is always the background layer.",
    {
      variant_ids: z.array(z.string()).optional(),
      use_current_selection: z.boolean().default(false),
    },
    async (a) => listLayers(toTarget(a)),
  );

  tool(
    "co_create_layer",
    "data",
    "Create adjustment layers on variants. Capture One's scripting interface can only create " +
      "adjustment layers — layer kind is read-only, so clone, heal and the mask layer types " +
      "cannot be made this way. The resulting layer list is read back and reported.",
    {
      variant_ids: z.array(z.string()).optional(),
      use_current_selection: z.boolean().default(false),
      name: z.string().optional().describe("Layer name; Capture One auto-names if omitted"),
      count: z.number().int().min(1).max(10).default(1),
    },
    async (a) => createLayer(toTarget(a), a.name ?? null, a.count),
  );

  tool(
    "co_set_layer",
    "data",
    "Set a layer's name, enabled state or opacity (1–100). Each value is read back after " +
      "writing and reported as requested/actual/matched.",
    {
      ...layerRef,
      name: z.string().optional(),
      enabled: z.boolean().optional(),
      opacity: z.number().int().min(1).max(100).optional(),
    },
    async (a) => {
      if (a.name === undefined && a.enabled === undefined && a.opacity === undefined) {
        throw new Error("Supply at least one of name, enabled or opacity.");
      }
      return setLayer(toRef(a), {
        ...(a.name !== undefined ? { name: a.name } : {}),
        ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
        ...(a.opacity !== undefined ? { opacity: a.opacity } : {}),
      });
    },
  );

  tool(
    "co_mask_edit",
    "data",
    "Edit a layer's mask: invert, feather (0–100) or refine (0–300). IMPORTANT: Capture One " +
      "exposes no way to read a mask, so the result confirms only that the command was " +
      "accepted — it cannot confirm the mask actually changed. Filling is under co_mask_replace, " +
      "since it discards whatever was masked before.",
    {
      ...layerRef,
      operation: z.enum(["invert", "feather", "refine"]),
      amount: z
        .number()
        .optional()
        .describe("Required for feather (0–100) and refine (0–300); ignored otherwise"),
    },
    async (a) => {
      if ((a.operation === "feather" || a.operation === "refine") && a.amount === undefined) {
        throw new Error(`'${a.operation}' requires an amount.`);
      }
      if (a.operation === "feather" && a.amount !== undefined && (a.amount < 0 || a.amount > 100)) {
        throw new Error("feather amount must be between 0 and 100.");
      }
      if (a.operation === "refine" && a.amount !== undefined && (a.amount < 0 || a.amount > 300)) {
        throw new Error("refine amount must be between 0 and 300.");
      }
      return maskOperation(toRef(a), a.operation, a.amount ?? null);
    },
  );

  tool(
    "co_copy_mask",
    "data",
    "Copy a layer's mask onto another layer, possibly on a different variant. Not verifiable " +
      "by read-back — mask contents are not readable.",
    {
      from_variant_id: z.string(),
      from_layer_index: z.number().int().min(0),
      to_variant_id: z.string(),
      to_layer_index: z.number().int().min(0),
    },
    async (a) =>
      copyMask(
        { variantId: a.from_variant_id, layerIndex: a.from_layer_index },
        { variantId: a.to_variant_id, layerIndex: a.to_layer_index },
      ),
  );

  tool(
    "co_set_luma_range",
    "data",
    "Set a layer mask's luma range — range low/high, falloff low/high, invert, radius, " +
      "sensitivity. Every field is read back after writing.",
    {
      ...layerRef,
      ...Object.fromEntries(
        Object.keys(LUMA_RANGE_FIELDS).map((k) => [
          k,
          k === "invert" ? z.boolean().optional() : z.number().optional(),
        ]),
      ),
    },
    async (a) => {
      const fields: Record<string, number | boolean> = {};
      for (const k of Object.keys(LUMA_RANGE_FIELDS)) {
        const v = (a as Record<string, unknown>)[k];
        if (typeof v === "number" || typeof v === "boolean") fields[k] = v;
      }
      if (!Object.keys(fields).length) throw new Error("Supply at least one luma range field.");
      return setLumaRange(toRef(a), fields);
    },
  );

  tool(
    "co_clear_luma_range",
    "data",
    "Clear a layer's luma range, returning it to defaults. The resulting values are read back.",
    layerRef,
    async (a) => clearLumaRange(toRef(a)),
  );

  tool(
    "co_apply_style_to_layer",
    "data",
    "Apply a named style or preset to a layer. Styles apply to LAYERS, not variants — to style " +
      "a whole image, target its background layer (index 0). Use co_list_styles for names.",
    { ...layerRef, named: z.string() },
    async (a) => applyStyleToLayer(toRef(a), a.named),
  );

  tool(
    "co_create_people_mask",
    "data",
    "Run Capture One's AI people masking, creating mask layers on variants. Areas: " +
      PEOPLE_MASK_AREAS.join(", ") + ". Defaults to body skin and face skin. Producing no " +
      "layers is a normal outcome when no people are detected, and is reported explicitly.",
    {
      variant_ids: z.array(z.string()).optional(),
      use_current_selection: z.boolean().default(false),
      areas: z.array(z.enum(PEOPLE_MASK_AREAS)).optional(),
      separate_layers: z
        .boolean()
        .optional()
        .describe("One layer per area, rather than all areas combined into one"),
    },
    async (a) => createPeopleMask(toTarget(a), a.areas ?? null, a.separate_layers ?? null),
  );

  tool(
    "co_adjust_layer",
    "data",
    "Apply adjustments to a single LAYER rather than the whole variant — this is what makes an " +
      "adjustment layer useful, since the layer's mask limits where they take effect. Accepts " +
      "the same properties and validation as co_adjust_variants, and reads every value back.",
    {
      ...layerRef,
      adjustments: z
        .record(z.union([z.number(), z.boolean(), z.string()]))
        .describe(
          "Map of property name to value, same 83 properties, types and measured ranges as " +
            "co_adjust_variants. " + ADJUSTMENT_CASING_NOTE +
            "See co_list_adjustments for names and ranges.",
        ),
    },
    async (a) => adjustLayer(toRef(a), a.adjustments),
  );

  tool(
    "co_mask_replace",
    "destructive",
    "Clear, fill or rasterize a layer's mask. All three discard what was there: clearing and " +
      "filling both replace the whole mask, and rasterizing permanently converts a parametric " +
      "mask to pixels. None is undoable through scripting, and none can be verified afterwards " +
      "since mask contents are not readable.",
    { ...layerRef, operation: z.enum(["clear", "fill", "rasterize"]) },
    async (a) => maskOperation(toRef(a), a.operation, null),
  );

  tool(
    "co_delete_layer",
    "destructive",
    "Delete a layer from a variant. The background layer cannot be deleted. The resulting " +
      "layer list is read back to confirm the removal.",
    layerRef,
    async (a) => deleteLayer(toRef(a)),
  );

  // ---------------------------------------------------------------- Phase 5

  tool(
    "co_list_recipe_properties",
    "read",
    "List every writable recipe property with its type and allowed values, for use with " +
      "co_configure_recipe.",
    {},
    async () => ({
      total: RECIPE_PROPERTIES.length,
      properties: RECIPE_PROPERTIES.map((p) => ({
        param: p.param,
        kind: p.kind,
        ...(p.values ? { values: p.values } : {}),
      })),
      unsupported: RECIPE_UNSUPPORTED,
    }),
  );

  tool(
    "co_configure_recipe",
    "data",
    "Change an output recipe's settings — format, quality, scaling, sharpening, destination, " +
      "naming, metadata inclusion. Every value is read back and reported as " +
      "requested/actual/matched. Note that 'existing_files' controls overwrite behaviour: " +
      "'add suffix' and 'skip' are safe. Setting it to 'overwrite' replaces files already on " +
      "disk and requires CAPTURE_ONE_MCP_ALLOW_DESTRUCTIVE=1 whatever the recipe is rooted at, " +
      "because an armed recipe outlives this session and is used by the next Process in the UI.",
    {
      recipe: z.string().describe("Recipe name, from co_list_recipes"),
      settings: z.record(z.union([z.number(), z.boolean(), z.string()])),
      acknowledge_overwrites_originals: z
        .boolean()
        .default(false)
        .describe(
          "Second confirmation, required IN ADDITION to CAPTURE_ONE_MCP_ALLOW_DESTRUCTIVE=1, " +
            "when the resulting recipe would overwrite files in the image folder — i.e. " +
            "replace originals. Only for deliberately restoring a recipe already configured " +
            "that way.",
        ),
    },
    async (a) =>
      configureRecipe(a.recipe, a.settings, a.acknowledge_overwrites_originals, config.allowDestructive),
  );

  tool(
    "co_process_variants",
    "data",
    "Render variants to disk through an output recipe (Capture One PRO only). Processing is " +
      "asynchronous, so this fires the job then polls the queue until it drains, and reports " +
      "exactly which files were newly written by THIS call — the variant's prior output history " +
      "is excluded. Overwrite recipes require CAPTURE_ONE_MCP_ALLOW_DESTRUCTIVE=1; " +
      "unreadable existing-files behavior is refused before submission.",
    {
      variant_ids: z.array(z.string()).optional(),
      use_current_selection: z.boolean().default(false),
      recipe: z.string().optional().describe("Recipe name; the document's current recipe if omitted"),
      wait_seconds: z
        .number()
        .int()
        .min(0)
        .max(600)
        .default(120)
        .describe("How long to wait for the processing queue to drain"),
    },
    async (a) => processVariants(toTarget(a), a.recipe ?? null, a.wait_seconds, config.allowDestructive),
  );

  tool(
    "co_process_queue_status",
    "read",
    "Current depth of the processing queue, and the jobs still pending.",
    {},
    async () => queueStatus(),
  );

  tool(
    "co_variant_output_files",
    "read",
    "Files previously written for variants, from Capture One's output history, including " +
      "whether each file still exists on disk.",
    {
      variant_ids: z.array(z.string()).optional(),
      use_current_selection: z.boolean().default(false),
    },
    async (a) => outputFiles(toTarget(a)),
  );

  tool(
    "co_export_originals",
    "data",
    "Copy original files out, using the document's export-originals settings. Writes files but " +
      "records no output events, so the destination folder must be listed to confirm them.",
    {
      variant_ids: z.array(z.string()).optional(),
      use_current_selection: z.boolean().default(false),
    },
    async (a) => exportOriginals(toTarget(a)),
  );

  tool(
    "co_import_images",
    "data",
    "Import image files into the current document, using its import settings. Paths must be " +
      "absolute and must exist; importing a whole folder tree requires allow_folders, since an " +
      "over-broad path can pull in thousands of images that are laborious to remove. Runs " +
      "asynchronously; poll co_list_variants for the resulting variants.",
    {
      sources: z.array(z.string()).min(1).max(500).describe("Absolute paths to image files"),
      allow_folders: z
        .boolean()
        .default(false)
        .describe("Permit folder sources, importing their contents recursively"),
    },
    async (a) => importImages(a.sources, a.allow_folders),
  );

  tool(
    "co_batch_rename",
    "destructive",
    "Rename the ORIGINAL IMAGE FILES ON DISK, using the document's batch-rename settings. This " +
      "is not undoable through scripting. The result reports the actual from/to mapping for " +
      "every variant, which is also the only record of how to reverse it.",
    {
      variant_ids: z.array(z.string()).optional(),
      use_current_selection: z.boolean().default(false),
    },
    async (a) => batchRename(toTarget(a)),
  );

  tool(
    "co_create_candidates", "data",
    "Clone explicitly targeted variants into native editable candidates, preserving existing edits. " +
      "Requires the expected document ID. Returns source/candidate ID mappings; selection may change. " +
      "An incomplete result must be inspected before retrying to avoid duplicate copies.",
    {
      document_id: z.string().min(1),
      variant_ids: z.array(z.string().min(1)).min(1).max(50).optional(),
      use_current_selection: z.boolean().optional(),
      max_variants: z.number().int().min(1).max(50).default(10),
    },
    async a => createCandidates({ documentId: a.document_id, ...(a.variant_ids ? { variantIds: a.variant_ids } : {}),
      ...(a.use_current_selection !== undefined ? { useCurrentSelection: a.use_current_selection } : {}), maxVariants: a.max_variants }),
  );
  tool(
    "co_render_preview", "data",
    "Return a bounded sRGB JPEG as an MCP image for one variant in the expected document. " +
      "Uses a private temporary export recipe and folder. Requires write access; " +
      "does not change image adjustments. Cleanup may be deferred while processing remains active.",
    {
      document_id: z.string().min(1), variant_id: z.string().min(1),
      max_edge: z.number().int().min(64).max(2560).default(1600),
      wait_seconds: z.number().int().min(1).max(120).default(60),
    },
    async a => renderPreview({ documentId: a.document_id, variantId: a.variant_id,
      maxEdge: a.max_edge, waitSeconds: a.wait_seconds }),
    previewToolResult,
  );
  tool(
    "co_compare_variants", "read",
    "Compare readable settings of source and candidate variants from the same image in the expected " +
      "document. Reports differences and unavailable fields, plus IDs for keeping the candidate or " +
      "returning to the source. Mask contents, curves and luma ranges are outside comparison coverage.",
    {
      document_id: z.string().min(1), source_variant_id: z.string().min(1),
      candidate_variant_id: z.string().min(1),
    },
    async a => compareVariants({ documentId: a.document_id, sourceVariantId: a.source_variant_id,
      candidateVariantId: a.candidate_variant_id }),
  );

  return server;
}
