# WhatsApp incoming sync patch

For the subsequent Hermes outgoing-reply integration and early status-receipt
reconciliation, see [Hermes outgoing sync](hermes-outbound-sync.md).

This single-business CRM currently receives no customer webhook while Meta points
at the separate Hermes gateway. This patch prepares the CRM to receive signed
Meta events, persist them, and optionally forward allowed messages to Hermes.
It has not been deployed and does not change Meta's current callback.

## Resulting behavior

- `GET /api/webhook` returns Meta's verification challenge as plain text.
- `POST /api/webhook` validates the HMAC over the original request bytes and
  checks the configured WhatsApp Business Account and phone-number IDs before
  creating a service-role client. Invalid signatures never reach the database.
- A transactional Postgres function saves incoming messages by unique `wamid`.
  A retried event cannot create another message or increment its contact count.
  Existing contact names, email, tags and blocked/inactive status survive.
- Text, template quick replies (`DEMO`, `PRICE`), interactive replies and media
  captions become inbox content. Media without captions is represented by its
  type; the file itself is not downloaded or rendered by this patch.
- Duplicate/reordered delivery/read receipts do not downgrade successful states
  or repeatedly increment campaign counters. Unknown outgoing IDs are ignored.
- Exact `STOP` or `UNSUBSCRIBE` (case insensitive, surrounding spaces ignored)
  blocks the contact. Blocked/inactive contacts are not forwarded to Hermes and
  are excluded from subsequent campaign sends. Campaigns recheck status before
  each send; a send already in progress cannot be recalled. Existing manual
  reply controls and human reactivation of a contact are unchanged.
- With `HERMES_WEBHOOK_URL` configured, forwarding happens after persistence.
  Allowed batches keep their original signed bytes. Mixed batches remove blocked
  contacts and are signed again with the same Meta app secret. A failed/redirected
  relay returns a retryable error; already saved messages may be forwarded again
  on retry. Confirm the installed Hermes adapter deduplicates `wamid`s before
  enabling automatic replies. This is not an exactly-once delivery guarantee.
- Inbox subscriptions handle inserts and status updates, deduplicate overlapping
  events, ignore stale responses from a previously selected contact, and refresh
  visible tabs every 10 seconds if Realtime misses an event.
- Browser API routes require a Supabase login. Middleware is moved alongside
  `src/app` so this Next.js build actually registers it; route-level checks also
  protect privileged handlers. The service client has no browser
  cookies. This does not create per-tenant access rules: existing RLS grants all
  authenticated users access to the business's data. Keep public signup disabled
  in Supabase and invite only the CRM's intended operators.

## Apply and validate (do not switch the live callback first)

1. Apply the supplied patch to `KKG-213/wa-crm`, based on commit
   `2abe51e29369adba40b7a4881547f48cdbfe321b`. Keep unrelated local changes.
   If the branch has moved, inspect conflicts rather than replacing whole files.
2. In Supabase SQL Editor, apply **only** `database/webhook-sync.sql` to the
   existing database. It is transactional and rerunnable. Do not rerun the
   original schema: its triggers/policies/publication additions are not rerunnable.
3. Confirm the Vercel project's **server-only Production** variables below. Do
   not put server credentials in `NEXT_PUBLIC_` variables or repository files.
4. Run `npm ci`, `npm test` (Node 24 or Node 22.18+), `npm run typecheck` and
   `npm run build`. Test a signed synthetic event with a test database; do not
   send an unsolicited real campaign as a build check.
   `npm run smoke` starts a local production server with dummy credentials,
   checks the actual middleware registration, verification challenge, signature
   rejection and anonymous API/page access, then stops the server.
5. Deploy/redeploy the CRM so code and environment changes are active. Verify its
   GET challenge and signed incoming event storage before switching Meta.
6. Configure/verify the Hermes **sales** profile and platform routing separately.
   This patch does not change the VM, model, allowed users, tools or SOUL.md.
   Its App Secret must match this CRM's Meta app. Only then set the optional
   `HERMES_WEBHOOK_URL` to the existing Hermes callback and redeploy if needed.
7. After both services pass their checks, change the Meta app's WhatsApp webhook
   callback to `https://wam.kwsolutioins.online/api/webhook`, enter this CRM's
   `META_VERIFY_TOKEN`, verify and save, and keep the `messages` field subscribed.
   Use the WhatsApp webhook configuration, not the app's authentication callback.
8. Send one fresh message from your test phone. Confirm one incoming row in the
   CRM and one Hermes response. Repeat delivery of the event to check deduplication.
   Test DEMO/PRICE and STOP with controlled test contacts before campaigns.

| Variable | Value/source |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Existing project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Existing anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only project service-role key |
| `META_ACCESS_TOKEN` | Existing valid server-only token used to send messages |
| `META_PHONE_NUMBER_ID` | `1409792945541835` |
| `META_WABA_ID` | `4496553363935878` |
| `META_VERIFY_TOKEN` | Your chosen verification string, exactly matching Meta |
| `META_APP_SECRET` | App `user_data` → Settings → Basic → App Secret |
| `HERMES_WEBHOOK_URL` | Optional: `https://n8n.devkoushik.online/whatsapp/webhook` |

Keep the current callback at `https://n8n.devkoushik.online/whatsapp/webhook`
until the migration, deployment and profile checks are complete. An empty relay
variable deliberately saves incoming messages in the CRM without invoking Hermes.

## Limits and rollback

This patch syncs **new incoming events**. It does not backfill earlier messages,
and Meta delivery receipts cannot reconstruct the body text of replies sent
directly by Hermes. Those replies need a separately authenticated post-send
integration to appear as outgoing CRM conversation rows. CRM-originated replies
already use its message-sending endpoint. Image-header template sending, keyword
sales flows and Hermes model/profile activation are separate work.

It uses synchronous relay with a five-second timeout, not a durable relay queue.
Temporary failures rely on Meta retrying events. A status received before an
outgoing row is inserted cannot be reconciled by these functions. The existing
campaign sender's completion counter writes are unchanged, so concurrent status
receipts while a campaign is running may need a later counter reconciliation.
Existing public/security-definer SQL helpers and multi-tenant authorization were
not audited by this scoped patch.

To roll back routing, restore Meta's previous Hermes callback and its existing
verify token. The new database functions are additive and can remain; no contacts
or messages are deleted by the migration. Reverting code does not undo stored
data. The minor Skeleton HTML-props and Supabase cookie-type fixes resolve two
pre-existing TypeScript errors found while validating this patch.

Primary platform references:
- [Meta Cloud API webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks)
- [Hermes multi-profile gateway](https://hermes-agent.nousresearch.com/docs/user-guide/multi-profile-gateways)
- [Supabase Realtime Postgres changes](https://supabase.com/docs/guides/realtime/postgres-changes)
