import test from 'node:test';
import assert from 'node:assert/strict';
import { createWhatsAppWebhook, signMetaBody, verifyMetaSignature, inboundText } from '../src/lib/whatsapp-webhook.ts';
import { mergeChatMessages } from '../src/lib/merge-chat-messages.ts';

const secret = 'test-only-app-secret';
const config = { appSecret: secret, verifyToken: 'test-verify', wabaId: 'waba-test', phoneNumberId: 'phone-test', hermesWebhookUrl: 'https://hermes.example/whatsapp/webhook' };
const message = (id = 'wamid.1', from = '919000000001', body = 'Hi') => ({ id, from, timestamp: '1791624000', type: 'text', text: { body } });
const envelope = (messages = [message()], statuses) => ({ object: 'whatsapp_business_account', entry: [{ id: 'waba-test', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'phone-test' }, contacts: messages.map((m) => ({ wa_id: m.from, profile: { name: 'Test customer' } })), messages, ...(statuses ? { statuses } : {}) } }] }] });
const request = (payload, signature, raw) => {
  const body = raw ?? JSON.stringify(payload);
  return new Request('https://crm.example/api/webhook', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature ?? signMetaBody(body, secret) } });
};
function harness(overrides = {}, storeOverrides = {}, transport) {
  const writes = []; const statuses = []; const relays = []; const logs = []; let clients = 0;
  const handler = createWhatsAppWebhook({ ...config, ...overrides }, {
    createStore: () => { clients++; return {
      saveInbound: async (item) => { writes.push(item); return { inserted: true, forwardAllowed: true }; },
      saveStatus: async (item) => { statuses.push(item); }, ...storeOverrides,
    }; },
    fetch: async (...args) => { relays.push(args); return transport ? transport(...args) : new Response('ok'); },
    logger: { error: (...args) => logs.push(args) },
  });
  return { handler, writes, statuses, relays, logs, clients: () => clients };
}

