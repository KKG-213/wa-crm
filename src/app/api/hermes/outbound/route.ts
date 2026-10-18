import { createServiceRoleClient } from "@/lib/supabase/server";
import { createHermesOutboundHandler } from "@/lib/hermes-outbound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return createHermesOutboundHandler({
    appSecret: process.env.META_APP_SECRET,
    phoneNumberId: process.env.META_PHONE_NUMBER_ID,
  }, {
    createStore: () => {
      const supabase = createServiceRoleClient();
      return { async save(message) {
        const { data, error } = await supabase.rpc("record_whatsapp_outbound", {
          p_phone: `+${message.recipient}`, p_wamid: message.wamid,
          p_content: message.content, p_sent_at: message.sent_at,
        });
        if (error || typeof data?.inserted !== "boolean") throw new Error("outbound_write_failed");
        return data.inserted as boolean;
      } };
    },
  })(request);
}
