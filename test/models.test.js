'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {mkdtempSync,rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {operations,embed,rerank} = require('../lib/models');

function fixture(adapter='ollama', purpose='generation') {
  const provider = {options:{adapter,baseUrl:'http://127.0.0.1:8765'},credentials:{apiKey:'test-only'}};
  const profile = {options:{purpose,provider:'connection',model:'demo'}};
  const store = Object.assign(new EventEmitter(),{id:'store',options:{adapter:'memory',maxTurns:2,maxChars:80}});
  const configNodes = {profile,connection:provider,store};
  const events = [], requests = [];
  const ctx = {
    RED:{nodes:{getNode:id=>configNodes[id]}},cfg:{generationProfile:'profile',store:'store'},cw:{},msg:{auth:{tenantId:'team',sub:'a'}},
    value:(key,fallback)=>fallback, emit:event=>events.push(event),
    fetch:async (url,opts)=>{
      requests.push({url,body:JSON.parse(opts.body),headers:opts.headers});
      const body = ctx.reply(requests.at(-1));
      return body instanceof Response ? body : Response.json(body);
    },
    reply:()=>({message:{content:'A valid answer [E:a].'}})
  };
  return {ctx,profile,provider,store,events,requests};
}
const item = {evidenceId:'a',documentId:'doc',text:'Reset links expire in 30 minutes.',document:{uri:'https://example.org/help'}};
test('grounded answer enforces markers and cite can render a validated answer again',async()=>{
  const {ctx,requests} = fixture();
  ctx.cw.query = 'How long?'; ctx.cw.evidence = [item];
  await operations.answer(ctx);
  assert.equal(ctx.cw.answer.citations[0].documentId,'doc');
  assert.equal(ctx.cw.answer.text,'A valid answer [1].');
  assert.match(requests[0].url,/\/api\/chat$/);
  ctx.cfg.citationFormat = 'markdown';
  operations.cite(ctx);
  assert.match(ctx.cw.answer.text,/\[1\]\(https:\/\/example.org\/help\)/);
  ctx.reply = ()=>({message:{content:'Invented [E:unknown]'}});
  await assert.rejects(operations.answer(ctx),{code:'CITATION_VALIDATION'});
  ctx.cw.evidence = [];
  await operations.answer(ctx);
  assert.equal(ctx.cw.answer.grounded,false);
  assert.equal(requests.length,2);
});
for (const [adapter,path,result] of [
  ['anthropic','/messages',{content:[{type:'text',text:'hello'}]}],
  ['google-gemini','/models/demo:generateContent',{candidates:[{content:{parts:[{text:'hello'}]}}]}],
  ['openai','/chat/completions',{choices:[{message:{content:'hello'}}]}],
  ['openai-compatible','/chat/completions',{choices:[{message:{content:'hello'}}]}]
]) test(adapter+' generation encodes a request and decodes final text',async()=>{
  const {ctx,requests} = fixture(adapter); ctx.msg.payload = 'hi'; ctx.reply=()=>result;
  await operations.generate(ctx);
  assert.equal(ctx.cw.generation.text,'hello');
  assert.equal(ctx.cw.generation.grounded,false);
  assert.ok(requests[0].url.endsWith(path));
});
test('model service errors are redacted and privacy fails closed',async()=>{
  const {ctx,provider,profile,requests} = fixture('openai'); ctx.msg.payload = 'hi';
  ctx.reply=()=>new Response('private document contents',{status:429});
  await assert.rejects(operations.generate(ctx),{code:'RATE_LIMITED',message:'Model service returned HTTP 429'});
  provider.options.baseUrl = 'https://api.example.org/v1'; profile.options.privacy='local-only';
  await assert.rejects(operations.generate(ctx),{code:'POLICY'}); assert.equal(requests.length,1);
});
test('stream decoder uses provider chunk boundaries and requires completion',async()=>{
  const {ctx,events} = fixture();ctx.cfg.streamMode='events';ctx.msg.payload='Hi';
  ctx.reply=()=>new Response('{"message":{"content":"hel"},"done":false}\n{"message":{"content":"lo"},"done":true}\n');
  await operations.generate(ctx);assert.equal(ctx.cw.generation.text,'hello');
  assert.deepEqual(events.map(event=>event.text),['hel','lo']);
  ctx.reply=()=>new Response('{"message":{"content":"partial"}}');
  await assert.rejects(operations.generate(ctx),{code:'UPSTREAM'});
});
for (const [adapter,result] of [
  ['ollama',{embeddings:[[1,2],[3,4]]}],
  ['openai',{data:[{index:1,embedding:[3,4]},{index:0,embedding:[1,2]}]}],
  ['google-gemini',{embeddings:[{values:[1,2]},{values:[3,4]}]}],
  ['huggingface-tei',[[1,2],[3,4]]]
]) test(adapter+' embeddings preserve input order',async()=>{
  const {ctx} = fixture(adapter,'embedding'); ctx.reply=()=>result;
  assert.deepEqual(await embed(ctx,['a','b'],'profile'),[[1,2],[3,4]]);
});
test('ragged embedding and duplicated reranker indices rejected',async()=>{
  const {ctx,profile,provider} = fixture('ollama','embedding');
  ctx.reply=()=>({embeddings:[[1,2],[3]]});
  await assert.rejects(embed(ctx,['a','b'],'profile'),{code:'UPSTREAM'});
  profile.options.purpose='reranking';provider.options.adapter='cross-encoder';
  ctx.reply=()=>[{index:1,score:2},{index:0,score:3}];
  assert.deepEqual(await rerank(ctx,'query',['a','b'],'profile'),[3,2]);
  ctx.reply=()=>[{index:0,score:1},{index:0,score:3}];
  await assert.rejects(rerank(ctx,'query',['a','b'],'profile'),{code:'UPSTREAM'});
});
test('document summarize delegates ID security lookup and fact-check validates verdict',async()=>{
  const {ctx}=fixture();ctx.cw.documentId='a';ctx.invoke=async name=>{assert.equal(name,'document-get');ctx.cw.document={id:'a',text:'policy.'};};
  await operations['document-summarize'](ctx); assert.equal(ctx.cw.summary.documentId,'a');
  ctx.cw.answer={text:'policy'};ctx.cw.evidence=[item];ctx.reply=()=>({message:{content:'{"assessment":"supported","reason":"present"}'}});
  await operations['fact-check'](ctx);assert.equal(ctx.cw.factCheck.assessment,'supported');
});
for (const adapter of ['memory','sqlite']) test(adapter+' conversation lifecycle bounds history, expiry and principal isolation',t=>{
  const {ctx,store}=fixture();store.options.adapter=adapter;store.storeDir=mkdtempSync(join(tmpdir(),'cw-models-'));
  t.after(()=>{store.emit('close');rmSync(store.storeDir,{recursive:true,force:true});});
  operations['conversation-open'](ctx);
  for (const text of ['first','second','third']) {ctx.msg.payload=text;operations['conversation-turn'](ctx);}
  operations['conversation-read'](ctx);assert.deepEqual(ctx.cw.conversation.history.map(t=>t.content),['second','third']);
  ctx.msg.auth.sub='b';assert.throws(()=>operations['conversation-read'](ctx),{code:'NOT_FOUND'});ctx.msg.auth.sub='a';
  assert.throws(()=>operations['conversation-delete'](ctx),{code:'POLICY'});ctx.cw.confirm=true;
  operations['conversation-delete'](ctx);assert.throws(()=>operations['conversation-read'](ctx),{code:'NOT_FOUND'});
});
test('tool dispatch validates the identity-bound response before resuming',async t=>{
  const {ctx,store,requests}=fixture();t.after(()=>store.emit('close'));
  ctx.msg.payload='Lookup';ctx.cfg.tools=[{name:'lookup',kind:'branch',inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id']},outputSchema:{type:'string'}}];
  ctx.reply=()=>({message:{content:requests.length===1?'{"tool":"lookup","input":{"id":"7"}}':'{"answer":"Ticket is open"}'}});
  ctx.emit=event=>{
    const responder={...ctx,cfg:{toolId:'lookup'},cw:{event},msg:{...ctx.msg,payload:'open'}};
    assert.throws(()=>operations['agent-tool']({...responder,msg:{auth:{tenantId:'other',sub:'a'}}}),{code:'POLICY'});
    operations['agent-tool'](responder);
    assert.throws(()=>operations['agent-tool'](responder),{code:'POLICY'});
  };
  await operations['agent-run'](ctx);
  assert.equal(ctx.cw.answer.text,'Ticket is open');assert.equal(ctx.cw.conversation.history.length,2);
});
test('agent rejects disallowed tool',async t=>{
  const {ctx,store}=fixture();t.after(()=>store.emit('close'));ctx.msg.payload='Hi';ctx.reply=()=>({message:{content:'{"tool":"unknown","input":{}}'}});
  await assert.rejects(operations['agent-run'](ctx),{code:'POLICY'});
});
