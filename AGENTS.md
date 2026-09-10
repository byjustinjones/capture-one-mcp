# AGENTS.md

**All agent guidance for this repository lives in [CLAUDE.md](CLAUDE.md). Read it
before changing anything here.**

This file is a pointer, not a second copy. Keeping the instructions in one file
is what keeps the two in sync — if you are tempted to add guidance here, add it
to `CLAUDE.md` instead.

Two rules worth stating twice, because getting them wrong is expensive:

- The gate for any change is `npm run verify && npm test`. Both are hermetic and
  must stay that way: the test suite never launches Capture One and never
  touches real photos.
- This server edits a real photo library. Never point a write test at a client
  session or catalog. Automated live testing uses the one standing session that
  `scripts/testbed.mjs` is hard-locked to; the candidate/preview workflow uses a
  disposable session over copied RAWs.

Everything else — architecture, invariants, the live-app behaviours you must not
"fix", how to add a tool — is in [CLAUDE.md](CLAUDE.md).
