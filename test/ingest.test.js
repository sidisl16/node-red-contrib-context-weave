'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { operations } = require('../lib/ingest');

function context(payload, cfg = {}, nodes = {}) {
  const cw = {};
  const msg = { payload, contextWeave: cw };
  const ctx = { msg, cw, cfg, RED: { nodes: { getNode: id => nodes[id] } } };
  ctx.value = (key, fallback) => {
    if (!cfg[key]) return fallback;
    if (cfg[key + 'Type'] === 'msg') return cfg[key].split('.').reduce((v,k) => v?.[k], msg);
    return cfg[key];
  };
  return ctx;
}

test('external connector profile produces identical identities across replay, updates and deletes', async () => {
  const profile = { options: { sourceSystem: 'helpdesk', itemIdSource: 'payload.uid', itemIdSourceType: 'msg',
    contentSource: 'payload.body', contentSourceType: 'msg', contentKind: 'html',
    operation: 'payload.op', operationType: 'msg', uriSource: 'payload.link', uriSourceType: 'msg' } };
  const ctx = context({ uid: 42, op: 'upsert', body: '<h2>Rules</h2><script>hidden()</script><p>Cats &amp; dogs</p>',
    link: 'https://example.test/rules' }, { sourceProfile: 'sp' }, { sp:profile });
  operations['source-map'](ctx);
  const { documentId } = ctx.cw.source;
  assert.equal(ctx.cw.source.uri, ctx.msg.payload.link);
  await operations['parse-content'](ctx);
  assert.equal(ctx.cw.input.document.text, 'Rules Cats & dogs');
  assert.equal(ctx.cw.input.document.id, documentId);
  operations['record-ingest'](ctx);
  assert.equal(ctx.cw.input.document.uri, ctx.msg.payload.link);
  ctx.msg.payload.op = 'delete';
  assert.deepEqual(operations['source-map'](ctx), { port:2 });
  assert.equal(ctx.cw.source.content, undefined);
  assert.equal(ctx.cw.source.documentId, documentId);
  assert.equal(ctx.cw.source.deleteConfirmed, undefined);
});

test('records preserve validated sections, source metadata and ACL', async () => {
  const ctx = context({ id:'a', sections:[{id:'p1',text:'The facts', metadata:{page:1}}],
    acl:{allow:['team-a']}, metadata:{tags:['hello']} }, { sourceSystem:'test' });
  operations['source-map'](ctx);
  await operations['parse-content'](ctx);
  assert.deepEqual(ctx.cw.input.document.sections, ctx.msg.payload.sections);
  assert.deepEqual(ctx.cw.input.document.acl, { allow:['team-a'] });
  ctx.msg.payload.metadata.tags.push('later');
  assert.deepEqual(ctx.cw.input.document.metadata.tags, ['hello']);
});

test('mapped record properties are validated, including hostile metadata keys', () => {
  const ctx = context({ ticket:{key:'D42', summary:'Hello'} }, { documentSource:'payload',documentSourceType:'msg',idPath:'ticket.key',textPath:'ticket.summary' });
  operations['record-ingest'](ctx);
  assert.equal(ctx.cw.input.document.id, 'D42');
  ctx.msg.payload.metadata = JSON.parse('{"__proto__":"bad"}');
  assert.throws(() => operations['record-ingest'](ctx), /metadata field/);
  ctx.msg.payload = {};
  assert.throws(() => operations['record-ingest'](ctx), /document ID/);
});

test('parser enforces size, file format and UTF-8 limits, or routes to a custom branch', async () => {
  const ctx = context({}, { maxFileMb:1, parserRoute:'built-in' });
  const content = { kind:'file', filename:'x.txt', data: Buffer.alloc(1024*1024+1, 'x') };
  ctx.cw.source = { documentId:'a', content };
  await assert.rejects(operations['parse-content'](ctx), /size limit/);
  content.data = Buffer.from([255]);
  await assert.rejects(operations['parse-content'](ctx), /UTF-8/);
  content.filename = 'x.pdf';
  await assert.rejects(operations['parse-content'](ctx), /Unsupported/);
  ctx.cfg.parserRoute = 'custom';
  assert.deepEqual(await operations['parse-content'](ctx), {port:2});
});

test('file-ingest composes parsing, splitting and indexing and propagates index errors', async () => {
  const ctx = context({ data:Buffer.from('## Safety\nWear gloves.'), filename:'guide.md' });
  const visited = [];
  ctx.invoke = async (key, overrides) => {
    visited.push(key);
    if (key === 'split') await operations.split({...ctx,cfg:overrides});
  };
  await operations['file-ingest'](ctx);
  assert.deepEqual(visited,['split','index']);
  assert.equal(ctx.cw.job.chunks,1);
  assert.equal(ctx.cw.document.title,'guide.md');
  ctx.cw.job = undefined;
  ctx.invoke = async () => { throw new Error('write failed'); };
  await assert.rejects(operations['file-ingest'](ctx), /write failed/);
  assert.equal(ctx.cw.job,undefined);
});

test('remote extractor sends file bytes to configured service and caps extracted content', async t => {
  let received = '';
  t.mock.method(globalThis,'fetch',async (url,options) => {
    received = options.body.toString();
    assert.equal(url.pathname,'/tika');
    assert.equal(options.redirect,'error');
    return new Response(received === 'large' ? 'a'.repeat(1024*1024+1) : 'Page one');
  });
  const ctx = context({}, { extractor:'tika', maxFileMb:1 }, { tika:{options:{adapter:'tika',baseUrl:'http://127.0.0.1:9998'}} });
  ctx.cw.source = { documentId:'d', content:{ kind:'file', data:Buffer.from('pdf'), mimeType:'application/pdf' } };
  await operations['parse-content'](ctx);
  assert.equal(received, 'pdf');
  assert.equal(ctx.cw.input.document.text,'Page one');
  received = '';
  ctx.cw.source.content.data = 'large';
  await assert.rejects(operations['parse-content'](ctx), /size limit/);
});

test('chunking is deterministic, section-scoped and returns exact UTF-16 locators', async () => {
  const sections = [{id:'a',text:'one two. three four five six'},{id:'b',text:'💡 新しい文 today'}];
  const ctx = context({ id:'doc', sections }, {targetTokens:3,overlapTokens:1});
  await operations.split(ctx);
  const chunks = ctx.cw.input.chunks;
  assert.deepEqual(chunks.map(c=>c.text),['one two.','two. three four','four five six','💡 新しい文 today']);
  for (const chunk of chunks) {
    const loc = chunk.locator;
    assert.equal(chunk.text,sections.find(s=>s.id===loc.sectionId).text.slice(loc.charStart,loc.charEnd));
  }
  await operations.split(ctx);
  assert.deepEqual(ctx.cw.input.chunks,chunks);
  ctx.cfg.overlapTokens = 3;
  await assert.rejects(operations.split(ctx), /overlap/);
});

test('paragraph, heading and isolated regex splitters preserve source offsets', async () => {
  for (const [strategy,body] of [['paragraph','first\n\nsecond'],['markdown-headings','first\n# second'],
    ['custom-regex','first|second']]) {
    const ctx = context({id:'a',text:body},{strategy,customRegex:'\\|'});
    await operations.split(ctx);
    assert.equal(ctx.cw.input.chunks.length,2);
    const last = ctx.cw.input.chunks[1];
    assert.equal(last.text, body.slice(last.locator.charStart,last.locator.charEnd));
  }
  const ctx = context({id:'a',text:'abc'},{strategy:'custom-regex',customRegex:'['});
  await assert.rejects(operations.split(ctx),/Invalid delimiter/);
});
