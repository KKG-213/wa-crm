import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { z } from 'zod';
import * as crypto from 'node:crypto';
import * as templates from '../src/lib/meta-template.ts';
import * as phones from '../src/lib/campaign-contacts.ts';

const definition = { name:'web_design_request',language:'en',status:'APPROVED',components:[{type:'HEADER',format:'IMAGE'},{type:'BODY',text:'Website and SEO'}] };
const source = await readFile(new URL('../src/app/api/campaigns/route.ts',import.meta.url),'utf8');
const compiled = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function harness({definitions=[definition],version=1,dbFailure=false,authFailure=false}={}) {
  const rpcCalls=[]; const sends=[];
  const client=templates.createMetaClient({accessToken:'synthetic',phoneNumberId:'1409792945541835',wabaId:'synthetic'},async(url,init)=>{
    if(new URL(url).pathname.endsWith('/message_templates'))return Response.json({data:definitions});
    sends.push(init);throw new Error('Campaign creation must not send');
  });
  const store={rpc:async(name,args)=>{
    rpcCalls.push({name,args});
    if(name==='whatsapp_campaign_queue_version')return {data:version,error:null};
    if(name==='enqueue_whatsapp_campaign')return dbFailure?{data:null,error:{message:'Synthetic failure'}}:
      {data:{campaign_id:'test-campaign',accepted:0,failed:0,queued:args.p_contacts.length,skipped:0},error:null};
    throw new Error('Unexpected RPC');
  }};
  const exports={};const imports={
    'next/server':{NextResponse:{json:(v,i)=>Response.json(v,i)}},'node:crypto':crypto,
    '@/lib/supabase/server':{createAdminClient:async()=>{if(authFailure)throw new Error('Authentication required');return store;}},
    '@/services/meta':{getApprovedWhatsAppTemplates:client.templates},'@/lib/meta-template':templates,'@/lib/campaign-contacts':phones,zod:{z},
  };
  vm.runInNewContext(compiled,{exports,Error,process:{env:{META_PHONE_NUMBER_ID:'1409792945541835'}},console:{error(){}},
    require:n=>{if(!(n in imports))throw new Error(`Unexpected import ${n}`);return imports[n];}});
  return {rpcCalls,sends,send:p=>exports.POST(new Request('https://crm.example/api/campaigns',{method:'POST',body:JSON.stringify(p)}))};
}
const payload={request_key:'10000000-0000-4000-8000-000000000001',campaign_name:'Image test',template_name:'web_design_request',template_language:'en',
  header_image_url:'https://example.com/poster.png',contacts:[{phone:'+919000000001'}]};

test('actual campaign route rejects missing image before any database write or send',async()=>{
  const h=harness();const r=await h.send({...payload,header_image_url:''});assert.equal(r.status,400);assert.match((await r.json()).error,/requires a header image/);
  assert.equal(h.rpcCalls.length,0);assert.equal(h.sends.length,0);
});
test('exact approved language, supported components, phones and request key validate before queue creation',async()=>{
  for(const setting of [{input:{template_language:'en_US'}},{definitions:[{...definition,components:[{type:'HEADER',format:'VIDEO'}]}]},
    {input:{contacts:[{phone:'0000000000'}]}},{input:{request_key:'invalid'}}]){
    const h=harness(setting);assert.equal((await h.send({...payload,...setting.input})).status,400);assert.equal(h.rpcCalls.length,0);
  }
});
test('queue stores approved image components and deduplicates normalized contacts without sending',async()=>{
  const h=harness();const r=await h.send({...payload,contacts:[{phone:'09000000001'},{phone:'+919000000001'}]});
  assert.equal(r.status,200);assert.equal((await r.json()).queued,1);assert.equal(h.sends.length,0);
  const q=h.rpcCalls.at(-1);assert.equal(q.name,'enqueue_whatsapp_campaign');assert.equal(q.args.p_contacts.length,1);
  assert.equal(q.args.p_components[0].parameters[0].image.link,payload.header_image_url);assert.equal(q.args.p_image_url,payload.header_image_url);
  assert.equal(q.args.p_request_key,payload.request_key);assert.match(q.args.p_fingerprint,/^[a-f0-9]{64}$/);
});
test('request fingerprint stays stable on retry and changes with recipient/content',async()=>{
  const h=harness();await h.send(payload);await h.send(payload);await h.send({...payload,contacts:[{phone:'+919000000002'}]});
  const calls=h.rpcCalls.filter(x=>x.name==='enqueue_whatsapp_campaign');
  assert.equal(calls[0].args.p_fingerprint,calls[1].args.p_fingerprint);assert.notEqual(calls[0].args.p_fingerprint,calls[2].args.p_fingerprint);
});
test('missing queue migration fails before enqueueing or sending',async()=>{
  const h=harness({version:null});const r=await h.send(payload);assert.equal(r.status,503);assert.match((await r.json()).error,/whatsapp-campaign-queue.sql/);
  assert.equal(h.rpcCalls.length,1);assert.equal(h.sends.length,0);
});
test('database enqueue failure never sends and reports uncertainty about campaign creation',async()=>{
  const h=harness({dbFailure:true});const r=await h.send(payload);assert.equal(r.status,500);assert.match((await r.json()).error,/Check the campaign list/);assert.equal(h.sends.length,0);
});
test('authentication runs before template lookup or privileged queue writes',async()=>{
  const h=harness({authFailure:true});const r=await h.send(payload);assert.equal(r.status,500);assert.equal(h.rpcCalls.length,0);assert.equal(h.sends.length,0);
});
