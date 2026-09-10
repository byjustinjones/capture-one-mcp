# Review of five MCP fixes

Five isolated subagent changes were reviewed and integrated. The parent review
also added a public MCP regression suite and the `npm test` command.

- Export submission now requires the existing destructive authorization for
  overwrite recipes, rejects unknown behavior, and explicitly dispatches the
  same recipe that was checked. Safe add-suffix/skip exports remain available
  under normal write access.
- Every state-changing JXA call marks its mutation status so timeouts do not
  recommend a blind retry. Read-only timeouts retain normal retry guidance.
- Auto document binding uses one shared read-only probe before operation bodies
  run, survives subsequent write failures, and covers settings reads as well.
- Variant and layer snapshots read all 83 registered scalar adjustments while
  preserving camelCase response keys and reporting unreadable values explicitly.
- Processing validates the application response before polling, reports returned
  errors, and carries accepted batch identifiers through to the result.

## Validation

`npm run verify` passes TypeScript validation and all 38 embedded JXA checks.
`npm test` builds the runtime and passes 84 tests, including public MCP policy
and error propagation through the actual server and bridge.

No blocking issue was found in the integrated changes. Tests replace Apple
Events with simulated application behavior; they do not validate Capture One's
live rendering, performance, or AppleScript settings syntax against the app.
No live photo edits were performed. Structured adjustments, mask contents,
and atomic multi-property snapshots remain outside these five fixes.
