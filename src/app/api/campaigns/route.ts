import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/server";
import { getApprovedWhatsAppTemplates } from "@/services/meta";
import { buildTemplateComponents } from "@/lib/meta-template";
import { normalizeCampaignPhone, validCampaignPhone } from "@/lib/campaign-contacts";
import { z } from "zod";

const payloadSchema = z.object({
  request_key: z.string().uuid(),
  campaign_name: z.string().trim().min(2).max(200), template_name: z.string().min(1).max(512),
  template_language: z.string().min(1).max(32), header_image_url: z.string().max(4096).optional(),
  header_values: z.array(z.string().max(1024)).max(20).optional(),
  body_values: z.array(z.string().max(1024)).max(20).optional(),
  contacts: z.array(z.object({ phone: z.string().max(100), name: z.string().max(300).optional(),
    email: z.string().max(320).optional() })).min(1).max(1000),
});

export async function POST(req: NextRequest) {
  try {
    const supabase = await createAdminClient();
    const validation = payloadSchema.safeParse(await req.json());
    if (!validation.success) return NextResponse.json({ error: "Check the campaign fields and contacts." }, { status: 400 });
    const body = validation.data;
    const { campaign_name, template_name, template_language } = body;
    const contacts = [...new Map(body.contacts.map((contact) => {
      const phone = normalizeCampaignPhone(contact.phone);
      return [phone, { ...contact, phone }] as const;
    })).values()];
    if (contacts.some((contact) => !validCampaignPhone(contact.phone))) {
      return NextResponse.json({ error: "A contact has an invalid phone format. Include its country code." }, { status: 400 });
    }
    let templates;
    try { templates = await getApprovedWhatsAppTemplates(); }
    catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to check the approved template" }, { status: 502 }); }
    const template = templates.find((item) => item.name === template_name && item.language === template_language);
    if (!template) return NextResponse.json({ error: "This approved template/language was not found. Refresh templates and select it again." }, { status: 400 });
    let components;
    try {
      components = buildTemplateComponents(template, { headerImageUrl: body.header_image_url,
        headerValues: body.header_values, bodyValues: body.body_values });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Check template parameters" }, { status: 400 });
    }
    const { data: queueVersion, error: setupError } = await supabase.rpc("whatsapp_campaign_queue_version");
    if (setupError || queueVersion !== 1) {
      return NextResponse.json({ error: "Apply database/whatsapp-campaign-queue.sql before sending campaigns." }, { status: 503 });
    }
    const phoneId = process.env.META_PHONE_NUMBER_ID;
    if (!phoneId || !/^[0-9]{6,32}$/.test(phoneId)) return NextResponse.json({ error: "Meta sender is not configured." }, { status: 503 });
    const fingerprint = createHash("sha256").update(JSON.stringify({ campaign_name, template_name, template_language,
      phoneId, components, contacts })).digest("hex");
    // The request only queues work. A separate authenticated dispatch call sends
    // one recipient; closing/retrying this POST cannot resend accepted messages.
    const { data, error } = await supabase.rpc("enqueue_whatsapp_campaign", {
      p_request_key: body.request_key, p_fingerprint: fingerprint, p_name: campaign_name,
      p_template: template_name, p_language: template_language, p_phone_number_id: phoneId,
      p_components: components, p_image_url: body.header_image_url?.trim() || null, p_contacts: contacts,
    });
    if (error || !data?.campaign_id) return NextResponse.json({ error: "Could not queue campaign. Check the campaign list before retrying." }, { status: 500 });
    return NextResponse.json({ success: true, ...data, sent: data.accepted }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("Campaign error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const supabase = await createAdminClient();
    const { data, error } = await supabase
      .from("campaigns")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Failed to fetch campaigns" }, { status: 500 });
  }
}
