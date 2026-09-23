import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import ts from 'typescript';

// importImages is compiled on its own with its bridge calls injected, so these
// tests can see exactly which Apple Events it would send -- and prove that a
// refused destination sends no import at all.
const source = ts.createSourceFile('process.ts', readFileSync(new URL('../src/co/process.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const pick = (name) => source.statements.find(s => (ts.isFunctionDeclaration(s) && s.name?.text === name) ||
  (ts.isVariableStatement(s) && s.declarationList.declarations.some(d => d.name.getText(source) === name)));
const compiled = ts.transpileModule(
  [pick('IMPORT_SETTING_KEYS'), pick('importImages')].map(n => n.getText(source).replace(/^export /, '')).join('\n'),
  {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;

function harness(destinationType) {
  const calls = [];
  const readDocumentSettings = async (object, keys) => {
    calls.push(['settings', object]);
    return Object.fromEntries(keys.map(k => [k, k === 'destination type' ? destinationType : '']));
  };
  const runJxa = async (body) => { calls.push(['jxa', body.includes('d.import') ? 'import' : 'other']); return {variantsBefore: 3}; };
  const IMAGE_EXTENSIONS = new Set(['nef', 'jpg']);
  const importImages = new Function('readDocumentSettings', 'runJxa', 'IMAGE_EXTENSIONS',
    compiled + '\nreturn importImages;')(readDocumentSettings, runJxa, IMAGE_EXTENSIONS);
  return {importImages, calls};
}

async function withFile(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'import-test-'));
  const file = join(dir, 'DSC_0001.NEF');
  await writeFile(file, 'raw');
  try { await fn(file); } finally { await rm(dir, {recursive: true, force: true}); }
}

test('a mismatched destination type is refused before any import is sent', async () => {
  await withFile(async (file) => {
    const h = harness('session folder');
    await assert.rejects(h.importImages([file], false, 'current location'),
      /destination type is 'session folder', not 'current location'.*Nothing was imported/s);
    assert.deepEqual(h.calls, [['settings', 'import settings']]);
  });
});

test('a matching destination type imports, and returns the settings it checked', async () => {
  await withFile(async (file) => {
    const h = harness('current location');
    const r = await h.importImages([file], false, 'current location');
    assert.equal(r.settings['destination type'], 'current location');
    assert.deepEqual(h.calls, [['settings', 'import settings'], ['jxa', 'import']]);
  });
});

test('without a requirement the import proceeds as before', async () => {
  await withFile(async (file) => {
    const h = harness('session folder');
    await h.importImages([file], false);
    assert.deepEqual(h.calls.map(c => c[1]), ['import settings', 'import']);
  });
});
