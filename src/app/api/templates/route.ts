import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getApprovedWhatsAppTemplates } from "@/services/meta";

export async function GET() {
  const session = await createClient();
  const { data: { user }, error } = await session.auth.getUser();
  if (error || !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  try {
    const templates = await getApprovedWhatsAppTemplates();
    return NextResponse.json(templates.map((template) => ({ ...template,
      display_name: template.name.split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" "),
    })), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load approved templates" }, { status: 502 });
  }
}
