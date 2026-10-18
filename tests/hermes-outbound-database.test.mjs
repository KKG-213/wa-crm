import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createHermesOutboundHandler, signHermesOutbound } from '../src/lib/hermes-outbound.ts';

test('Hermes outgoing database migration', async (t) => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE PUBLICATION supabase_realtime;
      CREATE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql AS 'SELECT gen_random_uuid()';`);
    const load = (name) => readFile(new URL('../database/' + name, import.meta.url), 'utf8');
    const schema = (await load('schema.sql')).replace(/^CREATE EXTENSION.*$/gm, '').replace(/^CREATE INDEX IF NOT EXISTS idx_contacts_name_trgm.*$/gm, '');
    await db.exec(schema); await db.exec(await load('webhook-sync.sql'));
    const migration = await load('hermes-outbound-sync.sql');
    await db.exec(migration); await db.exec(migration);
    const query = async (sql, args = []) => (await db.query(sql, args)).rows;
    const outbound = async (id, content = 'Actual sent text', phone = '+919000000001', at = '2026-10-18T05:00:00Z') =>
      (await query('SELECT record_whatsapp_outbound($1,$2,$3,$4::timestamptz) AS result', [phone, id, content, at]))[0].result;
    const status = (id, value, at = '2026-10-18T05:00:10Z') => query('SELECT record_whatsapp_status($1,$2,$3::timestamptz)', [id, value, at]);
    await t.test('new outgoing rows preserve contact metadata and count unique IDs once', async () => {
      await query("INSERT INTO contacts(phone,name,email,tags,status) VALUES ('+919000000001','Custom name','lead@example.test',ARRAY['lead'],'blocked')");
      assert.deepEqual(await outbound('wamid.out.1'), { inserted: true });
      assert.deepEqual(await outbound('wamid.out.1'), { inserted: false });
      await outbound('wamid.out.old', 'Old text', '+919000000001', '2026-10-17T05:00:00Z');
      const [contact] = await query("SELECT * FROM contacts WHERE phone='+919000000001'");
      assert.equal(contact.name, 'Custom name'); assert.equal(contact.status, 'blocked'); assert.equal(contact.message_count, 2); assert.deepEqual(contact.tags, ['lead']);
      assert.equal(new Date(contact.last_message_at).toISOString(), '2026-10-18T05:00:00.000Z');
    });
    await t.test('same ID with another recipient/content cannot overwrite the original', async () => {
      await assert.rejects(outbound('wamid.out.1', 'Changed text'), /ID conflict/);
      await assert.rejects(outbound('wamid.out.1', 'Actual sent text', '+919000000099'), /ID conflict/);
      assert.equal((await query("SELECT FROM contacts WHERE phone='+919000000099'")).length, 0);
    });
    await t.test('early read/delivery receipts reconcile when Hermes reply is inserted later', async () => {
      await status('wamid.early', 'read'); await status('wamid.early', 'read');
      await status('wamid.early', 'delivered', '2026-10-18T05:00:05Z');
      assert.equal((await query("SELECT * FROM whatsapp_pending_statuses WHERE wamid='wamid.early'")).length, 2);
      await outbound('wamid.early');
      const [row] = await query("SELECT status,delivered_at,read_at FROM messages WHERE wamid='wamid.early'");
      assert.equal(row.status, 'read'); assert.equal(new Date(row.delivered_at).toISOString(), '2026-10-18T05:00:05.000Z'); assert.ok(row.read_at);
      assert.equal((await query("SELECT FROM whatsapp_pending_statuses WHERE wamid='wamid.early'")).length, 0);
      await outbound('wamid.early'); await status('wamid.early', 'sent'); await status('wamid.early', 'failed');
      assert.equal((await query("SELECT status FROM messages WHERE wamid='wamid.early'"))[0].status, 'read');
    });
    await t.test('insert trigger also reconciles existing CRM sends and campaign counters once', async () => {
      const [contact] = await query("SELECT id FROM contacts WHERE phone='+919000000001'");
      const [campaign] = await query("INSERT INTO campaigns(name,template_name,sent_count) VALUES ('Test','test_template',1) RETURNING id");
      await status('wamid.campaign', 'read');
      await query("INSERT INTO campaign_logs(campaign_id,contact_id,wamid,status) VALUES ($1,$2,'wamid.campaign','sent')", [campaign.id, contact.id]);
      await query("INSERT INTO messages(contact_id,campaign_id,wamid,direction,content) VALUES ($1,$2,'wamid.campaign','outbound','Campaign')", [contact.id, campaign.id]);
      await status('wamid.campaign', 'read'); await status('wamid.campaign', 'sent');
      assert.deepEqual((await query('SELECT delivered_count,read_count,failed_count FROM campaigns WHERE id=$1', [campaign.id]))[0], { delivered_count: 1, read_count: 1, failed_count: 0 });
    });
    await t.test('ordinary authenticated users cannot forge outgoing records or read pending receipts', async () => {
      await db.exec('SET ROLE authenticated');
      try {
        await assert.rejects(outbound('wamid.unauthorized'), /permission denied/);
        await assert.rejects(query('SELECT * FROM whatsapp_pending_statuses'), /permission denied/);
        await assert.rejects(query("SELECT flush_whatsapp_pending_statuses('anything')"), /permission denied/);
      } finally { await db.exec('RESET ROLE'); }
      await db.exec('SET ROLE service_role');
      try { assert.equal((await outbound('wamid.service-role')).inserted, true); }
      finally { await db.exec('RESET ROLE'); }
    });
    await t.test('old unmatched receipts are pruned on subsequent receipt activity', async () => {
      await status('wamid.expired', 'sent');
      await query("UPDATE whatsapp_pending_statuses SET received_at=now()-interval '8 days' WHERE wamid='wamid.expired'");
      await status('wamid.fresh', 'sent');
      assert.equal((await query("SELECT FROM whatsapp_pending_statuses WHERE wamid='wamid.expired'")).length, 0);
    });
    await t.test('signed endpoint and real SQL save full reply once across a retry', async () => {
      const secret = 'integration-test-secret';
      const handler = createHermesOutboundHandler({ appSecret: secret, phoneNumberId: '1409792945541835' }, {
        createStore: () => ({ save: async (m) => (await outbound(m.wamid, m.content, '+' + m.recipient, m.sent_at)).inserted }),
      });
      const raw = JSON.stringify({ version: 1, phone_number_id: '1409792945541835', recipient: '919000000002', wamid: 'wamid.signed.integration', content: 'नमस्ते 👋 ' + 'Full reply. '.repeat(100), message_type: 'text', sent_at: '2026-10-18T05:00:00Z' });
      const send = () => handler(new Request('https://crm.example/api/hermes/outbound', { method: 'POST', body: raw, headers: { 'x-hermes-signature-256': signHermesOutbound(raw, secret) } }));
      const first = await send(); const again = await send();
      assert.equal(first.status, 200); assert.equal((await again.json()).inserted, false);
      const [row] = await query("SELECT content,direction FROM messages WHERE wamid='wamid.signed.integration'");
      assert.equal(row.content, JSON.parse(raw).content); assert.equal(row.direction, 'outbound');
      assert.equal((await query("SELECT message_count FROM contacts WHERE phone='+919000000002'"))[0].message_count, 1);
    });
  } finally { await db.close(); }
});
