'use strict';

const { createHash } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const path = require('node:path');

const MiB = 1024 * 1024;
const maxDocumentBytes = 32 * MiB;
const unsafeKeys = new Set(['constructor', 'prototype', '__proto__']);

function fail(message, code = 'VALIDATION') {
  throw Object.assign(new Error(message), { code });
}

function hash(data) { return createHash('sha256').update(data).digest('hex'); }
function object(value) {
  return value !== null && typeof value === 'object' &&
    [null, Object.prototype].includes(Object.getPrototypeOf(value));
}
function string(value, name, max = 2048) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('Invalid ' + name);
  return value;
}
function integer(value, min, max, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) fail('Invalid ' + name);
  return n;
}
function lookup(obj, prop) {
  if (!prop) return undefined;
  for (const key of prop.split('.')) {
    if (unsafeKeys.has(key) || obj == null || !Object.hasOwn(obj, key)) return undefined;
    obj = obj[key];
  }
  return obj;
}
function mapped(ctx, prop, fallback) {
  return ctx.cfg[prop] === '' || ctx.cfg[prop] == null ? fallback : ctx.value(prop, fallback);
}
function metadata(value = {}) {
  if (!object(value) || Object.keys(value).length > 256) fail('Invalid metadata');
  const result = {};
  let bytes = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (!key || key.length > 128 || unsafeKeys.has(key)) fail('Invalid metadata field');
    const values = Array.isArray(entry) ? entry : [entry];
    if (values.length > 512 || !values.every(v => v === null || typeof v === 'boolean' ||
      Number.isFinite(v) || (typeof v === 'string' && v.length <= 8192))) fail('Invalid metadata value');
    bytes += Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(entry));
    if (bytes > MiB) fail('Metadata exceeds size limit');
    result[key] = Array.isArray(entry) ? [...entry] : entry;
  }
  return result;
}
function normalize(raw) {
  if (!object(raw)) fail('Expected a document object');
  const doc = { id: string(raw.id, 'document ID'), metadata: metadata(raw.metadata) };
  if (raw.title != null) doc.title = string(raw.title, 'title', 8192);
  if (raw.uri != null) doc.uri = string(raw.uri, 'source URI', 8192);
  if (raw.acl !== undefined) {
    if (!object(raw.acl) || Object.keys(raw.acl).some(k => !['allow','deny'].includes(k))) fail('Invalid ACL');
    doc.acl = {};
    for (const key of Object.keys(raw.acl)) {
      if (!Array.isArray(raw.acl[key]) || raw.acl[key].length > 1024) fail('Invalid ACL');
      doc.acl[key] = raw.acl[key].map(v => string(v, 'principal'));
    }
  }
  let bytes = 0;
  const text = value => {
    string(value, 'document text', maxDocumentBytes);
    bytes += Buffer.byteLength(value);
    if (bytes > maxDocumentBytes) fail('Document exceeds size limit');
    return value;
  };
  if (raw.text != null && raw.text !== '') doc.text = text(raw.text);
  if (raw.sections !== undefined) {
    if (!Array.isArray(raw.sections) || raw.sections.length > 10000) fail('Invalid sections');
    const ids = new Set();
    doc.sections = raw.sections.map((s, i) => {
      if (!object(s)) fail('Invalid section');
      const id = string(s.id ?? String(i), 'section ID');
      if (ids.has(id)) fail('Duplicate section ID');
      ids.add(id);
      const section = { id, text: text(s.text), metadata: metadata(s.metadata) };
      bytes += Buffer.byteLength(JSON.stringify(section.metadata));
      if (bytes > maxDocumentBytes) fail('Document exceeds size limit');
      if (s.title != null) section.title = string(s.title, 'section title', 8192);
      return section;
    });
  }
  if (!doc.text && !doc.sections?.length) fail('Document needs text or sections');
  return doc;
}

function input(ctx, key, value, defaultPath) {
  ctx.cw.input ??= {};
  ctx.cw.input[key] = value;
  const target = ctx.cfg.outputProperty;
  if (target && target !== defaultPath) {
    if (!/^[a-zA-Z_]\w*(\.[a-zA-Z_]\w*)*$/.test(target) ||
      target.split('.').some(k => unsafeKeys.has(k)) || /^(auth|req|res|_msgid)(\.|$)/.test(target)) fail('Invalid output path');
    ctx.RED.util.setMessageProperty(ctx.msg, target, value, true);
  }
}

