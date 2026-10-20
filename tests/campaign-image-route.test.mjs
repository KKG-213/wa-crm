import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { z } from 'zod';
import * as templates from '../src/lib/meta-template.ts';
import * as phones from '../src/lib/campaign-contacts.ts';

const definition = { name: 'web_design_request', language: 'en', status: 'APPROVED', components: [
  { type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Website and SEO' },
] };
const source = await readFile(new URL('../src/app/api/campaigns/route.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

class Store {
  writes = []; contacts = []; statuses = new Map(); rpcCalls = []; deliveryVersion = 1; logError = false;
  async rpc(name, args) {
    this.rpcCalls.push({ name, args });
    if (name === 'whatsapp_delivery_sync_version') return { data: this.deliveryVersion, error: null };
    if (name === 'finish_whatsapp_campaign') return { data: {}, error: null };
    throw new Error(`Unexpected RPC ${name}`);
  }
  from(table) {
    const store = this;
    const query = {
      operation: '', filter: '', values: null,
      insert(values) { this.operation = 'insert'; this.values = values; store.writes.push({ table, operation: 'insert', values }); return this; },
      upsert(values) { this.operation = 'upsert'; store.contacts = values.map((value, index) => ({ ...value, id: `contact-${index}`, status: store.statuses.get(`contact-${index}`) ?? 'active' })); return this; },
      update(values) { this.operation = 'update'; this.values = values; store.writes.push({ table, operation: 'update', values }); return this; },
      select() { return this; }, eq(_key, value) { this.filter = value; return this; },
      result() {
        if (table === 'campaign_logs' && store.logError) return { data: null, error: { message: 'Test database failure' } };
        if (table === 'campaigns' && this.operation === 'insert') return { data: { id: 'campaign-test' }, error: null };
        if (table === 'contacts' && this.operation === 'upsert') return { data: store.contacts, error: null };
        if (table === 'contacts' && this.operation === '') return { data: { status: store.statuses.get(this.filter) ?? 'active' }, error: null };
        if (table === 'campaign_logs' && this.values?.media_url) throw new Error('campaign_logs has no media_url column');
        return { data: null, error: null };
      },
      async single() { return this.result(); },
      then(resolve, reject) { return Promise.resolve().then(() => this.result()).then(resolve, reject); },
    };
    return query;
  }
}

function harness({ definitions = [definition], fail = false, afterSend } = {}) {
  const store = new Store(); const requests = [];
  const client = templates.createMetaClient({ accessToken: 'test-only', phoneNumberId: 'test-phone', wabaId: 'test-waba' }, async (url, init) => {
    if (new URL(url).pathname.endsWith('/message_templates')) return Response.json({ data: definitions });
    requests.push(JSON.parse(init.body)); afterSend?.(store);
    return fail ? Response.json({ error: { code: 132012, message: 'Parameter format mismatch', error_data: { details: 'expected IMAGE' } } }, { status: 400 })
      : Response.json({ messages: [{ id: `wamid.${requests.length}` }] });
  });
  const exports = {};
  const imports = {
    'next/server': { NextResponse: { json: (value, init) => Response.json(value, init) } },
    '@/lib/supabase/server': { createAdminClient: async () => store },
    '@/services/meta': { getApprovedWhatsAppTemplates: client.templates, sendWhatsAppTemplate: client.template },
    '@/lib/meta-template': templates, '@/lib/campaign-contacts': phones, zod: { z },
  };
  vm.runInNewContext(compiled, { exports, Error, require: (name) => {
    if (!(name in imports)) throw new Error(`Unexpected import ${name}`); return imports[name];
  }, console: { error() {} } });
  return { store, requests, send: (payload) => exports.POST(new Request('https://crm.example/api/campaigns', { method: 'POST', body: JSON.stringify(payload) })) };
}

const payload = { campaign_name: 'Image template test', template_name: 'web_design_request', template_language: 'en',
  header_image_url: 'https://example.com/poster.png', contacts: [{ phone: '+919000000001', name: 'Test contact' }] };

test('actual campaign route rejects missing image before any database write or send', async () => {
  const app = harness();
  const response = await app.send({ ...payload, header_image_url: '' });
  assert.equal(response.status, 400); assert.match((await response.json()).error, /requires a header image/);
  assert.equal(app.store.writes.length, 0); assert.equal(app.requests.length, 0);
});

test('approved exact language and supported header must validate before a campaign is created', async () => {
  for (const settings of [{ input: { template_language: 'en_US' } },
    { definitions: [{ ...definition, components: [{ type: 'HEADER', format: 'VIDEO' }] }] },
    { input: { contacts: [{ phone: '0000000000' }] } }]) {
    const app = harness(settings);
    const response = await app.send({ ...payload, ...settings.input });
    assert.equal(response.status, 400); assert.equal(app.store.writes.length, 0); assert.equal(app.requests.length, 0);
  }
});

test('actual campaign route sends the header, deduplicates normalized phones and stores media only on messages', async () => {
  const app = harness();
  const response = await app.send({ ...payload, contacts: [{ phone: '09000000001' }, { phone: '+919000000001' }] });
  assert.equal(response.status, 200); assert.equal((await response.json()).sent, 1);
  assert.equal(app.requests.length, 1); assert.equal(app.requests[0].to, '919000000001');
  assert.equal(app.requests[0].template.components[0].parameters[0].image.link, payload.header_image_url);
  const log = app.store.writes.find((row) => row.table === 'campaign_logs').values;
  const message = app.store.writes.find((row) => row.table === 'messages').values;
  assert.equal(log.wamid, 'wamid.1'); assert.equal(log.media_url, undefined);
  assert.equal(message.media_url, payload.header_image_url); assert.equal(message.status, 'sent');
});

test('all-rejected campaign keeps the useful error and finalizes from persisted logs', async () => {
  const app = harness({ fail: true });
  const response = await app.send(payload); const result = await response.json();
  assert.equal(result.success, false); assert.equal(result.sent, 0); assert.equal(result.failed, 1);
  assert.match(result.first_error, /expected IMAGE/);
  const log = app.store.writes.find((row) => row.table === 'campaign_logs').values;
  assert.equal(log.status, 'failed'); assert.match(log.error_message, /expected IMAGE/);
  assert.deepEqual(JSON.parse(JSON.stringify(app.store.rpcCalls.at(-1))), { name: 'finish_whatsapp_campaign', args: { p_campaign_id: 'campaign-test' } });
  assert.equal(app.store.writes.some((row) => row.table === 'campaigns' && 'failed_count' in row.values), false, 'local counts must not overwrite webhook counts');
});

test('missing delivery migration fails before campaign creation or a Meta send', async () => {
  const app = harness(); app.store.deliveryVersion = null;
  const response = await app.send(payload);
  assert.equal(response.status, 503); assert.match((await response.json()).error, /whatsapp-delivery-errors.sql/);
  assert.equal(app.store.writes.length, 0); assert.equal(app.requests.length, 0);
});

test('a database write failure after a send is reported without resending', async () => {
  const app = harness(); app.store.logError = true;
  const response = await app.send(payload);
  assert.equal(response.status, 500); assert.match((await response.json()).error, /Check delivery before retrying/);
  assert.equal(app.requests.length, 1); assert.equal(app.store.rpcCalls.some((call) => call.name === 'finish_whatsapp_campaign'), false);
});

test('STOP status recheck still suppresses a contact blocked while the campaign runs', async () => {
  const app = harness({ afterSend: (store) => store.statuses.set('contact-1', 'blocked') });
  const result = await (await app.send({ ...payload, contacts: [{ phone: '+919000000001' }, { phone: '+919000000002' }] })).json();
  assert.equal(app.requests.length, 1); assert.equal(result.sent, 1); assert.equal(result.skipped, 1);
});
