# Sending the approved image template

`web_design_request` is an approved English marketing template with an image header. Error `132012` occurred because the CRM sent only the template name and language; it did not include the required image component.

The campaign form now loads the current approved template components and exact language. Selecting this template fills the header-image URL with the bundled Website + Local SEO poster at:

`https://wam.kwsolutioins.online/whatsapp/web_design_request.png`

This URL exists after the changed source and `public/whatsapp/web_design_request.png` are deployed together. Open it without signing in to confirm Meta can download it. The image is the existing KW poster, copied without editing; it is approximately 1.7 MB.

## First live check after deployment

1. Open Campaigns → New Campaign and refresh templates.
2. Choose `web_design_request` and its English language entry. Confirm the header-image URL and image preview.
3. Upload a sheet containing only your own test WhatsApp number, with country code. Review and send that one test from the UI.
4. Confirm receipt of the image, text and approved buttons. Graph acceptance alone is not delivery; delivery/read receipts update later.
5. Start a new campaign for the intended contacts once the one-number test succeeds. Failed campaigns are not automatically replayed by this patch.

For another image template, supply a public HTTPS PNG/JPEG URL. A Meta sample/header upload shown in template approval is not automatically attached to each send; the send request needs its own image link.

## Request format

The backend re-fetches approved metadata and validates the exact name/language, required image and any numbered text values before it creates the campaign or sends a message. It constructs, rather than trusting client-supplied raw components:

```json
{
  "messaging_product": "whatsapp",
  "to": "919000000001",
  "type": "template",
  "template": {
    "name": "web_design_request",
    "language": { "code": "en" },
    "components": [{
      "type": "header",
      "parameters": [{
        "type": "image",
        "image": { "link": "https://wam.kwsolutioins.online/whatsapp/web_design_request.png" }
      }]
    }]
  }
}
```

Quick-reply button payloads are added from the approved button labels when present. Static phone and URL buttons stay as approved; they do not receive invented runtime parameters. Header/body numbered text variables get explicit form fields; those values apply to every contact in that campaign.

Text-only templates continue to work without an image. Video/document/location headers, named variables, carousel/flow and dynamic URL buttons receive a clear unsupported-format error before any campaign send. Up to 100 approved templates are loaded, matching the previous list limit.

## Other fixes needed for reliable results

- The form now retains actual sent/failed/skipped counts and the first Meta error. A campaign with zero successful sends is not displayed as successfully delivered.
- Meta error code and `error_data.details` are stored in `campaign_logs.error_message`, with access-token/JWT patterns redacted. Graph/network errors are not automatically retried because an uncertain send may already have been accepted.
- An image URL is recorded in the existing `messages.media_url` column; there is no new database column or migration.
- India-local 10-digit numbers and 11-digit numbers with a leading national trunk zero normalize consistently to `+91...`. Explicit international prefixes are preserved, invalid country-code formats are rejected, and duplicate normalized contacts are sent only once per submitted campaign. This checks format, not whether a number has WhatsApp. Existing contact rows/campaign history are not rewritten; re-import the source for a new campaign.
- Existing active/blocked checks, including the status recheck immediately before each send, remain in place.
- Sender and template lookup use the same Graph API version, defaulting to `v26.0` to match the configured Meta app. `META_GRAPH_API_VERSION` can explicitly override it if needed. Existing Meta credentials are reused.

This patch changes the CRM's template-send flow. Its webhook, Hermes forwarding, outbound sync endpoint, authentication rules and installed VM sales filter are unchanged. No SQL or VM reinstallation is needed.

## Limits of this fix

Bulk campaigns still run in one server request, as in the existing application. This is not a durable campaign queue and does not add campaign-wide idempotency or automatic retry. A server/network timeout can leave delivery uncertain: inspect existing campaign logs before launching another campaign. Account, payment, quality, recipient and template-policy restrictions still come from Meta and are shown through its error response.

## Validation

`npm test`, `npm run typecheck`, `npm run build`, and `npm run smoke` are the project checks. New tests execute the campaign handler with mocked external dependencies and verify actual outgoing image JSON, format rejection before writes/sends, exact language, normalized deduplication, failure counts and STOP rechecks. Existing webhook/database tests continue to run. The production smoke also checks that the bundled PNG is public while private APIs still require login. No real Meta send is performed in those tests.

API structure reference: [Meta's template object example](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/types/TemplateObject/).
