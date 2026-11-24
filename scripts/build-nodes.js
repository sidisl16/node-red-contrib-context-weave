'use strict';

// Regenerate the editor/runtime pairs after changing a field schema or the design catalogue.
const fs = require('node:fs');
const path = require('node:path');
const {config,ports} = require('../lib/definitions');
const fields = Object.assign({},config,require('../lib/ingest-fields'),require('../lib/knowledge-fields'),require('../lib/model-fields'));
const references = {library:'library',provider:'provider',embeddingProfile:'model-profile',generationProfile:'model-profile',verifierProfile:'model-profile',rerankProfile:'model-profile',sourceProfile:'source-profile',store:'conversation-store',extractor:'provider'};
const choices = {
  adapter:['ollama','openai','openai-compatible','anthropic','google-gemini','huggingface-tei','cross-encoder','tika','qdrant','pgvector','chroma'],
  privacy:['local-only','allow-commercial-api','commercial-api-with-redaction'],purpose:['generation','embedding','reranking'],
  contentKind:['auto','record','file','html','markdown','text']
};
const esc = s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const design = fs.readFileSync('docs/design.md','utf8');
const descriptions = {};
for (const line of design.split('\n')) {
  const m = line.match(/^\| `([\w-]+)` \| (.*?) \| (.*?) \| (.*?) \|$/);
  if (m && !descriptions[m[1]]) descriptions[m[1]]={input:m[2],output:m[3],summary:m[4]};
}
const pkg = require('../package.json');
pkg['node-red'].nodes = {};
for (const [type, props] of Object.entries(fields).sort(([a],[b])=>a.localeCompare(b))) {
  const id = 'context-weave-'+type;
  const configOnly = Object.hasOwn(config,type);
  const prefix = configOnly ? 'node-config-input-' : 'node-input-';
  const labels=ports(type);
  const defaults={name:{value:''}};
  const rows=[];
  const jsonFields=[], numbers=[];
  function row(key,control) {
    const label = key.replace(/[A-Z]/g,c=>' '+c.toLowerCase());
    rows.push('  <div class="form-row"><label for="'+prefix+key+'">'+esc(label)+'</label>'+control+'</div>');
  }
  for (const [key, val] of Object.entries({name:'',...props})) {
    const htmlId='id="'+prefix+key+'"';
    const ref=key==='vectorProvider'?'provider':references[key];
    defaults[key]={value:val,...(ref?{type:'context-weave-'+ref,required:false}:{})};
    let options = key.endsWith('Type') && ['msg','str','flow','global','env','bool','num','json'].includes(val)
      ? ['msg','str','flow','global','env','bool','num','json'] : choices[key];
    if (key==='adapter' && type==='conversation-store') options=['sqlite','memory'];
    if (options && !options.includes(val)) options=[val,...options];
    if (ref) row(key,'<input type="text" '+htmlId+'>');
    else if (options) row(key,'<select '+htmlId+'>'+options.map(o=>'<option value="'+esc(o)+'">'+esc(o)+'</option>').join('')+'</select>');
    else if (val!==null && typeof val==='object') {
      jsonFields.push(key);
      row(key,'<textarea '+htmlId+' rows="3" style="width:70%"></textarea>');
    } else {
      const inputType=typeof val==='boolean'?'checkbox':typeof val==='number'?'number':'text';
      if (inputType==='number') numbers.push(key);
      row(key,'<input '+htmlId+' type="'+inputType+'"'+(inputType==='number'?' step="any"':'')+'>');
    }
  }
  if(type==='provider') row('apiKey','<input id="'+prefix+'apiKey" type="password" autocomplete="new-password">');
  const def={category:configOnly?'config':'context weave',defaults,...(configOnly?{}:{color:'#b2d5cc',inputs:1,outputs:labels.length,outputLabels:labels,icon:'font-awesome/fa-book'}),...(type==='provider'?{credentials:{apiKey:{type:'password'}}}:{})};
  const hooks=[
    "  paletteLabel: function () { return "+JSON.stringify(type)+"; }",
    "  label: function () { return this.name || "+JSON.stringify(type)+"; }",
    "  oneditprepare: function () {\n"+jsonFields.map(k=>"    $('#"+prefix+k+"').val(JSON.stringify(this."+k+" ?? "+JSON.stringify(props[k])+", null, 2));").join('\n')+"\n  }",
    "  oneditsave: function () {\n"+[...jsonFields.map(k=>"    this."+k+" = JSON.parse($('#"+prefix+k+"').val()); $('#"+prefix+k+"').remove();"),...numbers.map(k=>"    this."+k+" = Number($('#"+prefix+k+"').val()); $('#"+prefix+k+"').remove();")].join('\n')+"\n  }"
  ].join(',\n');
  const definition = JSON.stringify(def,null,2).slice(0,-2)+',\n'+hooks+'\n}';
  const d=descriptions[type]||{summary:'Reusable '+type.replaceAll('-',' ')+' configuration.',input:'Selected by dependent nodes',output:'Referenced configuration'};
  const html='<script type="text/javascript">\nRED.nodes.registerType('+JSON.stringify(id)+', '+definition+');\n</script>\n\n<script type="text/html" data-template-name="'+id+'">\n'+rows.join('\n')+'\n</script>\n\n<script type="text/html" data-help-name="'+id+'">\n  <p>'+esc(d.summary)+'</p>\n  <p><b>Input</b> '+esc(d.input)+'</p>\n  <p><b>Output</b> '+esc(d.output)+'</p>\n</script>\n';
  const js='nodes/'+type+'.js';
  fs.writeFileSync(js,"'use strict';\n\nmodule.exports = RED => require('../lib/runtime')(RED, '"+type+"');\n");
  fs.writeFileSync(path.join('nodes',type+'.html'),html);
  pkg['node-red'].nodes[id]=js;
}
fs.writeFileSync('package.json',JSON.stringify(pkg,null,2)+'\n');
