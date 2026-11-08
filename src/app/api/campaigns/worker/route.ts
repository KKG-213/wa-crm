import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { dispatchCampaign } from "@/lib/campaign-dispatch";
import { workerAuthorized, workerCampaignIds, runCampaignWorker } from "@/lib/campaign-worker";
import { sendWhatsAppTemplate } from "@/services/meta";
import type { TemplateComponent } from "@/lib/meta-template";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (!workerAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  }
  try {
    const ids = workerCampaignIds(process.env.CAMPAIGN_WORKER_IDS);
    if (!ids.length) return NextResponse.json({ state: "disabled" }, { headers });
    const supabase = createServiceRoleClient();
    const { data: version, error } = await supabase.rpc("whatsapp_campaign_queue_version");
    if (error || version !== 1) throw new Error("Queue unavailable");
    const result = await runCampaignWorker(ids, id => dispatchCampaign(id, {
      rpc: (name, args) => supabase.rpc(name, args),
      phoneNumberId: process.env.META_PHONE_NUMBER_ID ?? "",
      send: job => sendWhatsAppTemplate(job.phone, job.template, job.language, job.components as TemplateComponent[]),
    }));
    return NextResponse.json(result, { headers });
  } catch {
    console.error("[campaign-worker] dispatch_incomplete");
    return NextResponse.json({ error: "Queue processing incomplete. Check campaign delivery details." }, { status: 503, headers });
  }
}
