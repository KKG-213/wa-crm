// India-local sheets are normalized before sending; explicit international
// country codes are preserved. Registration on WhatsApp is not inferred.
export function normalizeCampaignPhone(raw: string | number): string {
  const source = String(raw).trim();
  if (!source || /[A-Za-z]/.test(source) || (typeof raw === "number" && !Number.isSafeInteger(raw))) return "";
  let digits = source.replace(/\D/g, "");
  if (source.startsWith("+")) return `+${digits}`;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 10) return `+91${digits}`;
  return digits ? `+${digits}` : "";
}

export function validCampaignPhone(value: string): boolean {
  return /^\+[1-9]\d{9,14}$/.test(value);
}
