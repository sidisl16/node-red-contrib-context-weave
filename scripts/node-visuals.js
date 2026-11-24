'use strict';

// Keep palette styling in one source so an action is recognisable before its label is read.
const families = {
  configuration: {color:'#607D8B', meaning:'Reusable connection, model, library, source, or conversation settings.'},
  lifecycle: {color:'#78909C', meaning:'Create, inspect, update, reset, or delete a library.'},
  ingest: {color:'#F4A261', meaning:'Bring content in, normalize it, split it, or write it to a library.'},
  retrieval: {color:'#5B8DEF', meaning:'Find, rank, filter, expand, or format evidence.'},
  generation: {color:'#A78BFA', meaning:'Generate, validate, or render grounded model output.'},
  conversation: {color:'#2AA198', meaning:'Manage conversations and bounded agent actions.'}
};

const familyByType = {
  provider:'configuration','model-profile':'configuration',library:'configuration','source-profile':'configuration','conversation-store':'configuration',
  'library-create':'lifecycle','library-list':'lifecycle','library-info':'lifecycle','library-update':'lifecycle','library-reset':'lifecycle','library-delete':'lifecycle',
  'source-map':'ingest','parse-content':'ingest','record-ingest':'ingest','file-ingest':'ingest',split:'ingest',index:'ingest',
  'document-get':'ingest','document-list':'ingest','document-patch':'ingest','document-replace-metadata':'ingest','document-delete':'ingest','document-summarize':'generation',
  retrieve:'retrieval',rerank:'retrieval',context:'retrieval',filter:'retrieval','format-evidence':'retrieval','query-history':'retrieval',
  answer:'generation',generate:'generation',cite:'generation','fact-check':'generation',
  'conversation-open':'conversation','conversation-turn':'conversation','conversation-read':'conversation','conversation-delete':'conversation','agent-run':'conversation','agent-tool':'conversation'
};

const iconByType = {
  provider:'plug','model-profile':'microchip',library:'database','source-profile':'exchange','conversation-store':'comments',
  'library-create':'plus-circle','library-list':'list','library-info':'info-circle','library-update':'pencil','library-reset':'refresh','library-delete':'trash',
  'source-map':'exchange','parse-content':'file-text-o','record-ingest':'sign-in','file-ingest':'file-o',split:'scissors',index:'database',
  'document-get':'file-text-o','document-list':'list','document-patch':'pencil','document-replace-metadata':'tags','document-delete':'trash','document-summarize':'compress',
  retrieve:'search',rerank:'sort-amount-desc',context:'expand',filter:'filter','format-evidence':'align-left','query-history':'history',
  answer:'comment','generate':'magic',cite:'quote-right','fact-check':'check-circle',
  'conversation-open':'comments','conversation-turn':'paper-plane','conversation-read':'book','conversation-delete':'trash','agent-run':'bolt','agent-tool':'wrench'
};

function visualFor(type) {
  const family=familyByType[type];
  if (!family || !iconByType[type]) throw new Error('Missing visual metadata for '+type);
  return {family,color:families[family].color,icon:'font-awesome/fa-'+iconByType[type]};
}

module.exports={families,visualFor};
