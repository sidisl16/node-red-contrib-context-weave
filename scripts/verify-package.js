'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const pkg = require('../package.json');
const {ports} = require('../lib/definitions');
const names = Object.keys(pkg['node-red'].nodes);
assert.equal(names.length,39);
for (const [name, js] of Object.entries(pkg['node-red'].nodes)) {
  const html = fs.readFileSync(js.replace(/\.js$/,'.html'),'utf8');
  const short = name.slice('context-weave-'.length);
  const capture = {};
  const RED = {nodes:{registerType(key,definition){assert.equal(key,name);capture.definition=definition;}}};
  require('../'+js)(RED);
  assert.equal(typeof capture.definition,'function');
  vm.runInNewContext(html.match(/<script type="text\/javascript">([\s\S]+?)<\/script>/)[1],{RED});
  assert.equal(capture.definition.category,ports(short).length?'context weave':'config');
  assert.equal(capture.definition.paletteLabel(),short);
  assert.equal(capture.definition.label.call({}),short);
  assert.ok(!capture.definition.paletteLabel().includes('context-weave-'));
  assert.ok(html.includes('data-template-name="'+name+'"'));
  assert.ok(html.includes('data-help-name="'+name+'"'));
  if (ports(short).length) assert.equal(capture.definition.outputs,ports(short).length);
}
const flow = require('../examples/support-rag.json');
const ids = new Set(flow.map(n=>n.id));
assert.equal(ids.size,flow.length);
for (const n of flow) {
  if (n.type.startsWith('context-weave-')) {
    assert.ok(names.includes(n.type),n.type);
    if (n.z) assert.equal(n.wires.length,ports(n.type.slice(14)).length,n.name);
  }
  for(const id of (n.wires||[]).flat()) assert.ok(ids.has(id),'Unresolved wire '+id);
}
console.log('Verified '+names.length+' Node-RED runtime/editor pairs and the example flow.');
