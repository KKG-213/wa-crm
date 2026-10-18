// An INSERT may arrive through both the initial query and Realtime.
export function mergeChatMessages<T extends { id: string; sent_at: string }>(
  existing: T[], incoming: T[],
): T[] {
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => a.sent_at.localeCompare(b.sent_at) || a.id.localeCompare(b.id));
}
