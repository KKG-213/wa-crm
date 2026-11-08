import { timingSafeEqual } from "node:crypto";

export function workerAuthorized(header: string | null, secret: string | undefined) {
  if (!secret || secret.length < 32 || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// Explicit allowlist prevents deployment from starting abandoned campaigns.
export function workerCampaignIds(value = "") {
  const ids = [...new Set(value.split(",").map(id => id.trim()).filter(Boolean))];
  if (ids.length > 100 || ids.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
    throw new Error("CAMPAIGN_WORKER_IDS must contain at most 100 campaign UUIDs.");
  }
  return ids;
}

// At most one send per invocation. Shared database leases coordinate this with
// browser dispatch and concurrent scheduler calls. No retries of uncertain sends.
export async function runCampaignWorker(ids: string[], dispatch: (id: string) => Promise<unknown>) {
  for (const id of ids) {
    const result = await dispatch(id) as { state?: string };
    if (result.state === "done" || result.state === "review") continue;
    return { campaign_id: id, ...result };
  }
  return { state: "idle" };
}
