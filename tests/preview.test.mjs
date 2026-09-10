import assert from 'node:assert/strict';
import {readFileSync, constants} from 'node:fs';
import {mkdtemp, open, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import ts from 'typescript';
import {jpegDimensions} from '../dist/co/preview.js';
import {CaptureOneError} from '../dist/jxa/bridge.js';
const source = ts.createSourceFile('preview.ts', readFileSync(new URL('../src/co/preview.ts', import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
const fn = source.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name?.text==='renderPreview');
const compiled = ts.transpileModule(fn.getText(source).replace(/^export /,''),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const jpeg = Buffer.from([255,216,255,192,0,8,8,0,100,0,200,1,255,217]);
function harness({batch='batch-1', badSetting=false, wrongDoc=false, size=jpeg}={}) {
 let recipe, folder, submissions=0, deletions=0;
 const existing={name:()=> 'User recipe'};
 const doc={id:()=>wrongDoc?'other':'doc',currentRecipe:()=>existing,recipes:()=>recipe?[recipe]:[],jobs:()=>[]};
 const co={make:({withProperties})=> {
  const props={...withProperties};
  recipe=new Proxy({}, {get:(_,key)=>()=>badSetting&&key==='existingFiles'?'overwrite':props[key],set:(_,key,val)=>{ if(key==='rootFolderType'&&!props.rootFolderLocation)return true; if(key==='colorProfile'&&val!=='sRGB Color Space Profile')return true; props[key]=val; return true;}});
  return recipe;
 },process:()=>{submissions++;return batch;},delete:()=>{deletions++;}};
 const runJxa=async(body,opts)=>{
  folder=opts.args.folder;
  const value=new Function('args','requireDoc','resolveTargets','co','Path',body)(opts.args,()=>doc,()=>({doc,targets:[{}],notFound:[]}),co,x=>x);
  if (body.includes('co.process')&&submissions) await writeFile(join(folder,'preview.jpg'),size);
  return value;
 };
 const names=['runJxa','constants','mkdtemp','open','realpath','rm','tmpdir','join','randomUUID','jpegDimensions','MAX_BYTES','CaptureOneError'];
 const run=new Function(...names,compiled+'\nreturn renderPreview;')(runJxa,constants,mkdtemp,open,realpath,rm,tmpdir,join,randomUUID,jpegDimensions,8*1024*1024,CaptureOneError);
 return {run:opts=>run({documentId:'doc',variantId:'1',...opts}),stats:()=>({submissions,deletions,folder}),cleanup:()=>folder?rm(folder,{recursive:true,force:true}):null};
}
test('preview validates identifiers and bounds before work',async()=>{
 const h=harness();
 for(const opts of [{documentId:''},{variantId:''},{maxEdge:2561},{maxEdge:1.5},{waitSeconds:0},{waitSeconds:121}]) await assert.rejects(h.run(opts));
 assert.equal(h.stats().submissions,0);
});
test('preview returns bounded JPEG and cleans only after queue completion',async()=>{
 const h=harness();try { const r=await h.run(); assert.equal(r.mimeType,'image/jpeg');assert.equal(r.colorProfile,'sRGB Color Space Profile');assert.equal(r.data,jpeg.toString('base64'));assert.equal(r.width,200);assert.equal(r.height,100);assert.equal(h.stats().deletions,1); } finally {await h.cleanup();}
});
// Cleanup is decided by whether anything was SUBMITTED, not merely by whether
// the queue drained. Each failure point below sits on a different side of that
// line, and the recipe must be removed on exactly one of them.
test('a document mismatch fails before any recipe exists',async()=>{
 const h=harness({wrongDoc:true});
 try{await assert.rejects(h.run(),/document does not match/);
  assert.equal(h.stats().submissions,0);assert.equal(h.stats().deletions,0);}finally{await h.cleanup();}
});
test('a failed recipe read-back removes the private recipe, since nothing was submitted',async()=>{
 const h=harness({badSetting:true});
 try{await assert.rejects(h.run(),/no processing submitted/);
  assert.equal(h.stats().submissions,0);
  // Previously this leaked one "MCP Preview <uuid>" recipe into the user's
  // document on every failed configuration, permanently.
  assert.equal(h.stats().deletions,1,'a recipe created but never used must not be left behind');}
 finally{await h.cleanup();}
});
test('a rejected submission retains the recipe, because submission is uncertain',async()=>{
 const h=harness({batch:'ERROR rejected'});
 try{await assert.rejects(h.run(),/Inspect the processing queue|Inspect queue/);
  assert.equal(h.stats().submissions,1);
  assert.equal(h.stats().deletions,0,'never delete a recipe that work may be queued against');}
 finally{await h.cleanup();}
});
test('invalid JPEG fails after rendering and cleans completed resources',async()=>{
 const h=harness({size:Buffer.from('not jpeg')});try{await assert.rejects(h.run(),/complete JPEG/);assert.equal(h.stats().deletions,1);}finally{await h.cleanup();}
});
test('pixel bound is independently verified',async()=>{
 const h=harness();try{await assert.rejects(h.run({maxEdge:64}),/pixel bound/);}finally{await h.cleanup();}
});
test('JPEG parser rejects truncated and invalid input',()=>{
 assert.throws(()=>jpegDimensions(jpeg.subarray(0,10)));assert.throws(()=>jpegDimensions(Buffer.from([255,216,255,217])));
});
