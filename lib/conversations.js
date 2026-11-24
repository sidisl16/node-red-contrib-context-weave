'use strict';

const {randomUUID,createHash} = require('node:crypto');
const {mkdirSync} = require('node:fs');
const {join} = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {fail,integer} = require('./provider-client');
const connections = new WeakMap();

function identity(ctx) {
  const auth = ctx.msg.auth;
  const principal = auth?.principalId || auth?.sub || auth?.userId;
  if (typeof auth?.tenantId !== 'string' || !auth.tenantId || typeof principal !== 'string' || !principal) fail('AUTH','Conversation requires trusted tenant and principal');
  return JSON.stringify([auth.tenantId,principal]);
}
function connection(node) {
  if (connections.has(node)) return connections.get(node);
  const adapter = node.options.adapter || 'memory';
  let path;
  if (['memory','in-memory'].includes(adapter)) path = ':memory:';
  else if (adapter === 'sqlite') {
    mkdirSync(node.storeDir,{recursive:true,mode:0o700});
    const id = createHash('sha256').update(node.id).digest('hex');
    path = join(node.storeDir,'sessions-' + id + '.sqlite');
  } else fail('VALIDATION','Choose SQLite or in-memory conversation storage');
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS expiry ON sessions(expires)');
  } catch (err) { db.close(); throw err; }
  connections.set(node,db);
  node.on?.('close',() => {connections.delete(node); db.close();});
  return db;
}
function transaction(ctx, action) {
  const owner = identity(ctx);
  const node = ctx.RED.nodes.getNode(ctx.cfg.store);
  if (!node?.options) fail('VALIDATION','Select a conversation store');
  const {ttlSeconds,maxTurns,maxChars} = node.options;
  const ttl = integer(ttlSeconds,3600,31536000)*1000;
  const turns = integer(maxTurns,20,10000), chars = integer(maxChars,24000,2000000);
  const id = ctx.value('idSource',ctx.cw.conversation?.id) || (action === 'open' ? randomUUID() : null);
  if (typeof id !== 'string' || !id || id.length > 256) fail('VALIDATION','A conversation ID is required');
  const db = connection(node);
  const now = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM sessions WHERE expires<=?').run(now);
    const row = db.prepare('SELECT data FROM sessions WHERE id=? AND owner=?').get(id,owner);
    if (!row && (action !== 'open' || db.prepare('SELECT 1 FROM sessions WHERE id=?').get(id))) fail('NOT_FOUND','Conversation unavailable');
    const data = row ? JSON.parse(row.data) : {id,history:[],metadata:ctx.cw.conversation?.metadata || {}};
    if (ctx.cw.localOnly === true) data.localOnly = true;
    if (data.localOnly === true) ctx.cw.localOnly = true;
    if (JSON.stringify(data.metadata).length > 4096) fail('VALIDATION','Conversation metadata exceeds limit');
    if (action === 'delete') {
      if (ctx.value('confirmSource',ctx.cw.confirm) !== true) fail('POLICY','Confirmation required');
      if (!ctx.cfg.dryRun) db.prepare('DELETE FROM sessions WHERE id=? AND owner=?').run(id,owner);
      ctx.cw.operation = {id,deleted:!ctx.cfg.dryRun};
    } else {
      if (action === 'turn') {
        const role = ctx.cfg.role || 'user';
        if (!['user','assistant'].includes(role)) fail('VALIDATION','Invalid turn role');
        const text = ctx.value('textSource',role === 'assistant' ? ctx.cw.answer?.text : ctx.msg.payload);
        if (role === 'assistant' && (typeof ctx.cw.answer?.text !== 'string' || ctx.cw.answer.text !== text || !ctx.cw.answer.validated)) fail('POLICY','A validated answer is required for assistant turns');
        if (typeof text !== 'string' || !text.trim() || text.length > chars) fail('VALIDATION','Turn text outside configured budget');
        data.history.push({role,content:text});
        let size = data.history.reduce((count,m)=>count+m.content.length,0);
        while (data.history.length > turns || size > chars) size -= data.history.shift().content.length;
      }
      db.prepare('INSERT INTO sessions(id,owner,expires,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET expires=excluded.expires,data=excluded.data').run(id,owner,now+ttl,JSON.stringify(data));
      ctx.cw.conversation = data;
    }
    db.exec('COMMIT');
  } catch (err) {db.exec('ROLLBACK'); throw err;}
}
const operations = Object.fromEntries(['open','read','turn','delete'].map(action => ['conversation-'+action,ctx=>transaction(ctx,action)]));
module.exports = {identity,operations};
