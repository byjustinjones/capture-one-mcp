// Run after npm run build. No real osascript process or Apple Events are used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

const originalExecFile = childProcess.execFile;
let sequence = 0;
async function fixture(run) {
  const previous = process.env.CAPTURE_ONE_MCP_DOCUMENT;
  process.env.CAPTURE_ONE_MCP_DOCUMENT = 'auto';
  const state = { front: 'A', sources: [], writes: [], afterProbe: null, failProbe: false };
  childProcess.execFile = (_file, _args, _options, callback) => {
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = source => {
      state.sources.push(source);
      setImmediate(() => {
        try {
          if (source.startsWith('tell application')) {
            // Model the generated AS document check; additionally assert the
            // body addresses the checked object, not a new current document.
            assert.match(source, /tell targetDocument/);
            const pin = source.match(/is not "([^"]*)" then error/)[1];
            if (pin !== state.front) throw Error('CO_MCP_WRONG_DOCUMENT: changed');
            callback(null, 'value', '');
            return;
          }
          const probe = !source.includes('const args =');
          if (probe && state.failProbe) throw Error('-1712');
          const Application = () => ({ currentDocument: () => state.front ? { id: () => state.front } : null });
          Application.currentApplication = () => ({});
          const result = vm.runInNewContext(source + '\nrun()', { Application, writes: state.writes });
          if (probe && state.afterProbe) state.afterProbe();
          callback(null, result, '');
        } catch (error) {
          callback(error, '', error.message);
        }
      });
    };
    return child;
  };
  syncBuiltinESMExports();
  try {
    const bridge = await import(`../dist/jxa/bridge.js?pin-test=${sequence++}`);
    await run(bridge, state);
  } finally {
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
    if (previous === undefined) delete process.env.CAPTURE_ONE_MCP_DOCUMENT;
    else process.env.CAPTURE_ONE_MCP_DOCUMENT = previous;
  }
}

test('concurrent first calls share a read-only binding and reject a switched document before writing', async () => {
  await fixture(async (bridge, state) => {
    state.afterProbe = () => { state.front = 'B'; };
    const results = await Promise.allSettled([
      bridge.runJxa('requireDoc(); writes.push("first");', { mutating: true }),
      bridge.runJxa('requireDoc(); writes.push("second");', { mutating: true }),
    ]);
    assert.equal(state.sources.filter(s => !s.includes('const args =')).length, 1);
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      assert.equal(result.reason.code, 'WRONG_DOCUMENT');
    }
    assert.deepEqual(state.writes, []);
    assert.equal(bridge.documentLock().documentId, 'A');
  });
});

test('binding survives an operation that writes and then fails', async () => {
  await fixture(async (bridge, state) => {
    await assert.rejects(bridge.runJxa('requireDoc(); writes.push("done"); throw Error("late failure");', { mutating: true }));
    state.front = 'B';
    await assert.rejects(bridge.runJxa('requireDoc(); writes.push("wrong");', { mutating: true }), { code: 'WRONG_DOCUMENT' });
    assert.deepEqual(state.writes, ['done']);
    assert.equal(bridge.documentLock().documentId, 'A');
  });
});

test('failed probe rejects all waiters without running bodies and allows later retry', async () => {
  await fixture(async (bridge, state) => {
    state.failProbe = true;
    const results = await Promise.allSettled([bridge.runJxa('requireDoc();'), bridge.runJxa('requireDoc();')]);
    assert.ok(results.every(r => r.status === 'rejected' && r.reason.code === 'TIMEOUT'));
    assert.equal(state.sources.length, 1);
    assert.equal(bridge.documentLock().documentId, null);
    state.failProbe = false;
    assert.equal(await bridge.runJxa('return requireDoc().id();'), 'A');
  });
});

test('no-document app reads work; newly opened documents cannot bypass an empty probe', async () => {
  await fixture(async (bridge, state) => {
    state.front = null;
    assert.equal(await bridge.runJxa('return "app health";'), 'app health');
    state.afterProbe = () => { state.front = 'B'; state.afterProbe = null; };
    await assert.rejects(bridge.runJxa('requireDoc(); writes.push("wrong");', { mutating: true }), { code: 'NO_DOCUMENT' });
    assert.deepEqual(state.writes, []);
    assert.equal(await bridge.runJxa('return requireDoc().id();'), 'B');
  });
});

test('settings reads establish and enforce the shared document binding', async () => {
  await fixture(async (bridge, state) => {
    assert.deepEqual(await bridge.readDocumentSettings('import settings', ['destination']), { destination: 'value' });
    assert.equal(bridge.documentLock().documentId, 'A');
    state.front = 'B';
    await assert.rejects(bridge.readDocumentSettings('import settings', ['destination']), { code: 'WRONG_DOCUMENT' });
  });
});

// CLAUDE.md: "co_status deliberately does NOT bind -- a health check must not
// claim the server for a document." It did: healthCheck reaches the app through
// runJxa, which latched unconditionally. Since co_status is the tool a client is
// told to call first when anything times out, diagnosing a problem claimed the
// server for whatever document happened to be frontmost.
test('an observing call reads the app without latching the binding', async () => {
  await fixture(async (bridge, state) => {
    assert.equal(await bridge.runJxa('return "app version";', { observeOnly: true }), 'app version');
    assert.equal(bridge.documentLock().documentId, null, 'a health check must not claim a document');
    // No probe was sent at all -- the only source is the observing body itself.
    assert.equal(state.sources.filter(s => !s.includes('const args =')).length, 0);
    // The document the user actually works in still binds normally afterwards.
    state.front = 'B';
    assert.equal(await bridge.runJxa('return requireDoc().id();'), 'B');
    assert.equal(bridge.documentLock().documentId, 'B');
  });
});

test('an observing call still honours a binding that already exists', async () => {
  await fixture(async (bridge, state) => {
    assert.equal(await bridge.runJxa('return requireDoc().id();'), 'A');
    assert.equal(bridge.documentLock().documentId, 'A');
    state.front = 'B';
    // Diagnostics must keep working while mismatched -- reporting the mismatch
    // is the whole point of the tool -- so this observes rather than refusing.
    assert.equal(await bridge.runJxa('return "app version";', { observeOnly: true }), 'app version');
    assert.equal(bridge.documentLock().documentId, 'A');
  });
});

// Structural: the behaviour above is only reached if healthCheck asks for it.
test('healthCheck opts out of binding', () => {
  const health = readFileSync(new URL('../src/jxa/health.ts', import.meta.url), 'utf8');
  assert.match(health, /observeOnly:\s*true/);
});
