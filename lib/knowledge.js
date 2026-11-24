'use strict';
const { scope,withStore,setting,put,attributes,tx,validateMetadata,index,integer,fail,string,hash } = require('./knowledge-store');
const { compileFilter,invalid } = require('./knowledge-filter');
const { retrieve,rerank,windowText,incoming } = require('./knowledge-search');

function local(fn, opts) { return ctx=>{ const s=scope(ctx); return withStore(s,db=>fn(ctx,s,db),opts); }; }
function stats(db) {
  return {documents:db.prepare('SELECT count(*) n FROM docs').get().n,chunks:db.prepare('SELECT count(*) n FROM chunks').get().n};
}
function descriptor(s,db) {
  return {id:s.id,name:setting(db,'name',s.o.name || s.id),description:setting(db,'description',s.o.description || ''),
    filterAttributes:attributes(db,s),embeddingProfile:s.o.embeddingProfile,...stats(db)};
}
function id(ctx) { return string(ctx.value('documentIdSource',ctx.cw.documentId || ctx.cw.input?.document?.id),'document id'); }
function get(db,k) {
  const row=db.prepare('SELECT body FROM docs WHERE id=?').get(k);
  if (!row) fail('NOT_FOUND','Document not found');
  return JSON.parse(row.body);
}
function confirm(ctx) {
  if (ctx.value('confirmSource',ctx.cw.confirm) !== true) fail('POLICY','Explicit operation confirmation required');
}
function audit(ctx,operation,s) {
  ctx.node?.log?.(JSON.stringify({operation,library:s.id,requestId:ctx.cw.requestId,scope:s.tenant?'tenant':'library'}));
}
function clear(deleting) {
  return local((ctx,s,db)=>{
    const counts=stats(db);
    if (!ctx.cfg.dryRun) {
      if (s.o.allowDestructive!==true) fail('POLICY','Library reset and deletion disabled');
      confirm(ctx);
      if (deleting && ctx.cw.confirmLibraryId!==s.id) fail('POLICY','Library ID confirmation required');
      tx(db,()=>{
        db.exec('DELETE FROM docs; DELETE FROM history');
        if (deleting) {db.exec("DELETE FROM settings WHERE k!='vectorBackend'");put(db,'deleted',true);}
        else db.exec("DELETE FROM settings WHERE k='space'");
      });
      audit(ctx,deleting?'library-delete':'library-reset',s);
    }
    ctx.cw.operation={...counts,dryRun:!!ctx.cfg.dryRun,libraryId:s.id};
  });
}
function updateMetadata(replace) {
  return local((ctx,s,db)=>tx(db,()=>{
    const k=id(ctx), doc=get(db,k), attrs=attributes(db,s);
    const delta=ctx.value('metadataSource',replace?ctx.cw.metadata:ctx.cw.patch);
    if (!delta || typeof delta!=='object' || Array.isArray(delta) || (!replace && !Object.keys(delta).length)) invalid('Expected metadata fields');
    const tenantField=s.policy.metadataField || 'tenant_id';
    if (s.tenant && Object.hasOwn(delta,tenantField) && delta[tenantField]!==s.tenant) fail('POLICY','Cannot reassign tenant');
    doc.metadata={...(replace?{}:doc.metadata),...delta,...(s.tenant?{[tenantField]:s.tenant}:{})};
    validateMetadata(s,attrs,doc.metadata);
    db.prepare('UPDATE docs SET body=?,digest=? WHERE id=?').run(JSON.stringify(doc),'',k);
    ctx.cw.document=doc;
  }));
}
function pagination(ctx) {
  return {limit:integer(ctx.cfg.pageSize??50,1,500),offset:integer(ctx.value('cursorSource',ctx.cw.cursor??0),0,1000000)};
}
function paged(ctx,items,key,limit,offset) {
  ctx.cw[key]=items.slice(0,limit);
  ctx.cw.page={nextCursor:items.length>limit?String(offset+limit):null};
}
module.exports={
  index,retrieve,rerank,
  'library-create':local((ctx,s,db)=>tx(db,()=>{
    const spec=ctx.cw.librarySpec || {};
    if (spec.id && spec.id!==s.id) invalid('Select the config node for this library ID');
    const key=hash(ctx.cw.idempotencyKey || '',spec);
    const existing=setting(db,'create',null);
    if (existing && existing!==key) fail('CONFLICT','Library already exists');
    put(db,'deleted',false);put(db,'create',key);
    if (spec.name) put(db,'name',string(spec.name,'name'));
    if (spec.description) put(db,'description',string(spec.description,'description'));
    ctx.cw.library=descriptor(s,db);
  }),{allowDeleted:true}),
  'library-list':ctx=>{
    const entries=ctx.cfg.libraries?.length?ctx.cfg.libraries.map(e=>ctx.RED.nodes.getNode(e.library || e)):[ctx.library];
    const {limit,offset}=pagination(ctx), result=[];
    for(const lib of entries) {
      if (!lib || lib.type && lib.type!=='context-weave-library') invalid('Invalid library reference');
      const s=scope(ctx,lib);
      withStore(s,db=>{if(!setting(db,'deleted',false)) result.push(descriptor(s,db));},{allowDeleted:true});
    }
    paged(ctx,result.slice(offset,offset+limit+1),'libraries',limit,offset);
  },
  'library-info':local((ctx,s,db)=>{ctx.cw.library=descriptor(s,db);}),
  'library-update':local((ctx,s,db)=>tx(db,()=>{
    const patch=ctx.value('patchSource',ctx.cw.patch);
    if (!patch || !Object.keys(patch).length || Object.keys(patch).some(k=>!['name','description','filterAttributes'].includes(k))) invalid('Unsupported library patch');
    for(const k of ['name','description']) if (patch[k]!=null) put(db,k,string(patch[k],k));
    if(patch.filterAttributes) {
      const attrs=attributes(db,s);
      if (!Array.isArray(patch.filterAttributes)) invalid('Expected filterAttributes array');
      const updated=[...attrs];
      for(const a of patch.filterAttributes) {
        if (!a || !/^[A-Za-z_]\w*$/.test(a.name) || !['string','boolean','integer','float','number','date','datetime'].includes(a.type)) invalid('Invalid filter attribute');
        const old=updated.find(v=>v.name===a.name);
        if (old && (old.type!==a.type || !!old.required!==!!a.required)) fail('CONFLICT','Incompatible filter schema change');
        if (!old) {
          if(a.required && db.prepare('SELECT 1 FROM docs LIMIT 1').get()) fail('CONFLICT','Required field needs migration');
          updated.push({name:a.name,type:a.type,required:!!a.required});
        }
      }
      put(db,'attributes',updated);
    }
    ctx.cw.library=descriptor(s,db);
  })),
  'library-delete':clear(true),'library-reset':clear(false),
  'document-get':local((ctx,s,db)=>{
    const doc=get(db,id(ctx));
    if(ctx.cfg.includeChunks) doc.chunks=db.prepare('SELECT chunk FROM chunks WHERE doc=? ORDER BY ord').all(doc.id).map(r=>JSON.parse(r.chunk));
    ctx.cw.document=doc;
  }),
  'document-list':local((ctx,s,db)=>{
    const {limit,offset}=pagination(ctx);
    const f=compileFilter(ctx.cfg.metadataFilter,attributes(db,s),ctx.msg.auth);
    const rows=db.prepare('SELECT body FROM docs d WHERE '+f.sql+' ORDER BY id LIMIT ? OFFSET ?').all(...f.params,limit+1,offset);
    paged(ctx,rows.map(r=>{const {id,title,uri,metadata}=JSON.parse(r.body);return {id,title,uri,metadata};}),'documents',limit,offset);
  }),
  'document-delete':local((ctx,s,db)=>{
    const k=id(ctx);get(db,k);
    if (!ctx.cfg.dryRun) {confirm(ctx);db.prepare('DELETE FROM docs WHERE id=?').run(k);audit(ctx,'document-delete',s);}
    ctx.cw.operation={documentId:k,dryRun:!!ctx.cfg.dryRun};
  }),
  'document-patch':updateMetadata(false),'document-replace-metadata':updateMetadata(true),
  'query-history':local((ctx,s,db)=>{
    const {limit,offset}=pagination(ctx);
    paged(ctx,db.prepare('SELECT req requestId,at,hits FROM history ORDER BY n DESC LIMIT ? OFFSET ?').all(limit+1,offset),'history',limit,offset);
  }),
  filter:local((ctx,s,db)=>{
    const f=compileFilter(ctx.value('filterSource',ctx.cfg.metadataFilter),attributes(db,s),ctx.msg.auth);
    ctx.cw.evidence=incoming(ctx).filter(e=>f.test(e.document?.metadata || {})).map((e,i)=>({...e,rank:i+1}));
  }),
  context:local((ctx,s,db)=>{
    ctx.cw.evidence=incoming(ctx).map(e=>{
      if(e.library!==s.id || e.evidenceId!==hash(s.id,s.tenant,e.documentId,e.chunkId)) fail('POLICY','Evidence is outside selected library scope');
      const doc=get(db,e.documentId);
      const row=db.prepare("SELECT chunk FROM chunks WHERE doc=? AND json_extract(chunk,'$.chunkId')=?").get(doc.id,e.chunkId);
      if (!row) fail('NOT_FOUND','Evidence chunk not found');
      return {...e,context:windowText(doc,JSON.parse(row.chunk),ctx.cfg)};
    });
  }),
  'format-evidence':ctx=>{
    const budget=integer(ctx.cfg.maxTotalChars??24000,1,1_000_000), perItem=integer(ctx.cfg.maxItemChars??4000,1,1_000_000);
    const format=ctx.cfg.format || 'text';if(!['text','markdown','json'].includes(format)) invalid('Invalid evidence format');
    const chunks=[]; let size=format==='json'?2:0;
    for(const e of incoming(ctx)) {
      if (!/^[a-zA-Z0-9_-]+$/.test(e.evidenceId)) invalid('Invalid evidence identifier');
      const prefix=(format==='markdown'?'### ':'')+'[E:'+e.evidenceId+']\n';
      const text=e.text.slice(0,perItem);
      const item=format==='json'?{evidenceId:e.evidenceId,text}:prefix+text;
      const n=format==='json'?JSON.stringify(item).length+(chunks.length?1:0):item.length+(chunks.length?2:0);
      if (size+n>budget) break;
      chunks.push(item);size+=n;
    }
    ctx.cw.promptEvidence=format==='json'?JSON.stringify(chunks):chunks.join('\n\n');
  }
};

for (const name of ['index','document-delete','library-reset','library-delete','library-create']) {
  const original=module.exports[name];
  module.exports[name]=ctx=>{
    if (!ctx.library?.options.vectorProvider) return original(ctx);
    const {prepare,flush}=require('./vector-sync');
    const s=scope(ctx), remote=prepare(ctx,s);
    return (async()=>{
      await flush(s,remote);
      await original(ctx);
      await flush(s,remote);
    })();
  };
}
