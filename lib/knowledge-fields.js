'use strict';
const library={library:''};
const document={...library,documentIdSource:'contextWeave.documentId',documentIdSourceType:'msg'};
const destructive={confirmSource:'contextWeave.confirm',confirmSourceType:'msg',dryRun:true};
const page={pageSize:50,cursorSource:'contextWeave.cursor',cursorSourceType:'msg'};
const evidence={evidenceSource:'contextWeave.evidence',evidenceSourceType:'msg'};
const query={querySource:'contextWeave.query',querySourceType:'msg'};
const windowOptions={contextMode:'sentences',sentencesBefore:1,sentencesAfter:1,charactersBefore:100,charactersAfter:100};
module.exports={
  'library-create':library,'library-info':library,'library-list':{...library,libraries:[],...page},
  'library-update':{...library,patchSource:'contextWeave.patch',patchSourceType:'msg'},
  'library-reset':{...library,...destructive},'library-delete':{...library,...destructive},
  'document-get':{...document,includeChunks:false},'document-list':{...library,...page,metadataFilter:''},
  'document-delete':{...document,...destructive},
  'document-patch':{...document,metadataSource:'contextWeave.patch',metadataSourceType:'msg'},
  'document-replace-metadata':{...document,metadataSource:'contextWeave.metadata',metadataSourceType:'msg'},
  index:{...library,mode:'upsert',documentSource:'contextWeave.input.document',documentSourceType:'msg',
    chunksSource:'contextWeave.input.chunks',chunksSourceType:'msg'},
  retrieve:{...library,libraries:[],...query,mode:'hybrid',lexicalWeight:0.05,metadataFilter:'',candidateLimit:25,resultLimit:10,
    offset:0,...windowOptions,highlights:false},
  rerank:{...query,...evidence,strategy:'mmr',stages:[],rerankProfile:'',diversityBias:0.3,limit:10,cutoff:'',field:'',boost:1},
  context:{...library,...evidence,...windowOptions},filter:{...library,...evidence,metadataFilter:''},
  'format-evidence':{...evidence,format:'text',maxItemChars:4000,maxTotalChars:24000},
  'query-history':{...library,...page}
};
