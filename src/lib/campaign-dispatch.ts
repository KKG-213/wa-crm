import { z } from "zod";

export const claimSchema = z.object({
  state: z.literal("claimed"), log_id: z.string().uuid(), dispatch_token: z.string().uuid(),
  phone: z.string().regex(/^\+[0-9]{6,15}$/), phone_number_id: z.string().regex(/^[0-9]{6,32}$/),
  template: z.string().min(1), language: z.string().min(1), components: z.array(z.record(z.unknown())),
});
type Result = { ok: boolean; wamid: string | null; error: string | null; uncertain?: boolean };
type RpcResult = { data: unknown; error: unknown };
type Dependencies = {
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;
  send: (claim: z.infer<typeof claimSchema>) => Promise<Result>;
  phoneNumberId: string;
};

// One Graph request per claim. Wait/paused/done requests never call Meta.
export async function dispatchCampaign(campaignId: string, dependencies: Dependencies) {
  const { data, error } = await dependencies.rpc("claim_whatsapp_campaign_message", { p_campaign_id: campaignId });
  if (error || !data || typeof data !== "object") throw new Error("Unable to claim queued message. Refresh before continuing.");
  const state = (data as { state?: unknown }).state;
  if (["wait", "paused", "done", "review"].includes(String(state))) return data;
  const claim = claimSchema.parse(data);
  // A deployment may have switched senders since this campaign was created.
  const result: Result = claim.phone_number_id !== dependencies.phoneNumberId
    ? { ok: false, wamid: null, error: "Sender settings changed. No message was sent." }
    : await dependencies.send(claim).catch((): Result => ({ ok: false, wamid: null,
      error: "Acceptance could not be confirmed. Review delivery before retrying.", uncertain: true }));
  const args = { p_log_id: claim.log_id, p_token: claim.dispatch_token,
    p_wamid: result.ok ? result.wamid : null, p_error: result.error, p_uncertain: result.uncertain === true };
  // Retry only the database acknowledgement. Never repeat the Graph send.
  let saved: RpcResult = { data: null, error: true };
  for (let attempt = 0; attempt < 3; attempt++) {
    try { saved = await dependencies.rpc("complete_whatsapp_campaign_message", args); }
    catch { saved = { data: null, error: true }; }
    if (!saved.error && saved.data) break;
  }
  if (saved.error || !saved.data) throw new Error("Message attempted, but recording is incomplete. Refresh and review it before continuing.");
  return { state: result.uncertain ? "review" : "processed", summary: saved.data,
    message: result.uncertain ? result.error : undefined };
}
