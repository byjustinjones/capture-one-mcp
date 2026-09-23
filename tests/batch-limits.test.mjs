// Run after npm run build. No real osascript process or Apple Events are used.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Three variants in one document. `failOn` names the variant whose next
// per-variant operation throws, modelling Capture One rejecting one image
// partway through a batch. Every script runs whole (bridge prelude included).
const originalExecFile = childProcess.execFile;
const originalPin = process.env.CAPTURE_ONE_MCP_DOCUMENT;
delete process.env.CAPTURE_ONE_MCP_DOCUMENT;
const app = { spawned: 0, failOn: null, writes: [], selection: [] };
function makeVariant(id) {
  const v = {
    // name() is read per variant by every batch body, after its writes.
    id: () => id, name: () => { if (app.failOn === id) throw new Error('name unavailable'); return 'photo' + id; }, parentImage: () => ({ extension: () => 'raw' }),
    adjustments: () => {
      if (app.failOn === id) throw new Error('Capture One got an error: AppleEvent handler failed.');
      return new Proxy({}, {
        get: (_t, k) => () => app.writes.filter(w => w.id === id && w.key === k).at(-1)?.value,
        set: (_t, k, value) => { app.writes.push({ id, key: k, value }); return true; },
      });
    },
    layers: () => [{ name: () => 'Background', kind: () => 'background' }],
    rating: () => app.writes.filter(w => w.id === id && w.key === 'rating').at(-1)?.value ?? 0,
  };
  return new Proxy(v, {
    set: (target, k, value) => {
      if (app.failOn === id) throw new Error('rejected');
      app.writes.push({ id, key: k, value });
      return true;
    },
  });
}
const variantList = ['1', '2', '3'].map(makeVariant);
const variants = Object.assign(() => variantList, { id: () => ['1', '2', '3'] }, variantList);
const co = {
  currentDocument: () => ({ id: () => 'doc', variants }),
  selectedVariants: () => app.selection.map(id => variantList[Number(id) - 1]),
  make: ({ at }) => {
    if (app.failOn === String(at.id())) throw new Error('Capture One got an error: cannot make layer.');
    app.writes.push({ id: String(at.id()), key: 'layer' });
    return { name: () => 'Layer' };
  },
};
childProcess.execFile = (_file, _argv, _options, callback) => {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = source => {
    app.spawned++;
    queueMicrotask(() => {
      try {
        const Application = Object.assign(() => co, { currentApplication: () => ({}) });
        callback(null, vm.runInNewContext(source + '\nrun()', { Application }), '');
      } catch (error) {
        callback(Object.assign(new Error('failed'), { code: 1 }), '', `execution error: Error: ${error.message} (-2700)`);
      }
    });
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

const { createServer } = await import('../dist/server.js');
const { loadConfig } = await import('../dist/config.js');

async function call(name, args, config = {}) {
  const server = createServer({ allowData: true, allowDestructive: false, maxVariants: 500, ...config });
  const client = new Client({ name: 'batch-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    return { isError: result.isError === true, value: JSON.parse(result.content[0].text) };
  } finally { await client.close(); await server.close(); }
}

function reset(failOn = null) { app.failOn = failOn; app.writes = []; app.selection = []; }

test('a variant failing partway returns the completed entries and stops', async () => {
  for (const [tool, args] of [
    ['co_adjust_variants', { adjustments: { exposure: 1 } }],
    ['co_set_flags', { rating: 3 }],
    ['co_create_layer', {}],
  ]) {
    reset('2');
    const { isError, value } = await call(tool, { variant_ids: ['1', '2', '3'], ...args });
    assert.equal(isError, false, `${tool}: a partial batch is a result, not an error`);
    assert.equal(value.status, 'incomplete', tool);
    const entries = value.affected ?? value.variants;
    assert.equal(entries.length, 2, `${tool}: the completed entry plus the failed one`);
    assert.equal(entries[0].id, '1');
    assert.equal(entries[0].error, undefined);
    assert.equal(entries[1].id, '2');
    assert.ok(entries[1].error, `${tool}: the failed variant carries its error`);
    assert.deepEqual(value.unattemptedIds, ['3']);
    assert.match(value.guidance, /Inspect the failed variant before retrying/);
    assert.ok(app.writes.some(w => w.id === '1'), `${tool}: the first variant was written`);
    assert.ok(!app.writes.some(w => w.id === '3'), `${tool}: nothing after the failure was touched`);
  }
});

test('a clean batch reports status complete', async () => {
  reset();
  const { value } = await call('co_adjust_variants', { variant_ids: ['1', '2'], adjustments: { exposure: 1 } });
  assert.equal(value.status, 'complete');
  assert.equal(value.unattemptedIds, undefined);
});

test('explicit variant_ids over the cap are refused before any Apple Event', async () => {
  reset();
  const before = app.spawned;
  const ids = Array.from({ length: 501 }, (_, i) => String(i + 1));
  const { isError, value } = await call('co_set_flags', { variant_ids: ids, rating: 1 });
  assert.equal(isError, true);
  assert.match(value.message, /501 entries, over the limit of 500/);
  assert.equal(app.spawned, before);

  const small = await call('co_adjust_variants', { variant_ids: ['1', '2', '3'], adjustments: { exposure: 1 } }, { maxTargets: 2 });
  assert.equal(small.isError, true);
  assert.equal(app.spawned, before, 'a configured cap applies too');
  assert.deepEqual(app.writes, []);
});

test('a selection over the cap is refused inside Capture One before anything is written', async () => {
  reset();
  app.selection = ['1', '2', '3'];
  const { isError, value } = await call('co_set_flags', { use_current_selection: true, rating: 2 }, { maxTargets: 2 });
  assert.equal(isError, true);
  assert.match(value.message, /current selection has 3 variants, over the limit of 2/);
  assert.match(value.message, /Nothing was changed/);
  assert.doesNotMatch(value.message, /may have partially applied/, 'a pre-write refusal must not claim partial writes');
  assert.deepEqual(app.writes, []);

  app.selection = ['1', '2'];
  const ok = await call('co_set_flags', { use_current_selection: true, rating: 2 }, { maxTargets: 2 });
  assert.equal(ok.isError, false);
  assert.equal(ok.value.count, 2);
});

test('CAPTURE_ONE_MCP_MAX_TARGETS configures the cap, defaulting to 500', () => {
  const previous = process.env.CAPTURE_ONE_MCP_MAX_TARGETS;
  try {
    delete process.env.CAPTURE_ONE_MCP_MAX_TARGETS;
    assert.equal(loadConfig().maxTargets, 500);
    process.env.CAPTURE_ONE_MCP_MAX_TARGETS = '25';
    assert.equal(loadConfig().maxTargets, 25);
  } finally {
    if (previous === undefined) delete process.env.CAPTURE_ONE_MCP_MAX_TARGETS;
    else process.env.CAPTURE_ONE_MCP_MAX_TARGETS = previous;
  }
});
