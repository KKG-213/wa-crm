import ast
import asyncio
from contextlib import closing
import importlib.util
import json
import logging
import os
from pathlib import Path
import sqlite3
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

sync = load('crm_sync', ROOT / 'integrations/hermes/whatsapp_crm_sync.py')
installer = load('crm_installer', ROOT / 'integrations/hermes/install_crm_sync.py')
SOURCE = (ROOT / 'tests/fixtures/hermes_whatsapp_cloud_bd0affe5.py').read_text()
PHONE = '1409792945541835'
SECRET = 'unit-test-only-secret'

class Reply:
    def __init__(self, code=200, data=None):
        self.status_code = code
        self.data = {'status': 'ok', 'inserted': True} if data is None else data
    def json(self): return self.data

class Client:
    def __init__(self, replies=None): self.replies = list(replies or []); self.calls = []; self.closed = False
    async def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        response = self.replies.pop(0) if self.replies else Reply()
        if isinstance(response, Exception): raise response
        return response
    async def aclose(self): self.closed = True

class SyncTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.client = Client()
        self.queue = sync.WhatsAppCrmSync(installer.ENDPOINT, SECRET, PHONE, Path(self.temp.name) / 'private', self.client)
        self.queue.initialize()
    async def asyncTearDown(self):
        await self.queue.close()
        self.temp.cleanup()
    def rows(self, queue=None):
        with closing(sqlite3.connect((queue or self.queue).db_path)) as db:
            return db.execute('SELECT wamid,body,attempts,next_attempt FROM outbox ORDER BY wamid').fetchall()
    async def capture(self, text='नमस्ते 👋', id='wamid.test', to='919000000001'):
        await self.queue.capture({'to': to, 'type': 'text', 'text': {'body': text}}, [{'id': id}])
    async def test_full_unicode_text_and_immutable_id_are_queued(self):
        text = 'नमस्ते 👋 ' + 'Full reply. ' * 100
        await self.capture(text)
        row = self.rows()[0]; event = json.loads(row[1])
        self.assertEqual(event['content'], text); self.assertGreater(len(event['content']), 500)
        self.assertEqual(event['wamid'], 'wamid.test'); self.assertEqual(event['phone_number_id'], PHONE)
        if os.name == 'posix':
            self.assertEqual(stat.S_IMODE(self.queue.db_path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(self.queue.directory.stat().st_mode), 0o700)
    async def test_duplicate_capture_does_not_replace_original_or_add_rows(self):
        await self.capture('Original'); await self.capture('Changed')
        self.assertEqual(len(self.rows()), 1); self.assertEqual(json.loads(self.rows()[0][1])['content'], 'Original')
    async def test_acknowledgement_removes_pending_copy_and_sends_no_graph_token(self):
        await self.capture(to='+919000000001'); await self.queue.drain_once(now=0)
        self.assertEqual(self.rows(), [])
        url, kwargs = self.client.calls[0]
        self.assertEqual(url, installer.ENDPOINT); self.assertNotIn('Authorization', kwargs['headers'])
        self.assertFalse(kwargs['follow_redirects']); self.assertEqual(kwargs['timeout'], 5.0)
        self.assertEqual(kwargs['headers']['X-Hermes-Signature-256'], sync.sign_body(kwargs['content'], SECRET))
        self.assertEqual(json.loads(kwargs['content'])['recipient'], '919000000001')
    async def test_failed_sync_survives_restart_and_retries_only_crm(self):
        self.client.replies = [Reply(503)]
        await self.capture(); await self.queue.drain_once(now=0)
        self.assertEqual(self.rows()[0][2], 1)
        fresh = sync.WhatsAppCrmSync(installer.ENDPOINT, SECRET, PHONE, self.queue.directory, Client())
        fresh.initialize()
        await fresh.drain_once(now=2)
        self.assertEqual(self.rows(fresh), []); self.assertEqual(len(fresh.client.calls), 1)
        self.assertTrue(all('graph.facebook.com' not in url for url, _ in fresh.client.calls))
        await fresh.close()
    async def test_redirect_network_error_and_invalid_ack_keep_pending_copy(self):
        for response in [Reply(302), OSError('network unavailable'), Reply(200, {'unexpected': True})]:
            self.client.replies = [response]
            await self.capture(id='wamid.failure.' + str(len(self.client.calls)))
            await self.queue.drain_once(now=0)
        self.assertEqual(len(self.rows()), 3)
    async def test_duplicate_ack_removes_copy_even_if_crm_already_saved(self):
        self.client.replies = [Reply(200, {'status': 'ok', 'inserted': False})]
        await self.capture(); await self.queue.drain_once(now=0); self.assertEqual(self.rows(), [])
    async def test_read_receipts_and_unsent_ids_are_not_saved_as_messages(self):
        await self.queue.capture({'status': 'read', 'message_id': 'incoming'}, [])
        await self.queue.capture({'to': '919000000001', 'type': 'text', 'text': {'body': 'No ID'}}, [])
        self.assertEqual(self.rows(), [])
    async def test_media_captions_and_interactive_buttons_have_readable_content(self):
        self.assertEqual(sync.message_content({'type': 'image', 'image': {'caption': 'Demo'}}), 'Demo')
        self.assertEqual(sync.message_content({'type': 'audio', 'audio': {'id': 'private-id'}}), '[audio]')
        self.assertEqual(sync.message_content({'type': 'interactive', 'interactive': {'body': {'text': 'Choose'}, 'action': {'buttons': [{'reply': {'title': 'DEMO'}}]}}}), 'Choose\nOptions: DEMO')
    async def test_separate_profiles_and_phone_ids_keep_separate_queues(self):
        other = sync.WhatsAppCrmSync(installer.ENDPOINT, SECRET, '1409792945541999', self.queue.directory, Client())
        other.initialize(); await self.capture(); self.assertEqual(self.rows(other), []); await other.close()
    async def test_disk_failure_logs_no_private_payload_and_never_raises_into_sender(self):
        with patch.object(self.queue, 'enqueue', side_effect=OSError('private text should not be logged')):
            with self.assertLogs(sync.logger, level='ERROR') as logs: await self.capture('Private customer message')
        self.assertNotIn('Private customer', str(logs.output)); self.assertIn('enqueue_failed', str(logs.output))
    async def test_actual_pinned_send_records_each_accepted_chunk_and_not_rejected_sends(self):
        patched = installer.patched_source(SOURCE)
        tree = ast.parse(patched)
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'WhatsAppCloudAdapter')
        methods = [n for n in cls.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in ('_post_messages', '_outbound_payload', 'send')]
        module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0), ast.ClassDef(name='Adapter', bases=[], keywords=[], body=methods, decorator_list=[])], type_ignores=[])
        namespace = {'logger': logging.getLogger('sender-test'), 'SendResult': SimpleNamespace, 'rich_sent_store': SimpleNamespace(record_async=AsyncMock())}
        exec(compile(ast.fix_missing_locations(module), '<pinned-hermes-send>', 'exec'), namespace)
        adapter = namespace['Adapter']()
        adapter._crm_sync = self.queue
        adapter._http_client = Client([Reply(200, {'messages': [{'id': 'wamid.chunk1'}]}), Reply(200, {'messages': [{'id': 'wamid.chunk2'}]})])
        adapter._graph_url = lambda _: 'https://graph.facebook.com/test/messages'
        adapter._auth_headers = lambda: {'Authorization': 'Bearer test-only'}
        adapter.format_message = lambda content: content
        adapter._outgoing_chunk_limit = lambda: 4096
        adapter.truncate_message = lambda content, limit: [content[i:i+limit] for i in range(0, len(content), limit)]
        adapter._response_error = lambda response: 'Graph rejected'
        result = await adapter.send('919000000001', 'A' * 5000)
        self.assertTrue(result.success)
        self.assertEqual([len(json.loads(row[1])['content']) for row in self.rows()], [4096, 904])
        adapter._http_client = Client([Reply(400)])
        result = await adapter.send('919000000001', 'Rejected')
        self.assertFalse(result.success); self.assertEqual(len(self.rows()), 2)
        adapter._http_client = Client([Reply(200, {'messages': [{'id': 'wamid.already-sent'}]})])
        adapter._crm_sync = SimpleNamespace(capture=AsyncMock(side_effect=OSError('disk failed')))
        result = await adapter.send('919000000001', 'Accepted despite CRM disk error')
        self.assertTrue(result.success); self.assertEqual(result.message_id, 'wamid.already-sent')
    async def test_worker_cancels_without_discarding_pending_rows(self):
        await self.capture(); self.client.replies = [Reply(503)]
        self.queue.task = asyncio.create_task(self.queue.run())
        await asyncio.sleep(0.05)
        await self.queue.close(); self.assertEqual(len(self.rows()), 1); self.assertTrue(self.client.closed)

