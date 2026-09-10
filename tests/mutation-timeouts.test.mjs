import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';

// Exercise the real bridge/error translator without launching osascript or
// sending Apple Events. Only the child-process boundary is substituted.
const originalExecFile = childProcess.execFile;
const originalPin = process.env.CAPTURE_ONE_MCP_DOCUMENT;
delete process.env.CAPTURE_ONE_MCP_DOCUMENT;
let failure = 'killed';
let scriptsSent = 0;
childProcess.execFile = (file, argv, options, callback) => {
  assert.equal(file, '/usr/bin/osascript');
  assert.equal(options.killSignal, 'SIGKILL');
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = (source) => {
    assert.match(source, /function run\(\)/);
    scriptsSent++;
    queueMicrotask(() => callback(
      Object.assign(new Error('simulated timeout'), { killed: failure === 'killed' }),
      '', failure === 'event' ? 'execution error: AppleEvent timed out. (-1712)' : '',
    ));
  };
  return child;
};
syncBuiltinESMExports();
after(() => {
  childProcess.execFile = originalExecFile;
  syncBuiltinESMExports();
  if (originalPin === undefined) delete process.env.CAPTURE_ONE_MCP_DOCUMENT;
  else process.env.CAPTURE_ONE_MCP_DOCUMENT = originalPin;
});

const layers = await import('../dist/co/layers.js');
const edit = await import('../dist/co/edit.js');
const adjust = await import('../dist/co/adjust.js');
const documents = await import('../dist/co/documents.js');
const collections = await import('../dist/co/collections.js');
const processing = await import('../dist/co/process.js');
const { CaptureOneError } = await import('../dist/jxa/bridge.js');
const target = { variantIds: ['1'] };
const ref = { variantId: '1', layerIndex: 1 };
const mutations = {
  createLayer: () => layers.createLayer(target, 'test', 1),
  setLayer: () => layers.setLayer(ref, { name: 'test' }),
  invertMask: () => layers.maskOperation(ref, 'invert', null),
  copyMask: () => layers.copyMask(ref, { ...ref, layerIndex: 2 }),
  setLumaRange: () => layers.setLumaRange(ref, { invert: true }),
  clearLumaRange: () => layers.clearLumaRange(ref),
  applyStyleToLayer: () => layers.applyStyleToLayer(ref, 'test'),
  createPeopleMask: () => layers.createPeopleMask(target, null, true),
  deleteLayer: () => layers.deleteLayer(ref),
  setFlags: () => edit.setFlags(target, { rating: 3 }),
  setMetadata: () => edit.setMetadata(target, { title: 'test' }),
  applyKeyword: () => edit.applyKeyword(target, 'test'),
  removeKeyword: () => edit.removeKeyword(target, 'test'),
  setSelection: () => edit.setSelection(['1'], 'replace'),
  adjustLayer: () => adjust.adjustLayer(ref, { exposure: 1 }),
  adjustVariants: () => adjust.adjustVariants(target, { exposure: 1 }),
  openDocument: () => documents.openDocument('/tmp/test.cosessiondb'),
  setCurrentCollection: () => collections.setCurrentCollection('test'),
  configureRecipe: () => processing.configureRecipe('test', { jpeg_quality: 80 }),
  processVariants: () => processing.processVariants(target, 'test', 0),
};

for (const mode of ['killed', 'event']) {
  for (const [name, invoke] of Object.entries(mutations)) {
    test(`${name}: ${mode} timeout warns against blind retry`, async () => {
      failure = mode;
      const before = scriptsSent;
      await assert.rejects(invoke, (error) => {
        assert.ok(error instanceof CaptureOneError);
        assert.equal(error.code, 'TIMEOUT');
        assert.match(error.message, /work may still be running or already done/);
        assert.match(error.message, /Inspect the current state before retrying/);
        assert.doesNotMatch(error.message, /Check the Capture One window, then retry/);
        return true;
      });
      assert.equal(scriptsSent - before, 1, 'does not automatically retry a mutation');
    });
  }
  test(`read-only call retains ordinary retry guidance for ${mode} timeout`, async () => {
    failure = mode;
    await assert.rejects(() => layers.listLayers(target), (error) => {
      assert.equal(error.code, 'TIMEOUT');
      assert.match(error.message, /Check the Capture One window, then retry/);
      assert.doesNotMatch(error.message, /MUTATES/);
      return true;
    });
  });
}
