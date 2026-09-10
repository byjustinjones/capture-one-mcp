# Output, import and rename: findings

Capture One Pro 16.8.5, verified against the standing test session.

## JXA cannot reach the document's settings objects

This is the largest structural finding in the project. The document exposes
`import settings`, `batch rename settings`, `export original settings`,
`next capture settings`, `overlay settings` and others as properties. **None of
them is reachable from JXA:**

```
JXA:         d.importSettings()                    ->  "Can't convert types."
JXA:         d.importSettings().destinationType()  ->  "Invalid key form."
AppleScript: destination type of import settings   ->  "session folder"
```

The identical reads succeed in AppleScript. Since this server is otherwise
entirely JXA, `src/jxa/bridge.ts` grew a second path — `runAppleScript` and
`readDocumentSettings` — used specifically for these objects. Anything that
reports or depends on those settings goes through it.

## A silent naming trap: JXA folds a leading acronym

JXA derives its identifiers from the dictionary's property names by lowercasing
**the entire first word** and capitalising subsequent words:

| Dictionary | JXA | Not |
| --- | --- | --- |
| `JPEG quality` | `jpegQuality` | ~~`JPEGQuality`~~ |
| `TIFF compression` | `tiffCompression` | ~~`TIFFCompression`~~ |
| `include GPS` | `includeGPS` | — later words keep their case |

Getting it wrong is **silent**. The accessor throws `"Can't convert types."`,
which the defensive `try/catch` wrappers this codebase uses turn into `null`.
`co_get_recipe` shipped in Phase 1 reporting `jpegQuality: null` for every
recipe, and nothing surfaced it until a Phase 5 write reported
`requested 82, actual null, matched false`.

Two fixes: the generators now apply the correct rule, and
`scripts/verify-property-names.mjs` (`npm run verify:live`) resolves every
generated name against the running app. It currently confirms 83/83 adjustment
and 40/40 recipe names.

## Processing is asynchronous and needs polling

`process` returns a batch identifier or an `ERROR`-prefixed string. The server
validates that response before polling and returns an accepted `batchId` with
the result. A missing or invalid identifier reports uncertain submission and
advises inspecting the queue/output before retrying.

Accepted work goes to a background queue. Completion is
established by polling `document.jobs` until it drains, then diffing each
variant's `output events` against a snapshot taken beforehand — that diff is
what makes the reported file list *the files this call produced*, rather than
everything the variant has ever written.

The dictionary's `processing done` and `batch done` hooks are AppleScript-file
callbacks, so they cannot be wired to an MCP server. Polling is the only usable
signal.

Three variants processed in **1.5 seconds** of queue time.

### Overwrite behaviour is checked before submission

Recipes carry an `existing files` setting of `add suffix`, `overwrite` or
`skip`. Before submitting work, `co_process_variants` resolves the requested
recipe (or the current recipe when omitted) and reads this setting. Unknown or
unreadable behavior is refused. The resolved recipe name is always passed
explicitly to processing, preventing other enabled recipes from bypassing the
check.

Any `overwrite` recipe requires the server's
`CAPTURE_ONE_MCP_ALLOW_DESTRUCTIVE=1` opt-in, in addition to write access. This
applies at every destination because custom paths and filesystem aliases can
also reach originals. Safe `add suffix` and `skip` recipes remain available with
ordinary write access. The result reports the behavior and warns that colliding
files *may* have been replaced; the setting alone does not prove a collision.

Note that a recipe whose output name format is counter-based will not collide in
the first place — processing the same variant twice under `overwrite` still
produced a new numbered file rather than replacing one.

## `export originals` has no destination by default

Its `destination folder` is unset until chosen in Capture One's UI, and the
command writes asynchronously while recording no output events. Rather than fire
blind, `co_export_originals` reads the setting over AppleScript first and refuses
when no destination exists, since there would be no way to say where files went.

## `batch_rename` renames originals on disk

Destructive and not undoable through scripting. It is gated behind
`CAPTURE_ONE_MCP_ALLOW_DESTRUCTIVE=1`, and the result reports the actual
from/to mapping per variant — which doubles as the only record of how to
reverse it:

```
/…/test session/MCP-RENAME-ME.JPG
  -> /…/test session/Untitled Job0001.JPG   changed=true
```

The token format comes from the document's batch rename settings
(`[Job Name][4 Digit Counter]` here), read over AppleScript and returned
alongside the mapping so the naming is explicable rather than mysterious.

## Import

`import` copies files in per the document's import settings — `session folder`
here, so files land at the session root — and runs asynchronously. The resulting
variant appears within a few seconds; poll `co_list_variants` for it.
