// Run after npm run build. No real osascript process or Apple Events are used.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

// Five variants in a document, read through whole-specifier bulk properties the
// way Capture One serves them: variants.rating() -> number[] and so on.
const rows = [
  { id: 1, name: 'DSC_1', rating: 0, colorTag: 0, ext: 'NEF' },
  { id: 2, name: 'DSC_1', rating: 3, colorTag: 2, ext: 'JPG' },
  { id: 3, name: 'DSC_2', rating: 5, colorTag: 0, ext: 'nef' },
  { id: 4, name: 'DSC_3', rating: 1, colorTag: 5, ext: 'cr3' },
  { id: 5, name: 'DSC_4', rating: 2, colorTag: 0, ext: 'jpg' },
];
const col = key => () => rows.map(r => r[key]);
const variants = {
  id: col('id'), name: col('name'), rating: col('rating'), colorTag: col('colorTag'),
  pick: () => rows.map(() => false), selected: () => rows.map(() => false),
  parentImage: { extension: col('ext') },
};
const co = { currentDocument: () => ({ id: () => 'doc', name: () => 'Test', variants }) };
const originalExecFile = childProcess.execFile;
const originalPin = process.env.CAPTURE_ONE_MCP_DOCUMENT;
delete process.env.CAPTURE_ONE_MCP_DOCUMENT;
childProcess.execFile = (_file, _argv, _options, callback) => {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = source => queueMicrotask(() => {
    try {
      const Application = Object.assign(() => co, { currentApplication: () => ({}) });
      callback(null, vm.runInNewContext(source + '\nrun()', { Application }), '');
    } catch (error) { callback(error, '', String(error.message)); }
  });
  return child;
};
syncBuiltinESMExports();
after(() => {
  childProcess.execFile = originalExecFile;
  syncBuiltinESMExports();
  if (originalPin === undefined) delete process.env.CAPTURE_ONE_MCP_DOCUMENT;
  else process.env.CAPTURE_ONE_MCP_DOCUMENT = originalPin;
});

const { listVariants } = await import('../dist/co/variants.js');
const list = (filter = {}, page = {}) =>
  listVariants({ scope: 'document', filter, fields: [], limit: 50, offset: 0, ...page });

test('paging reports matched, returned, offset and truncated honestly', async () => {
  const first = await list({}, { limit: 2 });
  assert.equal(first.totalInScope, 5);
  assert.equal(first.matched, 5);
  assert.equal(first.returned, 2);
  assert.equal(first.truncated, true);
  assert.deepEqual(first.variants.map(v => v.id), ['1', '2']);

  const middle = await list({}, { limit: 2, offset: 2 });
  assert.deepEqual(middle.variants.map(v => v.id), ['3', '4']);
  assert.equal(middle.offset, 2);
  assert.equal(middle.truncated, true);

  const last = await list({}, { limit: 2, offset: 4 });
  assert.deepEqual(last.variants.map(v => v.id), ['5']);
  assert.equal(last.truncated, false);

  const past = await list({}, { limit: 2, offset: 10 });
  assert.equal(past.returned, 0);
  assert.equal(past.truncated, false);
});

test('color tag 0 filters for untagged variants', async () => {
  const result = await list({ colorTags: [0] });
  assert.deepEqual(result.variants.map(v => v.id), ['1', '3', '5']);
  assert.equal(result.matched, 3);
});

test('extension filter ignores case and a leading dot', async () => {
  assert.deepEqual((await list({ extensions: ['NEF'] })).variants.map(v => v.id), ['1', '3']);
  assert.deepEqual((await list({ extensions: ['.jpg'] })).variants.map(v => v.id), ['2', '5']);
  assert.deepEqual((await list({ extensions: [' .CR3 '] })).variants.map(v => v.id), ['4']);
  // Paging applies after filtering.
  const paged = await list({ extensions: ['nef', 'jpg'] }, { limit: 3 });
  assert.equal(paged.matched, 4);
  assert.equal(paged.returned, 3);
  assert.equal(paged.truncated, true);
  // The extension is reported as stored, not as normalised for matching.
  assert.equal((await list({ extensions: ['nef'] })).variants[0].extension, 'NEF');
});
