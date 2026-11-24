'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {config} = require('../lib/definitions');
const fields = Object.assign({},config,require('../lib/ingest-fields'),require('../lib/knowledge-fields'),require('../lib/model-fields'));
const {choicesFor,conditionFor,describe} = require('../scripts/editor-schema');

test('editor metadata covers every field and keeps conditional controllers valid',()=>{
  for (const [type,props] of Object.entries(fields)) {
    for (const [key,value] of Object.entries(props)) {
      assert.ok(describe(key).length>15,type+'.'+key+' needs useful help');
      const choices=choicesFor(type,key,value);
      if (choices) assert.ok(choices.includes(value),type+'.'+key+' choices must include its default');
      const condition=conditionFor(type,key);
      if (condition) assert.ok(Object.hasOwn(props,condition.field),type+'.'+key+' has an unknown visibility controller');
    }
  }
});

test('selection-dependent editors expose only relevant controls',()=>{
  assert.deepEqual(choicesFor('file-ingest','parserRoute','auto'),['auto','built-in','remote']);
  assert.deepEqual(conditionFor('split','customRegex'),{field:'strategy',in:['custom-regex']});
  assert.deepEqual(conditionFor('retrieve','lexicalWeight'),{field:'mode',in:['hybrid']});
  assert.deepEqual(conditionFor('answer','retrievalRecipe'),{field:'autoRetrieve',truthy:true});
  assert.deepEqual(conditionFor('parse-content','extractor'),{field:'parserRoute',in:['auto','remote']});
});

test('generated guide and editors cover the complete catalogue',()=>{
  const guide=fs.readFileSync('docs/node-user-guide.md','utf8');
  for (const [type,props] of Object.entries(fields)) {
    const html=fs.readFileSync('nodes/'+type+'.html','utf8');
    assert.ok(guide.includes('### `'+type+'`'));
    for (const key of Object.keys(props)) {
      assert.ok(html.includes('data-field="'+key+'"'),type+'.'+key+' missing from editor');
      assert.ok(guide.includes('| `'+key+'` |'),type+'.'+key+' missing from guide');
    }
  }
});
