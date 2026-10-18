# Hermes replies in the CRM inbox

The incoming webhook relay saves customer messages, but Hermes sends its replies
directly to Meta. Those sends never passed through the CRM's message endpoint.
This change records the actual outgoing text and Graph-returned WhatsApp message
ID in the same `messages` table the inbox already subscribes to.

## Components

1. `POST /api/hermes/outbound` validates a domain-separated HMAC over the exact
   request bytes using the existing server-only `META_APP_SECRET`, validates the
   phone-number ID, and calls a service-role-only database function. It accepts
   no browser session as a substitute for a signature. It saves data only: it
   does not call Meta, Hermes or any model.
2. `database/hermes-outbound-sync.sql` adds atomic, unique-`wamid` outgoing
   insertion. Retry acknowledgements do not double-count messages or overwrite
   contact metadata/status. Actual already-sent replies are recorded even if a
   contact has since become blocked. This recorder does not decide whether a
   new message should be sent.
3. A private receipt buffer preserves `sent`, `delivered`, `read` and `failed`
   events if they arrive before the outgoing row. An insert trigger reconciles
   them. Advisory locks serialize a receipt against an insert for the same ID.
   Matched buffered receipts are deleted. Unmatched receipts older than seven
   days are pruned on subsequent receipt activity; this is not a scheduled purge.
4. A local Hermes source extension intercepts **successful Graph acceptance** in
   `_post_messages` on the exact installed `bd0affe5` adapter. It records the
   formatted payload sent to Meta, not an LLM draft or a truncated `agent:end`
   event. Split long replies retain each actual chunk and its separate ID.
   A Graph API 200 means accepted for delivery; it does not prove delivery or
   reading. Later status events set those states.
5. Hermes writes accepted sends to a private SQLite outbox before returning the
   send result. A background worker retries only the CRM copy with capped
   exponential backoff. A CRM outage cannot trigger a second WhatsApp send.
   Records survive gateway restarts and are removed only after a valid CRM ack.
   The worker never forwards Meta's access token. HTTPS redirects are not followed.

## Compatibility and scope

- Target: Hermes Agent `v0.21.5+6224.gbd0affe`, install revision `bd0affe5`, path
  `/home/freescrib01/.hermes/hermes-agent`, git installation. The installer checks
  the Git revision AND a canonical SHA-256 of the adapter before changing it.
  A different revision or local adapter edit is refused without replacement.
- This is a **local source extension**, not a built-in upstream CRM setting.
  It changes the adapter, adds one helper module, and adds only the non-secret
  `WHATSAPP_CLOUD_CRM_SYNC_URL` to the receiving bot's existing profile `.env`.
  A source backup and uninstall path are included. Restore the original adapter
  before using Hermes's updater; review compatibility before reinstalling on a
  new revision. Do not copy this adapter file over a different Hermes version.
- The existing WhatsApp bot is received by the default profile. Defaults target
  `/home/freescrib01/.hermes/.env`. `--profile-home` can select a different
  receiving profile when appropriate. No profile/model/tool/allowlist change is
  made. This does not activate the separately created sales profile.
- Reuses the App Secret already configured on both servers. Outgoing sync uses
  `X-Hermes-Signature-256` and HMAC prefix `hermes-crm-outbound-v1\n`; Meta
  `X-Hub-Signature-256` values cannot be replayed as outgoing sync signatures.
  Treat both existing App Secret copies as credentials; never send them in chat.
- Full text is retained. Captions and interactive text/button labels are saved.
  Media without captions appears as `[image]`, `[audio]`, etc. Binary files and
  Meta media IDs/links are not downloaded or displayed by this patch.
- Only sends through this WhatsApp Cloud adapter are captured. External senders
  or other integrations need their own recorder. The CRM's existing sender
  already saves its sends and is not called again by this integration.
- Earlier Hermes replies are not backfilled. A process/disk failure in the small
  interval between Graph acceptance and writing the local queue can still lose
  a CRM copy. Disk-full errors are logged and do not turn an accepted WhatsApp
  send into a failed send. This is not an exactly-once guarantee across services.
