# Continue campaigns through cooldowns and closed browser tabs

The browser sender now waits through a valid Meta cooldown and resumes automatically.
It still stops for unknown acceptance, recording errors, or missing cooldown data.
Closing the page stops browser dispatch. Use the worker below for unattended sending.

## Background worker setup

1. Deploy this branch. No database migration is required; queue version 1 is reused.
2. Set a fresh random `CRON_SECRET` of at least 32 characters in the deployment.
3. Set `CAMPAIGN_WORKER_IDS` to a comma-separated list of reviewed campaign UUIDs.
   Empty means disabled; historical campaigns are never selected automatically.
4. Configure your scheduler to GET `/api/campaigns/worker` on the production origin
   with `Authorization: Bearer <CRON_SECRET>`, once per minute initially.
   Vercel cron can send this header automatically; check your plan's schedule limits.
   An external scheduler works too. Never put the secret in a URL or client code.
5. Verify scheduler responses and campaign delivery receipts. `processed` is one
   attempt, `paused` respects Meta's cooldown, `wait` respects the shared sender
   lease/pacing, and `idle` means no selected campaign has eligible work.
   HTTP 503 requires reviewing the last attempt; do not requeue it blindly.
6. To pause background sending, disable the scheduler. Removing campaign IDs or
   clearing the allowlist and redeploying also disables them. An in-flight send may
   finish. The browser's Pause button controls only that browser, not the worker.

At most one recipient is attempted per worker call, through the same database
claim/acknowledgement path as the browser. Multiple invocations cannot bypass the
sender lease. Repeated scheduler calls naturally resume after a cooldown. Already
accepted, failed and uncertain recipients are not requeued. Review 130429 failures
using the existing rate-limit export and create a separate retry campaign only
once appropriate; delivery/read recipients must not be included.

For the incident investigated on 2026-11-08, the image campaign had 49 queued
recipients and two asynchronous 130429 failures. The image URL returned HTTP 200
with image/png and 1,735,411 bytes. That evidence points to rate limiting, not a
broken image URL. Older campaigns also contain 132012 template mismatches; do not
resend those historical payloads without selecting a currently approved template
and the required image/text parameters again. No existing recipients were retried
as part of this change. Meta acceptance is not a delivery guarantee.

Reference: https://vercel.com/docs/cron-jobs/manage-cron-jobs