function sourceMap(ctx) {
  const profile = ctx.cfg.sourceProfile && ctx.RED.nodes.getNode(ctx.cfg.sourceProfile);
  if (ctx.cfg.sourceProfile && !profile) fail('Missing source profile');
  const p = profile?.options || {};
  const field = (key, fallback) => {
    if (ctx.cfg[key] !== '' && ctx.cfg[key] != null) return ctx.value(key, fallback);
    if (!p[key]) return fallback;
    if (p[key + 'Type'] === 'msg' || (key.endsWith('Source') && !p[key + 'Type'])) return lookup(ctx.msg, p[key]);
    return p[key];
  };
  const system = string(field('sourceSystem'), 'source system');
  const rawId = field('itemIdSource', ctx.msg.payload?.id);
  const itemId = string(Number.isSafeInteger(rawId) ? String(rawId) : rawId, 'source item ID');
  const operation = field('operation', 'upsert');
  if (!['upsert','delete'].includes(operation)) fail('Unknown source operation');
  const source = { system, itemId, documentId: hash(JSON.stringify([system,itemId])), operation,
    metadata: metadata(field('metadataSource', ctx.msg.payload?.metadata)) };
  for (const key of ['uri','title','modifiedAt','checkpoint']) {
    const val = field(key + 'Source', undefined);
    if (val != null) source[key] = string(String(val), key, 8192);
  }
  if (operation === 'upsert') {
    const data = field('contentSource', ctx.msg.payload);
    let kind = ctx.cfg.contentKind && ctx.cfg.contentKind !== 'auto' ? ctx.cfg.contentKind : p.contentKind;
    if (!kind || kind === 'auto') kind = Buffer.isBuffer(data) ? 'file' : object(data) ? 'record' : 'text';
    if (!['file','record','text','html','markdown'].includes(kind)) fail('Unknown content kind');
    source.content = { kind, data, filename: field('filenameSource'), mimeType: field('mimeTypeSource') };
  }
  ctx.cw.source = source;
  return operation === 'delete' ? { port: 2 } : undefined;
}

function stripHtml(html) {
  // Strip markup into plain searchable text. This output is never HTML for rendering.
  const lower = html.toLowerCase();
  const result = [];
  let i = 0;
  while (i < html.length) {
    const start = html.indexOf('<', i);
    if (start < 0) { result.push(html.slice(i)); break; }
    result.push(html.slice(i, start));
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const end = html.indexOf('>', start + 1);
    if (end < 0) { result.push(html.slice(start)); break; }
    const tag = /^<\s*(script|style)\b/i.exec(html.slice(start, Math.min(end + 1, start + 100)));
    if (tag) {
      const close = lower.indexOf('</' + tag[1].toLowerCase() + '>', end + 1);
      i = close < 0 ? html.length : close + tag[1].length + 3;
    } else { i = end + 1; }
    result.push(' ');
  }
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return result.join('').replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, k) => entities[k]).replace(/\s+/g, ' ').trim();
}

async function extractRemote(ctx, content, bytes, limit) {
  const id = ctx.cfg.extractor || ctx.library?.options?.extractor;
  const provider = id && ctx.RED.nodes.getNode(id);
  if (!provider?.options?.baseUrl) fail('Configure an extraction provider or wire a custom parser', 'EXTRACTION');
  // Only the deployment configuration selects the destination. Redirects are disabled.
  const url = new URL(provider.options.baseUrl);
  if (url.username || url.password || url.search || url.hash ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) {
    fail('Extractor requires HTTPS or local loopback HTTP');
  }
  if (ctx.library?.options?.privacy === 'local-only' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) {
    fail('Library policy requires local extraction', 'POLICY');
  }
  url.pathname = url.pathname.replace(/\/$/, '') + '/tika';
  const headers = { accept: 'text/plain', 'content-type': content.mimeType || 'application/octet-stream' };
  if (provider.credentials?.apiKey) headers.authorization = 'Bearer ' + provider.credentials.apiKey;
  const timeout = AbortSignal.timeout(1000 * integer(ctx.cfg.timeoutSeconds || 60, 1, 300, 'timeout'));
  const response = await fetch(url, { method: 'PUT', headers, body: bytes, redirect: 'error',
    signal: ctx.signal ? AbortSignal.any([timeout, ctx.signal]) : timeout });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    fail('Extraction service rejected the document', 'EXTRACTION');
  }
  const buffers = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > limit) fail('Extracted text exceeds size limit', 'EXTRACTION');
    buffers.push(part);
  }
  return Buffer.concat(buffers).toString('utf8');
}

