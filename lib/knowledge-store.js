'use strict';
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const { mkdirSync, openSync, closeSync } = require('node:fs');
const path = require('node:path');
const { invalid, matchesType } = require('./knowledge-filter');

const hash = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
function fail(code, message) { throw Object.assign(new Error(message), {code}); }
function string(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) invalid('Invalid ' + label);
  return value;
}
function integer(value, min, max) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) invalid('Count outside supported range');
  return n;
}
function scope(ctx, lib = ctx.library) {
  if (!lib?.options || !lib.storeDir) invalid('Select a library configuration');
  const o = lib.options;
  const id = string(o.libraryId || lib.id, 'library id');
  const policy = o.accessPolicy || {mode:'none'};
  let tenant = '';
  if (policy.mode === 'tenant-field') {
    const claim = (policy.claimProperty || 'auth.tenantId').replace(/^msg\./, '');
    if (!/^auth\.\w+$/.test(claim)) fail('POLICY','Invalid trusted tenant claim configuration');
    const value = ctx.msg.auth?.[claim.slice(5)];
    if (typeof value !== 'string' || !value || value.length > 512) fail('POLICY', 'Trusted tenant identity required');
    tenant = value;
  } else if (policy.mode !== 'none') fail('POLICY','Unsupported library access policy');
  return {lib, id, tenant, policy, o, file:path.join(lib.storeDir, hash(id,tenant) + '.sqlite')};
}
function withStore(s, fn, {allowDeleted = false} = {}) {
  mkdirSync(s.lib.storeDir, {recursive:true, mode:0o700});
  closeSync(openSync(s.file, 'a', 0o600));
  const db = new DatabaseSync(s.file);
  try {
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY,v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS docs(id TEXT PRIMARY KEY,body TEXT NOT NULL,digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks(seq INTEGER PRIMARY KEY,doc TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
        ord INTEGER NOT NULL,chunk TEXT NOT NULL,vector TEXT NOT NULL,UNIQUE(doc,ord));
      CREATE VIRTUAL TABLE IF NOT EXISTS terms USING fts5(text);
      CREATE TRIGGER IF NOT EXISTS delterms AFTER DELETE ON chunks BEGIN DELETE FROM terms WHERE rowid=OLD.seq; END;
      CREATE TABLE IF NOT EXISTS history(n INTEGER PRIMARY KEY,req TEXT,at TEXT,hits INTEGER);`);
    if (!allowDeleted && setting(db,'deleted',false)) fail('NOT_FOUND','Library was deleted');
    return fn(db);
  } finally { db.close(); }
}
function setting(db,k,fallback) {
  const row = db.prepare('SELECT v FROM settings WHERE k=?').get(k);
  return row ? JSON.parse(row.v) : fallback;
}
function put(db,k,v) { db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(k,JSON.stringify(v)); }
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (err) { db.exec('ROLLBACK'); throw err; }
}
function attributes(db,s) { return setting(db,'attributes', s.o.filterAttributes || []); }
function validateMetadata(s, attrs, metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) invalid('Expected a metadata object');
  const key = s.policy.metadataField || 'tenant_id';
  if (s.tenant && metadata[key] !== s.tenant) fail('POLICY','Document tenant does not match trusted identity');
  for (const a of attrs) {
    if (!(Object.hasOwn(metadata,a.name))) {
      if (a.required) invalid('Missing required metadata field ' + a.name);
    } else if (!matchesType(metadata[a.name],a.type)) invalid('Invalid metadata type for ' + a.name);
  }
}
function profileKey(ctx,s) {
  const ref = s.o.embeddingProfile;
  const p = ctx.RED?.nodes?.getNode?.(ref)?.options || {};
  const provider = ctx.RED?.nodes?.getNode?.(p.provider)?.options || {};
  return hash(ref, p.model, p.revision, p.dimensions, p.normalization, provider.adapter, provider.baseUrl);
}
function dimension(v) {
  if (!Array.isArray(v) || !v.length || v.length > 65536 || !v.every(Number.isFinite) || !v.some(x=>x!==0)) {
    fail('UPSTREAM','Provider returned an invalid embedding');
  }
  return v.length;
}
function checkSpace(db, space, dims) {
  const previous = setting(db,'space',null);
  if (previous && (previous.key !== space || previous.dims !== dims)) fail('CONFLICT','Embedding profile or dimensions changed; rebuild the library');
}
async function index(ctx) {
  const s = scope(ctx);
  const doc = ctx.value('documentSource',ctx.cw.input?.document);
  string(doc?.id,'document id');
  if (doc.acl != null) fail('POLICY','Document ACLs require a supported policy adapter');
  const chunks = ctx.value('chunksSource',ctx.cw.input?.chunks) || [{text:doc.text}];
  if (!Array.isArray(chunks) || chunks.length < 1 || chunks.length > 4096) invalid('Provide 1–4096 chunks');
  const rows = chunks.map((c, i) => {
    if (typeof c?.text !== 'string' || !c.text.trim()) invalid('Chunks require text');
    return {text:c.text, chunkId:c.chunkId || c.id || hash(doc.id,i,c.text), metadata:c.metadata || {}, locator:c.locator || {}};
  });
  if (new Set(rows.map(r=>r.chunkId)).size !== rows.length) invalid('Duplicate chunk ID');
  const encoded = JSON.stringify(doc);
  if (encoded.length + JSON.stringify(rows).length > 20_000_000) invalid('Document exceeds the indexing budget');
  const key = profileKey(ctx,s);
  const digest = hash(doc, rows, key);
  const inspect = db => {
    validateMetadata(s,attributes(db,s),doc.metadata || {});
    const prior = db.prepare('SELECT digest FROM docs WHERE id=?').get(doc.id);
    if (prior && ctx.cfg.mode === 'create-only') fail('CONFLICT','Document already exists');
    if (prior?.digest === digest) {
      ctx.cw.index = {documentId:doc.id,chunksCreated:0,chunksDeleted:0,chunksUpdated:0,unchanged:true};
      return true;
    }
    return false;
  };
  if (withStore(s,inspect)) return;
  const vectors = [];
  for (let at=0;at<rows.length;at+=32) {
    const texts = rows.slice(at,at+32).map(r=>r.text);
    const batch = await ctx.embed(texts,s.o.embeddingProfile);
    if (!Array.isArray(batch) || batch.length !== texts.length) fail('UPSTREAM','Incorrect embedding count');
    vectors.push(...batch);
  }
  const dims = dimension(vectors[0]);
  if (vectors.some(v=>dimension(v)!==dims)) fail('UPSTREAM','Inconsistent embedding dimensions');
  withStore(s,db=>tx(db,()=>{
    if (inspect(db)) return;
    checkSpace(db,key,dims);
    const old = new Set(db.prepare('SELECT json_extract(chunk,\'$.chunkId\') id FROM chunks WHERE doc=?').all(doc.id).map(r=>r.id));
    put(db,'space',{key,dims});
    db.prepare('DELETE FROM docs WHERE id=?').run(doc.id);
    db.prepare('INSERT INTO docs VALUES(?,?,?)').run(doc.id,encoded,digest);
    const insert = db.prepare('INSERT INTO chunks(doc,ord,chunk,vector) VALUES(?,?,?,?)');
    const term = db.prepare('INSERT INTO terms(rowid,text) VALUES(?,?)');
    let updated=0;
    rows.forEach((r,i)=>{
      const {lastInsertRowid} = insert.run(doc.id,i,JSON.stringify(r),JSON.stringify(vectors[i]));
      term.run(lastInsertRowid,r.text);
      if (old.delete(r.chunkId)) updated++;
    });
    ctx.cw.index = {documentId:doc.id,chunksCreated:rows.length-updated,chunksUpdated:updated,chunksDeleted:old.size};
  }));
}
module.exports = { scope,withStore,setting,put,attributes,tx,validateMetadata,profileKey,checkSpace,dimension,index,fail,string,hash,integer };