test('GET returns Meta challenge as unquoted plaintext without DB access', async () => {
  const h = harness();
  const response = await h.handler.GET(new Request('https://crm.example/api/webhook?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=hello'));
  assert.equal(response.status, 200); assert.equal(await response.text(), 'hello');
  assert.match(response.headers.get('content-type'), /text\/plain/); assert.equal(h.clients(), 0);
});
test('GET rejects wrong/missing tokens and missing server configuration', async () => {
  assert.equal((await harness().handler.GET(new Request('https://crm.example/api/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=hello'))).status, 403);
  assert.equal((await harness({ verifyToken: '' }).handler.GET(new Request('https://crm.example/api/webhook'))).status, 503);
});
test('invalid signature and tampered bytes never create a privileged DB client', async () => {
  const h = harness();
  assert.equal((await h.handler.POST(request(envelope(), 'sha256=bad'))).status, 401);
  assert.equal((await h.handler.POST(request(envelope(), signMetaBody('different', secret)))).status, 401);
  assert.equal(h.clients(), 0); assert.equal(h.relays.length, 0);
});
test('missing required configuration fails closed', async () => {
  for (const key of ['appSecret', 'phoneNumberId', 'wabaId']) {
    const h = harness({ [key]: '' });
    assert.equal((await h.handler.POST(request(envelope()))).status, 503); assert.equal(h.clients(), 0);
  }
});
test('signed malformed JSON/schema are rejected before persistence', async () => {
  const h = harness();
  assert.equal((await h.handler.POST(request(null, undefined, '{'))).status, 400);
  assert.equal((await h.handler.POST(request({ object: 'whatsapp_business_account', entry: null }))).status, 400);
  const payload = envelope(); payload.entry[0].changes[0].value.messages[0].timestamp = 'NaN';
  assert.equal((await h.handler.POST(request(payload))).status, 400); assert.equal(h.clients(), 0);
});
test('payload size limit works even without a content-length header', async () => {
  const h = harness(); const raw = 'x'.repeat(1024 * 1024 + 1);
  assert.equal((await h.handler.POST(request(null, undefined, raw))).status, 413); assert.equal(h.clients(), 0);
});
test('all account/phone IDs validated before any part of a mixed batch writes', async () => {
  for (const field of ['account', 'phone']) {
    const payload = envelope(); const other = structuredClone(payload.entry[0]);
    if (field === 'account') other.id = 'another-waba'; else other.changes[0].value.metadata.phone_number_id = 'another-phone';
    payload.entry.push(other); const h = harness();
    assert.equal((await h.handler.POST(request(payload))).status, 403); assert.equal(h.clients(), 0);
  }
});
test('UTF-8 payload persists then relays the exact signed bytes', async () => {
  const h = harness(); const raw = JSON.stringify(envelope([message('wamid.utf8', '919000000001', 'नमस्ते 👋')]), null, 2) + '\n';
  const response = await h.handler.POST(request(null, undefined, raw));
  assert.equal(response.status, 200); assert.equal(h.writes[0].content, 'नमस्ते 👋'); assert.equal(h.writes[0].phone, '+919000000001');
  assert.equal(h.writes[0].sentAt, new Date(1791624000 * 1000).toISOString());
  assert.equal(Buffer.from(h.relays[0][1].body).toString(), raw);
  assert.equal(h.relays[0][1].redirect, 'manual'); assert.ok(h.relays[0][1].signal instanceof AbortSignal);
  assert.ok(verifyMetaSignature(h.relays[0][1].body, h.relays[0][1].headers['X-Hub-Signature-256'], secret));
});
test('parses template quick replies, interactive replies and media captions', () => {
  for (const [input, expected] of [
    [{ type: 'button', button: { text: 'DEMO' } }, 'DEMO'],
    [{ type: 'interactive', interactive: { button_reply: { title: 'PRICE' } } }, 'PRICE'],
    [{ type: 'interactive', interactive: { list_reply: { title: 'Website' } } }, 'Website'],
    [{ type: 'image', image: { caption: 'My requirement' } }, 'My requirement'],
    [{ type: 'audio' }, '[audio]'],
  ]) assert.equal(inboundText(input), expected);
});
test('DB failures return retryable error, no relay, and no message content in logs', async () => {
  const h = harness({}, { saveInbound: async () => { throw new Error('secret customer text'); } });
  assert.equal((await h.handler.POST(request(envelope()))).status, 503);
  assert.equal(h.relays.length, 0); assert.deepEqual(h.logs, [['[whatsapp-webhook] persistence_failed']]);
});
test('relay failure is retryable even when the inbound row already exists', async () => {
  let calls = 0;
  const h = harness({}, { saveInbound: async () => ({ inserted: false, forwardAllowed: true }) }, () => new Response('', { status: ++calls === 1 ? 503 : 200 }));
  assert.equal((await h.handler.POST(request(envelope()))).status, 502);
  assert.equal((await h.handler.POST(request(envelope()))).status, 200); assert.equal(h.relays.length, 2);
});
test('redirects and timeout/network errors do not acknowledge a successful relay', async () => {
  for (const transport of [() => new Response('', { status: 302 }), () => { throw new DOMException('timed out', 'TimeoutError'); }]) {
    const h = harness({}, {}, transport);
    assert.equal((await h.handler.POST(request(envelope()))).status, 502);
  }
});
test('without relay configuration, incoming data saves without calling Hermes', async () => {
  const h = harness({ hermesWebhookUrl: '' }); const response = await h.handler.POST(request(envelope()));
  assert.equal(response.status, 200); assert.equal((await response.json()).forwarded, false); assert.equal(h.writes.length, 1); assert.equal(h.relays.length, 0);
});
test('insecure, self-referential and credential-bearing relay destinations are rejected', async () => {
  for (const url of ['http://hermes.example/webhook', 'https://crm.example/api/webhook/', 'https://user:pass@hermes.example/webhook', 'not-a-url']) {
    const h = harness({ hermesWebhookUrl: url });
    assert.equal((await h.handler.POST(request(envelope()))).status, 503); assert.equal(h.clients(), 0);
  }
});
test('mixed STOP/allowed batch forwards only allowed customer and verifies new HMAC', async () => {
  const payload = envelope([message('stop', '919000000001', 'STOP'), message('ok', '919000000002', 'DEMO')]);
  const h = harness({}, { saveInbound: async (m) => ({ inserted: true, forwardAllowed: m.content !== 'STOP' }) });
  assert.equal((await h.handler.POST(request(payload))).status, 200);
  const [, init] = h.relays[0]; const value = JSON.parse(Buffer.from(init.body).toString()).entry[0].changes[0].value;
  assert.deepEqual(value.messages.map((m) => m.id), ['ok']); assert.deepEqual(value.contacts.map((c) => c.wa_id), ['919000000002']);
  assert.ok(verifyMetaSignature(init.body, init.headers['X-Hub-Signature-256'], secret));
});
test('STOP later in same batch suppresses earlier messages for that contact', async () => {
  const h = harness({}, { saveInbound: async (m) => ({ inserted: true, forwardAllowed: m.content !== 'STOP' }) });
  assert.equal((await h.handler.POST(request(envelope([message('first'), message('stop', '919000000001', 'STOP')])))).status, 200);
  assert.equal(h.relays.length, 0);
});
test('delivery receipts persist supported statuses only, then forward', async () => {
  const h = harness(); const payload = envelope([], [{ id: 'outbound', timestamp: '1791624000', status: 'read' }, { id: 'x', timestamp: '1791624000', status: 'unknown' }]);
  assert.equal((await h.handler.POST(request(payload))).status, 200);
  assert.equal(h.statuses.length, 1); assert.equal(h.statuses[0].status, 'read'); assert.equal(h.relays.length, 1);
});
test('unrelated objects are ignored without privileged DB access', async () => {
  const h = harness(); assert.equal((await h.handler.POST(request({ object: 'page' }))).status, 200); assert.equal(h.clients(), 0);
});
test('chat merge deduplicates fetch/realtime overlap and applies status updates in order', () => {
  const old = [{ id: 'b', sent_at: '2026-10-10T10:01:00Z', status: 'sent' }];
  const result = mergeChatMessages(old, [{ ...old[0], status: 'read' }, { id: 'a', sent_at: '2026-10-10T10:00:00Z', status: 'sent' }]);
  assert.equal(result.length, 2); assert.equal(result[0].id, 'a'); assert.equal(result[1].status, 'read');
});
