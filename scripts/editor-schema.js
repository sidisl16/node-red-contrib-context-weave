'use strict';

const genericChoices = {
  adapter: ['ollama','openai','openai-compatible','anthropic','google-gemini','huggingface-tei','cross-encoder','tika','qdrant','pgvector','chroma'],
  privacy: ['local-only','allow-commercial-api','commercial-api-with-redaction'],
  purpose: ['generation','embedding','reranking'],
  contentKind: ['auto','record','file','html','markdown','text'],
  parserRoute: ['auto','built-in','remote','custom'],
  contextMode: ['sentences','characters','none'],
  streamMode: ['off','events','tokens'],
  citationFormat: ['structured-and-numeric','markdown','html'],
  normalization: ['none','l2'],
  role: ['user','assistant']
};

const references = {library:'library',provider:'provider',embeddingProfile:'model-profile',generationProfile:'model-profile',verifierProfile:'model-profile',rerankProfile:'model-profile',sourceProfile:'source-profile',store:'conversation-store',extractor:'provider'};

const scopedChoices = {
  'conversation-store.adapter': ['sqlite','memory'],
  'file-ingest.parserRoute': ['auto','built-in','remote'],
  'split.strategy': ['sentence-window','token-window','paragraph','section','markdown-headings','custom-regex'],
  'rerank.strategy': ['none','cross-encoder','mmr','rule','chain'],
  'retrieve.mode': ['hybrid','dense','lexical'],
  'index.mode': ['upsert','create-only'],
  'format-evidence.format': ['text','markdown','json']
};

// Conditions only affect the editor display. Runtime validation remains authoritative.
const visibility = {
  'model-profile.temperature': {field:'purpose',in:['generation']},
  'model-profile.maxOutputTokens': {field:'purpose',in:['generation']},
  'model-profile.maxContextChars': {field:'purpose',in:['generation','reranking']},
  'model-profile.topP': {field:'purpose',in:['generation']},
  'model-profile.batchSize': {field:'purpose',in:['embedding','reranking']},
  'model-profile.revision': {field:'purpose',in:['embedding']},
  'model-profile.dimensions': {field:'purpose',in:['embedding']},
  'model-profile.normalization': {field:'purpose',in:['embedding']},
  'parse-content.extractor': {field:'parserRoute',in:['auto','remote']},
  'parse-content.timeoutSeconds': {field:'parserRoute',in:['auto','remote']},
  'file-ingest.extractor': {field:'parserRoute',in:['auto','remote']},
  'file-ingest.timeoutSeconds': {field:'parserRoute',in:['auto','remote']},
  'split.customRegex': {field:'strategy',in:['custom-regex']},
  'retrieve.lexicalWeight': {field:'mode',in:['hybrid']},
  'retrieve.sentencesBefore': {field:'contextMode',in:['sentences']},
  'retrieve.sentencesAfter': {field:'contextMode',in:['sentences']},
  'retrieve.charactersBefore': {field:'contextMode',in:['characters']},
  'retrieve.charactersAfter': {field:'contextMode',in:['characters']},
  'context.sentencesBefore': {field:'contextMode',in:['sentences']},
  'context.sentencesAfter': {field:'contextMode',in:['sentences']},
  'context.charactersBefore': {field:'contextMode',in:['characters']},
  'context.charactersAfter': {field:'contextMode',in:['characters']},
  'rerank.stages': {field:'strategy',in:['chain']},
  'rerank.rerankProfile': {field:'strategy',in:['cross-encoder']},
  'rerank.diversityBias': {field:'strategy',in:['mmr']},
  'rerank.field': {field:'strategy',in:['rule']},
  'rerank.boost': {field:'strategy',in:['rule']},
  'answer.retrievalRecipe': {field:'autoRetrieve',truthy:true},
  'answer.minimumCitations': {field:'requireCitations',truthy:true},
  'cite.minimumCitations': {field:'requireCitations',truthy:true}
};

