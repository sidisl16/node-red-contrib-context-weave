'use strict';

const { isIP } = require('node:net');
const endpoints = Object.freeze({
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  'google-gemini': 'https://generativelanguage.googleapis.com/v1beta',
  ollama: 'http://127.0.0.1:11434'
});
function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}
function integer(value, fallback, max) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) fail('VALIDATION', 'Invalid numeric limit');
  return number;
}
function probability(value, max=1) {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max) fail('VALIDATION','Invalid sampling parameter');
  return n;
}
function profile(ctx, id, purpose) {
  const options = ctx.RED.nodes.getNode(id)?.options;
  if (!options || options.purpose !== purpose || !options.model) fail('VALIDATION', 'Select a compatible model profile');
  const provider = ctx.RED.nodes.getNode(options.provider);
  if (!provider?.options) fail('VALIDATION', 'Missing provider connection');
  const { adapter, baseUrl, timeoutMs } = provider.options;
  if (!['openai','openai-compatible','ollama','anthropic','google-gemini','huggingface-tei','cross-encoder'].includes(adapter)) fail('VALIDATION','Unknown model provider');
  const url = new URL(baseUrl || endpoints[adapter]);
  const host = url.hostname;
  const local = host === 'localhost' || host === '[::1]' || (isIP(host) === 4 && host.startsWith('127.'));
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) fail('POLICY', 'Provider requires HTTPS or loopback HTTP');
  const libraryPolicy = ctx.library?.options;
  const evidencePolicy = Array.isArray(ctx.cw?.evidence) && ctx.cw.evidence.some(item=>item?.privacy==='local-only');
  if ((options.privacy === 'local-only' || libraryPolicy?.privacy === 'local-only' || libraryPolicy?.privacyPolicy === 'local-only' || libraryPolicy?.localOnly === true || ctx.cw?.localOnly === true || evidencePolicy) && !local) fail('POLICY', 'Local-only content requires a loopback provider');
  if (!local && options.privacy === 'commercial-api-with-redaction') fail('POLICY', 'Outbound redaction requires a configured redaction adapter');
  const key = provider.credentials?.apiKey;
  const headers = {'content-type': 'application/json'};
  if (key) {
    if (adapter === 'anthropic') headers['x-api-key'] = key;
    else if (adapter === 'google-gemini') headers['x-goog-api-key'] = key;
    else headers.authorization = 'Bearer ' + key;
  }
  if (adapter === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  return {options, adapter, model: options.model, base: url.href.replace(/\/$/, ''), headers,
    timeout: integer(timeoutMs, 60000, 600000), id};
}
async function request(ctx, p, path, body, consume) {
  const timeout = AbortSignal.timeout(p.timeout);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
  try {
    const res = await (ctx.fetch || fetch)(p.base + path, {method:'POST', headers:p.headers, body:JSON.stringify(body), redirect:'error', signal});
    if (!res.ok) {
      await res.body?.cancel();
      fail(res.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM', 'Model service returned HTTP ' + res.status);
    }
    return await consume(res);
  } catch (err) {
    if (signal.aborted) fail(ctx.signal?.aborted ? 'CANCELLED' : 'TIMEOUT', 'Model request interrupted');
    if (['RATE_LIMITED','UPSTREAM','VALIDATION','POLICY'].includes(err.code)) throw err;
    fail('UPSTREAM', 'Model service returned an unreadable response or could not be reached');
  }
}
async function* parts(response) {
  let size = 0;
  const decoder = new TextDecoder();
  for await (const bytes of response.body) {
    size += bytes.length;
    if (size > 16 * 1024 * 1024) fail('UPSTREAM', 'Model response exceeded size limit');
    yield decoder.decode(bytes, {stream:true});
  }
  yield decoder.decode();
}
async function json(response) {
  let text = '';
  for await (const part of parts(response)) text += part;
  return JSON.parse(text);
}
async function embed(ctx, texts, profileId) {
  const p = profile(ctx, profileId, 'embedding');
  if (!Array.isArray(texts) || texts.some(text => typeof text !== 'string')) fail('VALIDATION','Expected text array');
  const size = integer(p.options.batchSize, 32, 1024);
  const output = [];
  for (let start = 0; start < texts.length; start += size) {
    const input = texts.slice(start, start + size);
    let path, body, decode;
    if (p.adapter === 'google-gemini') {
      path = '/models/' + encodeURIComponent(p.model) + ':batchEmbedContents';
      body = {requests:input.map(text => ({model:'models/' + p.model, content:{parts:[{text}]}, ...(Number(p.options.dimensions)>0 ? {outputDimensionality:integer(p.options.dimensions,1,65536)} : {})}))};
      decode = result => result.embeddings.map(entry => entry.values);
    } else if (p.adapter === 'ollama') {
      path = '/api/embed'; body = {model:p.model, input}; decode = result => result.embeddings;
    } else if (p.adapter === 'huggingface-tei') {
      path = '/embed'; body = {inputs:input}; decode = result => result;
    } else if (['openai','openai-compatible'].includes(p.adapter)) {
      path = '/embeddings'; body = {model:p.model, input};
      if (Number(p.options.dimensions)>0) body.dimensions = integer(p.options.dimensions, 1, 65536);
      decode = result => result.data.sort((a,b) => a.index-b.index).map((entry,i) => {
        if (entry.index !== i) fail('UPSTREAM','Invalid embedding index');
        return entry.embedding;
      });
    } else fail('VALIDATION','Provider does not support embeddings');
    const vectors = await request(ctx,p,path,body, async res => decode(await json(res)));
    if (!Array.isArray(vectors) || vectors.length !== input.length) fail('UPSTREAM','Embedding count mismatch');
    for (const vector of vectors) {
      if (!Array.isArray(vector) || !vector.length || !vector.every(Number.isFinite) || (output.length && vector.length !== output[0].length)) fail('UPSTREAM','Invalid embedding vector');
      if (Number(p.options.dimensions)>0 && vector.length !== Number(p.options.dimensions)) fail('UPSTREAM','Embedding dimension mismatch');
      if (p.options.normalization === 'l2') {
        const norm = Math.sqrt(vector.reduce((sum,n)=>sum+n*n,0));
        if (!Number.isFinite(norm) || norm === 0) fail('UPSTREAM','Invalid vector norm');
        output.push(vector.map(n=>n/norm));
      } else output.push(vector);
    }
  }
  return output;
}
function chatRequest(p, messages, stream) {
  const {model, adapter, options} = p;
  const max = integer(options.maxOutputTokens,1024,131072);
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const turns = messages.filter(m => m.role !== 'system');
  const temperature = probability(options.temperature,adapter === 'anthropic' ? 1 : 2);
  const topP = probability(options.topP);
  if (adapter === 'anthropic') return ['/messages', {model, system, messages:turns, max_tokens:max, temperature:topP==null?temperature:undefined, top_p:topP, stream},
    data => stream ? data.delta?.text : data.content?.map(part => part.text || '').join('')];
  if (adapter === 'google-gemini') return ['/models/' + encodeURIComponent(model) + (stream ? ':streamGenerateContent?alt=sse' : ':generateContent'),
    {systemInstruction:system?{parts:[{text:system}]}:undefined, contents:turns.map(m => ({role:m.role === 'assistant' ? 'model':'user',parts:[{text:m.content}]})), generationConfig:{maxOutputTokens:max,temperature,topP}},
    data => data.candidates?.[0]?.content?.parts?.filter(part => !part.thought).map(part => part.text || '').join('')];
  if (adapter === 'ollama') return ['/api/chat',{model,messages,stream,options:{num_predict:max,temperature,top_p:topP}}, data => data.message?.content];
  if (['openai','openai-compatible'].includes(adapter)) return ['/chat/completions',{model,messages,stream,temperature,top_p:topP,...(adapter === 'openai' ? {max_completion_tokens:max}:{max_tokens:max})},data => stream ? data.choices?.[0]?.delta?.content : data.choices?.[0]?.message?.content];
  fail('VALIDATION','Provider does not support generation');
}
async function streamText(response,p,decode,onDelta) {
  let pending = '', output = '', finished = false;
  function line(raw) {
    const text = raw.trim();
    if (!text || (p.adapter !== 'ollama' && !text.startsWith('data:'))) return;
    const payload = p.adapter === 'ollama' ? text : text.slice(5).trim();
    if (payload === '[DONE]') {finished = true; return;}
    const data = JSON.parse(payload);
    if (data.error) fail('UPSTREAM','Provider interrupted generation');
    if (data.done || data.type === 'message_stop' || data.candidates?.[0]?.finishReason || data.choices?.[0]?.finish_reason) finished = true;
    const delta = decode(data);
    if (typeof delta === 'string' && delta) {output += delta; onDelta(delta);}
  }
  for await (const chunk of parts(response)) {
    pending += chunk;
    let endl;
    while ((endl = pending.indexOf('\n')) >= 0) {line(pending.slice(0,endl)); pending = pending.slice(endl+1);}
  }
  line(pending);
  if (!finished) fail('UPSTREAM','Incomplete generation stream');
  return output;
}
async function withProfiles(ctx,id,purpose,attempt) {
  const primary = profile(ctx,id,purpose);
  const privacyLevels = new Map([['allow-commercial-api',1],['commercial-api-with-redaction',2],['local-only',3]]);
  const level = p => privacyLevels.get(p.options.privacy || 'local-only') || fail('POLICY','Invalid profile privacy setting');
  const requiredLevel = level(primary);
  const fallbacks = primary.options.failInsteadOfFallback ? [] : (primary.options.fallbackProfiles || []);
  if (!Array.isArray(fallbacks) || fallbacks.length>8) fail('VALIDATION','Invalid fallback profile list');
  let lastError;
  for (const profileId of new Set([id,...fallbacks])) {
    const p = profileId === id ? primary : profile(ctx,profileId,purpose);
    if (level(p)<requiredLevel) fail('POLICY','Fallback profile permits broader data transfer');
    let emitted = false;
    try { return await attempt(p,()=>{emitted=true;}); }
    catch (err) {
      if (emitted || !['RATE_LIMITED','UPSTREAM','TIMEOUT'].includes(err.code) || ctx.signal?.aborted) throw err;
      lastError = err;
    }
  }
  throw lastError;
}
async function chat(ctx,messages,{profileId=ctx.cfg.generationProfile,stream=false}={}) {
  if (!Array.isArray(messages) || !messages.length || messages.some(m => !m || !['system','user','assistant'].includes(m.role) || typeof m.content !== 'string')) fail('VALIDATION','Expected text chat messages');
  const chars = messages.reduce((n,m)=>n+m.content.length,0);
  return withProfiles(ctx,profileId,'generation',async (p,markEmitted)=>{
    if (chars > integer(p.options.maxContextChars,64000,2000000)) fail('VALIDATION','Prompt exceeds model profile context budget');
    const [path,body,decode] = chatRequest(p,messages,stream);
    const text = await request(ctx,p,path,body,async res => stream ? streamText(res,p,decode,delta => {
      markEmitted(); ctx.emit({type:'generation.delta',text:delta});
    }) : decode(await json(res)));
    if (typeof text !== 'string' || !text.trim()) fail('UPSTREAM','Model returned no answer text');
    return {text,trace:{profile:p.id,requestedProfile:profileId,model:p.model,revision:p.options.revision || 1}};
  });
}
async function rerank(ctx,query,texts,profileId) {
  return withProfiles(ctx,profileId,'reranking',async p=>{
  if (!['cross-encoder','huggingface-tei'].includes(p.adapter)) fail('VALIDATION','Provider does not support reranking');
  if (!Array.isArray(texts) || texts.some(t => typeof t !== 'string') || typeof query !== 'string') fail('VALIDATION','Expected query and passages');
  const response = await request(ctx,p,'/rerank',{query,texts},json);
  if (!Array.isArray(response) || response.length !== texts.length) fail('UPSTREAM','Invalid reranking response');
  const scores = Array(texts.length).fill(null);
  for (const item of response) {
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= scores.length || scores[item.index] !== null || !Number.isFinite(item.score)) fail('UPSTREAM','Invalid reranking score');
    scores[item.index] = item.score;
  }
    ctx.cw.rerankTrace = {profile:p.id,requestedProfile:profileId,model:p.model,revision:p.options.revision || 1};
    return scores;
  });
}
module.exports = {chat,embed,rerank,fail,integer,profile,request,json};
