import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as webhook from '../src/lib/whatsapp-webhook.ts';
import { campaignDeliveryState } from '../src/lib/campaign-delivery.ts';

const errors = [{ code: 131026, title: 'Message undeliverable', message: 'Message undeliverable',
  error_data: { details: 'Synthetic delivery failure for this test.' }, debug: 'must not be saved', recipient_id: 'must not be saved' }];

test('failed receipt diagnostics preserve code/details and omit unrelated payload fields', () => {
  assert.equal(webhook.deliveryErrorMessage(errors), '(#131026) Message undeliverable — Synthetic delivery failure for this test.');
  for (const value of [undefined, null, {}, [], [null, {}, 'invalid']]) assert.equal(webhook.deliveryErrorMessage(value), null);
});

test('diagnostics are bounded and redact token-shaped values before persistence', () => {
  const input = [{ code: 1, message: 'EAA' + 'X'.repeat(30) + ' eyJabc.def.ghi Bearer private-value access_token=private-key\n' + 'z'.repeat(4000) }];
  const result = webhook.deliveryErrorMessage(input);
  assert.equal(result.length, 2000); assert.doesNotMatch(result, /EAA|eyJ|private-value|private-key|\n/);
  assert.match(result, /redacted/);
});

test('completed send jobs show actual failed/pending/delivered states', () => {
  const campaign = { status: 'completed', total_contacts: 1, delivered_count: 0, failed_count: 0 };
  assert.equal(campaignDeliveryState(campaign), 'pending');
  assert.equal(campaignDeliveryState({ ...campaign, failed_count: 1 }), 'failed');
  assert.equal(campaignDeliveryState({ ...campaign, delivered_count: 1 }), 'delivered');
  assert.equal(campaignDeliveryState({ ...campaign, total_contacts: 2, delivered_count: 1 }), 'partly_delivered');
  assert.equal(campaignDeliveryState({ ...campaign, total_contacts: 2, failed_count: 1 }), 'has_failures');
  assert.equal(campaignDeliveryState({ ...campaign, total_contacts: 0 }), 'empty');
  assert.equal(campaignDeliveryState({ ...campaign, status: 'draft' }), 'draft');
  assert.equal(campaignDeliveryState({ ...campaign, status: 'running' }), 'running');
  assert.equal(campaignDeliveryState({ ...campaign, status: 'failed', delivered_count: 1 }), 'delivered', 'delivery can recover after a failed receipt');
});

test('the actual signed webhook route passes error diagnostics to the new database RPC', async () => {
  const source = await readFile(new URL('../src/app/api/webhook/route.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const calls = [];
  const imports = { '@/lib/whatsapp-webhook': webhook, '@/lib/supabase/server': {
    createServiceRoleClient: () => ({ rpc: async (...args) => { calls.push(args); return { error: null }; } }),
  } };
  const exports = {};
  const secret = 'synthetic-delivery-secret';
  vm.runInNewContext(compiled, { exports, Error, process: { env: {
    META_APP_SECRET: secret, META_WABA_ID: 'test-waba', META_PHONE_NUMBER_ID: 'test-phone',
  } }, require: (name) => { if (!(name in imports)) throw new Error(`Unexpected import ${name}`); return imports[name]; } });
  const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'test-waba', changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: 'test-phone' }, statuses: [
      { id: 'wamid.failed.test', status: 'failed', timestamp: '1791624000', errors },
      { id: 'wamid.delivered.test', status: 'delivered', timestamp: '1791624001', errors },
    ],
  } }] }] });
  const send = (signature) => exports.POST(new Request('https://crm.example/api/webhook', { method: 'POST', body: payload,
    headers: { 'x-hub-signature-256': signature } }));
  assert.equal((await send('sha256=invalid')).status, 401); assert.equal(calls.length, 0);
  assert.equal((await send(webhook.signMetaBody(payload, secret))).status, 200);
  assert.equal(calls.length, 2); assert.equal(calls[0][0], 'record_whatsapp_status_with_error');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])), { p_wamid: 'wamid.failed.test', p_status: 'failed',
    p_at: '2026-10-10T09:20:00.000Z', p_error_message: webhook.deliveryErrorMessage(errors) });
  assert.equal(calls[1][1].p_error_message, null);
});
