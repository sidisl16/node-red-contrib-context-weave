'use strict';

const config = {
  provider: { adapter: 'ollama', baseUrl: 'http://localhost:11434', timeoutMs: 60000 },
  'model-profile': { provider: '', purpose: 'generation', model: '', privacy: 'local-only',
    temperature: 0.2, maxOutputTokens: 900, maxContextChars: 24000, batchSize: 32,
    revision: '1', dimensions: 0, topP: '', normalization: 'none', fallbackProfiles: [], failInsteadOfFallback: false },
  library: { libraryId: 'support-kb', embeddingProfile: '', vectorProvider: '', privacy: 'local-only',
    filterAttributes: [], accessPolicy: { mode: 'tenant-field', metadataField: 'tenant_id', claimProperty: 'auth.tenantId' }, allowDestructive: false },
  'source-profile': {},
  'conversation-store': {adapter:'sqlite', ttlSeconds:86400, maxTurns:20, maxChars:24000}
};
const events = new Set(['answer','generate','document-summarize','agent-run']);
const branches = new Set(['parse-content','source-map']);
function ports(type) {
  if (Object.hasOwn(config,type)) return [];
  if (events.has(type)) return ['event','complete','error'];
  if (branches.has(type)) return type === 'source-map' ? ['upsert','delete','error'] : ['parsed','custom parser','error'];
  return ['success','error'];
}
module.exports = {config,events,ports};
