export type ContactStatus = "active" | "inactive" | "blocked";
export type MessageDirection = "inbound" | "outbound";
export type MessageStatus = "sent" | "delivered" | "read" | "failed";
export type CampaignStatus = "draft" | "running" | "completed" | "failed";

export interface Contact {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  status: ContactStatus;
  tags: string[];
  message_count: number;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  contact_id: string;
  campaign_id: string | null;
  wamid: string | null;
  direction: MessageDirection;
  content: string;
  media_url: string | null;
  status: MessageStatus;
  sent_at: string;
  delivered_at: string | null;
  read_at: string | null;
  created_at: string;
  contact?: Contact;
}

export interface Campaign {
  id: string;
  name: string;
  template_name: string;
  template_language: string;
  status: CampaignStatus;
  total_contacts: number;
  sent_count: number;
  delivered_count: number;
  read_count: number;
  failed_count: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface CampaignLog {
  id: string;
  campaign_id: string;
  contact_id: string;
  wamid: string | null;
  status: MessageStatus;
  error_message: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  created_at: string;
  contact?: Contact;
}

export interface Analytics {
  total_messages: number;
  total_sent: number;
  total_delivered: number;
  total_read: number;
  total_failed: number;
  delivered_rate: number;
  read_rate: number;
  failed_rate: number;
  total_campaigns: number;
  total_contacts: number;
  messages_by_day: { date: string; count: number }[];
  campaigns_performance: { name: string; sent: number; delivered: number; read: number; failed: number }[];
}

export interface ParsedContact {
  phone: string;
  name?: string;
  email?: string;
}

export interface WhatsAppTemplate {
  name: string;
  language: string;
  display_name: string;
  components: import("@/lib/meta-template").TemplateDefinition["components"];
  parameter_format?: string;
}

export interface SendCampaignPayload {
  campaign_name: string;
  template_name: string;
  template_language: string;
  header_image_url?: string;
  header_values?: string[];
  body_values?: string[];
  contacts: ParsedContact[];
}

export interface SendReplyPayload {
  contact_id: string;
  phone: string;
  message: string;
}

export interface WebhookDeliveryUpdate {
  wamid: string;
  status: MessageStatus;
  timestamp: string;
}

export interface IncomingMessage {
  phone: string;
  name: string;
  message: string;
  wamid: string;
  timestamp: string;
}
