import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const MAX_BODY_BYTES = 1024 * 1024;
const phone = z.string().regex(/^\d{6,15}$/);
const timestamp = z.string().regex(/^\d+$/).refine((v) => Number.isSafeInteger(Number(v)) && Number(v) <= 8640000000000);
const messageSchema = z.object({ id: z.string().min(1).max(512), from: phone, timestamp, type: z.string().optional(), text: z.object({ body: z.string() }).optional() }).passthrough();
const statusSchema = z.object({ id: z.string().min(1).max(512), status: z.string(), timestamp }).passthrough();
const valueSchema = z.object({
  metadata: z.object({ phone_number_id: z.string() }).passthrough().optional(),
  contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string() }).passthrough().optional() }).passthrough()).optional(),
  messages: z.array(messageSchema).max(100).optional(),
  statuses: z.array(statusSchema).max(100).optional(),
}).passthrough();
const envelopeSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(z.object({ id: z.string(), changes: z.array(z.object({ field: z.string(), value: valueSchema }).passthrough()) }).passthrough()).max(100),
}).passthrough();

export type InboundMessage = { phone: string; name: string | null; wamid: string; content: string; sentAt: string };
export type MessageStatus = { wamid: string; status: "sent" | "delivered" | "read" | "failed"; at: string; errorMessage: string | null };
export interface WebhookStore {
  saveInbound(message: InboundMessage): Promise<{ inserted: boolean; forwardAllowed: boolean }>;
  saveStatus(status: MessageStatus): Promise<void>;
}
export interface WebhookConfig { verifyToken?: string; appSecret?: string; wabaId?: string; phoneNumberId?: string; hermesWebhookUrl?: string }
type Dependencies = { createStore: () => WebhookStore | Promise<WebhookStore>; fetch?: typeof globalThis.fetch; logger?: Pick<Console, "error"> };
type Envelope = z.infer<typeof envelopeSchema>;

