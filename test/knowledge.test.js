'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const path=require('node:path');
const ops=require('../lib/knowledge');
const {compileFilter}=require('../lib/knowledge-filter');

function setup(t) {
  const storeDir=mkdtempSync(path.join(tmpdir(),'cw-knowledge-'));
  t.after(()=>rmSync(storeDir,{recursive:true,force:true}));
  const library={type:'context-weave-library',id:'lib',storeDir,options:{
    name:'Guides',libraryId:'guides',embeddingProfile:'embed',filterAttributes:[{name:'status',type:'string',required:true}],
    accessPolicy:{mode:'tenant-field',metadataField:'tenant_id',claimProperty:'auth.tenantId'}
  }};
  const ctx={library,cfg:{},msg:{auth:{tenantId:'alpha'}},cw:{},RED:{nodes:{getNode:ref=>ref==='lib'?library:null}},
    value(key,fallback){return this.cfg[key]??fallback;},
    embed:async texts=>texts.map(s=>/reset|password/i.test(s)?[1,0]:[0,1])};
  function record(id,text,meta={},chunks=[{text}]) {
    ctx.cw.input={document:{id,title:id,text,metadata:{tenant_id:ctx.msg.auth.tenantId,status:'published',...meta}},chunks};
    return ops.index(ctx);
  }
  return {ctx,record};
}

test('imported library defaults isolate tenants and evidence carries its outbound policy',async t=>{
  const {ctx,record}=setup(t);
  delete ctx.library.options.accessPolicy;
  await record('private','password reset');
  ctx.cw.query='password';
  await ops.retrieve(ctx);
  assert.equal(ctx.cw.evidence[0].privacy,'local-only');
  delete ctx.msg.auth;
  await assert.rejects(ops.retrieve(ctx),{code:'POLICY'});
});

test('index is durable, idempotent and removes obsolete chunks and FTS entries',async t=>{
  const {ctx,record}=setup(t);
  const chunks=[{chunkId:'a',text:'password reset'},{chunkId:'b',text:'obsolete word'}];
  await record('d','password reset. obsolete word',{},chunks);
  assert.equal(ctx.cw.index.chunksCreated,2);
  await record('d','password reset. obsolete word',{},chunks);assert.equal(ctx.cw.index.unchanged,true);
  await record('d','password reset',{},chunks.slice(0,1));assert.equal(ctx.cw.index.chunksDeleted,1);
  ctx.cw.query='obsolete';ctx.cfg={mode:'lexical'};await ops.retrieve(ctx);assert.deepEqual(ctx.cw.evidence,[]);
  ctx.cw.query='forgot password';ctx.cfg={mode:'hybrid',highlights:true};await ops.retrieve(ctx);
  assert.equal(ctx.cw.evidence[0].documentId,'d');assert.ok(ctx.cw.evidence[0].scores.lexical>0);
  assert.equal(ctx.cw.evidence[0].scores.dense,1);assert.equal(ctx.cw.evidence[0].highlights.length,1);
  ops['query-history'](ctx);assert.equal(ctx.cw.history.length,2);
  ops['library-info'](ctx);assert.equal(ctx.cw.library.chunks,1);
  ctx.cw.documentId='d';ctx.cw.confirm=true;ops['document-delete'](ctx);await ops.retrieve(ctx);
  assert.equal(ctx.cw.evidence.length,0);
});

test('updated embeddings cannot corrupt or mix vector spaces',async t=>{
  const {ctx,record}=setup(t);
  await record('d','original');ctx.embed=async()=>[[1,0,1]];
  await assert.rejects(record('d','edit'),{code:'CONFLICT'});
  ctx.cw.documentId='d';ops['document-get'](ctx);assert.equal(ctx.cw.document.text,'original');
  ctx.library.options.embeddingProfile='changed';ctx.embed=async()=>[[0,1]];
  await assert.rejects(record('d','edit'),{code:'CONFLICT'});
  ctx.cw.query='anything';await assert.rejects(ops.retrieve(ctx),{code:'CONFLICT'});
  ctx.embed=async()=>[[NaN]];await assert.rejects(record('d','edit'),{code:'UPSTREAM'});
});

test('tenant isolation covers reads, writes, deletes, library reports and traces',async t=>{
  const {ctx,record}=setup(t);
  await record('shared','secret password');ctx.msg.auth.tenantId='beta';
  ctx.cw.documentId='shared';assert.throws(()=>ops['document-get'](ctx),{code:'NOT_FOUND'});
  ctx.cw.query='password';await ops.retrieve(ctx);assert.equal(ctx.cw.evidence.length,0);
  ops['library-info'](ctx);assert.equal(ctx.cw.library.documents,0);
  await assert.rejects(record('fake','secret',{tenant_id:'alpha'}),{code:'POLICY'});
  await record('shared','public');ctx.cw.confirm=true;ops['document-delete'](ctx);
  ctx.msg.auth.tenantId='alpha';ops['document-get'](ctx);assert.equal(ctx.cw.document.text,'secret password');
  ctx.msg.auth={};assert.throws(()=>ops['document-list'](ctx),{code:'POLICY'});
  await assert.rejects(ops.retrieve(ctx),{code:'POLICY'});
});

