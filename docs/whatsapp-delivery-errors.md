# Diagnose an accepted campaign that was not delivered

Meta accepting a send and returning a `wamid` does not confirm delivery. A later
signed webhook may report `failed` with diagnostic objects in `statuses[].errors`.
The previous webhook handler discarded those objects. A campaign could therefore
show `Completed`, `failed_count=1`, and `error_message=NULL`.

This patch records the next failure reason and displays delivery separately from
completion of the send job. It cannot reconstruct a diagnostic already discarded,
and it does not by itself resolve an unknown Meta account/recipient failure.

## Rollout order

1. Apply the code patch to a checkout containing commit `deef3d4` (image-template fix).
2. In the existing Supabase project's SQL Editor, run
   `database/whatsapp-delivery-errors.sql`. Its prerequisites are the already
   installed `database/webhook-sync.sql` and `database/hermes-outbound-sync.sql`.
   Run only the new migration; do not rerun the original schema or older migrations.
3. Run `npm test`, `npm run typecheck`, `npm run build`, `npm run smoke`, and
   `git diff --check` on Node 24. Review, commit, push, and redeploy the application.
4. After the deployment succeeds, create one new campaign addressed to your own
   known-working WhatsApp number. Use the approved template and its public image.
5. Wait for the receipt, then open Campaigns → Refresh → View delivery. A failed
   message should show the Meta code and details. Share that diagnostic for the
   next account/recipient-specific fix. Use a new test so a fresh receipt is captured.

Do not treat `Accepted` as delivery confirmation or automatically resend the
previous campaign. Its recipients may have different outcomes. This rollout does
not require changing the Meta callback URL or modifying the Hermes VM.

The campaign send route checks the migration version before creating a campaign
or sending anything. Missing migration returns HTTP 503 with the required filename.
If saving a record fails after a send attempt, the endpoint reports the uncertainty
and does not retry the send.

## What changes

- The signature-checked webhook stores bounded Meta error code/title/message/details
  through the service-only `record_whatsapp_status_with_error` RPC. It excludes
  unrelated receipt fields and redacts token-shaped values. No raw receipt is logged.
- The existing pending-status table becomes a short-lived receipt ledger. It keeps
  at most one row per message ID and status, so a receipt can reconcile both the
  campaign log and the separately inserted message, in either order. A new log
  insert trigger complements the existing message insert trigger.
- Receipt ledger entries older than seven days are removed on subsequent receipt
  activity. This is not a scheduled purge. The bounded error copied into a campaign
  log follows the campaign log's existing retention/deletion lifecycle.
- Repeated receipts remain idempotent. Read/delivered states are not downgraded by
  stale failed/sent receipts, and successful recovery clears a stale log error.
- Campaign finalization recomputes counts from logs under a database row lock,
  instead of overwriting a delivery failure with the send loop's local count.
- The campaign list and dashboard distinguish Awaiting delivery, Delivered, Has
  failures, and Failed. `Accepted` is cumulative API acceptance and can overlap
  `Failed` when delivery fails later. The existing database job states are retained.
- The authenticated campaign details endpoint supplies the failure reason to
  View delivery. Its response is not cached. Refresh updates the list and open details.
- The existing three-argument status RPC remains callable by the service role
  during rollout. Inbound storage, opt-out filtering, and Hermes outgoing recording
  remain compatible with the new migration.

## Read-only fallback diagnosis

If the UI still cannot show the reason after the new test, run:

```sql
SELECT cl.status,
       (cl.wamid IS NOT NULL) AS meta_accepted,
       cl.error_message
FROM public.campaign_logs AS cl
WHERE cl.campaign_id = (
  SELECT id FROM public.campaigns
  ORDER BY created_at DESC
  LIMIT 1
)
ORDER BY cl.created_at;
```

If a new failed receipt has no `errors` array, its reason correctly remains unknown.
Do not infer billing, recipient restrictions, or a media failure without evidence.

## Validation

Tests execute the actual webhook and campaign routes with synthetic requests, and
exercise the additive migrations on PGlite PostgreSQL. Cases include early and
duplicate receipts, receipts between the two inserts in both orders, failure
recovery, missing diagnostics, RPC permissions, version preflight, finalization,
retention, rerunnable migration, and compatibility with the Hermes recorder.
Local checks do not send to Meta or prove live WhatsApp delivery.
