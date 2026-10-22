import { z } from "zod";

export const templateDefinitionSchema = z.object({
  name: z.string().min(1), language: z.string().min(1), status: z.string().optional(),
  components: z.array(z.object({
    type: z.string(), format: z.string().optional(), text: z.string().optional(),
    buttons: z.array(z.object({ type: z.string(), text: z.string().optional(), url: z.string().optional() }).passthrough()).optional(),
  }).passthrough()).default([]),
  parameter_format: z.string().optional(),
}).passthrough();

export type TemplateDefinition = Pick<z.infer<typeof templateDefinitionSchema>, "name" | "language" | "status" | "components" | "parameter_format">;
export type TemplateComponent = { type: string; sub_type?: string; index?: string;
  parameters: Array<{ type: string; text?: string; payload?: string; image?: { link: string } }> };
export type TemplateInputs = { headerImageUrl?: string; headerValues?: string[]; bodyValues?: string[] };

function variableCount(text = ""): number {
  const keys = [...text.matchAll(/\{\{([^{}]+)\}\}/g)].map((match) => match[1].trim());
  if (keys.some((key) => !/^[1-9]\d*$/.test(key))) throw new Error("This template uses named variables. Choose a template with numbered variables.");
  const indexes = [...new Set(keys.map(Number))].sort((a, b) => a - b);
  if (indexes.length > 20 || indexes.some((index, i) => index !== i + 1)) throw new Error("Unsupported template variable numbering.");
  return indexes.length;
}

export function templateRequirements(template: TemplateDefinition) {
  let headerFormat = "NONE", headerCount = 0, bodyCount = 0;
  for (const component of template.components) {
    if (component.type === "HEADER") {
      headerFormat = component.format ?? "TEXT";
      if (!["IMAGE", "TEXT"].includes(headerFormat)) throw new Error(`The ${headerFormat.toLowerCase()} header is not supported in this campaign form.`);
      if (headerFormat === "TEXT") headerCount = variableCount(component.text);
    } else if (component.type === "BODY") bodyCount = variableCount(component.text);
    else if (component.type === "BUTTONS") {
      for (const button of component.buttons ?? []) {
        if (!["PHONE_NUMBER", "URL", "QUICK_REPLY"].includes(button.type)) throw new Error("This template has a button type not supported by this campaign form.");
        if (button.type === "URL" && /\{\{/.test(button.url ?? "")) throw new Error("Dynamic URL buttons are not supported by this campaign form.");
      }
    } else if (component.type !== "FOOTER") throw new Error("This template format is not supported by this campaign form.");
  }
  return { headerFormat, headerCount, bodyCount };
}

export function publicImageUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("Enter a public HTTPS image URL."); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
      host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host.includes(":") || /^(0|10|127|169\.254|192\.168)\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    throw new Error("Use a public HTTPS image URL that opens without signing in.");
  }
  return url.href;
}

function textParameters(values: string[] | undefined, count: number, label: string) {
  if ((values?.length ?? 0) !== count) throw new Error(`Enter all ${count} ${label} variable values.`);
  return (values ?? []).map((value) => {
    if (typeof value !== "string" || !value.trim() || value.length > 1024) throw new Error(`Enter a valid ${label} variable value.`);
    return { type: "text", text: value.trim() };
  });
}

export function buildTemplateComponents(template: TemplateDefinition, input: TemplateInputs): TemplateComponent[] {
  const { headerFormat, headerCount, bodyCount } = templateRequirements(template);
  const components: TemplateComponent[] = [];
  const header = textParameters(input.headerValues, headerCount, "header");
  const body = textParameters(input.bodyValues, bodyCount, "body");
  if (headerFormat === "IMAGE") {
    if (!input.headerImageUrl?.trim()) throw new Error("This template requires a header image. Add its public HTTPS image URL.");
    components.push({ type: "header", parameters: [{ type: "image", image: { link: publicImageUrl(input.headerImageUrl) } }] });
  } else if (input.headerImageUrl?.trim()) throw new Error("This template does not have an image header.");
  if (header.length) components.push({ type: "header", parameters: header });
  if (body.length) components.push({ type: "body", parameters: body });
  for (const component of template.components) if (component.type === "BUTTONS") {
    (component.buttons ?? []).forEach((button, index) => {
      if (button.type === "QUICK_REPLY") components.push({ type: "button", sub_type: "quick_reply", index: String(index),
        parameters: [{ type: "payload", payload: (button.text || `button_${index}`).slice(0, 256) }] });
    });
  }
  return components;
}

