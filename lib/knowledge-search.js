'use strict';
const { scope,withStore,attributes,profileKey,checkSpace,dimension,integer,hash,fail,string } = require('./knowledge-store');
const { compileFilter,invalid } = require('./knowledge-filter');
const { libraryIsLocal } = require('./privacy');

function words(text) { return String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []; }
function cosine(a,b) {
  let dot=0, aa=0, bb=0;
  for (let i=0;i<a.length;i++) { dot+=a[i]*b[i]; aa+=a[i]*a[i]; bb+=b[i]*b[i]; }
  return dot / (Math.sqrt(aa)*Math.sqrt(bb));
}
function fraction(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n<0 || n>1) invalid('Weight must be between 0 and 1');
  return n;
}
function libraries(ctx) {
  const entries = ctx.cfg.libraries;
  if (!entries?.length) return [{s:scope(ctx),weight:fraction(ctx.cfg.lexicalWeight ?? .05),filter:ctx.cfg.metadataFilter}];
  if (!Array.isArray(entries) || entries.length > 32) invalid('Select at most 32 libraries');
  return entries.map(entry=>{
    const lib = ctx.RED.nodes.getNode(entry.library);
    if (!lib || lib.type !== 'context-weave-library') invalid('Invalid library reference');
    return {s:scope(ctx,lib), weight:fraction(entry.lexicalWeight ?? .05), filter:entry.metadataFilter};
  });
}
function windowText(doc,chunk,cfg) {
  let text = doc.text || '';
  if (doc.sections?.length) {
    const section = doc.sections.find(s=>s.id===chunk.locator?.sectionId);
    if (!section) return {};
    text = section.text;
  }
  const {charStart:start,charEnd:end} = chunk.locator || {};
  if (!Number.isInteger(start) || !Number.isInteger(end) || start<0 || end>text.length || end<start) return {};
  if (cfg.contextMode === 'characters') {
    const before=integer(cfg.charactersBefore ?? 100,0,2000), after=integer(cfg.charactersAfter ?? 100,0,2000);
    return {before:text.slice(Math.max(0,start-before),start),after:text.slice(end,end+after)};
  }
  if (cfg.contextMode !== 'sentences') return {};
  const split = value=>Array.from(new Intl.Segmenter(undefined,{granularity:'sentence'}).segment(value), item=>item.segment);
  const before=integer(cfg.sentencesBefore ?? 1,0,10), after=integer(cfg.sentencesAfter ?? 1,0,10);
  return {before:before ? split(text.slice(Math.max(0,start-4000),start)).slice(-before).join('') : '',
    after:split(text.slice(end,end+4000)).slice(0,after).join('')};
}
function search(db,target,ctx,query,vector,mode,k,filter,remoteHits) {
  const {s,weight} = target;
  const ranks = new Map();
  function add(rows, stage, blend) {
    rows.forEach((r,i)=>{
      const entry = ranks.get(r.seq) || {score:0,scores:{}};
      entry.score += blend/(60+i+1);
      entry.scores[stage] = r.score;
      ranks.set(r.seq,entry);
    });
  }
  if (vector) {
    checkSpace(db,profileKey(ctx,s),dimension(vector));
    if (remoteHits) {
      const valid=db.prepare('SELECT 1 FROM chunks c JOIN docs d ON d.id=c.doc WHERE c.seq=? AND c.doc=? AND c.chunk=? AND ('+filter.sql+')');
      add(remoteHits.filter(h=>valid.get(h.seq,h.doc,h.chunk,...filter.params)).slice(0,k),'dense',mode==='dense'?1:1-weight);
    } else {
    db.function('cw_cosine', raw=>cosine(vector,JSON.parse(raw)));
    add(db.prepare('SELECT c.seq,cw_cosine(c.vector) score FROM docs d JOIN chunks c ON c.doc=d.id WHERE ' + filter.sql +
      ' ORDER BY score DESC,c.seq LIMIT ?').all(...filter.params,k),'dense',mode==='dense'?1:1-weight);
    }
  }
  if (mode !== 'dense' && (mode === 'lexical' || weight>0)) {
    const tokens = [...new Set(words(query))].slice(0,64);
    if (tokens.length) {
      const expression=tokens.map(t=>'"'+t+'"').join(' OR ');
      const rows=db.prepare('SELECT c.seq,-bm25(terms) score FROM terms JOIN chunks c ON c.seq=terms.rowid JOIN docs d ON d.id=c.doc WHERE terms MATCH ? AND (' +
        filter.sql + ') ORDER BY bm25(terms),c.seq LIMIT ?').all(expression,...filter.params,k);
      add(rows,'lexical',mode==='lexical'?1:weight);
    }
  }
  const load=db.prepare('SELECT c.chunk,d.body FROM chunks c JOIN docs d ON d.id=c.doc WHERE c.seq=?');
  return [...ranks].sort((a,b)=>b[1].score-a[1].score).slice(0,k).map(([seq,r])=>{
    const row=load.get(seq), doc=JSON.parse(row.body), chunk=JSON.parse(row.chunk);
    const e = {evidenceId:hash(s.id,s.tenant,doc.id,chunk.chunkId),library:s.id,documentId:doc.id,
      privacy:libraryIsLocal(s.o)?'local-only':s.o.privacy,
      chunkId:chunk.chunkId,text:chunk.text,score:r.score,scores:r.scores,
      locator:chunk.locator,chunkMetadata:chunk.metadata,document:{title:doc.title,uri:doc.uri,metadata:doc.metadata || {}},
      context:windowText(doc,chunk,ctx.cfg)};
    if (ctx.cfg.highlights === true) {
      const needles = new Set(words(query));
      e.highlights = [...chunk.text.matchAll(/[\p{L}\p{N}]+/gu)].filter(m=>needles.has(m[0].toLowerCase()))
        .map(m=>({start:m.index,end:m.index+m[0].length}));
    }
    return e;
  });
}
async function retrieve(ctx) {
  const q=string(ctx.value('querySource',ctx.cw.query ?? ctx.msg.payload),'query');
  const mode=ctx.cfg.mode || 'hybrid';
  if (!['dense','lexical','hybrid'].includes(mode)) invalid('Invalid retrieval mode');
  const k=integer(ctx.cfg.candidateLimit ?? 25,1,1000);
  const limit=integer(ctx.cfg.resultLimit ?? 10,1,1000);
  const offset=integer(ctx.cfg.offset ?? 0,0,100000);
  const targets=libraries(ctx);
  const filters=targets.map(t=>withStore(t.s,db=>compileFilter(t.filter,attributes(db,t.s),ctx.msg.auth)));
  const evidence=[];
  for (const [i,t] of targets.entries()) {
    const vector=(mode==='dense' || (mode==='hybrid' && t.weight<1)) ? (await ctx.embed([q],t.s.o.embeddingProfile))[0] : null;
    if (mode==='dense' || (mode==='hybrid' && t.weight<1)) dimension(vector);
    const remoteHits=vector && t.s.o.vectorProvider ? await require('./vector-sync').dense(ctx,t,vector,k,filters[i]) : null;
    const results=withStore(t.s,db=> {
      const hits=search(db,t,ctx,q,vector,mode,k,filters[i],remoteHits);
      db.prepare('INSERT INTO history(req,at,hits) VALUES(?,?,?)').run(ctx.cw.requestId || '',new Date().toISOString(),hits.length);
      db.exec('DELETE FROM history WHERE n < (SELECT MAX(n) - 999 FROM history)');
      return hits;
    });
    evidence.push(...results);
  }
  ctx.cw.query=q;
  ctx.cw.evidence=evidence.sort((a,b)=>b.score-a.score || a.evidenceId.localeCompare(b.evidenceId))
    .slice(offset,offset+limit).map((e,i)=>({...e,rank:offset+i+1}));
}
function incoming(ctx) {
  const items=ctx.value('evidenceSource',ctx.cw.evidence);
  if (!Array.isArray(items) || items.length>1000) invalid('Expected up to 1000 evidence items');
  return items;
}
async function rerank(ctx) {
  let items=incoming(ctx).map(e=>({...e,scores:{...e.scores}}));
  const stages=ctx.cfg.strategy==='chain' ? ctx.cfg.stages : [ctx.cfg];
  if (!Array.isArray(stages) || stages.length>10) invalid('Invalid reranking chain');
  for (const stage of stages) {
    const strategy=stage.strategy || 'none';
    const limit=integer(stage.limit ?? 10,1,1000);
    if (strategy==='cross-encoder' && items.length) {
      const scores=await ctx.rerank(ctx.value('querySource',ctx.cw.query),items.map(e=>e.text),stage.rerankProfile);
      if (!Array.isArray(scores) || scores.length!==items.length || !scores.every(Number.isFinite)) fail('UPSTREAM','Invalid reranker scores');
      items.forEach((e,i)=>{ e.score=scores[i]; e.scores[strategy]=e.score; });
      items.sort((a,b)=>b.score-a.score);
    } else if (strategy==='mmr') {
      const bias=fraction(stage.diversityBias ?? .3);
      const selected=[];
      const sets=new Map(items.map(e=>[e,new Set(words(e.text))]));
      const rel=new Map(items.map((e,i)=>[e,1-i/items.length]));
      const overlap=new Map(items.map(e=>[e,0]));
      while (items.length && selected.length<limit) {
        let best=0,score=-Infinity;
        items.forEach((e,i)=>{const n=(1-bias)*rel.get(e)-bias*overlap.get(e); if (n>score) {best=i;score=n;}});
        const [next]=items.splice(best,1);
        next.scores.mmr=next.score=score;
        selected.push(next);
        const known=sets.get(next);
        for (const other of items) {
          const s=sets.get(other); let same=0;
          for(const w of s) if(known.has(w)) same++;
          overlap.set(other,Math.max(overlap.get(other),same/Math.max(1,s.size+known.size-same)));
        }
      }
      items=selected;
    } else if (strategy==='rule') {
      const field=string(stage.field,'metadata score field');
      const boost=Number(stage.boost ?? 1);
      if (!Number.isFinite(boost)) invalid('Invalid rule weight');
      for (const e of items) {
        const value=e.document?.metadata?.[field];
        e.scores.rule=e.score=(e.score || 0)+(Number.isFinite(value)?value*boost:0);
      }
      items.sort((a,b)=>b.score-a.score);
    } else if (!['none','cross-encoder'].includes(strategy)) invalid('Unsupported reranking strategy');
    if (stage.cutoff != null && stage.cutoff!=='') {
      const cutoff=Number(stage.cutoff); if (!Number.isFinite(cutoff)) invalid('Invalid reranker cutoff');
      items=items.filter(e=>e.score>=cutoff);
    }
    items=items.slice(0,limit);
  }
  ctx.cw.evidence=items.map((e,i)=>({...e,rank:i+1}));
}
module.exports={retrieve,rerank,windowText,incoming};
