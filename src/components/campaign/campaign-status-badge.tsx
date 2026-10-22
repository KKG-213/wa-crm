import { cn } from "@/lib/utils";
import { Campaign } from "@/types";
import { campaignDeliveryState } from "@/lib/campaign-delivery";

const configs = {
  queued: { label: "Recipients queued", className: "bg-blue-500/10 text-blue-500" },
  review: { label: "Needs review", className: "bg-destructive/10 text-destructive" },
  draft: { label: "Draft", className: "bg-muted text-muted-foreground" },
  running: { label: "Sending", className: "bg-blue-500/10 text-blue-500" },
  pending: { label: "Awaiting delivery", className: "bg-blue-500/10 text-blue-500" },
  partly_delivered: { label: "Partly delivered", className: "bg-blue-500/10 text-blue-500" },
  has_failures: { label: "Has failures", className: "bg-destructive/10 text-destructive" },
  delivered: { label: "Delivered", className: "bg-primary/10 text-primary" },
  empty: { label: "No recipients", className: "bg-muted text-muted-foreground" },
  failed: { label: "Failed", className: "bg-destructive/10 text-destructive" },
};

export function CampaignStatusBadge({ campaign }: { campaign: Campaign }) {
  const config = configs[campaignDeliveryState(campaign)];
  return (
    <span className={cn("px-2.5 py-1 rounded-full text-xs font-medium", config.className)}>
      {config.label}
    </span>
  );
}