- Pending outbox rows contain customer text/recipient numbers, not credentials.
  Its directory is mode 0700 and database 0600, under the receiving profile's
  `platforms/whatsapp_cloud/crm_outbox` directory (or the existing legacy layout
  returned by this Hermes revision). Successful copies are removed; unsynced
  rows have no automatic expiry so they can recover after a prolonged outage.
  Include pending copies in any customer deletion workflow. SQLite deletion is
  logical removal, not a guarantee of forensic erasure of disk pages/backups.
- The existing campaign sender's final completion-counter writes can still race
  with delivery receipts. This change does not replace that campaign runner.

## Installation order

The current Meta callback stays `https://wam.kwsolutioins.online/api/webhook`.
The existing Vercel `HERMES_WEBHOOK_URL` stays unchanged. No new Vercel secret or
Meta webhook URL is required.

### CRM code first

Apply the supplied patch to `KKG-213/wa-crm` main based on commit
`911925c1c44eaed8eaadca6fc408eec0ae7b97c5`, preserving unrelated work.
Run these checks locally (Node 24/22.18+, Python 3.10+):

```bash
npm ci
npm test
python3 -m unittest discover -s tests -p 'test_hermes_crm_sync.py' -v
npm run typecheck
npm run build
npm run smoke
```

The Python test command is intended for a Linux environment like the VM; Windows
users can use `py -3` instead of `python3` where necessary. Node and Python tests
both verify the same signed UTF-8 protocol fixture independently.
Build/smoke checks use dummy credentials or the project's uncommitted local
configuration. Keep secrets out of logs, source and commits.

Apply **only** `database/hermes-outbound-sync.sql` in the existing Supabase
project's SQL Editor. The prior `database/webhook-sync.sql` migration must already
be installed; the new one is transactional and rerunnable. Commit/push the code
and let Vercel deploy. An unsigned POST to the new route should return
`401 Invalid signature`, not a login redirect or 404. Do not call a valid signed
write against a real customer as a deployment smoke check.

### Then the VM extension

Upload the supplied `hermes-vm-sync-bd0affe5.zip` to the VM home directory. Extract:

```bash
python3 -m zipfile -e ~/hermes-vm-sync-bd0affe5.zip ~/hermes_crm_sync
python3 ~/hermes_crm_sync/install_crm_sync.py
```

The second command checks compatibility and changes nothing. If it reports a
mismatch, preserve the output and use a matching patch rather than bypassing the
version/hash check. When compatible, briefly stop the owned multiplexed gateway,
install and restart (other bots on that gateway disconnect during this restart):

```bash
hermes gateway stop
python3 ~/hermes_crm_sync/install_crm_sync.py --install
hermes gateway restart
```

If installation fails, restart the gateway to resume the existing integration.
The installer preflights all source/config checks and restores its touched files
on a normal write exception. A machine crash during installation can still need
the preserved `.crm-sync-backup` file; retain the installer and backup.

### Test with your own phone

Send a NEW customer message from the existing allowed test phone. Confirm that
the incoming customer row and the actual Hermes outgoing reply appear under the
same CRM contact. Wait for the existing 10-second visible-tab refresh if needed.
Verify a reply longer than 500 characters, then delivered/read status. Controlled
retry checks should resend only a queued CRM copy, not the WhatsApp message.
Do not run a real bulk campaign as an integration test.

### Rollback

Stop the gateway and run:

```bash
python3 ~/hermes_crm_sync/install_crm_sync.py --uninstall
hermes gateway restart
```

It restores the verified source backup and removes only its matching helper.
Existing credentials, the non-secret URL and pending outbox are preserved. If
the source/helper was edited after installation, it refuses to overwrite those
edits. Database changes are additive; reverting source does not delete stored
customer messages. Restore the previous CRM commit only if necessary; the Meta
callback does not need another change for this recorder.

## Sources and fixture license

- [Pinned Hermes WhatsApp adapter](https://github.com/NousResearch/hermes-agent/blob/bd0affe5/gateway/platforms/whatsapp_cloud.py)
- [Hermes event hooks](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks)
- [Hermes Cloud API guide](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/whatsapp-cloud)

`tests/fixtures/hermes_whatsapp_cloud_bd0affe5.py` is an unmodified upstream
source fixture, read as syntax for compatibility and actual-send tests; the full
Hermes dependency graph is not imported. Its MIT license is included alongside
it as `LICENSE-hermes-MIT.txt`. The installer patches the user's existing source
and never deploys this fixture as the live adapter.
