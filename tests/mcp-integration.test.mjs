import assert from 'node:assert/strict';
import { test } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Verify the public MCP path, including schema validation, authorization,
// domain logic and bridge errors. All Apple Events are replaced by an in-memory
// application; this suite must never start Capture One or access real photos.
test('MCP processing honors policy and reports submission errors end to end', async t => {
  const originalExecFile = childProcess.execFile;
  const previousPin = process.env.CAPTURE_ONE_MCP_DOCUMENT;
  delete process.env.CAPTURE_ONE_MCP_DOCUMENT;
  let co;
  childProcess.execFile = (_file, _args, _options, callback) => {
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = source => queueMicrotask(() => {
      try {
        const Application = Object.assign(() => co, { currentApplication: () => ({}) });
        callback(null, vm.runInNewContext(source + '\nrun()', { Application }), '');
      } catch (error) { callback(error, '', String(error)); }
    });
    return child;
  };
  syncBuiltinESMExports();
  try {
    const { createServer } = await import('../dist/server.js');
    async function clientFor(config, body) {
      const server = createServer({ maxVariants: 500, documentPin: null, ...config });
      const client = new Client({ name: 'integration-test', version: '1' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(a), client.connect(b)]);
      try { await body(client); } finally { await client.close(); await server.close(); }
    }
    function application(behavior, submission = 'batch-123') {
      const state = { submissions: [], queueReads: 0 };
      const variant = { id: () => 1, name: () => 'test', parentImage: () => ({ extension: () => 'jpg' }), outputEvents: () => [] };
      const variants = () => [variant];
      variants[0] = variant;
      variants.id = () => [1];
      const recipe = { name: () => 'Export', existingFiles: () => behavior };
      const doc = { id: () => 'test-document', variants, recipes: () => [recipe], currentRecipe: () => recipe,
        jobs: () => { state.queueReads++; return []; } };
      co = { currentDocument: () => doc, process: (_targets, options) => { state.submissions.push(options); return submission; } };
      return state;
    }
    await t.test('read-only server has no processing tool', async () => {
      await clientFor({ allowData: false, allowDestructive: false }, async client => {
        assert.equal((await client.listTools()).tools.some(x => x.name === 'co_process_variants'), false);
      });
    });
    await t.test('ordinary writes cannot escalate overwrite through tool arguments', async () => {
      const state = application('overwrite');
      await clientFor({ allowData: true, allowDestructive: false }, async client => {
        const result = await client.callTool({ name: 'co_process_variants', arguments: {
          variant_ids: ['1'], wait_seconds: 0, allowOverwrite: true, allowDestructive: true,
        } });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /CAPTURE_ONE_MCP_ALLOW_DESTRUCTIVE/);
        assert.equal(state.submissions.length, 0);
        assert.equal(state.queueReads, 0);
      });
    });
    await t.test('safe export uses the checked current recipe', async () => {
      const state = application('skip');
      await clientFor({ allowData: true, allowDestructive: false }, async client => {
        const result = await client.callTool({ name: 'co_process_variants', arguments: { variant_ids: ['1'], wait_seconds: 0 } });
        assert.notEqual(result.isError, true);
        assert.equal(state.submissions.length, 1);
        assert.equal(state.submissions[0].recipe, 'Export');
        assert.equal(JSON.parse(result.content[0].text).queueDrained, true);
      });
    });
    await t.test('authorized overwrite still surfaces a Capture One rejection as MCP error', async () => {
      const state = application('overwrite', 'ERROR: export refused');
      await clientFor({ allowData: true, allowDestructive: true }, async client => {
        const result = await client.callTool({ name: 'co_process_variants', arguments: { variant_ids: ['1'], wait_seconds: 0 } });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /export refused/);
        assert.equal(state.submissions.length, 1);
        assert.equal(state.queueReads, 0);
      });
    });
  } finally {
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
    if (previousPin === undefined) delete process.env.CAPTURE_ONE_MCP_DOCUMENT;
    else process.env.CAPTURE_ONE_MCP_DOCUMENT = previousPin;
  }
});
