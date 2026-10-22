import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { sendWhatsAppTemplate } from "@/services/meta";
import { dispatchCampaign } from "@/lib/campaign-dispatch";
import type { TemplateComponent } from "@/lib/meta-template";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const supabase = await createAdminClient();
    const { id } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Invalid campaign" }, { status: 400 });
    const { data: version, error } = await supabase.rpc("whatsapp_campaign_queue_version");
    if (error || version !== 1) return NextResponse.json({ error: "Apply database/whatsapp-campaign-queue.sql first." }, { status: 503 });
    const result = await dispatchCampaign(id, {
      rpc: (name, args) => supabase.rpc(name, args), phoneNumberId: process.env.META_PHONE_NUMBER_ID ?? "",
      send: (job) => sendWhatsAppTemplate(job.phone, job.template, job.language, job.components as TemplateComponent[]),
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("[campaign-dispatch] dispatch_incomplete");
    return NextResponse.json({ error: "Sending stopped. Refresh and review the last recipient before continuing." }, { status: 503 });
  }
}