test('prefilters run before embedding and constrain both search modes',async t=>{
  const {ctx,record}=setup(t);
  await record('live','password reset');await record('draft','password reset',{status:'draft'});
  ctx.cw.query='password';ctx.cfg={libraries:[{library:'lib',metadataFilter:"status = 'published'"}]};
  await ops.retrieve(ctx);assert.deepEqual(ctx.cw.evidence.map(e=>e.documentId),['live']);
  ctx.cfg={metadataFilter:"status = 'draft'",mode:'lexical'};await ops.retrieve(ctx);assert.equal(ctx.cw.evidence[0].documentId,'draft');
  ctx.cfg.metadataFilter="unknown = 'x'";ctx.embed=()=>assert.fail('embedding must not run');ctx.cfg.mode='dense';
  await assert.rejects(ops.retrieve(ctx),{code:'VALIDATION'});
  ctx.cfg={mode:'lexical',resultLimit:1,offset:1};await ops.retrieve(ctx);assert.equal(ctx.cw.evidence.length,1);
});

test('safe grammar supports conjunctions, disjunctions, claims, and IN',()=>{
  const fields=[{name:'status',type:'string'},{name:'priority',type:'integer'}];
  const f=compileFilter("(status IN ['open','waiting'] OR status = $auth.status) AND priority >= 2",fields,{status:'closed'});
  assert.ok(f.test({status:'closed',priority:3}));assert.ok(!f.test({status:'closed',priority:1}));
  assert.ok(!f.sql.includes('closed'));assert.equal(f.params.length,4);
  for(const input of ["status = 'open'; DROP TABLE docs", "priority = 'x'",'status = $auth.missing',"prototype = 'evil'",'','(']) {
    if (input==='') assert.ok(compileFilter(input,fields).test({}));
    else assert.throws(()=>compileFilter(input,fields),{code:'VALIDATION'});
  }
});

test('library lifecycle, metadata changes, protected tenant and scoped pagination',async t=>{
  const {ctx,record}=setup(t);
  ctx.cw.librarySpec={name:'Support'};ops['library-create'](ctx);ops['library-create'](ctx);
  assert.equal(ctx.cw.library.name,'Support');
  ctx.cw.librarySpec.name='Other';assert.throws(()=>ops['library-create'](ctx),{code:'CONFLICT'});
  ctx.cw.patch={name:'Updated',filterAttributes:[{name:'age',type:'integer'}]};ops['library-update'](ctx);
  ops['library-list'](ctx);assert.equal(ctx.cw.libraries[0].name,'Updated');
  await record('a','a');await record('b','b');ctx.cfg={pageSize:1};
  ops['document-list'](ctx);assert.equal(ctx.cw.page.nextCursor,'1');assert.equal(ctx.cw.documents[0].text,undefined);
  ctx.cw.cursor='1';ops['document-list'](ctx);assert.equal(ctx.cw.documents[0].id,'b');
  ctx.cw.documentId='a';ctx.cw.patch={age:4};ops['document-patch'](ctx);assert.equal(ctx.cw.document.metadata.age,4);
  ctx.cw.metadata={status:'draft'};ops['document-replace-metadata'](ctx);
  assert.deepEqual(ctx.cw.document.metadata,{tenant_id:'alpha',status:'draft'});
  ctx.cw.patch={tenant_id:'other'};assert.throws(()=>ops['document-patch'](ctx),{code:'POLICY'});
  ctx.cfg={dryRun:true};ops['library-reset'](ctx);assert.equal(ctx.cw.operation.documents,2);
  ctx.cfg={};ctx.cw.confirm=true;assert.throws(()=>ops['library-reset'](ctx),{code:'POLICY'});
  ctx.library.options.allowDestructive=true;ops['library-reset'](ctx);ops['library-info'](ctx);assert.equal(ctx.cw.library.documents,0);
  assert.throws(()=>ops['library-delete'](ctx),{code:'POLICY'});
  ctx.cw.confirmLibraryId='guides';ops['library-delete'](ctx);assert.throws(()=>ops['library-info'](ctx),{code:'NOT_FOUND'});
  ops['library-create'](ctx);assert.equal(ctx.cw.library.documents,0);
});

test('context, chained reranking, formatting and evidence filtering',async t=>{
  const {ctx,record}=setup(t);
  const text='Read this. Reset password. Then log in.';
  await record('a',text,{},[{text:'Reset password.',locator:{charStart:11,charEnd:26}}]);
  await record('b','Log in.');ctx.cw.query='password';await ops.retrieve(ctx);
  ctx.cfg={contextMode:'sentences'};ops.context(ctx);assert.equal(ctx.cw.evidence[0].context.before.trim(),'Read this.');
  ctx.cfg={metadataFilter:"status='published'"};ops.filter(ctx);assert.equal(ctx.cw.evidence.length,2);
  ctx.rerank=async()=>[.9,.6];ctx.cfg={strategy:'chain',stages:[{strategy:'cross-encoder',cutoff:.5},{strategy:'mmr',limit:1},{strategy:'rule',field:'age'}]};
  await ops.rerank(ctx);assert.equal(ctx.cw.evidence.length,1);assert.ok('mmr' in ctx.cw.evidence[0].scores);
  for (const format of ['text','markdown','json']) {
    ctx.cfg={format};ops['format-evidence'](ctx);assert.ok(ctx.cw.promptEvidence.includes(ctx.cw.evidence[0].evidenceId));
  }
  ctx.cw.evidence[0].evidenceId='wrong';assert.throws(()=>ops.context(ctx),{code:'POLICY'});
});
