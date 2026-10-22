"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Summary = { accepted: number; failed: number; queued: number; uncertain: number; skipped: number };
export function CampaignQueueRunner({ campaignId, autoStart = false }: { campaignId: string; autoStart?: boolean }) {
  const [running, setRunning] = useState(autoStart);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [notice, setNotice] = useState("");
  const [finished, setFinished] = useState(false);
  const router = useRouter();
  useEffect(() => {
    if (!running) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      try {
        const response = await fetch(`/api/campaigns/${encodeURIComponent(campaignId)}/dispatch`, { method: "POST", cache: "no-store" });
        const result = await response.json();
        if (stopped) return;
        if (!response.ok) throw new Error(result.error || "Sending stopped. Refresh before continuing.");
        if (result.summary) setSummary(result.summary);
        if (result.state !== "wait") router.refresh();
        if (result.state === "done") {
          setFinished(true); setRunning(false); setNotice("Sending finished. Check delivery receipts for final outcomes."); return;
        }
        if (result.state === "paused" || result.state === "review") {
          setNotice(result.message + (result.retry_at ? ` Resume after ${new Date(result.retry_at).toLocaleString()}.` : ""));
          setRunning(false); return;
        }
        setNotice("Sending one recipient at a time. Keep this page open; closing it saves the remaining queue.");
        timer = setTimeout(tick, result.state === "wait" ? Math.min(10000, Math.max(500, Number(result.wait_ms) || 2000)) : 1000);
      } catch (error) {
        if (!stopped) { setNotice(error instanceof Error ? error.message : "Sending stopped."); setRunning(false); router.refresh(); }
      }
    }
    void tick();
    // Let an in-flight request finish saving its result. Never abort/resend it.
    return () => { stopped = true; clearTimeout(timer); };
  }, [running, campaignId, router]);
  return <div className="space-y-2 text-xs" aria-live="polite">
    <button type="button" disabled={finished} onClick={() => setRunning(!running)}
      className="border border-input rounded-lg px-3 py-2 text-primary disabled:opacity-50">
      {finished ? "Sending finished" : running ? "Pause after current message" : "Send remaining"}
    </button>
    {summary && <p>Accepted: {summary.accepted} · Failed: {summary.failed} · Remaining: {summary.queued} · Review: {summary.uncertain} · Skipped: {summary.skipped}</p>}
    {notice && <p className="text-muted-foreground max-w-md">{notice}</p>}
  </div>;
}
