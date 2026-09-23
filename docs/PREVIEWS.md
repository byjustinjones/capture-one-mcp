# Direct previews

`renderPreview({documentId, variantId, maxEdge?, waitSeconds?})` exports one explicitly
identified variant using a unique `MCP Preview <UUID>` recipe and private OS temporary
folder. It returns JPEG base64 plus document/variant/batch identity, dimensions, byte
count, and profile name. The MCP adapter should return the data as an `image` content
block and the remaining metadata as text, without duplicating base64 in the text.
This operation requires write access because it creates an export recipe and submits
processing even though it does not change the image adjustments.

`co_render_preview` also takes:

- `output_path` — an absolute path ending in `.jpg` whose parent folder already
  exists. After the JPEG is verified it is also written there, and the result
  gains `savedTo` (the path as given). Refused before anything is created or
  submitted: a relative path, another extension, any path containing `..`, a
  missing parent folder, or an existing file unless `overwrite: true`. Even with
  `overwrite`, only a regular file is replaced — never a symlink or folder — and
  the write uses `O_EXCL`/`O_NOFOLLOW`, so a file or link appearing during the
  render is not clobbered. A path inside the session's Capture folder (as given,
  or after resolving symlinks in its folder) is refused inside Capture One before
  the private recipe is made; a stray JPEG there would be treated as a capture.
  Catalogs have no Capture folder, so there is nothing to check.
- `overwrite` (default `false`) — see above.
- `return_image` (default `true`) — `false` returns only the text metadata, no
  image block, so an agent can save many renders to disk without pulling each
  image into its context.

Defaults: 1600 pixels on the long edge; 60 seconds of queue polling. Valid limits:
64–2560 pixels, 1–120 seconds. Setup has a separate 60-second Apple Event timeout;
each poll is bounded by the remaining polling budget, with a maximum of 10 seconds.
The result is limited to 8 MiB and independently checked for JPEG frame dimensions.
The preview uses sRGB IEC61966-2.1, JPEG quality 85, respects the crop, disables
upscaling and output sharpening, and uses `skip` for existing files. Recipe settings
and destination are read back before submission. An existing recipe is never edited;
if creation changes the selected recipe, it is immediately restored.

The private recipe is disabled and explicitly named in the process command. Normal
enabled recipes and the document output destination are not used. The destination
is supplied as a JXA `Path`, as required by the scripting dictionary's file type.
The exact file `preview.jpg` is read only after the document processing queue drains.
This is deliberately conservative: unrelated queued work can delay a preview. An
empty queue on the first poll does not count — the job may not be listed yet. The
queue counts as drained once a job was seen and has left it, once `preview.jpg`
exists with the queue empty, or after empty polls spanning 3 seconds.

After confirmed completion — the job was observed leaving the queue, or the file
exists — the tool removes its recipe and temporary folder. A drain inferred only from
a quiet empty queue is not confirmation: the recipe is retained and reported. If
submission, waiting, document identity, or cleanup is uncertain, the recipe/folder
are retained and identified in the error or `cleanupWarning`. Inspect the queue
before retrying or manually deleting these resources. Never delete a recipe while
its job may still be running. A crashed MCP can likewise leave private resources.
No automatic startup deletion is attempted.

Unit tests execute the submitted script bodies against a simulated Capture One and
use disposable local JPEG fixtures. They cover document checks, recipe read-back
failures, returned process errors, output validation and completed-job cleanup.
The tests do not establish actual Capture One recipe creation or rendering behavior;
those operations require the disposable-session live validation.

Live Capture One 16.8.5 validation requires the recipe profile name `sRGB Color Space Profile` (the rendered JPEG embeds `sRGB IEC61966-2.1`). Assign the destination before the `custom location` root type. See [validation results](WORKFLOW-VALIDATION.md).
