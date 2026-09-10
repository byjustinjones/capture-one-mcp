#!/usr/bin/env node
/**
 * Every Capture One call embeds JXA source inside a TypeScript template
 * literal. Two failure modes are invisible to `tsc` alone:
 *   - a stray backtick in an embedded comment silently ends the literal
 *     (this actually happened, and tsc's error points nowhere near the cause);
 *   - the embedded JXA can be syntactically invalid JS and only fail at runtime.
 *
 * This parses each embedded body with `new Function` so both are caught in CI.
 *
 * It also rejects control characters in the cooked script text. argv cannot
 * carry a NUL byte, so a script containing one fails inside execFile with
 * ERR_INVALID_ARG_VALUE -- before osascript runs and without mentioning Capture
 * One at all. The transport now uses stdin, which removes that failure, but a
 * control character in script source is still almost always an escaping slip.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir) {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

let checked = 0;
let failed = 0;

for (const file of walk("src")) {
  const src = readFileSync(file, "utf8");
  // Bodies passed to runJxa: the backtick-delimited argument. The generic may
  // itself contain '>' (e.g. runJxa<Omit<X, "y">>), so it cannot be matched with
  // a [^>]* class -- doing so silently skipped a whole file.
  const re = /runJxa\s*(?:<[\s\S]*?>)?\s*\(\s*`([\s\S]*?)`\s*[,)]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    checked++;
    try {
      new Function("co", "args", "requireDoc", "app", "delay", "Path", m[1]);
    } catch (err) {
      failed++;
      console.error(`FAIL ${file}: embedded JXA does not parse -- ${err.message}`);
    }

    // The captured text is the RAW source; cook it the way TS would so an
    // escape that collapses into a control character is visible.
    let cooked;
    try {
      cooked = new Function(`return \`${m[1].replace(/`/g, "\\`")}\`;`)();
    } catch {
      cooked = m[1];
    }
    const control = [...cooked].find((ch) => {
      const c = ch.charCodeAt(0);
      return c < 32 && ch !== "\n" && ch !== "\r" && ch !== "\t";
    });
    if (control !== undefined) {
      failed++;
      console.error(
        `FAIL ${file}: embedded JXA contains a control character ` +
          `(charCode ${control.charCodeAt(0)}). Write it as an escape sequence the script ` +
          `interprets at its own runtime, or avoid needing one.`,
      );
    }
  }
}

console.log(`${checked} embedded JXA blocks checked, ${failed} failed`);
// A file that calls runJxa but contributed no checked block means the matcher
// missed it -- fail loudly rather than reporting a clean run over nothing.
for (const file of walk("src")) {
  const src = readFileSync(file, "utf8");
  // Ignore the declaration in the bridge itself -- only call sites carry a body.
  const body = src.replace(/export\s+async\s+function\s+runJxa[\s\S]*?\{/, "");
  const calls = (body.match(/runJxa\s*[<(]/g) ?? []).length;
  const matched = (body.match(/runJxa\s*(?:<[\s\S]*?>)?\s*\(\s*`/g) ?? []).length;
  if (calls > matched) {
    console.error(`FAIL ${file}: ${calls} runJxa call(s) but only ${matched} matched the extractor`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
