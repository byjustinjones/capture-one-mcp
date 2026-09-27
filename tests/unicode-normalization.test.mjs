// Run after npm run build. No real osascript process or Apple Events are used.
//
// Capture One reports document ids (folder paths) in decomposed Unicode (NFD:
// "c" + U+0327) while a caller types or generates composed text (NFC: "ç").
// The same document must be accepted whichever form the caller uses, and a
// genuinely different document must still be refused.
import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const NFD_ID = '/Volumes/Studio/Franc\u0327ois/Session';
const NFC_ID = '/Volumes/Studio/Fran\u00e7ois/Session';
const OTHER_ID = '/Volumes/Studio/Fran\u00e7ois/Other session';
assert.notEqual(NFD_ID, NFC_ID);

test('sameText treats composed and decomposed forms as the same id', async () => {
  const { sameText } = await import('../dist/jxa/bridge.js');
  assert.equal(sameText(NFD_ID, NFC_ID), true);
  assert.equal(sameText(NFC_ID, NFD_ID), true);
  assert.equal(sameText(NFD_ID, OTHER_ID), false);
});

test('a pinned document id matches the front document across Unicode forms', async () => {
  const original = childProcess.execFile;
  const previous = process.env.CAPTURE_ONE_MCP_DOCUMENT;
  childProcess.execFile = (_file, _args, _options, callback) => {
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = source => setImmediate(() => {
      try {
        const doc = { id: () => NFD_ID, name: () => 'Session.cosessiondb' };
        const Application = () => ({ currentDocument: () => doc, documents: () => [doc] });
        Application.currentApplication = () => ({});
        callback(null, vm.runInNewContext(source + '\nrun()', { Application }), '');
      } catch (error) {
        callback(error, '', error.message);
      }
    });
    return child;
  };
  syncBuiltinESMExports();
  try {
    process.env.CAPTURE_ONE_MCP_DOCUMENT = NFC_ID;
    const bridge = await import('../dist/jxa/bridge.js?unicode-pin');
    assert.equal(await bridge.runJxa('return String(requireDoc().id());'), NFD_ID);
    process.env.CAPTURE_ONE_MCP_DOCUMENT = OTHER_ID;
    await assert.rejects(bridge.runJxa('return String(requireDoc().id());'), e => e.code === 'WRONG_DOCUMENT');
  } finally {
    childProcess.execFile = original;
    syncBuiltinESMExports();
    if (previous === undefined) delete process.env.CAPTURE_ONE_MCP_DOCUMENT;
    else process.env.CAPTURE_ONE_MCP_DOCUMENT = previous;
  }
});

test('candidates accept the composed form of a decomposed document id', async () => {
  const source = readFileSync(new URL('../src/co/candidates.ts', import.meta.url), 'utf8')
    .replace(/^import .*;$/m, '').replace(/export /g, '');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const rows = [{ id: () => '4', name: () => 'photo', extension: 'ARW' }];
  const variants = new Proxy({}, { get: (_, key) => key === 'id' ? () => rows.map(v => v.id()) : rows[Number(key)] });
  const doc = { id: () => NFD_ID, name: () => 'Session.cosessiondb', variants };
  const co = {
    cloneVariant: src => {
      const clone = { id: () => '7', name: src.name, extension: src.extension };
      rows.push(clone);
      return clone;
    },
  };
  const runJxa = async (body, opts) => new Function('args', 'co', 'requireDoc', 'describeVariant', body)(
    opts.args, co, () => doc, v => ({ name: v.name(), extension: v.extension }));
  const createCandidates = new Function('runJxa', compiled + '\nreturn createCandidates;')(runJxa);

  const result = await createCandidates({ documentId: NFC_ID, variantIds: ['4'] });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.copies.map(c => [c.originalId, c.candidateId]), [['4', '7']]);
  await assert.rejects(createCandidates({ documentId: OTHER_ID, variantIds: ['4'] }), /CO_MCP_WRONG_DOCUMENT/);
  assert.equal(rows.length, 2, 'the refused call must not clone anything');
});

test('comparison accepts the composed form of a decomposed document id', async () => {
  const { ADJUSTMENT_PROPERTIES } = await import('../dist/co/adjustment-properties.js');
  const adjustments = Object.fromEntries(ADJUSTMENT_PROPERTIES.map(p => [p.jxa, 0]));
  globalThis.__unicodeComparisonReader = async id => ({
    id, name: 'photo', document: { id: NFD_ID, name: 'Session.cosessiondb' },
    image: { path: NFD_ID + '/photo.ARW' }, adjustments, adjustmentReadErrors: {}, layers: [],
  });
  let source = readFileSync(new URL('../src/co/comparison.ts', import.meta.url), 'utf8');
  source = source
    .replace('import { getVariant } from "./variants.js";', 'const getVariant = globalThis.__unicodeComparisonReader;')
    .replace('"./adjustment-properties.js"', JSON.stringify(new URL('../dist/co/adjustment-properties.js', import.meta.url).href));
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { compareVariants } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

  const result = await compareVariants({ documentId: NFC_ID, sourceVariantId: '4', candidateVariantId: '7' });
  assert.equal(result.document.id, NFD_ID);
  await assert.rejects(compareVariants({ documentId: OTHER_ID, sourceVariantId: '4', candidateVariantId: '7' }), /expected document identity/);
});
