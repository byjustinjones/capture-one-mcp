import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/co/candidates.ts', import.meta.url), 'utf8').replace(/^import .*;$/m, '').replace(/export /g, '');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function harness({ selection = ['1', '2'], failAt, badReturn = false, switchAfter = false } = {}) {
  const makeVariant = (id, extension) => ({ id: () => id, name: () => 'same-name', extension });
  const rows = [makeVariant('1', 'raw'), makeVariant('2', 'jpg'), makeVariant('3', 'raw')];
  const variants = new Proxy({}, {get: (_, key) => key === 'id' ? () => rows.map(v => v.id()) : rows[Number(key)]});
  const doc = {id: () => 'doc-A', name: () => 'Test', variants};
  let calls = 0;
  let options;
  const clonedSources = [];
  const co = {
    selectedVariants: () => selection.map(id => rows.find(v => v.id() === id)),
    cloneVariant: (source, opts) => {
      assert.deepEqual(opts, { additiveSelect: false });
      clonedSources.push(source.id());
      calls++;
      if (calls === failAt) throw new Error('Timed out -1712');
      if (badReturn) return source;
      const candidate = makeVariant('new-' + source.id(), source.extension);
      rows.splice(rows.indexOf(source) + 1, 0, candidate);
      return candidate;
    },
  };
  const runJxa = async (body, opts) => {
    options = opts;
    return new Function('args', 'co', 'requireDoc', 'describeVariant', body)(opts.args, co,
      () => switchAfter && calls ? {id: () => 'doc-B'} : doc,
      v => ({name: v.name(), extension: v.extension}));
  };
  const run = new Function('runJxa', compiled + '\nreturn createCandidates;')(runJxa);
  return { run, rows, clonedSources, calls: () => calls, options: () => options };
}

test('native clones map RAW/JPEG identities despite insertion changing indices', async () => {
  const h = harness();
  const result = await h.run({ documentId: 'doc-A', variantIds: ['1', '2'] });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.document, {id: 'doc-A', name: 'Test'});
  assert.deepEqual(result.copies.map(c => [c.originalId, c.candidateId, c.extension]), [['1', 'new-1', 'raw'], ['2', 'new-2', 'jpg']]);
  assert.deepEqual(h.clonedSources, ['1', '2']);
  assert.equal(h.options().mutating, true);
  assert.ok(h.rows.find(v => v.id() === '1'));
});
for (const input of [
  {documentId:'wrong', variantIds:['1']},
  {documentId:'doc-A', variantIds:['1','missing']},
  {documentId:'doc-A', variantIds:['1','1']},
  {documentId:'doc-A', variantIds:[]},
  {documentId:'doc-A', variantIds:['1'], useCurrentSelection:true},
  {documentId:'doc-A'},
  {documentId:'', variantIds:['1']},
  {documentId:'doc-A', variantIds:['1'], maxVariants:51},
  {documentId:'doc-A', variantIds:['1','2'], maxVariants:1},
]) test('invalid or unresolved request makes zero clone calls: ' + JSON.stringify(input), async () => {
  const h = harness();
  await assert.rejects(h.run(input));
  assert.equal(h.calls(), 0);
});
test('selection count is bounded, not truncated', async () => {
  const h = harness();
  await assert.rejects(h.run({documentId:'doc-A', useCurrentSelection:true, maxVariants:1}), /nothing was cloned/);
  assert.equal(h.calls(), 0);
});
test('selection clones use captured identities', async () => {
  const h = harness();
  const result = await h.run({documentId:'doc-A', useCurrentSelection:true});
  assert.equal(result.copies.length, 2);
  assert.deepEqual(h.clonedSources, ['1','2']);
});
test('partial failure preserves completed mapping and stops without retry', async () => {
  const h = harness({failAt:2});
  const result = await h.run({documentId:'doc-A', variantIds:['1','2','3']});
  assert.equal(result.status, 'incomplete');
  assert.equal(result.copies.length, 1);
  assert.equal(result.failure.outcome, 'unknown');
  assert.equal(result.failure.originalId, '2');
  assert.deepEqual(result.unattemptedOriginalIds, ['3']);
  assert.equal(h.calls(), 2);
});
test('document switch after first clone stops before the next mutation', async () => {
  const h = harness({switchAfter:true});
  const result = await h.run({documentId:'doc-A', variantIds:['1','2']});
  assert.equal(result.status, 'incomplete');
  assert.equal(result.failure.outcome, 'not_attempted');
  assert.deepEqual(result.unattemptedOriginalIds, ['2']);
  assert.equal(h.calls(), 1);
});
test('a returned original identity is treated as uncertain, not success', async () => {
  const h = harness({badReturn:true});
  const result = await h.run({documentId:'doc-A', variantIds:['1','2']});
  assert.equal(result.copies.length, 0);
  assert.equal(result.failure.outcome, 'unknown');
  assert.equal(h.calls(), 1);
});
