// Run after npm run build. No real osascript process or Apple Events are used.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';

// Each child fails with the next scripted stderr, exactly as osascript prints
// it: "<pos>: execution error: <message> (<number>)". A `null` entry succeeds.
const originalExecFile = childProcess.execFile;
const originalPin = process.env.CAPTURE_ONE_MCP_DOCUMENT;
delete process.env.CAPTURE_ONE_MCP_DOCUMENT;
const replies = [];
childProcess.execFile = (_file, _argv, _options, callback) => {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => {
    const reply = replies.shift();
    queueMicrotask(() => reply === null
      ? callback(null, 'true', '')
      : callback(Object.assign(new Error('Command failed'), { code: 1 }), '', reply));
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

const { runJxa, busyStatus, clearBusy } = await import('../dist/jxa/bridge.js');
const { healthCheck } = await import('../dist/jxa/health.js');

async function failure(stderr, options = {}) {
  replies.push(stderr);
  try { await runJxa('return 1;', options); } catch (error) { return error; }
  assert.fail('expected the call to fail');
}

test('a collection named "Shoot-600" is a script error, not "not running"', async () => {
  const e = await failure("0:120: execution error: Error: No collection named 'Shoot-600'. (-2700)");
  assert.equal(e.code, 'SCRIPT_ERROR');
  assert.match(e.message, /Shoot-600/);
});

test('a pinned path containing "-1712" is a document mismatch, not a timeout', async () => {
  const e = await failure(
    "0:88: execution error: Error: CO_MCP_WRONG_DOCUMENT: front document is '/Photos/B' but this " +
    "server is pinned to '/Photos/Shoot-1712 (-1712)'. (-2700)", { mutating: true });
  assert.equal(e.code, 'WRONG_DOCUMENT');
  assert.match(e.message, /Shoot-1712/);
  assert.doesNotMatch(e.message, /\(-2700\)/);
  assert.equal(busyStatus().busy, false, 'not a timeout, so the server is not busy');
});

test('Capture One\'s own "not allowed" error is not an automation-permission failure', async () => {
  const e = await failure('0:51: execution error: Capture One got an error: Operation not allowed. (-10000)');
  assert.equal(e.code, 'SCRIPT_ERROR');
  assert.match(e.message, /not allowed/);
});

test('error numbers are read from the end of the error line', async () => {
  assert.equal((await failure('execution error: Not authorized to send Apple events to Capture One. (-1743)')).code, 'NOT_AUTHORIZED');
  assert.equal((await failure("execution error: Error: Application isn't running. (-600)")).code, 'NOT_RUNNING');
  assert.equal((await failure('execution error: Connection is invalid. (-609)')).code, 'NOT_RUNNING');
  assert.equal((await failure('execution error: Capture One got an error: AppleEvent timed out. (-1712)')).code, 'TIMEOUT');
  // A number in the middle of the message is data, not a classification.
  assert.equal((await failure('execution error: Error: rating -1743 is invalid (-2700)')).code, 'SCRIPT_ERROR');
});

test('the NO_DOCUMENT marker wins over any error number', async () => {
  assert.equal((await failure('execution error: Error: CO_MCP_NO_DOCUMENT (-1712)')).code, 'NO_DOCUMENT');
});

test('every failure of a mutating call carries partial-application advice', async () => {
  const plain = await failure('execution error: Error: Layer index 5 is out of range (-2700)', { mutating: true });
  assert.equal(plain.code, 'SCRIPT_ERROR');
  assert.match(plain.message, /may have partially applied/);
  assert.match(plain.message, /Inspect the current state before retrying/);

  const inFlight = await failure('execution error: Error: boom (-2700)', { mutationInFlight: true });
  assert.match(inFlight.message, /ALREADY SUBMITTED/);

  const read = await failure('execution error: Error: boom (-2700)');
  assert.doesNotMatch(read.message, /IMPORTANT/);

  const timedOut = await failure('execution error: AppleEvent timed out. (-1712)', { mutating: true });
  assert.equal(timedOut.code, 'TIMEOUT');
  assert.match(timedOut.message, /work may still be running or already done/);
  assert.equal(busyStatus().busy, true);
  clearBusy();
});

test('co_status names a running app whose probe times out as EVENTS_BLOCKED', async () => {
  replies.push(null, 'execution error: AppleEvent timed out. (-1712)');
  const report = await healthCheck();
  assert.equal(report.processRunning, true);
  assert.equal(report.eventsReachable, false);
  assert.equal(report.problem.code, 'EVENTS_BLOCKED');
});
