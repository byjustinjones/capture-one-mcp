import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

// Transpile the real domain function, injecting only its JXA transport. The
// first submitted body executes against a fake application: no Apple Events.
const source = ts.createSourceFile('process.ts', readFileSync(new URL('../src/co/process.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const fn = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'processVariants');
const compiled = ts.transpileModule(fn.getText(source).replace(/^export /, ''), {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
import {drainTracker} from '../dist/co/queue-drain.js';
// `queue` is the job count each successive drain poll reads (then empty), and
// `newOutputAtPoll` is the poll from which the variant shows a new output event.
// Poll bodies run for real against the fake document.
function harness(processResult, afterResult = {outputs: {'1': [{path: '/export/photo.jpg', date: 'today'}]}, notFound: []},
  {queue = [], newOutputAtPoll = 0, waitSeconds = 0} = {}) {
  const calls = [];
  let submissions = 0, polls = 0, pendingNow = 0, events = [];
  const variant = {id: () => '1', outputEvents: () => events};
  const recipe = {name: () => 'Safe', existingFiles: () => 'skip'};
  const doc = {id: () => 'test-document', recipes: () => [recipe], currentRecipe: () => recipe, jobs: () => new Array(pendingNow)};
  const resolveTargets = () => ({doc, targets: [variant], notFound: []});
  const runJxa = async (body, options) => {
    calls.push(body);
    if (calls.length === 1) {
      return new Function('args', 'resolveTargets', 'describeVariant', 'co', body)(
        options.args, resolveTargets,
        () => ({name: 'photo', extension: 'raw'}),
        {process: () => {submissions++; return processResult;}},
      );
    }
    if (body.includes('d.jobs()')) {
      pendingNow = queue[polls] ?? 0;
      if (newOutputAtPoll !== null && polls >= newOutputAtPoll) events = [{}];
      polls++;
      return new Function('args', 'requireDoc', 'resolveTargets', body)(options.args, () => doc, resolveTargets);
    }
    // The diff reports both the outputs it read and the ids that no longer
    // resolve, so a variant deleted during the wait cannot silently vanish.
    return afterResult;
  };
  const processVariants = new Function('runJxa', 'drainTracker', compiled + '\nreturn processVariants;')(runJxa, drainTracker);
  return {run: () => processVariants({variantIds: ['1']}, 'Safe', waitSeconds), calls, submissions: () => submissions, polls: () => polls};
}
for (const error of ['ERROR: invalid recipe', 'ERROR no variants processed', '  ERROR: output folder missing  ', 'error: rejected']) {
  test(`rejects returned error before queue polling: ${error}`, async () => {
    const h = harness(error);
    await assert.rejects(h.run(), /Capture One rejected the processing request/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.submissions(), 1);
  });
}
for (const invalid of [undefined, null, '', '  ', 123, {}, []]) {
  test(`unknown acceptance (${JSON.stringify(invalid)}) stops without retrying`, async () => {
    const h = harness(invalid);
    await assert.rejects(h.run(), /may have been submitted.*before retrying/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.submissions(), 1);
  });
}
test('accepted batch identifier reaches the result and permits output inspection', async () => {
  const h = harness('batch-123');
  const result = await h.run();
  assert.equal(result.batchId, 'batch-123');
  assert.equal(result.queueDrained, true);
  assert.equal(result.drainedBy, 'completion-evidence');
  assert.deepEqual(result.newFiles, [{variant: 'photo.raw', path: '/export/photo.jpg', date: 'today'}]);
  assert.equal(h.calls.length, 3);
  assert.equal(h.submissions(), 1);
});

// A variant deleted or moved while the queue drained resolved at submission but
// no longer resolves. It previously fell out of newFiles, variantsWithNoOutput,
// outputHistoryUnreadable and notFound alike, leaving a requested count that no
// row in the result accounted for.
test('a variant that disappears during the wait is reported, not dropped', async () => {
  const h = harness('batch-123', {outputs: {}, notFound: ['1']});
  const result = await h.run();
  assert.equal(result.requested, 1);
  assert.deepEqual(result.newFiles, []);
  assert.deepEqual(result.variantsWithNoOutput, []);
  assert.deepEqual(result.variantsGoneDuringWait, ['photo.raw']);
});

// The drain poll and the output diff both re-enter through requireDoc, which
// compares documents only when a pin is set -- and the pin is unset by default.
test('the wait and the diff both re-check the submitting document', () => {
  const h = harness('batch-123');
  return h.run().then(() => {
    for (const body of h.calls.slice(1)) {
      assert.match(body, /args\.documentId/, 'post-submit read must verify the document it reads');
    }
  });
});

// A timeout AFTER submission must never advise a blind retry: the batch is
// already queued, so re-running processes everything twice.
test('post-submit reads are flagged as having a mutation in flight', () => {
  const submitted = readFileSync(new URL('../src/co/process.ts', import.meta.url), 'utf8');
  const body = submitted.slice(submitted.indexOf('export async function processVariants'));
  assert.equal((body.match(/mutationInFlight: true/g) ?? []).length, 2);
});

// The job is not in document.jobs yet when the first poll runs, and the variant
// has no new output. That empty read used to end the wait and diff output that
// had not been written, reporting the variant as having produced nothing.
test('a job that appears only on the second poll is waited for', async () => {
  const h = harness('batch-123', undefined, {queue: [0, 1, 0], newOutputAtPoll: null, waitSeconds: 10});
  const result = await h.run();
  assert.equal(result.queueDrained, true);
  assert.equal(result.drainedBy, 'queue-observed');
  assert.equal(h.polls(), 3);
});

test('a single empty poll without output evidence is not reported as drained', async () => {
  const h = harness('batch-123', undefined, {newOutputAtPoll: null, waitSeconds: 0});
  const result = await h.run();
  assert.equal(result.queueDrained, false);
  assert.equal(result.drainedBy, undefined);
});
