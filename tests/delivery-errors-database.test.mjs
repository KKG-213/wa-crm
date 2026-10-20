import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('delivery error migration and real receipt reconciliation', async (t) => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE PUBLICATION supabase_realtime;
      CREATE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql AS 'SELECT gen_random_uuid()';`);
    const load = (name) => readFile(new URL('../database/' + name, import.meta.url), 'utf8');
    const schema = (await load('schema.sql')).replace(/^CREATE EXTENSION.*$/gm, '')
      .replace(/^CREATE INDEX IF NOT EXISTS idx_contacts_name_trgm.*$/gm, '');
    await db.exec(schema);
    await db.exec(await load('webhook-sync.sql'));
    await db.exec(await load('hermes-outbound-sync.sql'));
    const migration = await load('whatsapp-delivery-errors.sql');
    await db.exec(migration); await db.exec(migration);
    const query = async (sql, args = []) => (await db.query(sql, args)).rows;
    const [contact] = await query("INSERT INTO contacts(phone,name) VALUES ('+919000000001','Synthetic test') RETURNING id");
    const makeCampaign = async () => (await query("INSERT INTO campaigns(name,template_name,status,total_contacts,sent_count) VALUES ('Test','test','running',1,1) RETURNING id"))[0].id;
    const addLog = (campaign, id, status = 'sent', error = null) => query('INSERT INTO campaign_logs(campaign_id,contact_id,wamid,status,error_message) VALUES ($1,$2,$3,$4,$5)', [campaign, contact.id, id, status, error]);
    const addMessage = (campaign, id) => query("INSERT INTO messages(contact_id,campaign_id,wamid,direction,content) VALUES ($1,$2,$3,'outbound','Synthetic campaign')", [contact.id, campaign, id]);
    const status = (id, value, error = null, at = '2026-10-20T00:00:10Z') => query('SELECT record_whatsapp_status_with_error($1,$2,$3::timestamptz,$4)', [id, value, at, error]);
    const finish = (id) => query('SELECT finish_whatsapp_campaign($1) AS result', [id]);
    const counts = async (id) => (await query('SELECT total_contacts,sent_count,delivered_count,read_count,failed_count FROM campaigns WHERE id=$1', [id]))[0];
    const log = async (id) => (await query('SELECT status,error_message FROM campaign_logs WHERE wamid=$1', [id]))[0];
    const messageStatus = async (id) => (await query('SELECT status FROM messages WHERE wamid=$1', [id]))[0].status;
    const reason = '(#131026) Synthetic delivery error';

    await t.test('accepted send followed by failure saves reason and counts exactly once', async () => {
      const campaign = await makeCampaign(); const id = 'wamid.delivery.failed';
      await addLog(campaign, id); await addMessage(campaign, id);
      await status(id, 'failed', reason); await status(id, 'failed', null); await status(id, 'sent');
      assert.deepEqual(await log(id), { status: 'failed', error_message: reason });
      assert.equal(await messageStatus(id), 'failed');
      assert.equal((await counts(campaign)).failed_count, 1);
      await finish(campaign); await finish(campaign);
      assert.deepEqual(await counts(campaign), { total_contacts: 1, sent_count: 1, delivered_count: 0, read_count: 0, failed_count: 1 });
    });

    await t.test('receipt before either row replays to the log and then the later message', async () => {
      const campaign = await makeCampaign(); const id = 'wamid.delivery.early';
      await status(id, 'failed', reason);
      await addLog(campaign, id);
      assert.deepEqual(await log(id), { status: 'failed', error_message: reason });
      await addMessage(campaign, id);
      assert.equal(await messageStatus(id), 'failed');
      await finish(campaign);
      assert.equal((await counts(campaign)).failed_count, 1);
      assert.equal((await query('SELECT * FROM whatsapp_pending_statuses WHERE wamid=$1', [id])).length, 1);
    });

    await t.test('receipt between the log and message inserts reaches both rows', async () => {
      const campaign = await makeCampaign(); const id = 'wamid.delivery.between';
      await addLog(campaign, id); await status(id, 'failed', reason); await addMessage(campaign, id);
      assert.equal(await messageStatus(id), 'failed'); assert.equal((await log(id)).error_message, reason);
      await finish(campaign); assert.equal((await counts(campaign)).failed_count, 1);
    });

    await t.test('message-first ordering also replays to a later campaign log', async () => {
      const campaign = await makeCampaign(); const id = 'wamid.delivery.message-first';
      await addMessage(campaign, id); await status(id, 'failed', reason); await addLog(campaign, id);
      assert.equal(await messageStatus(id), 'failed'); assert.equal((await log(id)).error_message, reason);
      assert.equal((await counts(campaign)).failed_count, 1);
    });

    await t.test('recovery clears stale errors and never downgrades read/delivered', async () => {
      const campaign = await makeCampaign(); const id = 'wamid.delivery.recovery';
      await addLog(campaign, id); await addMessage(campaign, id); await status(id, 'failed', reason);
      await status(id, 'read', null, '2026-10-20T00:00:30Z');
      await status(id, 'delivered', null, '2026-10-20T00:00:20Z');
      await status(id, 'failed', 'late duplicate'); await status(id, 'sent');
      assert.deepEqual(await log(id), { status: 'read', error_message: null });
      assert.equal(await messageStatus(id), 'read');
      await finish(campaign);
      assert.deepEqual(await counts(campaign), { total_contacts: 1, sent_count: 1, delivered_count: 1, read_count: 1, failed_count: 0 });
    });

    await t.test('finalization does not erase a failed receipt, before or after it runs', async () => {
      const campaign = await makeCampaign(); const id = 'wamid.delivery.after-finish';
      await addLog(campaign, id); await addMessage(campaign, id); await finish(campaign);
      await status(id, 'failed', reason);
      assert.equal((await counts(campaign)).failed_count, 1);
      await finish(campaign);
      assert.equal((await counts(campaign)).failed_count, 1);
      await status(id, 'delivered', null, '2026-10-20T00:01:00Z');
      assert.equal((await counts(campaign)).failed_count, 0);
      assert.equal((await counts(campaign)).delivered_count, 1);
    });

    await t.test('immediate API rejection and asynchronous failure both count correctly', async () => {
      const campaign = await makeCampaign(); const id = 'wamid.delivery.mixed';
      await addLog(campaign, null, 'failed', '(#132012) Synthetic immediate rejection');
      await addLog(campaign, id); await addMessage(campaign, id); await status(id, 'failed', reason);
      await finish(campaign);
      assert.deepEqual(await counts(campaign), { total_contacts: 2, sent_count: 1, delivered_count: 0, read_count: 0, failed_count: 2 });
    });

    await t.test('missing reasons stay unknown; a later diagnostic fills them without double counting', async () => {
      const campaign = await makeCampaign(); const id = 'wamid.delivery.no-details';
      await addLog(campaign, id); await status(id, 'failed');
      assert.equal((await log(id)).error_message, null);
      await status(id, 'failed', reason); await status(id, 'failed', '');
      assert.equal((await log(id)).error_message, reason);
      assert.equal((await counts(campaign)).failed_count, 1);
      await status('wamid.delivery.bounded', 'failed', 'x'.repeat(3000));
      assert.equal((await query("SELECT length(error_message) AS size FROM whatsapp_pending_statuses WHERE wamid='wamid.delivery.bounded'"))[0].size, 2000);
    });

    await t.test('old three-argument status RPC and Hermes outgoing recorder remain compatible', async () => {
      const id = 'wamid.delivery.hermes';
      await query('SELECT record_whatsapp_status($1,$2,$3::timestamptz)', [id, 'read', '2026-10-20T00:00:10Z']);
      await query('SELECT record_whatsapp_outbound($1,$2,$3,$4::timestamptz)', ['+919000000002', id, 'Synthetic Hermes reply', '2026-10-20T00:00:00Z']);
      assert.equal(await messageStatus(id), 'read');
      await db.exec(migration);
      assert.equal((await log('wamid.delivery.failed')).error_message, reason, 'rerun preserves captured diagnostics');
    });

    await t.test('receipt ledger is private and only service role may record/finalize', async () => {
      const campaign = await makeCampaign();
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`SET ROLE ${role}`);
        try {
          await assert.rejects(status('wamid.denied', 'failed', reason), /permission denied/);
          await assert.rejects(query('SELECT * FROM whatsapp_pending_statuses'), /permission denied/);
          await assert.rejects(finish(campaign), /permission denied/);
          await assert.rejects(query('SELECT whatsapp_delivery_sync_version()'), /permission denied/);
        } finally { await db.exec('RESET ROLE'); }
      }
      await db.exec('SET ROLE service_role');
      try {
        assert.equal((await query('SELECT whatsapp_delivery_sync_version() AS version'))[0].version, 1);
        await status('wamid.service', 'failed', reason); await finish(campaign);
      } finally { await db.exec('RESET ROLE'); }
    });

    await t.test('applied and unmatched receipts expire on later receipt activity', async () => {
      await query("UPDATE whatsapp_pending_statuses SET received_at=now()-interval '8 days' WHERE wamid IN ('wamid.delivery.failed','wamid.delivery.bounded')");
      await status('wamid.delivery.fresh', 'sent');
      assert.equal((await query("SELECT * FROM whatsapp_pending_statuses WHERE wamid IN ('wamid.delivery.failed','wamid.delivery.bounded')")).length, 0);
      assert.equal((await log('wamid.delivery.failed')).error_message, reason, 'campaign diagnostic survives ledger expiry');
    });
  } finally { await db.close(); }
});
