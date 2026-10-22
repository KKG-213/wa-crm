type Log = { status: string; error_message: string | null; contact?: { phone: string; name: string | null } };
export function rateLimitedContactsCsv(logs: Log[]): string | null {
  const contacts = new Map<string, { phone: string; name: string }>();
  for (const log of logs) {
    if (log.status !== "failed" || !log.error_message?.startsWith("(#130429)") || !log.contact) continue;
    const phone = log.contact.phone.replace(/^\+/, "");
    if (/^[1-9][0-9]{5,14}$/.test(phone)) contacts.set(phone, { phone, name: log.contact.name ?? "" });
  }
  if (!contacts.size) return null;
  const cell = (value: string) => '"' + value.replace(/^[=+@\-\t\r]/, "'$&").replace(/"/g, '""') + '"';
  return "Phone,Name\r\n" + [...contacts.values()].map((c) => `${cell(c.phone)},${cell(c.name)}`).join("\r\n") + "\r\n";
}
