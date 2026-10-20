type DeliveryCounts = {
  status: "draft" | "running" | "completed" | "failed";
  total_contacts: number;
  delivered_count: number;
  failed_count: number;
};

// Database status describes the send job. These labels describe delivery.
export function campaignDeliveryState(campaign: DeliveryCounts) {
  if (campaign.status === "draft") return "draft";
  if (campaign.status === "running") return "running";
  if (campaign.total_contacts === 0) return campaign.status === "failed" ? "failed" : "empty";
  if (campaign.failed_count >= campaign.total_contacts) return "failed";
  if (campaign.delivered_count >= campaign.total_contacts) return "delivered";
  if (campaign.failed_count > 0) return "has_failures";
  if (campaign.delivered_count > 0) return "partly_delivered";
  return "pending";
}
