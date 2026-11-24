'use strict';

const {backend}=require('./vector-backend');
const {withStore,setting,put,tx,fail}=require('./knowledge-store');
const queues=new Map();

function prepare(ctx,s) {
  const remote=backend(ctx,s);
  withStore(s,db=>{
    const saved=setting(db,'vectorBackend',null);
    if(saved && saved!==remote?.signature) fail('CONFLICT','Use a new library for a different vector endpoint');
    if(!remote || saved) return;
    tx(db,()=>{
      put(db,'vectorBackend',remote.signature);
      db.exec(`CREATE TABLE IF NOT EXISTS vector_changes (rev INTEGER PRIMARY KEY AUTOINCREMENT, seq INTEGER, dims INTEGER, vec TEXT);
        CREATE TRIGGER IF NOT EXISTS vector_add AFTER INSERT ON chunks BEGIN
          INSERT INTO vector_changes(seq,dims,vec) VALUES(new.seq,json_array_length(new.vector),new.vector); END;
        CREATE TRIGGER IF NOT EXISTS vector_del AFTER DELETE ON chunks BEGIN
          INSERT INTO vector_changes(seq,dims,vec) VALUES(old.seq,json_array_length(old.vector),NULL); END;
        INSERT INTO vector_changes(seq,dims,vec) SELECT seq,json_array_length(vector),vector FROM chunks;`);
    });
  },{allowDeleted:true});
  return remote;
}

async function flush(scope,remote) {
  if(!remote) return;
  const previous=queues.get(scope.file)||Promise.resolve();
  const work=previous.catch(()=>{}).then(async()=>{
    const access=fn=>withStore(scope,fn,{allowDeleted:true});
    while(true) {
      const rows=access(db=>db.prepare('SELECT rev,seq,dims,vec AS vector FROM vector_changes ORDER BY rev LIMIT 64').all());
      if(!rows.length) return;
      const head=rows[0], group=[];
      for(const row of rows){
        if(row.dims!==head.dims || (row.vector===null)!==(head.vector===null) || group.some(x=>x.seq===row.seq)) break;
        group.push(row);
      }
      await remote.operate(head.vector===null?'delete':'put',head.dims,group);
      access(db=>db.prepare('DELETE FROM vector_changes WHERE rev<=?').run(group.at(-1).rev));
    }
  });
  queues.set(scope.file,work);
  try {await work;} finally {if(queues.get(scope.file)===work) queues.delete(scope.file);}
}

async function dense(ctx,target,vector,k,filter) {
  const s=target.s, remote=prepare(ctx,s);
  if(!remote) return null;
  await flush(s,remote);
  const allowed=withStore(s,db=>db.prepare('SELECT c.seq,c.doc,c.chunk FROM chunks c JOIN docs d ON d.id=c.doc WHERE '+filter.sql+' ORDER BY c.seq').all(...filter.params));
  const found=[];
  for(let i=0;i<allowed.length;i+=256) {
    const batch=allowed.slice(i,i+256), candidates=new Map(batch.map(x=>[x.seq,x]));
    const hits=await remote.operate('search',vector.length,batch,vector,k);
    for(const hit of hits) if(candidates.has(hit.seq) && Number.isFinite(hit.score)) found.push({...candidates.get(hit.seq),score:hit.score});
  }
  return found.sort((a,b)=>b.score-a.score||a.seq-b.seq);
}

module.exports={prepare,flush,dense};
