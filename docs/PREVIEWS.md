# Direct previews

`renderPreview({documentId, variantId, maxEdge?, waitSeconds?})` exports one explicitly
identified variant using a unique `MCP Preview <UUID>` recipe and private OS temporary
folder. It returns JPEG base64 plus document/variant/batch identity, dimensions, byte
count, and profile name. The MCP adapter should return the data as an `image` content
block and the remaining metadata as text, without duplicating base64 in the text.
This operation requires write access because it creates an export recipe and submits
processing even though it does not change the image adjustments.

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
This is deliberately conservative: unrelated queued work can delay a preview.

After confirmed completion, the tool removes its recipe and temporary folder. If
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
