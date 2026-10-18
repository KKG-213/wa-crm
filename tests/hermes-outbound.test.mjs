import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHermesOutboundHandler, signHermesOutbound } from '../src/lib/hermes-outbound.ts';
import { signMetaBody } from '../src/lib/whatsapp-webhook.ts';

const secret = 'outbound-test-only-secret';
const sample = { version: 1, phone_number_id: '1409792945541835', recipient: '919000000001', wamid: 'wamid.outbound', message_type: 'text', content: 'नमस्ते 👋 Website demo', sent_at: '2026-10-18T05:00:00.000Z' };
function harness(overrides = {}, save = async () => true) {
  const rows = []; const logs = []; let clients = 0;
  const handler = createHermesOutboundHandler({ appSecret: secret, phoneNumberId: sample.phone_number_id, ...overrides }, {
    createStore: () => { clients++; return { save: async (data) => { rows.push(data); return save(data); } }; },
    logger: { error: (...args) => logs.push(args) },
  });
  return { handler, rows, logs, clients: () => clients };
}
const req = (data = sample, signature, body) => {
  const raw = body ?? JSON.stringify(data);
  return new Request('https://crm.example/api/hermes/outbound', { method: 'POST', body: raw,
    headers: { 'x-hermes-signature-256': signature ?? signHermesOutbound(raw, secret) } });
};
test('actual UTF-8 outgoing text and message ID persist after authentication', async () => {
  const h = harness(); const response = await h.handler(req());
  assert.equal(response.status, 200); assert.equal((await response.json()).inserted, true);
  assert.equal(h.rows[0].content, sample.content); assert.equal(h.rows[0].wamid, sample.wamid);
});
test('missing/invalid signatures and Meta signatures cannot authorize outgoing sync', async () => {
  const h = harness(); const raw = JSON.stringify(sample);
  for (const signature of ['', 'sha256=bad', signMetaBody(raw, secret), signHermesOutbound(raw + ' ', secret)])
    assert.equal((await h.handler(req(sample, signature))).status, 401);
  assert.equal(h.clients(), 0);
});
test('wrong phone identity is rejected before service-role client creation', async () => {
  const h = harness(); assert.equal((await h.handler(req({ ...sample, phone_number_id: '999999999' }))).status, 403); assert.equal(h.clients(), 0);
});
test('missing server configuration fails closed', async () => {
  for (const key of ['appSecret', 'phoneNumberId']) {
    const h = harness({ [key]: '' }); assert.equal((await h.handler(req())).status, 503); assert.equal(h.clients(), 0);
  }
});
test('signed invalid schema/JSON never creates a database client', async () => {
  const h = harness();
  for (const data of [{ ...sample, recipient: '+919000000001' }, { ...sample, sent_at: 'invalid' }, { ...sample, extra: 'rejected' }, { ...sample, content: '' }])
    assert.equal((await h.handler(req(data))).status, 400);
  assert.equal((await h.handler(req(null, undefined, '{'))).status, 400); assert.equal(h.clients(), 0);
});
test('oversized requests are bounded before persistence', async () => {
  const h = harness(); assert.equal((await h.handler(req(null, undefined, 'x'.repeat(256 * 1024 + 1)))).status, 413); assert.equal(h.clients(), 0);
});
test('duplicate CRM acknowledgement is successful and does not ask sender to resend', async () => {
  const h = harness({}, async () => false); const response = await h.handler(req());
  assert.equal(response.status, 200); assert.equal((await response.json()).inserted, false);
});
test('database failure is retryable and never logs private message data', async () => {
  const h = harness({}, async () => { throw new Error('private customer text'); });
  assert.equal((await h.handler(req())).status, 503); assert.deepEqual(h.logs, [['[hermes-outbound] persistence_failed']]);
});
test('Python signs the same protocol bytes that the CRM verifies', async () => {
  // This vector is independently checked by the Python integration suite.
  const signed = JSON.parse(readFileSync(new URL('./fixtures/hermes-outbound-protocol.json', import.meta.url), 'utf8'));
  assert.equal(signed.secret, secret); assert.deepEqual(JSON.parse(signed.raw), sample);
  assert.equal(signed.signature, signHermesOutbound(signed.raw, secret));
  const h = harness(); assert.equal((await h.handler(req(null, signed.signature, signed.raw))).status, 200);
});