class InstallerTests(unittest.TestCase):
    def test_different_git_revision_refuses_install_without_writing(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            target = root / 'gateway/platforms/whatsapp_cloud.py'
            target.parent.mkdir(parents=True); target.write_text(SOURCE)
            with patch.object(installer.subprocess, 'check_output', return_value='a' * 40):
                with patch.object(sys, 'argv', ['installer', '--hermes-dir', str(root), '--install']):
                    with self.assertRaises(ValueError): installer.main()
            self.assertEqual(target.read_text(), SOURCE)
            self.assertFalse(target.with_name('whatsapp_cloud.py.crm-sync-backup').exists())
    def test_cross_language_protocol_vector(self):
        vector = json.loads((ROOT / 'tests/fixtures/hermes-outbound-protocol.json').read_text())
        self.assertEqual(sync.sign_body(vector['raw'].encode(), vector['secret']), vector['signature'])
    def test_exact_pin_and_changed_source_refusal(self):
        patched = installer.patched_source(SOURCE)
        self.assertIn(installer.MARKER, patched); ast.parse(patched)
        with self.assertRaises(ValueError): installer.patched_source(SOURCE + '\n# local modification\n')
    def test_only_sync_url_changes_and_duplicate_variables_are_rejected(self):
        original = 'WHATSAPP_CLOUD_ACCESS_TOKEN=test-only\nWHATSAPP_CLOUD_APP_SECRET=test-only\n'
        result = installer.configured_env(original)
        self.assertTrue(result.startswith(original)); self.assertEqual(result.count('WHATSAPP_CLOUD_CRM_SYNC_URL='), 1)
        with self.assertRaises(ValueError): installer.configured_env('WHATSAPP_CLOUD_CRM_SYNC_URL=a\nWHATSAPP_CLOUD_CRM_SYNC_URL=b\n')
    def test_install_repeat_and_uninstall_restore_adapter_and_preserve_credentials(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'hermes'; profile = Path(temp) / 'profile'; profile.mkdir()
            target = root / 'gateway/platforms/whatsapp_cloud.py'; target.parent.mkdir(parents=True); target.write_text(SOURCE)
            env = profile / '.env'; original_env = 'WHATSAPP_CLOUD_ACCESS_TOKEN=test-only\n'; env.write_text(original_env)
            base = ['installer', '--hermes-dir', str(root), '--profile-home', str(profile)]
            with patch.object(installer.subprocess, 'check_output', return_value='bd0affe5' + '0' * 32):
                with patch.object(sys, 'argv', base): installer.main()
                self.assertEqual(target.read_text(), SOURCE)
                with patch.object(sys, 'argv', base + ['--install']): installer.main()
                self.assertIn(installer.MARKER, target.read_text()); self.assertTrue(env.read_text().startswith(original_env))
                with patch.object(sys, 'argv', base + ['--install']): installer.main()
                with patch.object(sys, 'argv', base + ['--uninstall']): installer.main()
            self.assertEqual(target.read_text(), SOURCE); self.assertTrue(env.read_text().startswith(original_env))

if __name__ == '__main__': unittest.main()
