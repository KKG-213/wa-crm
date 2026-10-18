import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createWhatsAppWebhook, signMetaBody } from '../src/lib/whatsapp-webhook.ts';

test('Postgres migration and webhook persistence', async (t) => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE PUBLICATION supabase_realtime;
      CREATE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql AS 'SELECT gen_random_uuid()';`);
    const schema = (await readFile(new URL('../database/schema.sql', import.meta.url), 'utf8'))
      .replace(/^CREATE EXTENSION.*$/gm, '')
      .replace(/^CREATE INDEX IF NOT EXISTS idx_contacts_name_trgm.*$/gm, '');
    await db.exec(schema);
    const migration = await readFile(new URL('../database/webhook-sync.sql', import.meta.url), 'utf8');
    await db.exec(migration); await db.exec(migration);
    const query = async (sql, args = []) => (await db.query(sql, args)).rows;
    const inbound = async (phone, name, id, content, at = '2026-10-17T10:00:00Z') =>
      (await query('SELECT public.record_whatsapp_inbound($1,$2,$3,$4,$5::timestamptz) AS result', [phone, name, id, content, at]))[0].result;
    const status = (id, state, at = '2026-10-17T11:00:00Z') => query('SELECT public.record_whatsapp_status($1,$2,$3::timestamptz)', [id, state, at]);

    await t.test('migration is rerunnable and all inbox tables are published once', async () => {
      const rows = await query("SELECT tablename FROM pg_publication_tables WHERE pubname='supabase_realtime' ORDER BY tablename");
      assert.deepEqual(rows.map((r) => r.tablename), ['campaigns', 'contacts', 'messages']);
    });
    await t.test('duplicates never increment counts; custom contact metadata survives', async () => {
      await query("INSERT INTO contacts(phone,name,email,tags) VALUES ('+919000000001','Custom name','customer@example.test',ARRAY['lead'])");
      assert.deepEqual(await inbound('+919000000001', 'WhatsApp name', 'wamid.1', 'DEMO'), { inserted: true, forward_allowed: true });
      assert.deepEqual(await inbound('+919000000001', 'WhatsApp name', 'wamid.1', 'DEMO'), { inserted: false, forward_allowed: true });
      await inbound('+919000000001', null, 'wamid.old', 'Old event', '2026-10-16T10:00:00Z');
      const [contact] = await query("SELECT * FROM contacts WHERE phone='+919000000001'");
      assert.equal(contact.message_count, 2); assert.equal(contact.name, 'Custom name'); assert.equal(contact.email, 'customer@example.test'); assert.deepEqual(contact.tags, ['lead']);
      assert.equal(new Date(contact.last_message_at).toISOString(), '2026-10-17T10:00:00.000Z');
    });
    await t.test('STOP blocks current and later replies without reactivating contact', async () => {
      assert.deepEqual(await inbound('+919000000001', null, 'wamid.stop', '  StOp  '), { inserted: true, forward_allowed: false });
      assert.deepEqual(await inbound('+919000000001', null, 'wamid.after-stop', 'Hi again'), { inserted: true, forward_allowed: false });
      const [contact] = await query("SELECT status,message_count FROM contacts WHERE phone='+919000000001'");
      assert.equal(contact.status, 'blocked'); assert.equal(contact.message_count, 4);
    });
    await t.test('a conflicting message ID rolls back contact creation and counter writes', async () => {
      await assert.rejects(inbound('+919000000099', null, 'wamid.1', 'Wrong owner'), /different contact/);
      assert.equal((await query("SELECT * FROM contacts WHERE phone='+919000000099'")).length, 0);
    });
    await t.test('only the service role can call privileged webhook RPCs', async () => {
      await db.exec('SET ROLE authenticated');
      try {
        await assert.rejects(inbound('+919000000099', null, 'unauthorized', 'test'), /permission denied for function/);
        await assert.rejects(status('anything', 'read'), /permission denied for function/);
      } finally { await db.exec('RESET ROLE'); }
      await db.exec('SET ROLE service_role');
      try { assert.equal((await inbound('+919000000003', null, 'service-role', 'Hi')).inserted, true); }
      finally { await db.exec('RESET ROLE'); }
    });
    await t.test('duplicate/reordered delivery events do not downgrade status or double count', async () => {
      const [contact] = await query("SELECT id FROM contacts WHERE phone='+919000000003'");
      const [campaign] = await query("INSERT INTO campaigns(name,template_name,sent_count) VALUES ('Test','test_template',1) RETURNING id");
      await query("INSERT INTO messages(contact_id,campaign_id,wamid,direction,content) VALUES ($1,$2,'outbound.1','outbound','Test')", [contact.id, campaign.id]);
      await query("INSERT INTO campaign_logs(campaign_id,contact_id,wamid,status) VALUES ($1,$2,'outbound.1','sent')", [campaign.id, contact.id]);
      await status('outbound.1', 'read'); await status('outbound.1', 'read');
      await status('outbound.1', 'delivered', '2026-10-17T10:59:00Z');
      await status('outbound.1', 'sent'); await status('outbound.1', 'failed');
      const [message] = await query("SELECT * FROM messages WHERE wamid='outbound.1'");
      assert.equal(message.status, 'read'); assert.ok(message.delivered_at); assert.ok(message.read_at);
      const [counts] = await query('SELECT delivered_count,read_count,failed_count,sent_count FROM campaigns WHERE id=$1', [campaign.id]);
      assert.deepEqual(counts, { delivered_count: 1, read_count: 1, failed_count: 0, sent_count: 1 });
    });
    await t.test('failure receipts count once and recovery cannot leave a failed counter behind', async () => {
      const [contact] = await query("SELECT id FROM contacts WHERE phone='+919000000003'");
      const [campaign] = await query("INSERT INTO campaigns(name,template_name,sent_count) VALUES ('Failure','test_template',1) RETURNING id");
      await query("INSERT INTO campaign_logs(campaign_id,contact_id,wamid,status) VALUES ($1,$2,'outbound.failure','sent')", [campaign.id, contact.id]);
      await status('outbound.failure', 'failed'); await status('outbound.failure', 'failed'); await status('outbound.failure', 'sent');
      assert.equal((await query('SELECT failed_count FROM campaigns WHERE id=$1', [campaign.id]))[0].failed_count, 1);
      await status('outbound.failure', 'read'); await status('outbound.failure', 'read');
      assert.deepEqual((await query('SELECT failed_count,delivered_count,read_count FROM campaigns WHERE id=$1', [campaign.id]))[0], { failed_count: 0, delivered_count: 1, read_count: 1 });
      await status('unknown-hermes-id', 'delivered');
    });
    await t.test('real signed webhook + SQL persists once across a failed relay and retry', async () => {
      const secret = 'integration-test-only'; let relays = 0;
      const handler = createWhatsAppWebhook({ appSecret: secret, wabaId: 'waba', phoneNumberId: 'phone', hermesWebhookUrl: 'https://hermes.example/webhook' }, {
        createStore: () => ({
          saveInbound: async (m) => { const result = await inbound(m.phone, m.name, m.wamid, m.content, m.sentAt); return { inserted: result.inserted, forwardAllowed: result.forward_allowed }; },
          saveStatus: (s) => status(s.wamid, s.status, s.at),
        }),
        fetch: async () => new Response('', { status: ++relays === 1 ? 503 : 200 }), logger: { error() {} },
      });
      const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'phone' }, messages: [{ id: 'wamid.integration', from: '919000000004', timestamp: '1791624000', type: 'button', button: { text: 'PRICE' } }] } }] }] });
      const send = () => handler.POST(new Request('https://crm.example/api/webhook', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': signMetaBody(raw, secret) } }));
      assert.equal((await send()).status, 502); assert.equal((await send()).status, 200);
      assert.equal(relays, 2);
      assert.equal((await query("SELECT message_count FROM contacts WHERE phone='+919000000004'"))[0].message_count, 1);
      assert.equal((await query("SELECT content FROM messages WHERE wamid='wamid.integration'"))[0].content, 'PRICE');
    });
  } finally { await db.close(); }
});
