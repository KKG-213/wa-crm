import { createServiceRoleClient } from "@/lib/supabase/server";
import { createWhatsAppWebhook, type WebhookStore } from "@/lib/whatsapp-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function handler() {
  return createWhatsAppWebhook({
    verifyToken: process.env.META_VERIFY_TOKEN,
    appSecret: process.env.META_APP_SECRET,
    wabaId: process.env.META_WABA_ID,
    phoneNumberId: process.env.META_PHONE_NUMBER_ID,
    hermesWebhookUrl: process.env.HERMES_WEBHOOK_URL,
  }, {
    createStore: (): WebhookStore => {
      const supabase = createServiceRoleClient();
      return {
        async saveInbound(message) {
          const { data, error } = await supabase.rpc("record_whatsapp_inbound", {
            p_phone: message.phone, p_name: message.name, p_wamid: message.wamid,
            p_content: message.content, p_sent_at: message.sentAt,
          });
          if (error || !data || typeof data.inserted !== "boolean" || typeof data.forward_allowed !== "boolean") throw new Error("inbound_write_failed");
          return { inserted: data.inserted, forwardAllowed: data.forward_allowed };
        },
        async saveStatus(status) {
          const { error } = await supabase.rpc("record_whatsapp_status", {
            p_wamid: status.wamid, p_status: status.status, p_at: status.at,
          });
          if (error) throw new Error("status_write_failed");
        },
      };
    },
  });
}

export async function GET(request: Request) { return handler().GET(request); }
export async function POST(request: Request) { return handler().POST(request); }
