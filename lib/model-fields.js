'use strict';

const generation = {generationProfile:'', streamMode:'off'};
const evidence = {evidenceSource:'contextWeave.evidence', maxEvidenceChunks:8, maxEvidenceChars:24000};
const query = {querySource:'contextWeave.query'};
const session = {store:'',idSource:'contextWeave.conversation.id'};
module.exports = {
  answer:{...generation,...evidence,...query,instructions:'',requireCitations:true,minimumCitations:1,citationFormat:'structured-and-numeric',noEvidenceText:'I could not find evidence to answer this question.',autoRetrieve:false,retrievalRecipe:{}},
  generate:{...generation,...evidence,messagesSource:'payload'},
  cite:{answerSource:'',evidenceSource:'contextWeave.evidence',citationFormat:'structured-and-numeric',requireCitations:true,minimumCitations:1},
  'fact-check':{generationProfile:'',...evidence},
  'document-summarize':{...generation,library:'',documentIdSource:'contextWeave.documentId',instructions:''},
  'conversation-open':{...session},
  'conversation-turn':{...session,textSource:'',role:'user'},
  'conversation-read':{...session},
  'conversation-delete':{...session,confirmSource:'contextWeave.confirm',dryRun:true},
  'agent-run':{...generation,...query,store:'',library:'',tools:[],maxToolCalls:5,timeoutSeconds:60,instructions:'',requireCitations:true,...evidence},
  'agent-tool':{toolId:'',resultSource:'payload'}
};