export function graphError(data: unknown, httpStatus: number): string {
  const error = data && typeof data === "object" ? (data as { error?: { code?: number; message?: string; error_data?: { details?: string } } }).error : undefined;
  const details = [typeof error?.message === "string" ? error.message : `Meta request failed (HTTP ${httpStatus})`,
    typeof error?.error_data?.details === "string" ? error.error_data.details : ""].filter(Boolean).join(" — ");
  return `${Number.isInteger(error?.code) && !details.startsWith(`(#${error!.code})`) ? `(#${error!.code}) ` : ""}${details}`
    .replace(/EAA[A-Za-z0-9]{16,}/g, "[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 2000);
}

export function createMetaClient(config: { accessToken?: string; phoneNumberId?: string; wabaId?: string; apiVersion?: string }, transport = globalThis.fetch) {
  const version = config.apiVersion ?? "v26.0";
  if (!/^v\d+\.\d+$/.test(version)) throw new Error("Invalid Meta API version configuration");
  const api = `https://graph.facebook.com/${version}`;
  const headers = () => {
    if (!config.accessToken?.trim()) throw new Error("Meta access token is not configured");
    return { Authorization: `Bearer ${config.accessToken}`, "Content-Type": "application/json" };
  };
  async function send(payload: object) {
    if (!config.phoneNumberId?.trim()) throw new Error("Meta phone number ID is not configured");
    try {
      const response = await transport(`${api}/${config.phoneNumberId}/messages`, { method: "POST", headers: headers(),
        body: JSON.stringify(payload), cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(15000) });
      let data;
      try { data = await response.json(); } catch { return { ok: false, wamid: null, error: `Invalid Meta response (HTTP ${response.status})`, uncertain: true }; }
      const wamid = data?.messages?.[0]?.id;
      if (!response.ok) return { ok: false, wamid: null, error: graphError(data, response.status) };
      if (typeof wamid !== "string" || !wamid || wamid.length > 512) return { ok: false, wamid: null, error: "Meta acceptance could not be confirmed: missing message ID.", uncertain: true };
      return { ok: true, wamid, error: null };
    } catch { return { ok: false, wamid: null, error: "Unable to confirm Meta accepted this message. Check the campaign log before retrying.", uncertain: true }; }
  }
  return {
    async templates() {
      if (!config.wabaId?.trim()) throw new Error("Meta WhatsApp Business Account ID is not configured");
      const url = new URL(`${api}/${config.wabaId}/message_templates`);
      url.searchParams.set("status", "APPROVED"); url.searchParams.set("limit", "100");
      url.searchParams.set("fields", "name,language,status,category,components,parameter_format");
      const response = await transport(url.href, { headers: headers(), cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(15000) });
      const data = await response.json();
      if (!response.ok) throw new Error(graphError(data, response.status));
      return z.array(templateDefinitionSchema).parse(data.data).filter((template) => template.status === "APPROVED");
    },
    template(phone: string, name: string, language: string, components: TemplateComponent[] = []) {
      return send({ messaging_product: "whatsapp", to: phone.replace(/^\+/, ""), type: "template",
        template: { name, language: { code: language }, ...(components.length ? { components } : {}) } });
    },
    text(phone: string, message: string) {
      return send({ messaging_product: "whatsapp", to: phone.replace(/^\+/, ""), type: "text", text: { body: message } });
    },
  };
}
