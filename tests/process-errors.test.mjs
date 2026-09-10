import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

// Transpile the real domain function, injecting only its JXA transport. The
// first submitted body executes against a fake application: no Apple Events.
const source = ts.createSourceFile('process.ts', readFileSync(new URL('../src/co/process.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const fn = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'processVariants');
const compiled = ts.transpileModule(fn.getText(source).replace(/^export /, ''), {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
function harness(processResult, afterResult = {outputs: {'1': [{path: '/export/photo.jpg', date: 'today'}]}, notFound: []}) {
  const calls = [];
  let submissions = 0;
  const variant = {id: () => '1', outputEvents: () => []};
  const recipe = {name: () => 'Safe', existingFiles: () => 'skip'};
  const doc = {id: () => 'test-document', recipes: () => [recipe], currentRecipe: () => recipe};
  const runJxa = async (body, options) => {
    calls.push(body);
    if (calls.length === 1) {
      return new Function('args', 'resolveTargets', 'describeVariant', 'co', body)(
        options.args, () => ({doc, targets: [variant], notFound: []}),
        () => ({name: 'photo', extension: 'raw'}),
        {process: () => {submissions++; return processResult;}},
      );
    }
    if (calls.length === 2) return 0;
    // The diff reports both the outputs it read and the ids that no longer
    // resolve, so a variant deleted during the wait cannot silently vanish.
    return afterResult;
  };
  const processVariants = new Function('runJxa', compiled + '\nreturn processVariants;')(runJxa);
  return {run: () => processVariants({variantIds: ['1']}, 'Safe', 0), calls, submissions: () => submissions};
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
