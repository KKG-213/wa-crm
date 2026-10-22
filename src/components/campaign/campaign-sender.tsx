"use client";

import { useState, useRef, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Upload, Send, X, Loader2, FileSpreadsheet, Plus, CheckCircle2, RefreshCw } from "lucide-react";
import { ParsedContact, WhatsAppTemplate } from "@/types";
import { parsePhoneFromExcel, isValidPhone } from "@/lib/utils";
import { buildTemplateComponents, templateRequirements } from "@/lib/meta-template";
import * as XLSX from "xlsx";
import Papa from "papaparse";
import { useRouter } from "next/navigation";
import { CampaignQueueRunner } from "./campaign-queue-runner";

const schema = z.object({
  campaign_name: z.string().min(2, "Campaign name required"),
  template_name: z.string().min(1, "Select a template"),
  template_language: z.string().min(1),
  header_image_url: z.string().optional(),
  header_values: z.array(z.string()).optional(),
  body_values: z.array(z.string()).optional(),
});

type FormData = z.infer<typeof schema>;

export function CampaignSender() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [contacts, setContacts] = useState<ParsedContact[]>([]);
  const [sending, setSending] = useState(false);
  const [step, setStep] = useState<"form" | "preview" | "success">("form");
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [result, setResult] = useState<{ campaign_id: string; queued: number; sent: number; failed: number; skipped: number; first_error?: string } | null>(null);
  const requestRef = useRef<{ payload: string; key: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const { register, handleSubmit, watch, setValue, reset, formState: { errors } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { template_language: "en" },
  });

  const templateName = watch("template_name");
  const templateLanguage = watch("template_language");
  const headerImageUrl = watch("header_image_url");
  const selectedTemplate = templates.find((template) => template.name === templateName && template.language === templateLanguage);
  let requirements = { headerFormat: "NONE", headerCount: 0, bodyCount: 0 };
  let templateError = "";
  if (selectedTemplate) {
    try { requirements = templateRequirements(selectedTemplate); }
    catch (error) { templateError = error instanceof Error ? error.message : "Unsupported template format"; }
  }

  const fetchTemplates = async () => {
    setLoadingTemplates(true);
    try {
      const res = await fetch("/api/templates");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to fetch templates");
      setTemplates(data);
      if (data.length === 0) {
        toast.warning("No approved templates found. Get a template approved in Meta Business Manager first.");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load approved templates");
      setTemplates([]);
    } finally {
      setLoadingTemplates(false);
    }
  };

  useEffect(() => {
    if (open) fetchTemplates();
  }, [open]);

  const handleFile = (file: File) => {
    if (!file) return;

    if (file.name.endsWith(".csv")) {
      Papa.parse(file, {
        header: true,
        complete: (result) => {
          const parsed = parseRows(result.data as Record<string, string>[]);
          setContacts(parsed);
        },
      });
    } else {
      const reader = new FileReader();
      reader.onload = (e) => {
        const data = new Uint8Array(e.target!.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet);
        const parsed = parseRows(rows);
        setContacts(parsed);
      };
      reader.readAsArrayBuffer(file);
    }
  };

  const parseRows = (rows: Record<string, unknown>[]): ParsedContact[] => {
    return rows
      .map((row) => {
        const phone = String(row.phone ?? row.Phone ?? row.PHONE ?? row.mobile ?? row.Mobile ?? "");
        const name = String(row.name ?? row.Name ?? row.NAME ?? "").trim();
        const email = String(row.email ?? row.Email ?? "").trim();
        return {
          phone: parsePhoneFromExcel(phone),
          name: name || undefined,
          email: email || undefined,
        };
      })
      .filter((c) => isValidPhone(c.phone));
  };

  const onSubmit = async (data: FormData) => {
    if (contacts.length === 0) {
      toast.error("Upload a contacts file first");
      return;
    }
    if (!selectedTemplate) { toast.error("Select an approved template and language."); return; }
    try {
      buildTemplateComponents(selectedTemplate, { headerImageUrl: data.header_image_url,
        headerValues: data.header_values, bodyValues: data.body_values });
    } catch (error) { toast.error(error instanceof Error ? error.message : "Check template fields"); return; }
    if (step === "form") {
      setStep("preview");
      return;
    }

    setSending(true);
    try {
      const fields = { campaign_name: data.campaign_name, template_name: data.template_name, template_language: data.template_language,
        header_image_url: data.header_image_url, header_values: data.header_values, body_values: data.body_values, contacts };
      const signature = JSON.stringify(fields);
      if (requestRef.current?.payload !== signature) requestRef.current = { payload: signature, key: crypto.randomUUID() };
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fields, request_key: requestRef.current.key }),
      });

      const outcome = await res.json();
      if (!res.ok) throw new Error(outcome.error ?? "Failed to send campaign");
      setResult(outcome);
      setStep("success");
      router.refresh();
      if (outcome.queued) toast.success(`${outcome.queued} recipients saved in the sending queue`);
      else if (outcome.failed) toast.error(outcome.first_error ?? `${outcome.failed} messages failed`);
      else if (outcome.sent) toast.success(`${outcome.sent} messages accepted for sending`);
      else toast.warning("No messages sent. Contacts may be blocked or inactive.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSending(false);
    }
  };

  const handleClose = () => {
    setOpen(false);
    requestRef.current = null;
    reset();
    setContacts([]);
    setStep("form");
    setResult(null);
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-4 py-2.5 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium rounded-xl transition-all"
      >
        <Plus className="w-4 h-4" />
        New Campaign
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={handleClose} />
          <div className="relative bg-card border border-border rounded-2xl w-full max-w-xl shadow-2xl max-h-[90vh] overflow-y-auto">
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-border">
              <div>
                <h2 className="text-base font-semibold text-foreground">
                  {step === "success" ? "Campaign results" : step === "preview" ? "Review & Send" : "New Campaign"}
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {step === "preview" ? `${contacts.length} contacts ready` : "Upload contacts and choose template"}
                </p>
              </div>
              <button onClick={handleClose} className="w-8 h-8 flex items-center justify-center rounded-xl hover:bg-muted text-muted-foreground">
                <X className="w-4 h-4" />
              </button>
            </div>

            {step === "success" ? (
              <div className="flex flex-col items-center justify-center py-16">
                <div className={`w-16 h-16 rounded-full flex items-center justify-center mb-4 ${result?.failed ? "bg-destructive/10" : "bg-primary/10"}`}>
                  {result?.failed ? <X className="w-8 h-8 text-destructive" /> : <CheckCircle2 className="w-8 h-8 text-primary" />}
                </div>
                <p className="text-base font-semibold text-foreground">{result?.queued ? "Campaign queued" : result?.failed ? "Campaign has failed messages" : "Campaign processed"}</p>
                <p className="text-sm text-muted-foreground mt-1">Accepted: {result?.sent ?? 0} · Rejected: {result?.failed ?? 0} · Skipped: {result?.skipped ?? 0}</p>
                {result?.first_error && <p className="text-sm text-destructive mt-3 px-6 break-words">{result.first_error}</p>}
                {result?.campaign_id && <div className="mt-4 px-6"><CampaignQueueRunner campaignId={result.campaign_id} autoStart /></div>}
                <p className="text-xs text-muted-foreground mt-3 px-6 text-center">Keep this dialog open while sending. You can resume saved recipients with Send remaining in the campaign list. Check View delivery for final receipts.</p>
              </div>
            ) : (
              <form onSubmit={handleSubmit(onSubmit)} className="p-6 space-y-5">
                <input type="hidden" {...register("template_name")} />
                <input type="hidden" {...register("template_language")} />
                {step === "form" && (
                  <>
                    {/* Campaign Name */}
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium text-foreground">Campaign Name</label>
                      <input
                        {...register("campaign_name")}
                        placeholder="e.g. Diwali Offer 2026"
                        className="w-full px-3 py-2.5 bg-background border border-input rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                      {errors.campaign_name && <p className="text-xs text-destructive">{errors.campaign_name.message}</p>}
                    </div>

                    {/* Template */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <label className="text-sm font-medium text-foreground">WhatsApp Template</label>
                        <button
                          type="button"
                          onClick={fetchTemplates}
                          disabled={loadingTemplates}
                          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <RefreshCw className={`w-3 h-3 ${loadingTemplates ? "animate-spin" : ""}`} />
                          Refresh
                        </button>
                      </div>

                      {loadingTemplates ? (
                        <div className="flex items-center gap-2 px-3 py-2.5 bg-background border border-input rounded-xl">
                          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                          <span className="text-sm text-muted-foreground">Loading templates...</span>
                        </div>
                      ) : (
                        <select
                          value={templateName && templateLanguage ? `${templateName}:${templateLanguage}` : ""}
                          onChange={(e) => {
                            const t = templates.find((t) => `${t.name}:${t.language}` === e.target.value);
                            setValue("template_name", t?.name ?? "", { shouldValidate: true });
                            setValue("template_language", t?.language ?? "");
                            setValue("header_values", []); setValue("body_values", []);
                            setValue("header_image_url", t?.name === "web_design_request" && t.components.some((c) => c.type === "HEADER" && c.format === "IMAGE")
                              ? `${window.location.origin}/whatsapp/web_design_request.png` : "");
                          }}
                          className="w-full px-3 py-2.5 bg-background border border-input rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        >
                          <option value="">Select a template</option>
                          {templates.map((t) => (
                            <option key={`${t.name}-${t.language}`} value={`${t.name}:${t.language}`}>
                              {t.display_name} ({t.language})
                            </option>
                          ))}
                        </select>
                      )}
                      {errors.template_name && <p className="text-xs text-destructive">{errors.template_name.message}</p>}
                    </div>

                    {templateError && <p className="text-sm text-destructive">{templateError}</p>}
                    {requirements.headerCount + requirements.bodyCount > 0 && <p className="text-xs text-muted-foreground">These variable values are used for every contact in this campaign.</p>}
                    {requirements.headerFormat === "IMAGE" && (
                      <div className="space-y-1.5">
                        <label htmlFor="header-image" className="text-sm font-medium text-foreground">Header image URL</label>
                        <input id="header-image" type="url" {...register("header_image_url")}
                          placeholder="https://your-site.com/poster.png"
                          className="w-full px-3 py-2.5 bg-background border border-input rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                        <p className="text-xs text-muted-foreground">Use a PNG or JPEG that opens without signing in. This image will be sent with your template.</p>
                      </div>
                    )}
                    {([['header_values', requirements.headerCount, 'Header'], ['body_values', requirements.bodyCount, 'Body']] as const).flatMap(([field, count, label]) =>
                      Array.from({ length: count }, (_, index) => (
                        <div key={`${field}-${index}`} className="space-y-1.5">
                          <label htmlFor={`${field}-${index}`} className="text-sm font-medium text-foreground">{label} variable {`{{${index + 1}}}`}</label>
                          <input id={`${field}-${index}`} {...register(`${field}.${index}`)}
                            className="w-full px-3 py-2.5 bg-background border border-input rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                        </div>
                      ))) }

                    {/* File Upload */}
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium text-foreground">Contacts File</label>
                      <div
                        className="border-2 border-dashed border-border rounded-xl p-6 text-center cursor-pointer hover:border-primary/50 hover:bg-primary/5 transition-all"
                        onClick={() => fileRef.current?.click()}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          const file = e.dataTransfer.files[0];
                          if (file) handleFile(file);
                        }}
                      >
                        {contacts.length > 0 ? (
                          <div className="flex items-center justify-center gap-3">
                            <FileSpreadsheet className="w-5 h-5 text-primary" />
                            <div className="text-left">
                              <p className="text-sm font-medium text-foreground">{contacts.length} contacts loaded</p>
                              <p className="text-xs text-muted-foreground">Click to replace</p>
                            </div>
                          </div>
                        ) : (
                          <>
                            <Upload className="w-6 h-6 text-muted-foreground mx-auto mb-2" />
                            <p className="text-sm text-foreground">Drop .xlsx or .csv file</p>
                            <p className="text-xs text-muted-foreground mt-1">Columns: phone, name (optional), email (optional)</p>
                          </>
                        )}
                      </div>
                      <input
                        ref={fileRef}
                        type="file"
                        accept=".xlsx,.xls,.csv"
                        className="hidden"
                        onChange={(e) => { if (e.target.files?.[0]) handleFile(e.target.files[0]); }}
                      />
                    </div>

                  </>
                )}

                {step === "preview" && (
                  <div className="space-y-4">
                    {requirements.headerFormat === "IMAGE" && headerImageUrl && (
                      <div className="space-y-2">
                        <p className="text-sm font-medium">Header image</p>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={headerImageUrl} alt="Campaign header preview" className="w-full max-h-64 object-contain rounded-xl border border-border" />
                      </div>
                    )}
                    <div className="bg-muted/40 rounded-xl p-4 space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Template</span>
                        <span className="font-medium text-foreground">{templateName}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Recipients</span>
                        <span className="font-medium text-foreground">{contacts.length}</span>
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Preview (first 5)</p>
                      <div className="rounded-xl border border-border overflow-hidden">
                        <table className="w-full text-sm">
                          <thead className="bg-muted/50">
                            <tr>
                              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Phone</th>
                              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Name</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {contacts.slice(0, 5).map((c, i) => (
                              <tr key={i}>
                                <td className="px-3 py-2 text-foreground font-mono text-xs">{c.phone}</td>
                                <td className="px-3 py-2 text-muted-foreground">{c.name ?? "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {contacts.length > 5 && (
                        <p className="text-xs text-muted-foreground">+{contacts.length - 5} more contacts</p>
                      )}
                    </div>
                  </div>
                )}

                <div className="flex gap-3 pt-2">
                  {step === "preview" && (
                    <button
                      type="button"
                      onClick={() => setStep("form")}
                      className="flex-1 py-2.5 border border-border rounded-xl text-sm font-medium text-foreground hover:bg-muted transition-all"
                    >
                      Back
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={sending || loadingTemplates || !!templateError || !selectedTemplate}
                    className="flex-1 py-2.5 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium rounded-xl transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {sending ? (
                      <><Loader2 className="w-4 h-4 animate-spin" /> Sending...</>
                    ) : step === "preview" ? (
                      <><Send className="w-4 h-4" /> Send Campaign</>
                    ) : (
                      "Continue"
                    )}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
