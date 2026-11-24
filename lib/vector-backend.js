'use strict';

const {createHash} = require('node:crypto');
const {Client} = require('pg');
const {libraryIsLocal} = require('./privacy');

function backend(ctx,s) {
  if (!s.o.vectorProvider) return null;
  const provider=ctx.RED.nodes.getNode(s.o.vectorProvider);
  const {adapter,baseUrl}=provider?.options || {};
  if (!['qdrant','chroma','pgvector'].includes(adapter)) throw new Error('Invalid vector provider');
  const url=new URL(baseUrl);
  const pg=adapter==='pgvector';
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (!url.hostname || url.password || url.search || url.hash || (!pg && url.username) ||
      (pg ? !['postgres:','postgresql:'].includes(url.protocol) : !(url.protocol==='https:' || (local && url.protocol==='http:'))) ||
      (!local && (libraryIsLocal(s.o) || ctx.cw.localOnly))) {
    throw Object.assign(new Error('Vector endpoint violates connection policy'),{code:'POLICY'});
  }
  const timeout=Number(provider.options.timeoutMs || 30000);
  if (!Number.isSafeInteger(timeout) || timeout<1 || timeout>600000) throw new Error('Invalid timeout');
  const secret=provider.credentials?.apiKey;
  const hash=(...v)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const signature=hash(adapter,url.href,s.o.vectorProvider);
  // Include the library config node ID so separate Node-RED libraries cannot collide.
  const scope=hash(s.lib.id,s.id,s.tenant).slice(0,40);
  const collection=dims=>'cw_'+scope+'_'+dims;
  async function http(method,path,body,allowed=[]) {
    const headers={'content-type':'application/json'};
    if(secret) headers[adapter==='qdrant'?'api-key':'x-chroma-token']=secret;
    const signal=AbortSignal.timeout(timeout);
    const res=await fetch(url.href.replace(/\/$/,'')+path,{method,headers,redirect:'error',
      signal:ctx.signal?AbortSignal.any([ctx.signal,signal]):signal,body:body===undefined?undefined:JSON.stringify(body)});
    if(allowed.includes(res.status)){await res.body?.cancel();return null;}
    if(!res.ok){await res.body?.cancel();throw Object.assign(new Error('Vector store HTTP '+res.status),{code:'UPSTREAM'});}
    const raw=await res.text();return raw?JSON.parse(raw):null;
  }
  const chroma='/api/v2/tenants/default_tenant/databases/default_database/collections';
  async function operate(op,dims,items,vector,limit) {
    const name=collection(dims);
    const ids=items.map(x=>x.seq);
    if(pg) {
      const db=new Client({host:url.hostname.replace(/^\[|\]$/g,''),port:Number(url.port||5432),database:decodeURIComponent(url.pathname.slice(1)),user:decodeURIComponent(url.username),password:secret||'',ssl:local?false:{rejectUnauthorized:true},connectionTimeoutMillis:timeout,statement_timeout:timeout});
      await db.connect();
      try {
        await db.query('CREATE TABLE IF NOT EXISTS context_weave_vectors (collection text, id bigint, embedding vector NOT NULL, PRIMARY KEY(collection,id))');
        if(op==='delete') return await db.query('DELETE FROM context_weave_vectors WHERE collection=$1 AND id=ANY($2::bigint[])',[name,ids]);
        if(op==='put') return await db.query('INSERT INTO context_weave_vectors SELECT $1,id,embedding::vector FROM unnest($2::bigint[],$3::text[]) AS v(id,embedding) ON CONFLICT(collection,id) DO UPDATE SET embedding=excluded.embedding',[name,ids,items.map(x=>x.vector)]);
        const r=await db.query('SELECT id,1-(embedding <=> $3::vector) AS score FROM context_weave_vectors WHERE collection=$1 AND id=ANY($2::bigint[]) ORDER BY embedding <=> $3::vector,id LIMIT $4',[name,ids,JSON.stringify(vector),limit]);
        return r.rows.map(r=>({seq:Number(r.id),score:r.score}));
      } finally { await db.end(); }
    }
    if(adapter==='qdrant') {
      const path='/collections/'+name;
      if(op==='put') {
        if(!await http('GET',path,undefined,[404])) await http('PUT',path,{vectors:{size:dims,distance:'Cosine'}},[409]);
        return http('PUT',path+'/points?wait=true',{points:items.map(x=>({id:x.seq,vector:JSON.parse(x.vector)}))});
      }
      if(op==='delete') return http('POST',path+'/points/delete?wait=true',{points:ids},[404]);
      const r=await http('POST',path+'/points/query',{query:vector,filter:{must:[{has_id:ids}]},limit,with_payload:false});
      return r.result.points.map(x=>({seq:x.id,score:x.score}));
    }
    const c=op==='put'?await http('POST',chroma,{name,get_or_create:true,configuration:{hnsw:{space:'cosine'}}}):
      await http('GET',chroma+'/'+name,undefined,op==='delete'?[404]:[]);
    if(!c) return;
    const path=chroma+'/'+encodeURIComponent(c.id);
    if(op==='put') return http('POST',path+'/upsert',{ids:ids.map(String),embeddings:items.map(x=>JSON.parse(x.vector)),metadatas:ids.map(seq=>({seq}))});
    if(op==='delete') return http('POST',path+'/delete',{ids:ids.map(String)});
    const r=await http('POST',path+'/query',{where:{seq:{$in:ids}},query_embeddings:[vector],n_results:Math.min(limit,ids.length),include:['distances']});
    return r.ids[0].map((id,i)=>({seq:Number(id),score:1-r.distances[0][i]}));
  }
  return {signature,operate};
}
module.exports={backend};
