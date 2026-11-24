'use strict';

const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { config, events, ports } = require('./definitions');
const { inheritPolicy } = require('./privacy');
const models = require('./models');
const knowledge = require('./knowledge');
const operations = {...(knowledge.operations || knowledge), ...require('./ingest').operations, ...models.operations};
const safeCodes = new Set(['VALIDATION','AUTH','NOT_FOUND','CONFLICT','RATE_LIMITED','UPSTREAM','TIMEOUT','EXTRACTION','INDEXING','POLICY','GENERATION','CITATION_VALIDATION','CANCELLED']);

function valueReader(RED, node, cfg, msg) {
  return (key, fallback) => {
    const value = cfg[key];
    if (value === undefined || value === '') return fallback;
    const kind = cfg[key + 'Type'] || (key.endsWith('Source') ? 'msg' : undefined);
    if (!kind) return value;
    if (!['msg','flow','global','env','str','bool','num','json'].includes(kind)) throw new Error('Invalid input type');
    if (['msg','flow','global'].includes(kind) && /(?:__proto__|constructor|prototype)/.test(value)) throw new Error('Invalid property path');
    return RED.util.evaluateNodeProperty(value,kind,node,msg) ?? fallback;
  };
}

module.exports = function register(RED,type) {
  const name = 'context-weave-' + type;
  const isConfig = Object.hasOwn(config,type);
  function ContextWeaveNode(cfg) {
    RED.nodes.createNode(this,cfg);
    if (isConfig) {
      this.options = {...cfg};
      delete this.options.credentials;
      this.storeDir = path.join(RED.settings.userDir,'context-weave');
      return;
    }
    const active = new Set();
    this.on('close', () => {
      for (const abort of active) abort.abort();
    });
    this.on('input', async (msg,send,done) => {
      const abort = new AbortController();
      active.add(abort);
      const labels = ports(type);
      function route(index, message) {
        const outputs = Array(labels.length).fill(null);
        outputs[index] = message;
        send(outputs);
      }
      let requestId = randomUUID();
      try {
        if (msg.contextWeave === undefined) msg.contextWeave = {};
        const cw = msg.contextWeave;
        if (!cw || typeof cw !== 'object' || Array.isArray(cw)) throw new Error('Invalid envelope');
        if (typeof cw.requestId === 'string' && /^[\w-]{1,128}$/.test(cw.requestId)) requestId = cw.requestId;
        cw.requestId = requestId;
        cw.input ??= {};
        cw.warnings ??= [];
        const run = async (operation, options, signal = abort.signal) => {
          const libraryId = options.library || options.libraries?.[0]?.library;
          const ctx = {RED,node:this,cfg:options,msg,cw,signal,library:RED.nodes.getNode(libraryId),
            value:valueReader(RED,this,options,msg),
            emit:event => {
              if (!abort.signal.aborted && events.has(type)) {
                const copy = RED.util.cloneMessage(msg);
                copy.contextWeave.event = event;
                route(0,copy);
              }
            },
            invoke:(child,overrides={},childSignal=signal) => run(child,{...options,...overrides},childSignal)
          };
          inheritPolicy(ctx);
          ctx.embed = (texts,profile) => models.embed(ctx,texts,profile);
          ctx.rerank = (query,texts,profile) => models.rerank(ctx,query,texts,profile);
          return operations[operation](ctx);
        };
        this.status({fill:'blue',shape:'dot',text:type});
        const result = await run(type,cfg);
        if (!abort.signal.aborted) route(result?.port ? result.port-1 : Number(events.has(type)),msg);
        done();
      } catch (err) {
        if (!abort.signal.aborted) {
          const code = safeCodes.has(err?.code) ? err.code : 'VALIDATION';
          const message = type + ' failed (' + code + ')';
          msg.error = {code,message,requestId,retryable:['TIMEOUT','RATE_LIMITED','UPSTREAM'].includes(code)};
          this.status({fill:'red',shape:'ring',text:code});
          route(labels.length-1,msg);
          done(new Error(message));
        } else done();
      } finally {
        active.delete(abort);
        if (!active.size && !msg.error) this.status({});
      }
    });
  }
  const credentialOptions = type === 'provider' ? {credentials:{apiKey:{type:'password'}}} : undefined;
  RED.nodes.registerType(name,ContextWeaveNode,credentialOptions);
};
