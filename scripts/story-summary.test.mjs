import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeStory } from './story-summary.mjs';

const source={id:'story-1',t:'Headline',s:'Publisher',x:'Excerpt'};
const openAiEnv={
 EMAIL_AI_PROVIDER:'openai_compatible',
 EMAIL_AI_ENDPOINT:'https://api.openai.com/v1/chat/completions',
 EMAIL_AI_API_KEY:'test-secret',
 EMAIL_AI_MODEL:'gpt-4o-mini',
};
const validSummary=JSON.stringify({
 headline:'Headline',summary:'A short summary.',why_it_matters:'A short impact.',
 category:'technology',entities:['Example'],confidence:.9,source_ids:['story-1'],
});

test('OpenAI-compatible summaries use the configured endpoint and validate JSON output',async()=>{
 const previousFetch=globalThis.fetch;
 let request;
 globalThis.fetch=async(url,init)=>{
  request={url:String(url),headers:init.headers,body:JSON.parse(init.body)};
  return Response.json({choices:[{message:{content:validSummary}}]});
 };
 try{
  const result=await summarizeStory([source],openAiEnv);
  assert.equal(request.url,openAiEnv.EMAIL_AI_ENDPOINT);
  assert.equal(request.headers.authorization,'Bearer test-secret');
  assert.equal(request.body.model,openAiEnv.EMAIL_AI_MODEL);
  assert.equal(request.body.response_format.type,'json_object');
  assert.equal(result.headline,'Headline');
 }finally{globalThis.fetch=previousFetch}
});

test('provider 400 errors include a safe actionable reason, not the API key',async()=>{
 const previousFetch=globalThis.fetch;
 globalThis.fetch=async()=>new Response(JSON.stringify({
  error:{message:`The selected model does not support response_format. test-secret ${openAiEnv.EMAIL_AI_ENDPOINT}`},
 }),{status:400,headers:{'content-type':'application/json'}});
 try{
  await assert.rejects(summarizeStory([source],openAiEnv),error=>{
   assert.match(error.message,/openai_compatible story summary request failed \(400\)/);
   assert.match(error.message,/does not support response_format/);
   assert.doesNotMatch(error.message,/test-secret/);
   assert.doesNotMatch(error.message,/api\.openai\.com/);
   return true;
  });
 }finally{globalThis.fetch=previousFetch}
});

test('invalid provider settings fail before any request is sent',async()=>{
 await assert.rejects(summarizeStory([source],{...openAiEnv,EMAIL_AI_ENDPOINT:'http://ai.example/v1/chat/completions'}),
  /must be a valid HTTPS URL/);
 await assert.rejects(summarizeStory([source],{...openAiEnv,EMAIL_AI_MODEL:''}),/EMAIL_AI_MODEL is required/);
 await assert.rejects(summarizeStory([source],{...openAiEnv,EMAIL_AI_PROVIDER:'unknown'}),
  /Unsupported EMAIL_AI_PROVIDER/);
});

test('Anthropic summaries use the Messages API and configured model',async()=>{
 const previousFetch=globalThis.fetch;
 let request;
 globalThis.fetch=async(url,init)=>{
  request={url:String(url),headers:init.headers,body:JSON.parse(init.body)};
  return Response.json({content:[{type:'text',text:validSummary}]});
 };
 try{
  const result=await summarizeStory([source],{
   EMAIL_AI_PROVIDER:'anthropic',EMAIL_AI_API_KEY:'anthropic-test-secret',EMAIL_AI_MODEL:'claude-test-model',
  });
  assert.equal(request.url,'https://api.anthropic.com/v1/messages');
  assert.equal(request.headers['x-api-key'],'anthropic-test-secret');
  assert.equal(request.headers.authorization,undefined);
  assert.equal(request.body.model,'claude-test-model');
  assert.equal(result.source_ids[0],'story-1');
 }finally{globalThis.fetch=previousFetch}
});
