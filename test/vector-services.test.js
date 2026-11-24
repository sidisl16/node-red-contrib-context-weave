'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const ops=require('../lib/knowledge');
const {backend}=require('../lib/vector-backend');
const {scope}=require('../lib/knowledge-store');

for(const adapter of ['qdrant','chroma','pgvector']) {
  test(adapter+' persists, ranks, filters, replaces and removes vectors',{skip:!process.env.CW_TEST_VECTOR_SERVICES},async t=>{
    const urls={qdrant:'http://127.0.0.1:6333',chroma:'http://127.0.0.1:8000',pgvector:'postgresql://postgres@127.0.0.1:5432/postgres'};
    const provider={options:{adapter,baseUrl:urls[adapter]},credentials:{apiKey:adapter==='pgvector'?process.env.PGPASSWORD:''}};
    const id=randomUUID(), storeDir=fs.mkdtempSync(path.join(os.tmpdir(),'cw-vector-'));
    t.after(()=>fs.rmSync(storeDir,{recursive:true,force:true}));
    const ctx={library:{id,storeDir,options:{libraryId:id,vectorProvider:'vectors',embeddingProfile:'embed',allowDestructive:true,
      filterAttributes:[{name:'category',type:'string'}]}},cfg:{mode:'dense'},cw:{query:'apple'},msg:{auth:{tenantId:'test'}},
      value:(_,fallback)=>fallback,RED:{nodes:{getNode:id=>id==='vectors'?provider:null}},embed:async texts=>texts.map(s=>s==='apple'?[1,0]:[0,1])};
    async function write(id,text,category) {
      ctx.cw.input={document:{id,text,metadata:{tenant_id:'test',category}},chunks:[{text}]};
      await ops.index(ctx);
    }
    await write('a','apple','public'); await write('b','pear','other');
    await ops.retrieve(ctx); assert.equal(ctx.cw.evidence[0].documentId,'a');
    ctx.cfg.metadataFilter="category='other'";await ops.retrieve(ctx);assert.deepEqual(ctx.cw.evidence.map(e=>e.documentId),['b']);
    ctx.cfg.metadataFilter='';await write('a','pear','public');await ops.retrieve(ctx);
    assert.ok(ctx.cw.evidence.every(e=>Math.abs(e.scores.dense)<0.001));
    ctx.cw.confirm=true;ctx.cw.documentId='a';await ops['document-delete'](ctx);
    await ops.retrieve(ctx);assert.deepEqual(ctx.cw.evidence.map(e=>e.documentId),['b']);
    await ops['library-reset'](ctx);
    const remaining=await backend(ctx,scope(ctx)).operate('search',2,[{seq:1},{seq:2},{seq:3}],[1,0],3);
    assert.deepEqual(remaining,[]);
  });
}
