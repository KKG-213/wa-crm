import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/utils";
import { Campaign } from "@/types";
import { CampaignStatusBadge } from "./campaign-status-badge";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

export async function RecentCampaigns() {
  const supabase = await createClient();
  const { data: campaigns } = await supabase
    .from("campaigns")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(5);

  return (
    <div className="bg-card border border-border rounded-2xl">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground">Recent Campaigns</h3>
        <Link
          href="/dashboard/campaigns"
          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
        >
          View all <ArrowRight className="w-3 h-3" />
        </Link>
      </div>

      {!campaigns || campaigns.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-sm text-muted-foreground">No campaigns yet</p>
          <p className="text-xs text-muted-foreground/60 mt-1">Create your first campaign to get started</p>
        </div>
      ) : (
        <div className="divide-y divide-border">
          {campaigns.map((campaign: Campaign) => (
            <div key={campaign.id} className="flex items-center justify-between px-6 py-4 hover:bg-muted/30 transition-colors">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{campaign.name}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{formatDate(campaign.created_at)}</p>
              </div>
              <div className="flex items-center gap-6 ml-4">
                <div className="text-right hidden sm:block">
                  <p className="text-sm font-medium text-foreground">{campaign.sent_count}</p>
                  <p className="text-xs text-muted-foreground">accepted</p>
                </div>
                <div className="text-right hidden sm:block">
                  <p className="text-sm font-medium text-primary">{campaign.delivered_count}</p>
                  <p className="text-xs text-muted-foreground">delivered</p>
                </div>
                <CampaignStatusBadge campaign={campaign} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
