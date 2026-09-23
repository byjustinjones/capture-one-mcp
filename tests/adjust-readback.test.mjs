// Run after npm run build. No real osascript process or Apple Events are used.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

// The whole generated script -- bridge prelude plus the adjust body -- runs in
// vm against one variant whose adjustments object stores writes and serves
// reads through `readAs`, which models what Capture One stores for a write.
const originalExecFile = childProcess.execFile;
const originalPin = process.env.CAPTURE_ONE_MCP_DOCUMENT;
delete process.env.CAPTURE_ONE_MCP_DOCUMENT;
const app = { stored: {}, readAs: {}, onWrite: {}, spawned: 0 };
function adjustments() {
  return new Proxy({}, {
    get: (_t, k) => () => (k in app.readAs ? app.readAs[k](app.stored[k]) : app.stored[k]),
    set: (_t, k, v) => { app.stored[k] = v; app.onWrite[k]?.(v); return true; },
  });
}
const variant = {
  id: () => 1, name: () => 'photo', parentImage: () => ({ extension: () => 'raw' }),
  adjustments,
  layers: () => [{}, { kind: () => 'adjustment', adjustments }],
};
const variants = Object.assign(() => [variant], { id: () => [1], 0: variant });
const co = { currentDocument: () => ({ id: () => 'doc', variants }) };
childProcess.execFile = (_file, _argv, _options, callback) => {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = source => {
    app.spawned++;
    queueMicrotask(() => {
      try {
        const Application = Object.assign(() => co, { currentApplication: () => ({}) });
        callback(null, vm.runInNewContext(source + '\nrun()', { Application }), '');
      } catch (error) { callback(error, '', String(error.message)); }
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

const { adjustVariants, adjustLayer } = await import('../dist/co/adjust.js');

const paths = {
  variant: async patch => (await adjustVariants({ variantIds: ['1'] }, patch)).affected[0].applied,
  layer: async patch => (await adjustLayer({ variantId: '1', layerIndex: 1 }, patch)).applied,
};

function reset(readAs = {}, onWrite = {}) {
  app.stored = {}; app.readAs = readAs; app.onWrite = onWrite;
}

for (const [path, apply] of Object.entries(paths)) {
  test(`${path}: temperature and tint match within 0.01, not beyond`, async () => {
    // The requantisation measured on the live app (docs/ADJUSTMENTS.md).
    reset({ temperature: v => v + 0.001465, tint: v => v - 0.000021 });
    let applied = await apply({ temperature: 5500, tint: 3 });
    assert.equal(applied.temperature.matched, true);
    assert.equal(applied.temperature.actual, 5500.001465);
    assert.equal(applied.tint.matched, true);

    reset({ temperature: v => v + 0.01, tint: v => v - 0.02 });
    applied = await apply({ temperature: 5500, tint: 3 });
    assert.equal(applied.temperature.matched, true, 'exactly 0.01 away is within tolerance');
    assert.equal(applied.tint.matched, false, '0.02 away is a mismatch');
  });

  test(`${path}: every other number matches within float32 precision, not beyond`, async () => {
    // Seen live on 16.8.6: rotation 2.6 reads back as 2.599998.
    reset({ rotation: v => Math.fround(v) });
    let applied = await apply({ rotation: 2.6 });
    assert.equal(applied.rotation.matched, true);

    reset({ exposure: v => v + 0.001 });
    applied = await apply({ exposure: 0.5 });
    assert.equal(applied.exposure.matched, false, 'a real difference is still a mismatch');
  });

  test(`${path}: colour-balance hues compare modulo 360`, async () => {
    reset({ colorBalanceMasterHue: v => (v === 0 ? 360 : v), colorBalanceShadowHue: v => v + 1 });
    const applied = await apply({ color_balance_master_hue: 0, color_balance_shadow_hue: 90 });
    assert.equal(applied.color_balance_master_hue.actual, 360);
    assert.equal(applied.color_balance_master_hue.matched, true, '0 and 360 are the same hue');
    assert.equal(applied.color_balance_shadow_hue.matched, false);

    reset({ colorBalanceMidtoneHue: () => 0 });
    assert.equal((await apply({ color_balance_midtone_hue: 360 })).color_balance_midtone_hue.matched, true);
  });

  test(`${path}: read-back happens after the whole patch, so a later write moving an earlier property is caught`, async () => {
    // Writing contrast resets exposure. Reading exposure straight after its own
    // write reported it as landed.
    reset({}, { contrast: () => { app.stored.exposure = 0; } });
    const applied = await apply({ exposure: 1, contrast: 10 });
    assert.equal(applied.exposure.actual, 0);
    assert.equal(applied.exposure.matched, false);
    assert.equal(applied.contrast.matched, true);
  });

  test(`${path}: hues outside 0..360 are refused before anything is sent`, async () => {
    reset();
    for (const bad of [-1, 360.5, 720]) {
      const before = app.spawned;
      await assert.rejects(apply({ exposure: 1, color_balance_highlight_hue: bad }), /between 0 and 360/);
      assert.equal(app.spawned, before, 'validation precedes any Apple Event');
    }
    assert.deepEqual(app.stored, {});
  });
}
