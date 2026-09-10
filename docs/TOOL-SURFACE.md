# Proposed tool surface

> **Historical design document.** This is the plan written before implementation,
> kept for the reasoning behind the phasing. It does **not** describe what
> shipped: the tool names here are the proposed ones (`variant_adjust` rather
> than `co_adjust_variants`), several listed tools were never built
> (`variant_reset_adjustments`, `variant_autoadjust`, `variant_crop`,
> `variant_clone`, `collection_sync`), and the safety section proposes a
> `CAPTURE_ONE_MCP_READONLY` flag that was replaced by the inverse
> `CAPTURE_ONE_MCP_ALLOW_WRITE`. **See [the README](../README.md) for the tools
> that actually exist.**

Derived from the dictionary of the **installed** build (Capture One 16.8.5.30,
`com.captureone.captureone16`), digested in [DICTIONARY.md](./DICTIONARY.md).

Design constraints that shaped this, all of them observed rather than assumed:

1. **`adjustment settings` has ~90 scalar properties.** One tool per property
   would be unusable. Adjustments are exposed as a handful of tools taking a
   structured patch object, validated against the real property list.
2. **Apple Events are synchronous and can block indefinitely.** Every tool
   carries a timeout budget; long verbs get their own polling model rather than
   holding a request open.
3. **Tier gating is real.** `process` is PRO-only and `autocrop` is Cultural
   Heritage-only, per the dictionary. These tools must degrade with a clear
   message, not a raw AppleScript error.
4. **This drives a real photo library.** Destructive verbs are separated and
   gated (see Safety).

## Phase 1 — read, navigate, inspect (no mutation)

| Tool | Maps to | Notes |
| --- | --- | --- |
| `co_status` | `app version`, `current document` | Health probe. Distinguishes "not running" from "Apple Events blocked". |
| `document_list` / `document_open` | `documents`, `open` | Sessions and catalogs. `kind` is `session` \| `catalog`. |
| `document_info` | `document` properties | Paths, counters, output/capture name formats, current collection/recipe. |
| `collection_list` | `document.collections` | Tree. `kind` ∈ favorite, catalog folder, album, group, project, smart album. |
| `variant_list` | `collection.variants` | **The workhorse.** Filter by rating/color tag/pick/keyword/filename; paginated; caller picks which fields to hydrate. |
| `variant_get` | `variant` + `parent image` | Full detail incl. EXIF, crop, adjustments, layers, metadata. |
| `recipe_list` / `recipe_get` | `document.recipes` | Output recipes and their full settings. |
| `style_list` | `application.available styles` | Names only; that is all the dictionary exposes. |
| `keyword_list` | `document.keywords` | Plus keyword libraries. |

## Phase 2 — selection, rating, metadata (cheap, reversible)

| Tool | Maps to |
| --- | --- |
| `variant_select` / `variant_deselect` | `select`, `deselect`, `change selection` |
| `variant_set_flags` | `rating`, `color tag`, `pick` |
| `variant_set_metadata` | the IPTC `contact */content */status *` property block |
| `keyword_apply` / `keyword_remove` | `apply keyword`, `delete` |

## Phase 3 — adjustments

| Tool | Maps to |
| --- | --- |
| `variant_adjust` | `adjustments` — structured patch (exposure, contrast, saturation, temperature, tint, HDR recovery, clarity, dehaze, vignetting, sharpening, noise reduction, grain, B&W, color balance) |
| `variant_reset_adjustments` | `reset adjustments` |
| `variant_autoadjust` | `autoadjust` + its seven per-category booleans |
| `variant_copy_adjustments` / `variant_apply_adjustments` | the document settings clipboard |
| `style_apply` | `apply style` (targets a **layer**, per the dictionary) |
| `variant_crop` | `crop`, `crop aspect ratio`, `crop size/center`, `maximum crop` |
| `variant_orient` | `rotate left/right`, `rotation`, `flip` |
| `variant_clone` / `image_add_variant` | `clone variant`, `add variant` |

## Phase 4 — layers and masks

`layer_list`, `layer_create`, `layer_adjust`, `layer_mask_op`
(`clear`/`invert`/`fill`/`feather`/`rasterize`), `people_mask_create`
(`create people mask` — areas ∈ body skin, face skin, eyebrows, lips, hair,
iris and pupil, sclera, clothes).

## Phase 5 — output, import, file management

| Tool | Maps to | Notes |
| --- | --- | --- |
| `recipe_configure` | `recipe` properties | Format, bits, scaling, sharpening, watermark, naming. |
| `variant_process` | `process` | **PRO only.** Async — see below. |
| `process_queue_status` | `document.jobs` | Poll target. |
| `variant_output_files` | `variant.output events` | Completed output paths + timestamps. |
| `export_originals` | `export originals` + `export original settings` | |
| `import_images` | `import` + `import settings` | |
| `batch_rename` | `batch rename` + `batch rename settings` | |
| `collection_sync` | `synchronize` | |

### Async processing model

`process` returns immediately; the work lands in the background queue. So:

1. `variant_process` sets the recipe, fires `process`, returns a handle.
2. `process_queue_status` polls `document.jobs` (id, image name, image path)
   until the queue drains.
3. `variant_output_files` reads each variant's `output events` for the real
   written paths.

This is the only reliable completion signal the dictionary offers — the
`processing done` / `batch done` hooks are AppleScript-file callbacks, which
are a poor fit for an MCP server.

## Deliberately out of scope for now

- **Tethered capture** (`capture`, `select camera`, `begin/end live view`,
  `adjust focus`, focus meter). PRO-only, needs a physical camera to develop
  against, and mistakes are costly during a live shoot. Worth a later phase if
  you shoot tethered.
- **`upgrade engine`** — the dictionary says "cannot be undone".
- **`silently quit`**, `apply workspace`, `create template`, `backup now`,
  `pack`/`unpack`/`relink` — administrative, low value per unit of risk.
- The `test *` verbs — internal test harness.

## Safety model

Capture One is operating on the user's actual images, and several verbs are
irreversible. Proposed:

- **`CAPTURE_ONE_MCP_READONLY=1`** — serve Phase 1 only. Good default for
  "let the model look at my catalog".
- **Destructive verbs are opt-in** via `CAPTURE_ONE_MCP_ALLOW_DESTRUCTIVE=1`:
  `delete`, `reset adjustments`, `batch rename`, `collection_sync` with
  `removing`, `upgrade engine`.
- **Every mutating tool reports what it touched** (variant ids + names) so the
  change is auditable from the transcript.
- **No implicit "apply to everything".** Mutating tools require either explicit
  variant ids or an explicit `use_current_selection: true`.