const descriptions = {
  name:'Optional label shown on the flow.', adapter:'Backend or API protocol used by this connection.',
  apiKey:'Secret used by the selected service. Node-RED stores it as a credential.', baseUrl:'Service endpoint or PostgreSQL connection URL.',
  timeoutMs:'Maximum provider request time in milliseconds.', provider:'Provider configuration used by this profile.',
  purpose:'Capability this model profile is allowed to perform.', model:'Exact model identifier expected by the provider.',
  privacy:'Controls whether content may leave the local host.', temperature:'Generation randomness; lower values are more deterministic.',
  maxOutputTokens:'Maximum tokens requested from a generation model.', maxContextChars:'Maximum characters admitted to the model context.',
  batchSize:'Maximum embedding or reranking items in one request.', revision:'Embedding model revision recorded with indexed vectors.',
  dimensions:'Expected embedding dimensions; zero lets the provider determine it.', topP:'Optional nucleus-sampling limit.',
  normalization:'Vector normalization policy.', fallbackProfiles:'Ordered model-profile IDs tried after a retryable failure.',
  failInsteadOfFallback:'Stop instead of sending data to a fallback profile.', libraryId:'Stable machine ID for the library.',
  embeddingProfile:'Embedding model profile used for indexing and dense retrieval.', vectorProvider:'Optional Qdrant, pgvector, or Chroma provider; blank uses SQLite vectors.',
  filterAttributes:'Metadata fields that the safe filter grammar may query.', accessPolicy:'Tenant access policy JSON applied before retrieval.',
  allowDestructive:'Allows reset and deletion operations for this library.', ttlSeconds:'Conversation lifetime after its latest activity.',
  maxTurns:'Maximum retained conversation messages.', maxChars:'Maximum total retained conversation characters.',
  sourceProfile:'Reusable connector mapping; non-empty fields on this node override it.', sourceSystem:'Stable name for the upstream system.',
  contentKind:'How to interpret the mapped content; auto detects common values.', parserRoute:'Parser selection: automatic, built-in text, remote Tika, or a custom branch.',
  extractor:'Tika provider used for remote extraction.', maxFileMb:'Maximum accepted source file size in MiB.', timeoutSeconds:'Maximum extraction or agent duration in seconds.',
  sourceEnvelope:'Property containing the normalized source envelope.', outputProperty:'Message property where this node writes its main result.',
  idPath:'Path to the record document ID.', titlePath:'Path to the optional record title.', textPath:'Path to the record text.',
  metadataPath:'Path to the record metadata object.', strategy:'Algorithm used by this node.', targetTokens:'Approximate target chunk size.',
  overlapTokens:'Approximate overlap between adjacent chunks.', customRegex:'Regular expression used as a chunk boundary.',
  library:'Library configuration used by this operation.', libraries:'Optional JSON list of weighted library targets.',
  pageSize:'Maximum entries returned on one page.', metadataFilter:'Safe metadata filter expression; raw SQL or JavaScript is never evaluated.',
  includeChunks:'Include stored chunks with the returned document.', dryRun:'Report the destructive action without applying it.',
  mode:'Operation or retrieval mode.', lexicalWeight:'Hybrid-search weight from 0 (dense) to 1 (lexical).',
  candidateLimit:'Candidates fetched before final limiting or reranking.', resultLimit:'Maximum retrieval results.', offset:'Number of ranked results to skip.',
  contextMode:'Adds sentence context, character context, or no surrounding context.', sentencesBefore:'Sentences added before each matching chunk.',
  sentencesAfter:'Sentences added after each matching chunk.', charactersBefore:'Characters added before each matching chunk.',
  charactersAfter:'Characters added after each matching chunk.', highlights:'Include query-term character ranges.',
  rerankProfile:'Reranking model profile used by the cross-encoder strategy.', stages:'Ordered JSON reranking stages used by chain mode.',
  diversityBias:'MMR diversity preference from 0 to 1.', limit:'Maximum evidence items retained.', cutoff:'Optional minimum reranking score.',
  field:'Trusted numeric metadata field used for a rule boost.', boost:'Multiplier applied to the rule field.',
  format:'Output serialization format.', maxItemChars:'Maximum characters copied from one evidence item.', maxTotalChars:'Total formatted evidence character budget.',
  generationProfile:'Generation model profile used by this node.', streamMode:'Whether progress is emitted on the event output.',
  maxEvidenceChunks:'Maximum evidence chunks sent to a model.', maxEvidenceChars:'Maximum total evidence characters sent to a model.',
  instructions:'Additional trusted instructions appended to the built-in prompt.', requireCitations:'Reject an evidence-backed answer without valid citations.',
  minimumCitations:'Minimum valid evidence citations required.', citationFormat:'How validated citation markers are rendered.',
  noEvidenceText:'Safe response returned when retrieval produces no evidence.', autoRetrieve:'Run retrieval inside the answer node before generation.',
  retrievalRecipe:'JSON options passed to the internal retrieve operation.', role:'Conversation turn role.', toolId:'Allowlisted tool name expected by this bridge.',
  tools:'JSON array of agent tool contracts and retrieval recipes.', maxToolCalls:'Maximum tool calls allowed for one agent run.'
};

function choicesFor(type,key,value) {
  const options = scopedChoices[type+'.'+key] || genericChoices[key];
  if (!options) return undefined;
  return options.includes(value) ? options : [value,...options];
}
function conditionFor(type,key) { return visibility[type+'.'+key]; }
function describe(key) {
  if (descriptions[key]) return descriptions[key];
  if (key.endsWith('SourceType')) return 'Node-RED typed-input kind used to evaluate the adjacent source value.';
  if (key.endsWith('Source')) return 'Message path or typed value read at runtime.';
  if (key.endsWith('Profile')) return 'Reusable configuration node selected for this operation.';
  return 'Configuration value for '+key.replace(/[A-Z]/g,c=>' '+c.toLowerCase())+'.';
}

module.exports={choicesFor,conditionFor,describe,references};
