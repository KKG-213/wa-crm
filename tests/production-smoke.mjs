// Local smoke check after a production build. No real Meta/Supabase credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';

const manifest = JSON.parse(await readFile('.next/server/middleware-manifest.json', 'utf8'));
assert.ok(manifest.middleware['/'], 'Next must register src/middleware.ts');
const port = 3197;
const secret = 'smoke-test-only-secret';
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-only-anon', SUPABASE_SERVICE_ROLE_KEY: 'test-only-service',
    META_ACCESS_TOKEN: 'test-only-access', META_APP_SECRET: secret, META_VERIFY_TOKEN: 'smoke-verify',
    META_WABA_ID: 'smoke-waba', META_PHONE_NUMBER_ID: 'smoke-phone', HERMES_WEBHOOK_URL: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Local server startup timed out')), 30000);
    child.on('error', reject);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Local server exited: ${code}`)); });
    child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-4000); });
    child.stdout.on('data', (chunk) => {
      output = (output + chunk).slice(-4000);
      if (output.includes('Ready in')) { clearTimeout(timer); resolve(); }
    });
  });
  const local = (path, init = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, redirect: 'manual', signal: AbortSignal.timeout(5000) });
  const verify = await local('/api/webhook?hub.mode=subscribe&hub.verify_token=smoke-verify&hub.challenge=hello');
  assert.equal(verify.status, 200); assert.equal(await verify.text(), 'hello');
  assert.equal((await local('/api/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=hello')).status, 403);
  assert.equal((await local('/api/webhook', { method: 'POST', body: '{}' })).status, 401);
  const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'wrong-waba', changes: [] }] });
  assert.equal((await local('/api/webhook', { method: 'POST', body: payload, headers: {
    'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`,
  } })).status, 403);
  for (const path of ['/api/contacts', '/api/messages', '/api/campaigns', '/api/analytics', '/api/templates']) {
    assert.equal((await local(path)).status, 401, `${path} must require login`);
  }
  assert.equal((await local('/api/campaigns', { method: 'POST', body: '{}' })).status, 401);
  const dashboard = await local('/dashboard');
  assert.equal(dashboard.status, 307); assert.match(dashboard.headers.get('location'), /\/auth\/login$/);
  console.log('Production smoke passed: middleware registered, webhook challenge/signatures checked, private APIs and dashboard require login.');
} finally {
  if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
}
