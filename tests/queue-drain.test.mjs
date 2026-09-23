import assert from 'node:assert/strict';
import test from 'node:test';
import { DRAIN_QUIET_MS, drainTracker } from '../dist/co/queue-drain.js';

// A job submitted a moment ago need not be in document.jobs yet, so a single
// empty read right after submission proves nothing. See src/co/queue-drain.ts.
function clocked() {
  let t = 0;
  return { tracker: drainTracker(() => t), advance: ms => { t += ms; } };
}

test('an empty first poll is not a drain', () => {
  const { tracker } = clocked();
  assert.equal(tracker.observe(0, false), null);
});

test('a queue seen busy and then empty has drained', () => {
  const { tracker, advance } = clocked();
  assert.equal(tracker.observe(0, false), null);
  advance(500);
  assert.equal(tracker.observe(2, false), null);
  assert.equal(tracker.sawJobs, true);
  advance(500);
  assert.equal(tracker.observe(0, false), 'queue-observed');
});

test('completion evidence drains an empty queue immediately', () => {
  const { tracker } = clocked();
  assert.equal(tracker.observe(0, true), 'completion-evidence');
});

test('evidence does not override a queue that is still busy', () => {
  const { tracker } = clocked();
  assert.equal(tracker.observe(1, true), null);
});

test('only consecutive empty polls spanning the quiet period count', () => {
  const { tracker, advance } = clocked();
  assert.equal(tracker.observe(0, false), null);
  advance(DRAIN_QUIET_MS - 1);
  assert.equal(tracker.observe(0, false), null);
  advance(1);
  assert.equal(tracker.observe(0, false), 'quiet-period');
});
