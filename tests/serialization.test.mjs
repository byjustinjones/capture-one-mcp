// Run after npm run build. No real osascript process or Apple Events are used.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Every osascript child is modelled as taking a few milliseconds, so two calls
// that were allowed to run at once would visibly overlap. `failNext` makes the
// next N children time out the way execFile reports a kill.
const originalExecFile = childProcess.execFile;
const originalPin = process.env.CAPTURE_ONE_MCP_DOCUMENT;
delete process.env.CAPTURE_ONE_MCP_DOCUMENT;
const state = { active: 0, maxActive: 0, spawned: 0, log: [], failNext: 0 };
childProcess.execFile = (_file, _argv, _options, callback) => {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = source => {
    state.spawned++;
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    const fail = state.failNext > 0 && (state.failNext--, true);
    setTimeout(() => {
      state.active--;
      if (fail) {
        callback(Object.assign(new Error('simulated timeout'), { killed: true }), '', '');
        return;
      }
      try {
        const co = { running: () => true, appVersion: () => '16.8.5', currentDocument: () => null };
        const Application = Object.assign(() => co, { currentApplication: () => ({}) });
        callback(null, vm.runInNewContext(source + '\nrun()', { Application, log: state.log }), '');
      } catch (error) {
        callback(error, '', String(error.message));
      }
    }, 5);
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

const bridge = await import('../dist/jxa/bridge.js');
const { createServer } = await import('../dist/server.js');

async function coStatus() {
  const server = createServer({ allowData: true, allowDestructive: false, maxVariants: 500 });
  const client = new Client({ name: 'serialization-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const result = await client.callTool({ name: 'co_status', arguments: {} });
    return JSON.parse(result.content[0].text);
  } finally { await client.close(); await server.close(); }
}

test('concurrent calls run one at a time, in the order they were made', async () => {
  state.maxActive = 0;
  state.log.length = 0;
  const calls = [];
  for (let n = 0; n < 6; n++) {
    const options = { args: { n }, ...(n % 2 ? { mutating: true } : {}) };
    // One call in the middle fails; the lock must still pass to the next.
    const body = n === 3 ? 'log.push(args.n); throw new Error("boom");' : 'log.push(args.n); return args.n;';
    calls.push(bridge.runJxa(body, options));
  }
  const settled = await Promise.allSettled(calls);
  assert.equal(state.maxActive, 1, 'two osascript children must never overlap');
  assert.deepEqual(state.log, [0, 1, 2, 3, 4, 5]);
  assert.equal(settled[3].status, 'rejected');
  assert.deepEqual(settled.filter(s => s.status === 'fulfilled').map(s => s.value), [0, 1, 2, 4, 5]);
});

test('a mutating timeout marks the server busy and refuses queued and later writes', async () => {
  state.failNext = 1;
  const before = state.spawned;
  const [first, queued] = await Promise.allSettled([
    bridge.runJxa('return 1;', { mutating: true }),
    // Queued behind the call that is about to time out: refused at its turn.
    bridge.runJxa('return 2;', { mutating: true }),
  ]);
  assert.equal(first.reason.code, 'TIMEOUT');
  assert.equal(queued.reason.code, 'BUSY');
  assert.match(queued.reason.message, /co_status/);
  assert.equal(state.spawned - before, 1, 'the refused write never reached osascript');
  assert.equal(bridge.busyStatus().busy, true);

  await assert.rejects(bridge.runJxa('return 3;', { mutating: true }), { code: 'BUSY' });
  await assert.rejects(bridge.runJxa('return 4;', { mutationInFlight: true }), { code: 'BUSY' });
  // Reads are how the caller finds out what happened; they stay available.
  assert.equal(await bridge.runJxa('return "read";'), 'read');
  assert.equal(bridge.busyStatus().busy, true, 'an ordinary read does not clear busy');
});

test('co_status reports busy while the probe fails and clears it once the app responds', async () => {
  assert.equal(bridge.busyStatus().busy, true, 'precondition: left busy by the previous test');
  // isRunning succeeds, the 8 s appVersion probe times out.
  state.failNext = 0;
  let probeCalls = 0;
  const realExec = childProcess.execFile;
  childProcess.execFile = (file, argv, options, callback) => {
    const child = realExec(file, argv, options, callback);
    const end = child.stdin.end;
    child.stdin.end = source => {
      if (source.includes('appVersion')) {
        probeCalls++;
        assert.equal(options.timeout, 8000, 'the probe has a fixed budget');
        if (probeCalls === 1) state.failNext = 1;
      }
      end(source);
    };
    return child;
  };
  syncBuiltinESMExports();
  try {
    const stuck = await coStatus();
    assert.equal(stuck.busy, true);
    assert.match(stuck.busyReason, /did not respond/);
    assert.equal(stuck.eventsReachable, false);
    await assert.rejects(bridge.runJxa('return 5;', { mutating: true }), { code: 'BUSY' });

    const healthy = await coStatus();
    assert.equal(healthy.busy, false);
    assert.match(healthy.busyCleared.note, /inspect|read back/i);
    assert.equal(bridge.busyStatus().busy, false);
    assert.equal(await bridge.runJxa('return 6;', { mutating: true }), 6);
  } finally {
    childProcess.execFile = realExec;
    syncBuiltinESMExports();
  }
});