function equalStrings(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function signMetaBody(body: Uint8Array | string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}
export function verifyMetaSignature(body: Uint8Array, header: string | null, secret: string): boolean {
  if (!header || !/^sha256=[a-fA-F0-9]{64}$/.test(header)) return false;
  return equalStrings(signMetaBody(body, secret), header.toLowerCase());
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
// Keep only Meta's diagnostic fields, never the complete receipt or recipient.
export function deliveryErrorMessage(errors: unknown): string | null {
  if (!Array.isArray(errors)) return null;
  const text = errors.slice(0, 5).map((value) => {
    const error = object(value);
    const code = typeof error.code === "number" && Number.isSafeInteger(error.code) ? `(#${error.code}) ` : "";
    const parts = [error.title, error.message, object(error.error_data).details]
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    return code + [...new Set(parts.map((item) => item.trim()))].join(" — ");
  }).filter(Boolean).join("; ")
    .replace(/EAA[A-Za-z0-9]{16,}/g, "[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(access_token|app_secret|authorization)\s*[=:]\s*[^\s&;,]+/gi, "$1=[redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 2000);
  return text || null;
}
export function inboundText(message: Record<string, unknown>): string {
  const button = object(message.button); const interactive = object(message.interactive);
  const reply = object(interactive.button_reply ?? interactive.list_reply);
  const media = object(message.image ?? message.video ?? message.document);
  const candidates = [object(message.text).body, button.text, reply.title, media.caption, message.caption];
  return candidates.find((v): v is string => typeof v === "string" && v.length > 0)
    ?? `[${typeof message.type === "string" ? message.type : "media"}]`;
}
async function limitedBody(request: Request): Promise<Buffer> {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) throw new Error("body_too_large");
  const reader = request.body?.getReader(); if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new Error("body_too_large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
function reply(status: number, data: object): Response { return Response.json(data, { status, headers: { "Cache-Control": "no-store" } }); }
function relayDestination(value: string | undefined, source: string): URL | null {
  if (!value?.trim()) return null;
  const target = new URL(value.trim()); const current = new URL(source);
  if (target.protocol !== "https:" || target.username || target.password || target.hash ||
      (target.origin === current.origin && target.pathname.replace(/\/$/, "") === current.pathname.replace(/\/$/, ""))) {
    throw new Error("invalid_relay_configuration");
  }
  return target;
}
// Preserve the original signed bytes unless blocked/opted-out messages need
// removing. A filtered body is signed again using this app's own secret.
function relayBody(envelope: Envelope, raw: Buffer, allowed: Set<string>): Buffer | null {
  let filtered = false; let relevant = false;
  const entry = envelope.entry.map((item) => ({ ...item, changes: item.changes.flatMap((change) => {
    if (change.field !== "messages") { filtered = true; return []; }
    const messages = change.value.messages?.filter((message) => allowed.has(message.id));
    const pruned = (messages?.length ?? 0) !== (change.value.messages?.length ?? 0);
    if (pruned) filtered = true;
    if (!messages?.length && !change.value.statuses?.length) { filtered = true; return []; }
    relevant = true;
    const phones = new Set(messages?.map((message) => message.from));
    return [{ ...change, value: { ...change.value, ...(messages ? { messages } : {}),
      ...(pruned && change.value.contacts ? { contacts: change.value.contacts.filter((contact) => phones.has(contact.wa_id)) } : {}),
    } }];
  }) })).filter((item) => item.changes.length > 0);
  if (!relevant) return null;
  return filtered ? Buffer.from(JSON.stringify({ ...envelope, entry })) : raw;
}

export function createWhatsAppWebhook(config: WebhookConfig, dependencies: Dependencies) {
  const transport = dependencies.fetch ?? globalThis.fetch;
  const logger = dependencies.logger ?? console;
  return {
    async GET(request: Request): Promise<Response> {
      if (!config.verifyToken?.trim()) return reply(503, { error: "Webhook verification is not configured" });
      const params = new URL(request.url).searchParams; const challenge = params.get("hub.challenge");
      if (params.get("hub.mode") !== "subscribe" || !equalStrings(params.get("hub.verify_token") ?? "", config.verifyToken) || !challenge) return reply(403, { error: "Forbidden" });
      return new Response(challenge, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    },
    async POST(request: Request): Promise<Response> {
      if (!config.appSecret?.trim() || !config.wabaId?.trim() || !config.phoneNumberId?.trim()) return reply(503, { error: "Webhook is not configured" });
      let raw: Buffer;
      try { raw = await limitedBody(request); }
      catch (e) { return reply(e instanceof Error && e.message === "body_too_large" ? 413 : 400, { error: "Invalid request body" }); }
      if (!verifyMetaSignature(raw, request.headers.get("x-hub-signature-256"), config.appSecret)) return reply(401, { error: "Invalid signature" });
      let parsed: unknown;
      try { parsed = JSON.parse(raw.toString("utf8")); } catch { return reply(400, { error: "Invalid JSON" }); }
      if (object(parsed).object !== "whatsapp_business_account") return reply(200, { status: "ignored" });
      const validation = envelopeSchema.safeParse(parsed);
      if (!validation.success) return reply(400, { error: "Invalid webhook payload" });
      const envelope = validation.data; let relevant = false;
      for (const entry of envelope.entry) {
        if (entry.id !== config.wabaId) return reply(403, { error: "Unexpected WhatsApp account" });
        for (const change of entry.changes) {
          if (change.field !== "messages" || (!change.value.messages?.length && !change.value.statuses?.length)) continue;
          if (change.value.metadata?.phone_number_id !== config.phoneNumberId) return reply(403, { error: "Unexpected phone number" });
          relevant = true;
        }
      }
      if (!relevant) return reply(200, { status: "ignored" });
      let destination: URL | null;
      try { destination = relayDestination(config.hermesWebhookUrl, request.url); } catch { return reply(503, { error: "Invalid Hermes relay configuration" }); }
      let messages = 0; let statuses = 0; const allowed = new Set<string>();
      const decisions = new Map<string, boolean>();
      const messagePhones = new Map<string, string>();
      try {
        const store = await dependencies.createStore();
        for (const entry of envelope.entry) for (const change of entry.changes) {
          if (change.field !== "messages") continue;
          const value = change.value;
          for (const message of value.messages ?? []) {
            const result = await store.saveInbound({ phone: `+${message.from}`, name: value.contacts?.find((c) => c.wa_id === message.from)?.profile?.name ?? null,
              wamid: message.id, content: inboundText(message), sentAt: new Date(Number(message.timestamp) * 1000).toISOString() });
            if (result.inserted) messages++;
            decisions.set(message.from, result.forwardAllowed);
            messagePhones.set(message.id, message.from);
          }
          for (const status of value.statuses ?? []) {
            if (!["sent", "delivered", "read", "failed"].includes(status.status)) continue;
            await store.saveStatus({ wamid: status.id, status: status.status as MessageStatus["status"],
              at: new Date(Number(status.timestamp) * 1000).toISOString(),
              errorMessage: status.status === "failed" ? deliveryErrorMessage(status.errors) : null });
            statuses++;
          }
        }
      } catch {
        logger.error("[whatsapp-webhook] persistence_failed");
        return reply(503, { error: "Unable to save webhook; please retry" });
      }
      // A STOP later in the same batch also suppresses earlier messages from
      // that contact; other contacts in the batch still reach Hermes.
      for (const [id, phone] of messagePhones) if (decisions.get(phone)) allowed.add(id);
      const outgoing = destination ? relayBody(envelope, raw, allowed) : null;
      if (destination && outgoing) {
        try {
          const response = await transport(destination.href, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(5000),
            headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signMetaBody(outgoing, config.appSecret) }, body: new Uint8Array(outgoing) });
          if (!response.ok) throw new Error("relay_failed");
        } catch {
          logger.error("[whatsapp-webhook] relay_failed");
          // Reattempt forwarding even if the CRM row already exists: the prior
          // attempt may have failed. The receiver must dedupe inbound wamids.
          return reply(502, { error: "Hermes unavailable; please retry" });
        }
      }
      return reply(200, { status: "ok", messages, statuses, forwarded: Boolean(outgoing) });
    },
  };
}