async function parseContent(ctx) {
  const source = mapped(ctx, 'sourceEnvelope', ctx.cw.source);
  if (!source?.content || source.operation === 'delete') fail('Missing source content');
  const route = ctx.cfg.parserRoute || 'auto';
  if (!['auto','built-in','remote','custom'].includes(route)) fail('Unknown parser route');
  if (route === 'custom') return { port: 2 };
  const id = string(source.documentId, 'document ID');
  const { content } = source;
  const limit = integer(ctx.cfg.maxFileMb || 10, 1, 32, 'file size') * MiB;
  let document;
  let parser = 'record';
  if (content.kind === 'record') {
    if (!object(content.data)) fail('Expected a structured record');
    document = normalize({ ...content.data, id, title: source.title ?? content.data.title,
      uri: source.uri ?? content.data.uri, metadata: { ...metadata(content.data.metadata), ...metadata(source.metadata) } });
    if (Buffer.byteLength(JSON.stringify(document)) > limit) fail('Record exceeds size limit');
  } else {
    if (!(Buffer.isBuffer(content.data) || typeof content.data === 'string')) fail('Expected a Buffer or text');
    if (Buffer.byteLength(content.data) > limit) fail('File exceeds size limit');
    const bytes = Buffer.isBuffer(content.data) ? content.data : Buffer.from(content.data);
    const mime = String(content.mimeType || '').split(';')[0].trim().toLowerCase();
    const ext = path.extname(String(content.filename || '')).toLowerCase();
    const html = content.kind === 'html' || mime === 'text/html' || (!mime && ['.htm','.html'].includes(ext));
    const plain = ['text','markdown'].includes(content.kind) || mime.startsWith('text/') || (!mime && ['.md','.txt','.csv'].includes(ext));
    let body;
    if (route === 'remote' || (!html && !plain && route === 'auto')) {
      body = await extractRemote(ctx, content, bytes, limit);
      parser = 'tika-text';
    } else {
      if (!html && !plain) fail('Unsupported built-in file format', 'EXTRACTION');
      try { body = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { fail('Text must be valid UTF-8', 'EXTRACTION'); }
      if (body.includes('\u0000')) fail('Binary content requires an extraction provider', 'EXTRACTION');
      if (html) body = stripHtml(body);
      parser = html ? 'html-text' : 'utf8-text';
    }
    document = normalize({ id, text: body, uri: source.uri, title: source.title || content.filename, metadata: source.metadata });
  }
  input(ctx, 'document', document, 'contextWeave.input.document');
  ctx.cw.parse = { parser, version: 1, contentHash: hash(JSON.stringify(document)), parsedAt: new Date().toISOString() };
}

function recordIngest(ctx) {
  const raw = mapped(ctx, 'documentSource', ctx.cw.input?.document ?? ctx.msg.payload);
  if (!object(raw)) fail('Expected a record');
  const doc = normalize({ ...raw, id: lookup(raw, ctx.cfg.idPath || 'id'), title: lookup(raw, ctx.cfg.titlePath || 'title'),
    text: lookup(raw, ctx.cfg.textPath || 'text'), metadata: lookup(raw, ctx.cfg.metadataPath || 'metadata') });
  input(ctx, 'document', doc, 'contextWeave.input.document');
}

async function fileIngest(ctx) {
  const raw = mapped(ctx, 'fileSource', ctx.msg.payload);
  const file = object(raw) ? raw : { data: raw };
  if (!Buffer.isBuffer(file.data) && typeof file.data !== 'string') fail('Expected file bytes or text');
  if (Buffer.byteLength(file.data) > integer(ctx.cfg.maxFileMb || 10, 1, 32, 'file size') * MiB) fail('File exceeds size limit');
  const id = mapped(ctx, 'documentIdSource', file.id ?? hash(file.data));
  ctx.cw.source = { system: 'file', itemId: id, documentId: id, operation: 'upsert',
    metadata: metadata(mapped(ctx, 'metadataSource', file.metadata)), content: {
      data: file.data, kind: 'file', filename: mapped(ctx, 'filenameSource', file.filename ?? ctx.msg.filename),
      mimeType: mapped(ctx, 'mimeTypeSource', file.mimeType ?? (typeof file.data === 'string' ? 'text/plain' : undefined)) } };
  if (ctx.cfg.parserRoute === 'custom') fail('Wire source-map to a custom parser branch for this file');
  await parseContent(ctx);
  await ctx.invoke('split', { ...(ctx.library?.options?.chunking || {}), outputProperty: 'contextWeave.input.chunks' });
  await ctx.invoke('index', { library: ctx.cfg.library });
  ctx.cw.document = ctx.cw.input.document;
  ctx.cw.job = { documentId: id, status: 'indexed', chunks: ctx.cw.input.chunks.length };
}

// Custom regexes run off the event loop with a deadline and a bounded result.
async function regexBoundaries(text, pattern, signal) {
  string(pattern, 'delimiter pattern', 256);
  signal?.throwIfAborted();
  const worker = new Worker(require.resolve('./regex-worker'), { workerData: { text, pattern },
    resourceLimits: { maxOldGenerationSizeMb: 64 } });
  return new Promise((resolve, reject) => {
    const stop = () => finish(new Error('Custom delimiter cancelled'));
    const timer = setTimeout(() => finish(new Error('Custom delimiter exceeded time limit')), 1000);
    function finish(err, value) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      worker.removeListener('exit', onExit);
      void worker.terminate();
      if (err) reject(err); else resolve(value);
    }
    function onExit() { finish(new Error('Custom delimiter stopped unexpectedly')); }
    signal?.addEventListener('abort', stop, { once:true });
    worker.once('error', finish);
    worker.once('exit', onExit);
    worker.once('message', result => result.error ? finish(new Error(result.error)) : finish(null, result.ends));
  });
}

