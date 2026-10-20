import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTemplateComponents, templateRequirements, createMetaClient, publicImageUrl } from '../src/lib/meta-template.ts';
import { normalizeCampaignPhone, validCampaignPhone } from '../src/lib/campaign-contacts.ts';

export const imageTemplate = { name: 'web_design_request', language: 'en', status: 'APPROVED', components: [
  { type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hello. Website and Local SEO.' },
  { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'DEMO' }, { type: 'QUICK_REPLY', text: 'PRICE' },
    { type: 'PHONE_NUMBER', text: 'Call now' }] },
] };
const image = 'https://example.com/whatsapp/poster.png';
const config = { accessToken: 'test-only-access', phoneNumberId: 'test-phone', wabaId: 'test-waba' };

test('image templates send an image header and button payloads while the static call button is kept by Meta', async () => {
  let sent;
  const client = createMetaClient(config, async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    return Response.json({ messages: [{ id: 'wamid.accepted' }] });
  });
  const result = await client.template('+919000000001', imageTemplate.name, 'en', buildTemplateComponents(imageTemplate, { headerImageUrl: image }));
  assert.equal(result.ok, true); assert.equal(result.wamid, 'wamid.accepted');
  assert.equal(sent.body.to, '919000000001'); assert.equal(sent.body.template.language.code, 'en');
  assert.deepEqual(sent.body.template.components[0], { type: 'header', parameters: [{ type: 'image', image: { link: image } }] });
  assert.deepEqual(sent.body.template.components.slice(1).map((c) => [c.index, c.parameters[0].payload]), [['0', 'DEMO'], ['1', 'PRICE']]);
  assert.equal(sent.init.redirect, 'manual');
});

test('missing image, extra image on text templates and unsafe URLs are rejected before sending', () => {
  assert.throws(() => buildTemplateComponents(imageTemplate, {}), /requires a header image/);
  for (const url of ['http://example.com/x.png', 'data:image/png;base64,a', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.1/x', 'https://user:password@example.com/x']) {
    assert.throws(() => publicImageUrl(url));
  }
  assert.throws(() => buildTemplateComponents({ ...imageTemplate, components: [{ type: 'BODY', text: 'Hi' }] }, { headerImageUrl: image }), /does not have an image/);
});

test('text-only hello_world keeps working without manufactured parameters', async () => {
  const template = { name: 'hello_world', language: 'en_US', components: [{ type: 'BODY', text: 'Hello' }] };
  const components = buildTemplateComponents(template, {});
  assert.deepEqual(components, []);
  const client = createMetaClient(config, async (_, init) => {
    assert.deepEqual(JSON.parse(init.body).template, { name: 'hello_world', language: { code: 'en_US' } });
    return Response.json({ messages: [{ id: 'wamid.hello' }] });
  });
  assert.equal((await client.template('+919000000001', template.name, template.language, components)).ok, true);
});

test('numbered body and text header variables are counted uniquely and sent in parameter order', () => {
  const template = { name: 'with_variables', language: 'en', components: [
    { type: 'HEADER', format: 'TEXT', text: 'Hello {{1}}' }, { type: 'BODY', text: '{{2}} then {{1}} again {{1}}' },
  ] };
  assert.deepEqual(templateRequirements(template), { headerFormat: 'TEXT', headerCount: 1, bodyCount: 2 });
  assert.throws(() => buildTemplateComponents(template, { headerValues: ['Name'], bodyValues: ['First'] }), /all 2 body/);
  assert.deepEqual(buildTemplateComponents(template, { headerValues: [' Name '], bodyValues: ['First', 'Second'] }), [
    { type: 'header', parameters: [{ type: 'text', text: 'Name' }] },
    { type: 'body', parameters: [{ type: 'text', text: 'First' }, { type: 'text', text: 'Second' }] },
  ]);
});

test('unsupported media, named variables and dynamic button formats fail locally', () => {
  for (const component of [{ type: 'HEADER', format: 'VIDEO' }, { type: 'BODY', text: 'Hi {{name}}' },
    { type: 'BODY', text: 'Hi {{2}}' }, { type: 'CAROUSEL' },
    { type: 'BUTTONS', buttons: [{ type: 'URL', url: 'https://example.com/{{1}}' }] }]) {
    assert.throws(() => templateRequirements({ name: 'unsupported', language: 'en', components: [component] }));
  }
});

test('template lookup retains format metadata, filters approval, and avoids stale cache', async () => {
  const client = createMetaClient(config, async (url, init) => {
    assert.equal(new URL(url).searchParams.get('status'), 'APPROVED');
    assert.match(new URL(url).searchParams.get('fields'), /components/);
    assert.equal(init.cache, 'no-store');
    return Response.json({ data: [imageTemplate, { ...imageTemplate, name: 'pending', status: 'PENDING' }] });
  });
  const templates = await client.templates();
  assert.equal(templates.length, 1); assert.equal(templates[0].components[0].format, 'IMAGE');
});

test('Meta details survive failure, tokens are redacted and no retry sends occur', async () => {
  let calls = 0;
  const client = createMetaClient(config, async () => {
    calls++;
    return Response.json({ error: { code: 132012, message: '(#132012) Parameter format does not match',
      error_data: { details: 'header: expected IMAGE, received UNKNOWN. EAA0000000000000000000000' } } }, { status: 400 });
  });
  const result = await client.template('919000000001', 'example', 'en');
  assert.equal(result.ok, false); assert.match(result.error, /expected IMAGE/); assert.doesNotMatch(result.error, /EAA0/);
  assert.equal(result.error.match(/\(#132012\)/g).length, 1); assert.equal(calls, 1);
});

test('a response without a message ID or a network timeout is not called successful', async () => {
  for (const transport of [async () => Response.json({ success: true }), async () => { throw new Error('private transport details'); }]) {
    const result = await createMetaClient(config, transport).template('919000000001', 'example', 'en');
    assert.equal(result.ok, false); assert.equal(result.wamid, null); assert.doesNotMatch(result.error, /private transport/);
  }
});

test('India national formats normalize consistently and explicit international numbers are preserved', () => {
  for (const source of ['9000000001', '09000000001', '+919000000001', '919000000001', 9000000001]) {
    assert.equal(normalizeCampaignPhone(source), '+919000000001');
  }
  assert.equal(normalizeCampaignPhone('+1 (202) 555-0100'), '+12025550100');
  assert.equal(normalizeCampaignPhone('0012025550100'), '+12025550100');
  for (const source of ['not a number', '9e9', '+00000000000', '123', Number.NaN]) {
    assert.equal(validCampaignPhone(normalizeCampaignPhone(source)), false);
  }
});
