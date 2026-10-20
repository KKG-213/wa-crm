"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Campaign, CampaignLog } from "@/types";
import { formatDate } from "@/lib/utils";
import { CampaignStatusBadge } from "./campaign-status-badge";
import { Search, RefreshCw } from "lucide-react";

interface CampaignTableProps {
  campaigns: Campaign[];
}

export function CampaignTable({ campaigns }: CampaignTableProps) {
  const [search, setSearch] = useState("");
  const router = useRouter();
  const [details, setDetails] = useState<{ campaign: Campaign; logs: CampaignLog[] } | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [detailsError, setDetailsError] = useState("");
  const loadDetails = async (id: string) => {
    setLoadingDetails(true); setDetailsError(""); setDetails(null);
    try {
      const response = await fetch(`/api/campaigns/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load delivery details. Try refreshing.");
      setDetails(await response.json());
    } catch (error) { setDetailsError(error instanceof Error ? error.message : "Could not load delivery details."); }
    finally { setLoadingDetails(false); }
  };

  const filtered = campaigns.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.template_name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden">
      <div className="p-4 border-b border-border">
        <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search campaigns..."
            className="w-full pl-9 pr-4 py-2 bg-background border border-input rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <button type="button" onClick={() => { router.refresh(); if (details) void loadDetails(details.campaign.id); }}
          disabled={loadingDetails} className="flex items-center gap-2 px-3 py-2 rounded-xl border border-input text-sm disabled:opacity-50">
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
        </div>
        <p className="text-xs text-muted-foreground mt-3">Accepted means Meta queued the message. Refresh to check delivery receipts and failure reasons.</p>
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16">
          <p className="text-sm text-muted-foreground">
            {search ? "No campaigns found" : "No campaigns yet"}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Campaign</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Template</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Accepted</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Delivered</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Read</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Failed</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Status</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Date</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((campaign) => (
                <tr key={campaign.id} className="hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3">
                    <p className="font-medium text-foreground">{campaign.name}</p>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground font-mono text-xs">{campaign.template_name}</td>
                  <td className="px-4 py-3 text-right font-medium text-foreground">{campaign.sent_count}</td>
                  <td className="px-4 py-3 text-right text-primary font-medium">{campaign.delivered_count}</td>
                  <td className="px-4 py-3 text-right text-blue-500 font-medium">{campaign.read_count}</td>
                  <td className="px-4 py-3 text-right text-destructive font-medium">{campaign.failed_count}</td>
                  <td className="px-4 py-3"><CampaignStatusBadge campaign={campaign} /></td>
                  <td className="px-4 py-3 text-muted-foreground text-xs whitespace-nowrap">{formatDate(campaign.created_at)}</td>
                  <td className="px-4 py-3"><button type="button" disabled={loadingDetails} onClick={() => void loadDetails(campaign.id)}
                    className="text-primary text-xs whitespace-nowrap hover:underline disabled:opacity-50" aria-label={`View delivery for ${campaign.name}`}>View delivery</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div aria-live="polite">
        {loadingDetails && <p className="p-4 text-sm text-muted-foreground">Loading delivery details…</p>}
        {detailsError && <p className="p-4 text-sm text-destructive" role="alert">{detailsError}</p>}
        {details && <section className="border-t border-border p-4 space-y-3" aria-label="Campaign delivery details">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">{details.campaign.name} — Delivery details</h3>
            <button type="button" className="text-xs text-muted-foreground hover:underline" onClick={() => setDetails(null)}>Close</button>
          </div>
          {details.logs.length === 0 && <p className="text-sm text-muted-foreground">No messages recorded.</p>}
          {details.logs.map((log) => <div key={log.id} className="border border-border rounded-xl p-3 text-sm">
            <p className="font-medium">{log.contact?.name || log.contact?.phone || "Recipient"} · {log.status === "sent" ? "Awaiting delivery" : log.status}</p>
            {log.contact?.name && <p className="text-xs text-muted-foreground mt-1">{log.contact.phone}</p>}
            {log.status === "failed" && <p className="text-destructive mt-2 break-words">{log.error_message || "No failure reason was recorded for this message."}</p>}
          </div>)}
        </section>}
      </div>
    </div>
  );
}
