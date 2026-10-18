"use client";

import { useState, useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { Contact, Message } from "@/types";
import { formatRelativeTime, getInitials, cn } from "@/lib/utils";
import { Send, Search, Loader2, MessageSquareOff } from "lucide-react";
import { toast } from "sonner";
import { mergeChatMessages } from "@/lib/merge-chat-messages";

interface InboxClientProps {
  initialContacts: Contact[];
}

export function InboxClient({ initialContacts }: InboxClientProps) {
  const [supabase] = useState(() => createClient());
  const [contacts, setContacts] = useState<Contact[]>(initialContacts);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [search, setSearch] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const filteredContacts = contacts.filter((c) =>
    (c.name ?? c.phone).toLowerCase().includes(search.toLowerCase()) ||
    c.phone.includes(search)
  );

  const selectedContactId = selectedContact?.id;

  // Realtime plus a visible-tab refresh if the socket reconnects or is blocked.
  useEffect(() => {
    if (!selectedContactId) return;
    let active = true;
    let pending = false;
    let duringFetch: Message[] = [];
    setMessages([]);
    setLoadingMessages(true);
    const refresh = async () => {
      if (pending || !active) return;
      pending = true;
      duringFetch = [];
      const { data, error } = await supabase.from("messages").select("*")
        .eq("contact_id", selectedContactId).order("sent_at", { ascending: true });
      if (active) {
        if (error) toast.error("Unable to refresh this conversation");
        else setMessages(mergeChatMessages(data ?? [], duringFetch));
        setLoadingMessages(false);
      }
      pending = false;
    };
    const onMessage = (payload: { new: unknown }) => {
      if (!active) return;
      const message = payload.new as Message;
      if (pending) duringFetch.push(message);
      setMessages((prev) => mergeChatMessages(prev, [message]));
    };
    const channel = supabase
      .channel(`messages:${selectedContactId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `contact_id=eq.${selectedContactId}` }, onMessage)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages", filter: `contact_id=eq.${selectedContactId}` }, onMessage)
      .subscribe((status) => { if (status === "SUBSCRIBED") void refresh(); });
    void refresh();
    const visibleRefresh = () => { if (document.visibilityState === "visible") void refresh(); };
    const interval = setInterval(visibleRefresh, 10000);
    document.addEventListener("visibilitychange", visibleRefresh);
    return () => {
      active = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visibleRefresh);
      void supabase.removeChannel(channel);
    };
  }, [selectedContactId, supabase]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  // Realtime for contact list updates
  useEffect(() => {
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending || !active) return;
      pending = true;
      const { data, error } = await supabase.from("contacts").select("*")
        .order("last_message_at", { ascending: false, nullsFirst: false }).limit(50);
      if (active && !error && data) {
        setContacts(data);
        setSelectedContact((current) => current ? data.find((contact) => contact.id === current.id) ?? current : null);
      }
      pending = false;
    };
    const channel = supabase
      .channel("contacts:updates")
      .on("postgres_changes", { event: "*", schema: "public", table: "contacts" }, () => { void refresh(); })
      .subscribe();
    void refresh();
    const visibleRefresh = () => { if (document.visibilityState === "visible") void refresh(); };
    const interval = setInterval(visibleRefresh, 10000);
    document.addEventListener("visibilitychange", visibleRefresh);
    return () => {
      active = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visibleRefresh);
      void supabase.removeChannel(channel);
    };
  }, [supabase]);

  const sendReply = async () => {
    if (!replyText.trim() || !selectedContact) return;
    setSending(true);

    try {
      const res = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_id: selectedContact.id,
          phone: selectedContact.phone,
          message: replyText.trim(),
        }),
      });

      if (!res.ok) throw new Error("Failed to send");
      setReplyText("");
    } catch {
      toast.error("Failed to send message");
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendReply();
    }
  };

  return (
    <div className="flex h-[calc(100vh-8rem)] bg-card border border-border rounded-2xl overflow-hidden animate-fade-in">
      {/* Contacts sidebar */}
      <div className="w-72 shrink-0 border-r border-border flex flex-col">
        <div className="p-3 border-b border-border">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search contacts..."
              className="w-full pl-8 pr-3 py-2 bg-background border border-input rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {filteredContacts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center p-4">
              <p className="text-xs text-muted-foreground">No contacts yet</p>
            </div>
          ) : (
            filteredContacts.map((contact) => (
              <button
                key={contact.id}
                onClick={() => setSelectedContact(contact)}
                className={cn(
                  "w-full flex items-center gap-3 p-3 hover:bg-muted/40 transition-colors text-left border-b border-border/50",
                  selectedContact?.id === contact.id && "bg-muted/60"
                )}
              >
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <span className="text-xs font-semibold text-primary">
                    {getInitials(contact.name, contact.phone)}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-foreground truncate">
                      {contact.name ?? contact.phone}
                    </p>
                    <span className="text-xs text-muted-foreground shrink-0 ml-1">
                      {formatRelativeTime(contact.last_message_at)}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">{contact.phone}</p>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Chat area */}
      <div className="flex-1 flex flex-col">
        {!selectedContact ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
            <div className="w-14 h-14 rounded-2xl bg-muted/50 flex items-center justify-center mb-4">
              <MessageSquareOff className="w-6 h-6 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">Select a conversation</p>
            <p className="text-xs text-muted-foreground mt-1">Choose a contact from the sidebar to start chatting</p>
          </div>
        ) : (
          <>
            {/* Chat header */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
              <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center">
                <span className="text-xs font-semibold text-primary">
                  {getInitials(selectedContact.name, selectedContact.phone)}
                </span>
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {selectedContact.name ?? selectedContact.phone}
                </p>
                <p className="text-xs text-muted-foreground">{selectedContact.phone}</p>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-3">
              {loadingMessages ? (
                <div className="flex items-center justify-center h-full">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full">
                  <p className="text-xs text-muted-foreground">No messages yet</p>
                </div>
              ) : (
                messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={cn(
                      "flex",
                      msg.direction === "outbound" ? "justify-end" : "justify-start"
                    )}
                  >
                    <div
                      className={cn(
                        "max-w-[70%] px-3.5 py-2.5 rounded-2xl text-sm",
                        msg.direction === "outbound"
                          ? "bg-primary text-primary-foreground rounded-br-sm"
                          : "bg-muted text-foreground rounded-bl-sm"
                      )}
                    >
                      <p>{msg.content}</p>
                      <p className={cn(
                        "text-xs mt-1",
                        msg.direction === "outbound" ? "text-primary-foreground/60 text-right" : "text-muted-foreground"
                      )}>
                        {new Date(msg.sent_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                        {msg.direction === "outbound" && (
                          <span className="ml-1">
                            {msg.status === "read" ? "✓✓" : msg.status === "delivered" ? "✓✓" : "✓"}
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Reply box */}
            <div className="p-3 border-t border-border">
              <div className="flex items-end gap-2">
                <textarea
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type a message... (Enter to send)"
                  rows={1}
                  className="flex-1 px-3 py-2.5 bg-background border border-input rounded-xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring max-h-32 scrollbar-thin"
                  style={{ minHeight: "40px" }}
                />
                <button
                  onClick={sendReply}
                  disabled={sending || !replyText.trim()}
                  className="w-10 h-10 flex items-center justify-center bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-all disabled:opacity-50 shrink-0"
                >
                  {sending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
