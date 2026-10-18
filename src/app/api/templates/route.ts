import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  try {
    const sessionClient = await createClient();
    const { data: { user }, error: authError } = await sessionClient.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    const wabaId = process.env.META_WABA_ID;
    const accessToken = process.env.META_ACCESS_TOKEN;

    if (!wabaId || !accessToken) {
      return NextResponse.json({ error: "META_WABA_ID or META_ACCESS_TOKEN not set" }, { status: 500 });
    }

    const res = await fetch(
      `https://graph.facebook.com/v19.0/${wabaId}/message_templates?status=APPROVED&limit=100`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        next: { revalidate: 300 },
      }
    );

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error?.message ?? "Failed to fetch templates");
    }

    const templates = (data.data ?? []).map((t: {
      name: string;
      language: string;
      status: string;
      category: string;
    }) => ({
      name: t.name,
      language: t.language,
      display_name: t.name
        .split("_")
        .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" "),
      category: t.category,
    }));

    return NextResponse.json(templates);
  } catch (err) {
    console.error("Templates fetch error:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
