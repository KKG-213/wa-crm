import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchCampaign } from '../src/lib/campaign-dispatch.ts';

const claim={state:'claimed',log_id:'10000000-0000-4000-8000-000000000001',dispatch_token:'20000000-0000-4000-8000-000000000001',
  phone:'+919000000001',phone_number_id:'1409792945541835',template:'web_design_request',language:'en',components:[{type:'header',parameters:[]} ]};
const summary={accepted:1,failed:0,queued:2,uncertain:0,skipped:0};
function harness({state=claim,result={ok:true,wamid:'wamid.test',error:null},failSaves=0,throwSend=false,phoneId=claim.phone_number_id}={}){
  const calls=[];let sends=0,saves=0;
  const dependencies={phoneNumberId:phoneId,rpc:async(name,args)=>{
    calls.push({name,args});
    if(name==='claim_whatsapp_campaign_message')return {data:state,error:null};
    if(name==='complete_whatsapp_campaign_message')return ++saves<=failSaves?{data:null,error:'synthetic'}:{data:summary,error:null};
    throw new Error('Unexpected RPC');
  },send:async()=>{sends++;if(throwSend)throw new Error('Synthetic timeout');return result;}};
  return {calls,get sends(){return sends;},get saves(){return saves;},dispatch:()=>dispatchCampaign('synthetic-campaign',dependencies)};
}
test('wait, pause, done and review outcomes never call Graph',async()=>{
  for(const state of ['wait','paused','done','review']){const h=harness({state:{state}});assert.equal((await h.dispatch()).state,state);assert.equal(h.sends,0);}
});
test('claim calls Meta once and acknowledgement retries never resend it',async()=>{
  const h=harness({failSaves:2});assert.equal((await h.dispatch()).state,'processed');assert.equal(h.sends,1);assert.equal(h.saves,3);
  assert.equal(h.calls[1].args.p_wamid,'wamid.test');
});
test('failed acknowledgement stops with one Graph call and no automatic retry',async()=>{
  const h=harness({failSaves:3});await assert.rejects(h.dispatch(),/recording is incomplete/);assert.equal(h.sends,1);assert.equal(h.saves,3);
});
test('network uncertainty becomes review rather than a resendable failure',async()=>{
  const h=harness({throwSend:true});assert.equal((await h.dispatch()).state,'review');assert.equal(h.sends,1);assert.equal(h.calls[1].args.p_uncertain,true);
});
test('known Meta rejection remains failed and its code is saved',async()=>{
  const h=harness({result:{ok:false,wamid:null,error:'(#130429) Synthetic rate limit'}});await h.dispatch();
  assert.equal(h.calls[1].args.p_uncertain,false);assert.match(h.calls[1].args.p_error,/130429/);assert.equal(h.sends,1);
});
test('sender identity change prevents the Graph call',async()=>{
  const h=harness({phoneId:'9999999999999'});await h.dispatch();assert.equal(h.sends,0);assert.match(h.calls[1].args.p_error,/No message was sent/);
});
test('malformed claim cannot call Meta',async()=>{
  const h=harness({state:{...claim,phone:'not-a-phone'}});await assert.rejects(h.dispatch());assert.equal(h.sends,0);
});
