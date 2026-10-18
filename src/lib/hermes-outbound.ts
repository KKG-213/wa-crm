import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const DOMAIN = "hermes-crm-outbound-v1\n";
const MAX_BYTES = 256 * 1024;
const payloadSchema = z.object({
  version: z.literal(1),
  phone_number_id: z.string().regex(/^\d{6,32}$/),
  recipient: z.string().regex(/^\d{6,15}$/),
  wamid: z.string().min(1).max(512),
  message_type: z.string().min(1).max(64),
  content: z.string().min(1).max(65536),
  sent_at: z.string().datetime({ offset: true }),
}).strict();
export type HermesOutbound = z.infer<typeof payloadSchema>;
export function signHermesOutbound(raw: Uint8Array | string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(DOMAIN).update(raw).digest("hex")}`;
}
export function createHermesOutboundHandler(config: { appSecret?: string; phoneNumberId?: string }, deps: {
  createStore: () => { save: (message: HermesOutbound) => Promise<boolean> };
  logger?: Pick<Console, "error">;
}) {
  return async function POST(request: Request): Promise<Response> {
    const reply = (status: number, data: object) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
    if (!config.appSecret?.trim() || !config.phoneNumberId?.trim()) return reply(503, { error: "Outbound sync is not configured" });
    let raw: Buffer;
    try {
      if (Number(request.headers.get("content-length")) > MAX_BYTES) return reply(413, { error: "Payload too large" });
      const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try {
        if (reader) for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) { await reader.cancel(); return reply(413, { error: "Payload too large" }); }
          chunks.push(value);
        }
      } finally { reader?.releaseLock(); }
      raw = Buffer.concat(chunks);
    } catch { return reply(400, { error: "Invalid request body" }); }
    const header = request.headers.get("x-hermes-signature-256");
    const expected = signHermesOutbound(raw, config.appSecret);
    if (!header || !/^sha256=[a-fA-F0-9]{64}$/.test(header) ||
        !timingSafeEqual(Buffer.from(expected), Buffer.from(header.toLowerCase()))) return reply(401, { error: "Invalid signature" });
    let decoded: unknown;
    try { decoded = JSON.parse(raw.toString("utf8")); } catch { return reply(400, { error: "Invalid JSON" }); }
    const parsed = payloadSchema.safeParse(decoded);
    if (!parsed.success) return reply(400, { error: "Invalid outgoing message" });
    if (parsed.data.phone_number_id !== config.phoneNumberId) return reply(403, { error: "Unexpected phone number" });
    try {
      const inserted = await deps.createStore().save(parsed.data);
      return reply(200, { status: "ok", inserted });
    } catch {
      (deps.logger ?? console).error("[hermes-outbound] persistence_failed");
      return reply(503, { error: "Unable to save outgoing message; please retry" });
    }
  };
}
