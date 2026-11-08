import test from 'node:test';
import assert from 'node:assert/strict';
import { workerAuthorized, workerCampaignIds, runCampaignWorker } from '../src/lib/campaign-worker.ts';
const secret = 'x'.repeat(32);
test('worker rejects missing, short and incorrect credentials', () => {
  for (const [header, key] of [[null, secret], ['Bearer undefined', undefined], ['Bearer short', 'short'], ['Bearer '+ 'y'.repeat(32),secret]]) assert.equal(workerAuthorized(header,key),false);
  assert.equal(workerAuthorized(`Bearer ${secret}`,secret),true);
});
test('worker is disabled by default and rejects invalid campaign lists', () => {
  assert.deepEqual(workerCampaignIds(),[]);
  const id='1955bb5d-bbf2-435f-b689-7d82c1a5a941';
  assert.deepEqual(workerCampaignIds(`${id}, ${id}`),[id]);
  assert.throws(()=>workerCampaignIds('all'));
});
test('worker sends at most one recipient and skips completed/review campaigns', async () => {
  const calls=[];
  const result=await runCampaignWorker(['done','review','ready','later'],async id=>{calls.push(id);return {state:id==='ready'?'processed':id};});
  assert.deepEqual(calls,['done','review','ready']);
  assert.equal(result.state,'processed');
});
test('cooldown and pacing end invocation without polling or bypassing gate', async () => {
  for (const state of ['wait','paused']) {
    let calls=0;
    assert.equal((await runCampaignWorker(['a','b'],async()=>{calls++;return {state};})).state,state);
    assert.equal(calls,1);
  }
});
test('recording failure is propagated without another dispatch attempt', async () => {
  let calls=0;
  await assert.rejects(runCampaignWorker(['a','b'],async()=>{calls++;throw new Error('ack failed');}));
  assert.equal(calls,1);
});
