'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {setTimeout:delay} = require('node:timers/promises');

async function listen(server) {
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  return server.address().port;
}

test('Node-RED loads the shipped nodes, indexes a connector record and serves a cited answer', {timeout:45000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'contextweave-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const service=http.createServer(async(req,res)=>{
    let raw='';
    for await (const chunk of req) raw+=chunk;
    const body=JSON.parse(raw);
    res.setHeader('content-type','application/json');
    if(req.url==='/api/embed') return res.end(JSON.stringify({embeddings:body.input.map(()=>[1,0])}));
    if(req.url==='/api/chat'){
      const {evidence}=JSON.parse(body.messages.at(-1).content);
      return res.end(JSON.stringify({message:{content:'After 30 minutes [E:'+evidence[0].id+'].'}}));
    }
    res.writeHead(404).end();
  });
  const modelPort=await listen(service);
  t.after(()=>new Promise(resolve=>service.close(resolve)));
  const reservation=http.createServer();
  const redPort=await listen(reservation);
  await new Promise(resolve=>reservation.close(resolve));

  const pkg=path.resolve(__dirname,'..');
  await fs.mkdir(path.join(dir,'node_modules'));
  await fs.symlink(pkg,path.join(dir,'node_modules','node-red-contrib-context-weave'),'dir');
  const flow=structuredClone(require('../examples/support-rag.json'));
  flow.find(n=>n.id==='cw-provider-local').baseUrl='http://127.0.0.1:'+modelPort;
  // This fixture simulates a trusted upstream identity only for the authorized request.
  const validate=flow.find(n=>n.id==='cw-validate-question');
  validate.func="if(msg.req?.headers['x-fixture-user']==='test-user') msg.auth={tenantId:'acme'};\n"+validate.func;
  await fs.writeFile(path.join(dir,'flows.json'),JSON.stringify(flow));
  await fs.writeFile(path.join(dir,'settings.js'),"module.exports={uiHost:'127.0.0.1',flowFile:'flows.json',credentialSecret:'fixture-only',logging:{console:{level:'info'}}};");
  const red=spawn(process.execPath,[require.resolve('node-red/red.js'),'--userDir',dir,'--port',String(redPort)],{stdio:['ignore','pipe','pipe']});
  let logs='';
  for(const stream of [red.stdout,red.stderr]) stream.on('data',c=>{logs=(logs+c).slice(-12000);});
  t.after(async()=>{if(red.exitCode===null && red.signalCode===null){const closed=once(red,'exit');red.kill();await closed;}});
  const root='http://127.0.0.1:'+redPort;
  for(let i=0; !logs.includes('Started flows');i++){
    if(i>150 || red.exitCode!==null) assert.fail('Node-RED startup: '+logs);
    await delay(100);
  }
  const ask=(authorized)=>fetch(root+'/context-weave/ask',{method:'POST',headers:{'content-type':'application/json',...(authorized?{'x-fixture-user':'test-user'}:{})},body:JSON.stringify({question:'When does the link expire?'}),signal:AbortSignal.timeout(5000)});
  assert.equal((await ask(false)).status,401);
  assert.equal((await fetch(root+'/inject/cw-inject-article',{method:'POST'})).status,200);
  let answer;
  for(let i=0;i<40;i++){
    const result=await ask(true);
    answer=await result.json();
    if(answer.citations?.length) break;
    await delay(100);
  }
  assert.match(answer.answer||'',/30 minutes/, JSON.stringify(answer)+' '+logs);
  assert.equal(answer.citations.length,1);
  assert.ok(answer.citations[0].documentId);
});
