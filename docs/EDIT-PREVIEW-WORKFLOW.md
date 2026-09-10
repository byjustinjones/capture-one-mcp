# Edit, preview, compare, and choose

Start validation in a disposable Capture One session containing copied RAW files. Include a layered variant and a RAW+JPEG pair. Record the session identity and the five selected variant ids with their full image paths; names alone cannot distinguish a RAW from its JPEG. Enable document pinning for the session.

For each of the five originals:

1. Create a candidate with the clone tool. Record the returned original/candidate ids and document identity. Inspect the candidate before editing, especially its layers and masks: scripting cannot verify every part of a clone.
2. Render the original and candidate through the preview tool. Confirm both represent the intended image. Use the same preview size and color profile for subsequent comparisons.
3. Apply a small, explicit set of adjustments to the candidate id, then read back those values. Do not target the current selection, which can change during the workflow.
4. Use `co_compare_variants` with the previously recorded `document_id`, `source_variant_id`, and `candidate_variant_id` to inspect the readable setting differences. Render the candidate again and inspect it visually beside the original. Repeat adjustments as needed.
5. Keep a candidate by recording its id as the chosen variant for later work and export. Revert by choosing the original id instead. Both variants remain in Capture One; choosing does not overwrite, delete, or restore anything. Send only chosen ids to the normal export tool after checking the recipe and destination.

Keep the five mappings in the conversation or a local note: document identity, image path, original id, candidate id, chosen id, and the reason for the choice. No persistent MCP decision state is required. Revalidate the document and ids when resuming a later session.

## What the comparison establishes

The comparison reads both variants sequentially and requires both snapshots to match the supplied document id as well as matching document id/name and exact source image path. A document switch before the first read is rejected even when variant ids collide. It compares the complete writable scalar adjustment registry at variant and layer level, plus readable crop, lens correction, flags, metadata, engine, processing mode, style names, and keywords. Unavailable values and read errors are reported separately rather than treated as equal.

Layers are matched by position because the scripting interface provides no stable layer id. Stack additions/removals are positional; reordering can appear as a series of differences. Masks, curves, layer luma ranges, color-editor structures, and other unexposed settings are not compared. A result with no comparable differences never proves identical edits or identical appearance. The snapshots are not a complete backup and cannot restore a variant. Avoid concurrent edits while reading or rendering comparisons.

## Live acceptance checks

Verify that the originals' readable settings remain unchanged after candidate editing; inspect originals visually as well. Confirm candidate edits survive in the application, previews correspond to their requested ids, and exports use the chosen variants. Switch documents between calls and confirm the pin rejects further operations. Confirm a RAW/JPEG comparison is rejected, and compare a candidate containing an additional layer to inspect positional reporting. If a mutation times out, inspect Capture One before retrying: the operation may have completed.
