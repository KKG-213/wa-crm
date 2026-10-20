import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { getApprovedWhatsAppTemplates, sendWhatsAppTemplate } from "@/services/meta";
import { buildTemplateComponents } from "@/lib/meta-template";
import { normalizeCampaignPhone, validCampaignPhone } from "@/lib/campaign-contacts";
import { z } from "zod";

const payloadSchema = z.object({
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
    // All format checks finish before a campaign is created or any recipient is sent a message.
    const { data: deliveryVersion, error: deliverySetupError } = await supabase.rpc("whatsapp_delivery_sync_version");
    if (deliverySetupError || deliveryVersion !== 1) {
      return NextResponse.json({ error: "Apply database/whatsapp-delivery-errors.sql before sending campaigns." }, { status: 503 });
    }

    // Create campaign
    const { data: campaign, error: campaignError } = await supabase
      .from("campaigns")
      .insert({
        name: campaign_name,
        template_name,
        template_language,
        status: "running",
        total_contacts: contacts.length,
      })
      .select()
      .single();

    if (campaignError || !campaign) {
      throw new Error(campaignError?.message ?? "Failed to create campaign");
    }

    // Upsert contacts
    const { data: upsertedContacts } = await supabase
      .from("contacts")
      .upsert(
        contacts.map((c) => ({ phone: c.phone, name: c.name ?? null, email: c.email ?? null })),
        { onConflict: "phone", ignoreDuplicates: false }
      )
      .select("id, phone, status");

    if (!upsertedContacts?.length) {
      throw new Error("Failed to upsert contacts");
    }

    let sentCount = 0;
    let failedCount = 0;
    let firstError: string | null = null;
    const eligibleContacts = upsertedContacts.filter((contact) => contact.status === "active");
    const skippedCount = upsertedContacts.length - eligibleContacts.length;

    await supabase.from("campaigns").update({ total_contacts: eligibleContacts.length }).eq("id", campaign.id);

    for (const contact of eligibleContacts) {
      // Recheck immediately before sending so a STOP received during a campaign
      // suppresses contacts that have not yet been sent a message.
      const { data: currentContact, error: contactError } = await supabase
        .from("contacts").select("status").eq("id", contact.id).single();
      if (contactError) throw new Error("Unable to check contact status");
      if (currentContact?.status !== "active") continue;
      const { ok, wamid, error } = await sendWhatsAppTemplate(
        contact.phone,
        template_name,
        template_language,
        components
      );

      const { error: logError } = await supabase.from("campaign_logs").insert({
        campaign_id: campaign.id,
        contact_id: contact.id,
        wamid: wamid ?? null,
        status: ok ? "sent" : "failed",
        error_message: error ?? null,
        sent_at: new Date().toISOString(),
      });
      if (logError) throw new Error("Message attempted, but its campaign record could not be saved. Check delivery before retrying.");

      const { error: messageError } = await supabase.from("messages").insert({
        contact_id: contact.id,
        campaign_id: campaign.id,
        wamid: wamid ?? null,
        direction: "outbound",
        media_url: body.header_image_url || null,
        content: `📢 ${campaign_name} — Template: ${template_name}`,
        status: ok ? "sent" : "failed",
        sent_at: new Date().toISOString(),
      });
      if (messageError) throw new Error("Message attempted, but its chat record could not be saved. Check delivery before retrying.");

      if (ok) {
        sentCount++;
        await supabase
          .from("contacts")
          .update({ last_message_at: new Date().toISOString() })
          .eq("id", contact.id);
      } else {
        failedCount++;
        firstError ??= error ?? "Meta did not accept this message";
        console.error("Campaign message send failed");
      }
    }

    // Receipts may arrive during the loop. Finalize from persisted logs under
    // a database lock instead of overwriting delivery failures with local totals.
    const { error: finishError } = await supabase.rpc("finish_whatsapp_campaign", { p_campaign_id: campaign.id });
    if (finishError) throw new Error("Messages attempted, but campaign totals could not be finalized. Refresh before retrying.");

    return NextResponse.json({ success: sentCount > 0 && failedCount === 0, campaign_id: campaign.id, sent: sentCount, failed: failedCount,
      first_error: firstError,
      skipped: skippedCount + eligibleContacts.length - sentCount - failedCount });
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
