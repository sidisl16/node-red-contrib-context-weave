'use strict';

const mapping = {
  sourceSystem: '', itemIdSource: '', itemIdSourceType: 'msg',
  contentSource: '', contentSourceType: 'msg', contentKind: 'auto',
  metadataSource: '', metadataSourceType: 'msg', uriSource: '', uriSourceType: 'msg',
  filenameSource: '', filenameSourceType: 'msg', mimeTypeSource: '', mimeTypeSourceType: 'msg',
  titleSource: '', titleSourceType: 'msg', modifiedAtSource: '', modifiedAtSourceType: 'msg',
  checkpointSource: '', checkpointSourceType: 'msg', operation: '', operationType: 'str'
};

const parser = { parserRoute: 'auto', extractor: '', maxFileMb: 10, timeoutSeconds: 60 };
const documentSource = { documentSource: '', documentSourceType: 'msg' };
module.exports = {
  'source-profile': mapping,
  'source-map': { sourceProfile: '', ...mapping },
  'parse-content': { ...parser, sourceEnvelope: 'contextWeave.source', sourceEnvelopeType: 'msg',
    outputProperty: 'contextWeave.input.document' },
  'record-ingest': { ...documentSource, idPath: 'id', titlePath: 'title', textPath: 'text', metadataPath: 'metadata' },
  split: { ...documentSource, strategy: 'sentence-window', targetTokens: 800, overlapTokens: 120,
    customRegex: '', outputProperty: 'contextWeave.input.chunks' },
  'file-ingest': { library: '', ...parser, fileSource: 'payload', fileSourceType: 'msg', documentIdSource: '',
    documentIdSourceType: 'msg', metadataSource: '', metadataSourceType: 'msg',
    filenameSource: '', filenameSourceType: 'msg', mimeTypeSource: '', mimeTypeSourceType: 'msg' }
};
