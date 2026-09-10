# Editable candidate variants

`createCandidates({ documentId, variantIds?, useCurrentSelection?, maxVariants? })`
creates one native Capture One clone per source, using `clone variant` from the
vendored 16.8.5 dictionary. It never reconstructs edits from scalar settings.
Original variants and source files are not deleted. Complete layer/mask preservation
must be checked on the installed version; the tool does not claim a verified
pixel-for-pixel snapshot.

Write-gated MCP tool: `co_create_candidates` with `document_id` (required),
`variant_ids` or `use_current_selection: true` (exactly one), and `max_variants`
(default 10, range 1–50). Larger selections are rejected, never truncated.
Explicit IDs must be unique and all exist before cloning. Use the returned document
identity with each original/candidate mapping. Edit candidates, not source IDs.

Selection is captured before cloning, but native cloning can change application
selection. Source resolution is refreshed for each clone because insertion can
move indices. The current document is checked before each clone in addition to
the bridge's configured document lock.

This is additive, not transactional or idempotent. A recoverable script error
returns `status: incomplete`, completed `copies`, a failure with `outcome: unknown`
or `not_attempted`, and unattempted sources. A transport timeout can lose the whole
response even if some clones completed; mutation-aware timeout advice applies.
Inspect the document before retrying. Never blindly replay a batch. No automatic
cleanup deletes clones or originals, and no global Undo is used.

Live validation must check `co.cloneVariant(source, {additiveSelect:false})` returns
a new variant specifier, references the same image, preserves layers/masks and
adjustments, and check selection side effects. Tests simulate native commands;
they are not proof of Capture One's behavior.
