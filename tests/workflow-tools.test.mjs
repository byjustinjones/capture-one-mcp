import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, previewToolResult } from '../dist/server.js';

for (const allowData of [false, true]) test(`workflow tool policy with data writes ${allowData}`, async () => {
  const server = createServer({ allowData, allowDestructive: false, maxVariants: 500, documentPin: null });
  const client = new Client({name:'workflow-test',version:'1'});
  const [a,b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a),client.connect(b)]);
  try {
    const {tools} = await client.listTools();
    for (const name of ['co_create_candidates','co_render_preview']) {
      assert.equal(tools.some(t=>t.name===name),allowData);
      if(allowData) assert.equal(tools.find(t=>t.name===name).annotations.readOnlyHint,false);
    }
    const comparison=tools.find(t=>t.name==='co_compare_variants');
    assert.equal(comparison.annotations.readOnlyHint,true);
    assert.ok(comparison.inputSchema.required.includes('document_id'));
    if(allowData) {
      const bad=await client.callTool({name:'co_render_preview',arguments:{document_id:'d',variant_id:'v',max_edge:9999}});
      assert.equal(bad.isError,true);
    }
  } finally {await client.close();await server.close();}
});
test('preview response carries image bytes once, separate from metadata', () => {
  const result=previewToolResult({documentId:'d',variantId:'v',batchId:'b',width:100,height:100,maxEdge:100,bytes:3,mimeType:'image/jpeg',data:'/9j/',colorProfile:'sRGB'});
  assert.equal(result.content.length,2);
  assert.equal(JSON.parse(result.content[0].text).data,undefined);
  assert.deepEqual(result.content[1],{type:'image',data:'/9j/',mimeType:'image/jpeg'});
});