async function split(ctx) {
  const doc = normalize(mapped(ctx, 'documentSource', ctx.cw.input?.document ?? ctx.msg.payload));
  const settings = ctx.library?.options?.chunking || {};
  const strategy = ctx.cfg.strategy || settings.strategy || 'sentence-window';
  if (!['sentence-window','token-window','paragraph','section','markdown-headings','custom-regex'].includes(strategy)) fail('Unknown splitter strategy');
  const target = integer(ctx.cfg.targetTokens ?? settings.targetTokens ?? 800, 1, 16384, 'window size');
  const overlap = integer(ctx.cfg.overlapTokens ?? settings.overlapTokens ?? Math.min(120,target-1), 0, target-1, 'overlap');
  const chunks = [];
  for (const section of doc.sections?.length ? doc.sections : [{ id: 'body', text: doc.text }]) {
    // Text offsets are UTF-16 offsets local to the source section. Token windows use whitespace units.
    const source = section.text;
    const pattern = { paragraph: /\n\s*\n/g, 'markdown-headings': /\n(?=#{1,6}[ \t])/g }[strategy];
    const boundaries = strategy === 'custom-regex' ? await regexBoundaries(source, ctx.cfg.customRegex, ctx.signal) : [];
    if (pattern) {
      for (const match of source.matchAll(pattern)) {
        if (boundaries.length >= 10000) fail('Document exceeds chunk limit');
        boundaries.push(match.index + match[0].length);
      }
    }
    let start = 0;
    let outputChars = 0;
    const makeChunk = (from, to) => {
      if (chunks.length >= 10000) fail('Document exceeds chunk limit');
      outputChars += to - from;
      if (outputChars > maxDocumentBytes * 2) fail('Chunk overlap exceeds output limit');
      const text = source.slice(from, to);
      const id = hash(JSON.stringify([doc.id, section.id, from, to, text]));
      chunks.push({ id, chunkId: id, text, metadata: section.metadata || {},
        locator: { sectionId: section.id, charStart: from, charEnd: to },
        splitter: { version: 1, strategy, targetTokens: target, overlapTokens: overlap } });
    };
    for (const end of [...boundaries, source.length]) {
      const part = source.slice(start,end);
      if (strategy === 'section' && part.trim()) makeChunk(start,end);
      else {
        // Keep only a window of matches. Oversized individual tokens are divided at 1,024 code points.
        const tokens = part.matchAll(/\S{1,1024}/gu);
        let next = tokens.next();
        let window = [];
        while (!next.done) {
          while (window.length < target && !next.done) {
            window.push(next.value);
            next = tokens.next();
          }
          let count = window.length;
          if (strategy === 'sentence-window' && !next.done) {
            for (let n = count; n > overlap; n--) {
              if (/[.!?。！？][”"']?$/u.test(window[n-1][0])) { count = n; break; }
            }
          }
          const last = window[count-1];
          makeChunk(start + window[0].index,start + last.index + last[0].length);
          window = window.slice(Math.max(1, count - overlap));
        }
      }
      start = end;
    }
  }
  input(ctx, 'chunks', chunks, 'contextWeave.input.chunks');
}

module.exports = { operations: { 'source-map': sourceMap, 'parse-content': parseContent,
  'record-ingest': recordIngest, 'file-ingest': fileIngest, split } };
