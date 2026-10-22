# Campaign pacing, rate-limit pause and durable recipients

This change replaces the campaign POST's unpaced send loop with a persistent
recipient queue. The browser dispatches one recipient per authenticated request.
A database row shared by CRM campaigns for the same Meta phone ID permits one
in-flight request and at least five seconds between a completed attempt and the
next attempt. The five-second gap is a conservative application default, not a
published Meta limit or a guarantee of delivery.

## Operator flow

1. Create a campaign with its approved template/image and reviewed contacts.
   Creation saves the recipients; it does not call the Meta messages endpoint.
2. The campaign dialog starts dispatching. Keep the dialog/page open while sending.
   Pause after current message stops future dispatch requests. An already-started
   request may finish and record its result.
3. Closing/reloading the page leaves unsent recipients queued in PostgreSQL.
   Open Campaigns and choose Send remaining to continue them. There is no installed
   background cron or VM worker in this patch.
4. On Meta error 130429 the sender pauses. The UI stops dispatching and displays
   a resume-after time. Resume manually after that time; the server also enforces it.
5. Check Refresh → View delivery for final receipts. API acceptance and delivery
   remain distinct. A failed or uncertain row is not automatically requeued.

Both HTTP 130429 rejections and asynchronous failed receipts trigger the pause.
Distinct rate-limit events increase the pause from 60 seconds by powers of two,
capped at one hour. Duplicate failed webhooks do not extend it repeatedly. A
stale failure after a successful delivery/read does not pause the sender.
This cooldown controls this CRM; Meta may still apply another limit after it.
Other senders using the same phone (including Hermes replies or separate MCP/n8n
campaigns) do not use this CRM's dispatcher and can contribute to Meta limits.

## Interpreting failures and recovering the old batch

- 130429 reports the sender's rate limit. Stop repeatedly submitting the full batch.
- 131026 reports an undeliverable message. Verify the actual WhatsApp recipient
  details before another attempt. The code alone does not prove that a number is
  invalid or identify one exact cause. A published business/landline number is not
  automatically a confirmed WhatsApp contact; landlines are not categorically
  rejected by the phone normalizer.
- 131049 remains Meta's marketing-delivery restriction. This patch does not bypass it.
- Delivered/read rows should not be included in a new retry campaign.

For an existing campaign, Refresh → View delivery → Export rate-limited recipients
downloads only currently failed 130429 rows. It excludes delivered/read, queued,
accepted/pending, uncertain and 131026 rows, and deduplicates phone numbers. The
CSV is a review aid; it sends nothing. Review the list and resume only appropriate
contacts after the sender cooldown. Historical campaigns are never automatically
converted into queued work or retried by the migration.

## Rollout

Prepared against `edc2f19ecb0a9190a2f0780eb68dd66a918108f8` in KKG-213/wa-crm.

1. Pause active campaign runs while rolling out.
2. Apply the patch to a checkout containing that delivery-diagnostics commit.
3. Run only `database/whatsapp-campaign-queue.sql` in the existing Supabase SQL
   Editor. Prerequisites are the already installed webhook-sync.sql,
   hermes-outbound-sync.sql, and whatsapp-delivery-errors.sql. The new migration
   is rerunnable. Do not rerun older migrations afterward; they replace functions.
4. On Node 24 run npm test, npm run typecheck, npm run build, npm run smoke and
   git diff --check. Deploy only after the new SQL succeeds.
5. Hard-refresh the browser. The campaign form now sends an idempotency key.
   Test with a small known-working, permissioned recipient set before normal use.

No new environment secret, Meta webhook URL, Hermes update, or VM configuration
is required. The new route refuses queue creation/dispatch when the queue SQL
version is missing. Existing pre-queue campaign data and the older service-only
status RPC remain compatible during rollout.

## Failure and duplication handling

Queued recipients, template components, language, image URL and sender identity
are persisted. Retrying campaign creation with the same request key and matching
fingerprint returns the original campaign, rather than enqueueing a second one.

A database claim changes one log from queued to sending and gives it an opaque
dispatch token and 90-second lease. Other tabs/campaign requests wait while that
sender has in-flight work. The worker checks that the configured Meta sender
still matches the queued sender. Contacts blocked/inactive after enqueue are
skipped immediately before dispatch.

The Graph messages call is made once per claim. Only database acknowledgement
is retried, up to three times. Repeated acknowledgements cannot duplicate chat
rows or reset a delivery/read receipt. Early webhooks reconcile when the queued
log acquires its wamid and again when the chat message is inserted.

If network/response acceptance is unknown, the row becomes uncertain and the UI
stops for review. If a process disappears, an expired lease is also moved to
uncertain on a later dispatch request. The same recipient is not automatically
claimed again. A late valid acknowledgement can reconcile that old attempt
without releasing another recipient's current lease. There is no promise of
exactly-once delivery by the external Meta API; uncertainty requires review.

Accepted/failed/skipped/remaining/review counters are recomputed from persisted
logs. Receipt updates still advance monotonically and update delivery counts.

## Security and validation

Public webhook signatures and account/phone validation remain mandatory. Queue
creation and dispatch require the existing logged-in admin API path; queue RPCs
are executable only by service_role. The sender table is private. Queue data
stores no access token or app secret. No raw request bodies are logged.

Tests cover persisted pacing/leases across separate requests, early receipts,
duplicate acknowledgements, cooldown/backoff, STOP, missing migration, idempotent
creation, unknown acceptance, stale leases, role privileges, image-template
components, safe CSV export, and compatibility with the legacy Hermes recorder.
PGlite tests exercise real PostgreSQL functions; multi-session production lock
behavior is reviewed in SQL, not load-tested against a remote production DB.
Local tests use fake Meta responses and do not send live messages.

Primary references:

- https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput
- https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes
- https://vercel.com/docs/functions/configuring-functions/duration
