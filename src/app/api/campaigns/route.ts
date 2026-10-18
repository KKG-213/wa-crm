import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { sendWhatsAppTemplate } from "@/services/meta";
import { SendCampaignPayload } from "@/types";

export async function POST(req: NextRequest) {
  try {
    const body: SendCampaignPayload = await req.json();
    const { campaign_name, template_name, template_language, contacts } = body;

    if (!campaign_name || !template_name || !contacts?.length) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const supabase = await createAdminClient();

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
        template_language
      );

      await supabase.from("campaign_logs").insert({
        campaign_id: campaign.id,
        contact_id: contact.id,
        wamid: wamid ?? null,
        status: ok ? "sent" : "failed",
        error_message: error ?? null,
        sent_at: new Date().toISOString(),
      });

      await supabase.from("messages").insert({
        contact_id: contact.id,
        campaign_id: campaign.id,
        wamid: wamid ?? null,
        direction: "outbound",
        content: `📢 ${campaign_name} — Template: ${template_name}`,
        status: ok ? "sent" : "failed",
        sent_at: new Date().toISOString(),
      });

      if (ok) {
        sentCount++;
        await supabase
          .from("contacts")
          .update({ last_message_at: new Date().toISOString() })
          .eq("id", contact.id);
      } else {
        failedCount++;
        console.error("Campaign message send failed");
      }
    }

    await supabase
      .from("campaigns")
      .update({
        status: failedCount > 0 && sentCount === 0 ? "failed" : "completed",
        total_contacts: sentCount + failedCount,
        sent_count: sentCount,
        failed_count: failedCount,
        completed_at: new Date().toISOString(),
      })
      .eq("id", campaign.id);

    return NextResponse.json({ success: true, campaign_id: campaign.id, sent: sentCount, failed: failedCount,
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
