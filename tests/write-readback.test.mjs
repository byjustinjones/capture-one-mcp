import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

// Invariant #4 -- "writes are read back and reported honestly" -- had no test,
// and both of the rules CLAUDE.md records as already broken once could be
// reintroduced with the whole suite still green. This locks them down.
//
//   Rule 1: only coerce `actual` when the read SUCCEEDED. Coercing a failed read
//           turned null into false, so writing false reported matched:true
//           having read nothing back at all.
//   Rule 2: an unreadable value is null WITH the reason attached. A bare null
//           presents an unreadable property as a value mismatch.
//
// Every writer is exercised through the real JXA source it ships, against a fake
// application whose reads fail. No osascript, no Capture One, no photos.

function bodyOf(file, fnName) {
  const source = ts.createSourceFile(file, readFileSync(new URL(`../src/co/${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const fn = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === fnName);
  assert.ok(fn, `${fnName} not found in ${file}`);
  let body;
  const walk = node => {
    if (!body && ts.isCallExpression(node) && node.expression.getText(source).startsWith('runJxa')) body = node.arguments[0].text;
    ts.forEachChild(node, walk);
  };
  walk(fn);
  assert.ok(body, `no runJxa body in ${fnName}`);
  return body;
}

// Writes land; every read raises the way a refused Apple Event does. `fixed`
// covers the identity properties a body legitimately reads before writing.
function target(fixed = {}) {
  const written = {};
  const proxy = new Proxy({}, {
    get: (_t, k) => (k in fixed ? fixed[k] : () => { throw new Error("Can't convert types."); }),
    set: (_t, k, v) => { written[k] = v; return true; },
  });
  return { proxy, written };
}
// The positive control: reads succeed and echo what was written.
function echoTarget(fixed = {}) {
  const written = {};
  const proxy = new Proxy({}, {
    get: (_t, k) => (k in fixed ? fixed[k] : () => written[k]),
    set: (_t, k, v) => { written[k] = v; return true; },
  });
  return { proxy, written };
}

const describeVariant = () => ({ id: '1', name: 'photo', extension: 'raw' });

// Each case names the entry it produces, the value it requests, and how to run
// the shipped body against a supplied target object.
const cases = [
  {
    name: 'co_configure_recipe',
    // The site where the bug actually shipped: a boolean whose read fails.
    request: false, entry: 'upscale',
    run: (t) => new Function('args', 'requireDoc', bodyOf('process.ts', 'configureRecipe'))(
      { recipeName: 'R', patch: { upscale: false }, paramFor: { upscale: 'upscale' }, acknowledged: false, allowDestructive: false },
      () => ({ recipes: () => [t.proxy] }),
    ).applied,
    fixed: { name: () => 'R', rootFolderType: () => 'output location', existingFiles: () => 'skip' },
  },
  {
    name: 'co_set_flags',
    request: false, entry: 'pick',
    run: (t) => new Function('args', 'resolveTargets', 'describeVariant', bodyOf('edit.ts', 'setFlags'))(
      { target: {}, flags: { pick: false } },
      () => ({ doc: {}, targets: [t.proxy], notFound: [] }), describeVariant,
    ).affected[0].changes,
  },
  {
    name: 'co_set_metadata',
    request: 'Headline', entry: 'headline',
    run: (t) => new Function('args', 'resolveTargets', 'describeVariant', bodyOf('edit.ts', 'setMetadata'))(
      { target: {}, fields: { contentHeadline: 'Headline' }, fieldFor: { contentHeadline: 'headline' } },
      () => ({ doc: {}, targets: [t.proxy], notFound: [] }), describeVariant,
    ).affected[0].changes,
  },
  {
    name: 'co_set_layer',
    request: false, entry: 'enabled',
    run: (t) => new Function('args', 'resolveLayer', 'describeVariant', bodyOf('layers.ts', 'setLayer'))(
      { ref: { variantId: '1', layerIndex: 1 }, props: { enabled: false } },
      () => ({ variant: {}, layers: [{}, t.proxy], layer: t.proxy }), describeVariant,
    ).applied,
    fixed: { kind: () => 'adjustment' },
  },
  {
    name: 'co_set_luma_range',
    request: false, entry: 'invert',
    run: (t) => new Function('args', 'resolveLayer', 'describeVariant', bodyOf('layers.ts', 'setLumaRange'))(
      { ref: { variantId: '1', layerIndex: 1 }, fields: { invert: false }, map: { invert: 'invert' } },
      () => ({ variant: {}, layers: [], layer: { lumaRange: () => t.proxy } }), describeVariant,
    ).applied,
  },
  {
    name: 'co_adjust_variants',
    request: false, entry: 'black_and_white',
    run: (t) => new Function('args', 'resolveTargets', 'describeVariant', bodyOf('adjust.ts', 'adjustVariants'))(
      { target: {}, patch: { blackAndWhite: false }, paramFor: { blackAndWhite: 'black_and_white' } },
      () => ({ doc: {}, targets: [{ adjustments: () => t.proxy }], notFound: [] }), describeVariant,
    ).affected[0].applied,
  },
  {
    name: 'co_adjust_layer',
    request: false, entry: 'black_and_white',
    run: (t) => new Function('args', 'resolveLayer', 'describeVariant', bodyOf('adjust.ts', 'adjustLayer'))(
      { ref: { variantId: '1', layerIndex: 1 }, patch: { blackAndWhite: false }, paramFor: { blackAndWhite: 'black_and_white' } },
      () => ({ variant: {}, layers: [], layer: { kind: () => 'adjustment', adjustments: () => t.proxy } }), describeVariant,
    ).applied,
  },
];

for (const c of cases) {
  test(`${c.name}: a failed read-back is never coerced into a match`, () => {
    const applied = c.run(target(c.fixed ?? {}));
    const entry = applied[c.entry];
    assert.ok(entry, `no entry for ${c.entry}; got ${Object.keys(applied)}`);
    // Rule 1. Requesting `false` (or a string) while the read fails must not
    // report success: Boolean(null) is false and String(null) is "null", either
    // of which would compare equal to the request once coerced.
    assert.equal(entry.actual, null, 'an unreadable value must stay null');
    assert.equal(entry.matched, false, 'a write whose read-back failed cannot be a match');
  });

  test(`${c.name}: an unreadable value carries the reason`, () => {
    const applied = c.run(target(c.fixed ?? {}));
    // Rule 2. Without this the caller cannot tell "Capture One rejected the
    // write" from "the read-back Apple Event failed".
    assert.match(String(applied[c.entry].note ?? ''), /convert types|read-back/i);
  });

  test(`${c.name}: a value that does read back is reported as a match`, () => {
    const applied = c.run(echoTarget(c.fixed ?? {}));
    const entry = applied[c.entry];
    assert.equal(entry.actual, c.request);
    assert.equal(entry.matched, true, 'a successful round trip must still report matched');
  });
}
