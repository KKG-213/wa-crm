import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { dispatchCampaign } from '../src/lib/campaign-dispatch.ts';
import { createMetaClient } from '../src/lib/meta-template.ts';

test('durable campaign queue SQL', async (t) => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE PUBLICATION supabase_realtime; CREATE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql AS 'SELECT gen_random_uuid()';`);
    const load = (name) => readFile(new URL('../database/' + name, import.meta.url), 'utf8');
    const schema = (await load('schema.sql')).replace(/^CREATE EXTENSION.*$/gm, '').replace(/^CREATE INDEX IF NOT EXISTS idx_contacts_name_trgm.*$/gm, '');
    await db.exec(schema);
    for (const file of ['webhook-sync.sql','hermes-outbound-sync.sql','whatsapp-delivery-errors.sql','whatsapp-campaign-queue.sql']) await db.exec(await load(file));
    const migration = await load('whatsapp-campaign-queue.sql'); await db.exec(migration);
    const rows = async (sql, args=[]) => (await db.query(sql,args)).rows;
    const phoneId='1409792945541835';
    const enqueue = async (contacts=[{phone:'+919000000001'}], key=randomUUID(), fingerprint='a'.repeat(64)) =>
      (await rows('SELECT enqueue_whatsapp_campaign($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb) AS result',
        [key,fingerprint,'Synthetic queue','web_design_request','en',phoneId,JSON.stringify([{type:'header',parameters:[{type:'image',image:{link:'https://example.com/poster.png'}}]}]),'https://example.com/poster.png',JSON.stringify(contacts)]))[0].result;
    const claim = async (id) => (await rows('SELECT claim_whatsapp_campaign_message($1) AS result',[id]))[0].result;
    const complete = async (job, id='wamid.'+job.log_id, error=null, uncertain=false) =>
      (await rows('SELECT complete_whatsapp_campaign_message($1,$2,$3,$4,$5) AS result',[job.log_id,job.dispatch_token,id,error,uncertain]))[0].result;
    const ready = () => rows("UPDATE whatsapp_campaign_senders SET next_send_at=now()-interval '1 second',paused_until=NULL WHERE phone_number_id=$1",[phoneId]);
    const receipt = (id,status,error=null) => rows('SELECT record_whatsapp_status_with_queue($1,$2,$3,now(),$4)',[phoneId,id,status,error]);
    const log = async (id) => (await rows('SELECT * FROM campaign_logs WHERE id=$1',[id]))[0];

    await t.test('enqueue is idempotent and preserves existing contact metadata/STOP', async () => {
      await rows("INSERT INTO contacts(phone,name,status) VALUES ('+919000000001','Existing name','active'),('+919000000002','Stopped','blocked')");
      const key=randomUUID(); const list=[{phone:'+919000000001',name:'Replacement'},{phone:'+919000000002'},{phone:'+919000000001'}];
      const first=await enqueue(list,key); const again=await enqueue(list,key);
      assert.equal(first.campaign_id,again.campaign_id); assert.equal(first.queued,1); assert.equal(first.skipped,1);
      assert.equal((await rows('SELECT * FROM campaign_logs WHERE campaign_id=$1',[first.campaign_id])).length,2);
      assert.equal((await rows("SELECT name FROM contacts WHERE phone='+919000000001'"))[0].name,'Existing name');
      await assert.rejects(enqueue(list,key,'b'.repeat(64)),/request conflict/);
    });
    await t.test('all campaigns share one in-flight slot and pacing persists between requests', async () => {
      const a=await enqueue(); const b=await enqueue([{phone:'+919000000003'}]);
      const job=await claim(a.campaign_id); assert.equal(job.state,'claimed');
      assert.equal((await claim(b.campaign_id)).state,'wait');
      await complete(job); assert.equal((await claim(b.campaign_id)).state,'wait');
      await ready(); const next=await claim(b.campaign_id); assert.equal(next.state,'claimed'); await complete(next);
    });
    await t.test('completion retries never create duplicate message records or downgrade receipts', async () => {
      await ready(); const campaign=await enqueue(); const job=await claim(campaign.campaign_id); const id='wamid.idempotent';
      await complete(job,id); await receipt(id,'read'); await complete(job,id);
      assert.equal((await rows('SELECT * FROM messages WHERE wamid=$1',[id])).length,1);
      assert.equal((await log(job.log_id)).status,'read');
    });
    await t.test('early failed receipt reconciles on wamid update and pauses queued recipients', async () => {
      await ready(); const c=await enqueue([{phone:'+919000000004'},{phone:'+919000000005'}]); const job=await claim(c.campaign_id);
      await receipt('wamid.rate.early','failed','(#130429) Synthetic rate limit');
      const done=await complete(job,'wamid.rate.early');
      assert.equal((await log(job.log_id)).status,'failed'); assert.match((await log(job.log_id)).error_message,/130429/);
      assert.equal(done.failed,1); assert.equal(done.queued,1);
      const paused=await claim(c.campaign_id); assert.equal(paused.state,'paused');
      assert.equal((await rows('SELECT rate_strikes FROM whatsapp_campaign_senders WHERE phone_number_id=$1',[phoneId]))[0].rate_strikes,1);
      await receipt('wamid.rate.early','failed','(#130429) Synthetic rate limit');
      assert.equal((await rows('SELECT rate_strikes FROM whatsapp_campaign_senders WHERE phone_number_id=$1',[phoneId]))[0].rate_strikes,1);
    });
    await t.test('a synchronous rate rejection is recorded once and leaves the rest queued', async () => {
      await ready(); const c=await enqueue([{phone:'+919000000006'},{phone:'+919000000007'}]); const job=await claim(c.campaign_id);
      await complete(job,null,'(#130429) Synthetic rate limit');
      const strikes=(await rows('SELECT rate_strikes FROM whatsapp_campaign_senders WHERE phone_number_id=$1',[phoneId]))[0].rate_strikes;
      await complete(job,null,'(#130429) Synthetic rate limit');
      assert.equal((await claim(c.campaign_id)).state,'paused');
      assert.equal((await rows('SELECT rate_strikes FROM whatsapp_campaign_senders WHERE phone_number_id=$1',[phoneId]))[0].rate_strikes,strikes);
    });
    await t.test('131026 is a final failure, without automatic requeue or sender cooldown', async () => {
      await ready(); const c=await enqueue(); const job=await claim(c.campaign_id);
      await complete(job,null,'(#131026) Synthetic undeliverable'); await ready();
      assert.equal((await claim(c.campaign_id)).state,'done'); assert.equal((await log(job.log_id)).status,'failed');
    });
    await t.test('a finished one-recipient campaign reports done while the sender remains rate-paused',async()=>{
      await ready();const c=await enqueue();const job=await claim(c.campaign_id);
      await complete(job,null,'(#130429) Synthetic rate limit');
      const result=await claim(c.campaign_id);assert.equal(result.state,'done');assert.equal(result.summary.failed,1);
    });
    await t.test('STOP received after queue creation suppresses the unsent job', async () => {
      await ready(); const c=await enqueue([{phone:'+919000000008'}]);
      await rows("UPDATE contacts SET status='blocked' WHERE phone='+919000000008'");
      const result=await claim(c.campaign_id); assert.equal(result.state,'done'); assert.equal(result.summary.skipped,1);
      assert.equal(result.summary.accepted,0);
    });
    await t.test('unknown acceptance is retained for review and is never reclaimed', async () => {
      await ready(); const c=await enqueue(); const job=await claim(c.campaign_id);
      const result=await complete(job,null,'Synthetic timeout',true); assert.equal(result.uncertain,1);
      await ready(); assert.equal((await claim(c.campaign_id)).state,'done');
      assert.equal((await rows('SELECT * FROM messages WHERE campaign_id=$1',[c.campaign_id])).length,0);
    });
    await t.test('expired in-flight work becomes uncertain; a late ack cannot clear another lease', async () => {
      await ready(); const c=await enqueue([{phone:'+919000000009'},{phone:'+919000000010'}]); const old=await claim(c.campaign_id);
      await rows("UPDATE whatsapp_campaign_senders SET lease_until=now()-interval '1 second',next_send_at=now()-interval '1 second' WHERE phone_number_id=$1",[phoneId]);
      assert.equal((await claim(c.campaign_id)).state,'review');
      const next=await claim(c.campaign_id); assert.equal(next.state,'claimed'); assert.notEqual(next.log_id,old.log_id);
      await complete(old,'wamid.late.ack');
      assert.equal((await rows('SELECT inflight_log FROM whatsapp_campaign_senders WHERE phone_number_id=$1',[phoneId]))[0].inflight_log,next.log_id);
      await complete(next);
    });
    await t.test('wrong dispatch token cannot complete or release the current send', async () => {
      await ready(); const c=await enqueue(); const job=await claim(c.campaign_id);
      await assert.rejects(complete({...job,dispatch_token:randomUUID()}),/token mismatch/);
      assert.equal((await log(job.log_id)).status,'sending'); await complete(job);
    });
    await t.test('stale rate failure after read does not pause the sender', async () => {
      await ready(); await receipt('wamid.idempotent','failed','(#130429) Late failure');
      assert.equal((await rows('SELECT paused_until FROM whatsapp_campaign_senders WHERE phone_number_id=$1',[phoneId]))[0].paused_until,null);
    });
    await t.test('real queue and dispatcher send the stored image once then stop on rate limit', async () => {
      await ready();const c=await enqueue([{phone:'+919000000012'},{phone:'+919000000013'}]);let sends=0;
      const client=createMetaClient({accessToken:'synthetic',phoneNumberId:phoneId},async(_url,init)=>{
        sends++;assert.equal(JSON.parse(init.body).template.components[0].parameters[0].image.link,'https://example.com/poster.png');
        return Response.json({error:{code:130429,message:'Synthetic rate limit'}},{status:400});
      });
      const rpc=async(name,args)=>{
        if(name==='claim_whatsapp_campaign_message')return {data:await claim(args.p_campaign_id),error:null};
        const job={log_id:args.p_log_id,dispatch_token:args.p_token};
        return {data:await complete(job,args.p_wamid,args.p_error,args.p_uncertain),error:null};
      };
      const deps={phoneNumberId:phoneId,rpc,send:j=>client.template(j.phone,j.template,j.language,j.components)};
      const first=await dispatchCampaign(c.campaign_id,deps);assert.equal(first.summary.failed,1);assert.equal(first.summary.queued,1);
      assert.equal((await dispatchCampaign(c.campaign_id,deps)).state,'paused');assert.equal(sends,1);
    });
    await t.test('repeated rate events increase the cooldown with a one-hour cap',async()=>{
      for(let i=0;i<10;i++)await receipt('wamid.backoff.'+i,'failed','(#130429) Synthetic rate limit');
      const [gate]=await rows('SELECT rate_strikes,extract(epoch FROM paused_until-now()) AS seconds FROM whatsapp_campaign_senders WHERE phone_number_id=$1',[phoneId]);
      assert.equal(gate.rate_strikes,7);assert.ok(Number(gate.seconds)>3590&&Number(gate.seconds)<=3600);
    });
    await t.test('service-only controls, migration rerun and legacy recorder stay compatible', async () => {
      await db.exec(migration);
      await rows("SELECT record_whatsapp_outbound('+919000000011','wamid.legacy.queue-test','Reply',now())");
      assert.equal((await rows("SELECT status FROM messages WHERE wamid='wamid.legacy.queue-test'"))[0].status,'sent');
      for (const role of ['anon','authenticated']) {
        await db.exec(`SET ROLE ${role}`);
        try {
          await assert.rejects(enqueue(),/permission denied/);
          await assert.rejects(rows('SELECT * FROM whatsapp_campaign_senders'),/permission denied/);
          await assert.rejects(rows('SELECT claim_whatsapp_campaign_message($1)',[randomUUID()]),/permission denied/);
          await assert.rejects(rows('SELECT complete_whatsapp_campaign_message($1,$2,NULL,NULL,false)',[randomUUID(),randomUUID()]),/permission denied/);
          await assert.rejects(receipt('wamid.forged','failed','(#130429) Forged'),/permission denied/);
        } finally { await db.exec('RESET ROLE'); }
      }
      await db.exec('SET ROLE service_role');
      try { assert.equal((await rows('SELECT whatsapp_campaign_queue_version() AS version'))[0].version,1); }
      finally { await db.exec('RESET ROLE'); }
    });
  } finally { await db.close(); }
});
