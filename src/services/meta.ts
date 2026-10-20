import { createMetaClient, type TemplateComponent } from "@/lib/meta-template";

function client() {
  return createMetaClient({ accessToken: process.env.META_ACCESS_TOKEN,
    phoneNumberId: process.env.META_PHONE_NUMBER_ID, wabaId: process.env.META_WABA_ID,
    apiVersion: process.env.META_GRAPH_API_VERSION });
}

export function getApprovedWhatsAppTemplates() { return client().templates(); }
export function sendWhatsAppTemplate(phone: string, templateName: string, templateLanguage: string, components: TemplateComponent[] = []) {
  return client().template(phone, templateName, templateLanguage, components);
}
export function sendWhatsAppText(phone: string, message: string) { return client().text(phone, message); }
