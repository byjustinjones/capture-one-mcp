import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

// Execute the real submitted JXA body against an in-memory application. No
// osascript or live photo library is involved.
const source = ts.createSourceFile('process.ts', readFileSync(new URL('../src/co/process.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const fn = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'processVariants');
let submission;
function find(node) {
  if (!submission && ts.isCallExpression(node) && node.expression.getText(source) === 'runJxa') submission = node.arguments[0].text;
  ts.forEachChild(node, find);
}
find(fn);
assert.ok(submission);
const submit = new Function('args', 'resolveTargets', 'describeVariant', 'co', submission);
const recipe = (name, behavior, root = 'output location') => ({name: () => name, existingFiles: () => behavior, rootFolderType: () => root});
function run({recipes = [recipe('Safe', 'add suffix')], current = recipes[0], recipeName = null, allowOverwrite = false} = {}) {
  const calls = [];
  // The submitted script records the document it dispatched into, so the diff
  // and the drain poll can prove they are still looking at it.
  const doc = {id: () => 'test-document', recipes: () => recipes, currentRecipe: () => current};
  const variant = {id: () => '1', outputEvents: () => []};
  let result, error;
  try {
    result = submit({target: {}, recipeName, allowOverwrite}, () => ({doc, targets: [variant], notFound: []}), () => ({name: 'original', extension: 'jpg'}), {process: (...args) => {calls.push(args); return 'batch-1';}});
  } catch (e) {error = e;}
  return {calls, result, error};
}

for (const root of ['image folder', 'custom location', 'output location']) {
  test(`ordinary write refuses an existing overwrite recipe at ${root} before dispatch`, () => {
    const r = run({recipes: [recipe('Overwrite', 'overwrite', root)], recipeName: 'Overwrite'});
    assert.match(r.error.message, /CAPTURE_ONE_MCP_ALLOW_DESTRUCTIVE/);
    assert.equal(r.calls.length, 0);
  });
}
for (const behavior of ['add suffix', 'skip']) {
  test(`${behavior} exports remain available with ordinary write access`, () => {
    const r = run({recipes: [recipe('Safe', behavior)]});
    assert.ifError(r.error);
    assert.equal(r.calls.length, 1);
    assert.equal(r.result.existingFilesBehavior, behavior);
  });
}
test('destructive opt-in permits overwrite exports', () => {
  const r = run({recipes: [recipe('Overwrite', 'overwrite', 'image folder')], allowOverwrite: true});
  assert.ifError(r.error);
  assert.equal(r.calls.length, 1);
});
test('implicit request dispatches only the checked current recipe', () => {
  const r = run({recipes: [recipe('Safe', 'skip'), recipe('Other enabled recipe', 'overwrite')]});
  assert.ifError(r.error);
  assert.deepEqual(r.calls[0][1], {recipe: 'Safe'});
});
test('explicit name is resolved case-insensitively and dispatched canonically', () => {
  const r = run({recipeName: 'sAfE'});
  assert.ifError(r.error);
  assert.deepEqual(r.calls[0][1], {recipe: 'Safe'});
});
test('implicit overwrite recipe is blocked', () => {
  const r = run({recipes: [recipe('Overwrite', 'overwrite')]});
  assert.match(r.error.message, /No processing was submitted/);
  assert.equal(r.calls.length, 0);
});
for (const behavior of ['unknown', undefined]) {
  test(`unrecognized ${behavior} behavior fails closed even with destructive opt-in`, () => {
    const r = run({recipes: [recipe('Unknown', behavior)], allowOverwrite: true});
    assert.match(r.error.message, /Cannot verify/);
    assert.equal(r.calls.length, 0);
  });
}
test('unreadable behavior fails closed', () => {
  const r = run({recipes: [{name: () => 'Unreadable', existingFiles: () => {throw Error('Apple Event failed');}}]});
  assert.match(r.error.message, /Cannot verify/);
  assert.equal(r.calls.length, 0);
});
test('missing current recipe fails closed', () => {
  const r = run({current: null});
  assert.match(r.error.message, /Cannot resolve/);
  assert.equal(r.calls.length, 0);
});
test('missing explicit recipe fails closed', () => {
  const r = run({recipeName: 'Missing'});
  assert.match(r.error.message, /No recipe named/);
  assert.equal(r.calls.length, 0);
});

// Also exercise the registered MCP callback, so the server's authorization is
// not lost between config and the domain function. A caller-provided flag must
// not override the server policy.
const serverSource = ts.createSourceFile('server.ts', readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
let handlerSource;
function findHandler(node) {
  if (ts.isCallExpression(node) && node.expression.getText(serverSource) === 'tool' && node.arguments[0]?.text === 'co_process_variants') {
    handlerSource = node.arguments.at(-1).getText(serverSource);
  }
  ts.forEachChild(node, findHandler);
}
findHandler(serverSource);
for (const allowDestructive of [false, true]) {
  test(`MCP handler uses server destructive setting ${allowDestructive}`, async () => {
    const observed = [];
    const handler = new Function('config', 'processVariants', 'toTarget', `return (${handlerSource});`)(
      {allowDestructive}, (...args) => observed.push(args), a => ({variantIds: a.variant_ids}),
    );
    await handler({variant_ids: ['1'], recipe: 'Overwrite', wait_seconds: 0, allowOverwrite: !allowDestructive});
    assert.deepEqual(observed, [[{variantIds: ['1']}, 'Overwrite', 0, allowDestructive]]);
  });
}
