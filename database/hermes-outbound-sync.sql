-- Apply AFTER database/webhook-sync.sql. Additive and safe to rerun.
BEGIN;

CREATE TABLE IF NOT EXISTS public.whatsapp_pending_statuses (
  wamid text NOT NULL,
  status text NOT NULL CHECK (status IN ('sent','delivered','read','failed')),
  event_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wamid, status)
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_pending_received ON public.whatsapp_pending_statuses(received_at);
ALTER TABLE public.whatsapp_pending_statuses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_pending_statuses FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.apply_whatsapp_status_internal(
  p_wamid text, p_status text, p_at timestamptz
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_log public.campaign_logs%ROWTYPE;
  v_status text;
  v_delivered boolean;
  v_read boolean;
BEGIN
  IF p_status NOT IN ('sent', 'delivered', 'read', 'failed') OR p_at IS NULL THEN
    RETURN;
  END IF;

  -- Only advance successful delivery states. A late 'sent' cannot undo 'failed'.
  UPDATE public.messages
  SET status = CASE
        WHEN p_status = 'read' THEN 'read'
        WHEN p_status = 'delivered' AND status <> 'read' THEN 'delivered'
        WHEN p_status = 'failed' AND status NOT IN ('delivered', 'read') THEN 'failed'
        ELSE status END,
      delivered_at = CASE WHEN p_status IN ('delivered', 'read') THEN least(delivered_at, p_at) ELSE delivered_at END,
      read_at = CASE WHEN p_status = 'read' THEN least(read_at, p_at) ELSE read_at END
  WHERE wamid = p_wamid AND direction = 'outbound';

  FOR v_log IN SELECT * FROM public.campaign_logs WHERE wamid = p_wamid ORDER BY id FOR UPDATE LOOP
    v_status := CASE
      WHEN p_status = 'read' THEN 'read'
      WHEN p_status = 'delivered' AND v_log.status <> 'read' THEN 'delivered'
      WHEN p_status = 'failed' AND v_log.status NOT IN ('delivered', 'read') THEN 'failed'
      ELSE v_log.status END;
    v_delivered := p_status IN ('delivered', 'read') AND v_log.delivered_at IS NULL;
    v_read := p_status = 'read' AND v_log.read_at IS NULL;
    UPDATE public.campaign_logs
    SET status = v_status,
        delivered_at = CASE WHEN p_status IN ('delivered', 'read') THEN least(delivered_at, p_at) ELSE delivered_at END,
        read_at = CASE WHEN p_status = 'read' THEN least(read_at, p_at) ELSE read_at END
    WHERE id = v_log.id;
    UPDATE public.campaigns
    SET delivered_count = delivered_count + CASE WHEN v_delivered THEN 1 ELSE 0 END,
        read_count = read_count + CASE WHEN v_read THEN 1 ELSE 0 END,
        failed_count = greatest(0, failed_count
          + CASE WHEN v_status = 'failed' AND v_log.status <> 'failed' THEN 1 ELSE 0 END
          - CASE WHEN v_status <> 'failed' AND v_log.status = 'failed' THEN 1 ELSE 0 END)
    WHERE id = v_log.campaign_id;
  END LOOP;
  -- Called only once a corresponding message or campaign log exists.
END;
$$;

CREATE OR REPLACE FUNCTION public.flush_whatsapp_pending_statuses(p_wamid text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_receipt record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_wamid, 0));
  FOR v_receipt IN SELECT * FROM public.whatsapp_pending_statuses
      WHERE wamid = p_wamid ORDER BY event_at, status LOOP
    PERFORM public.apply_whatsapp_status_internal(p_wamid, v_receipt.status, v_receipt.event_at);
  END LOOP;
  DELETE FROM public.whatsapp_pending_statuses WHERE wamid = p_wamid;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_whatsapp_status(p_wamid text, p_status text, p_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF nullif(p_wamid, '') IS NULL OR p_status IS NULL OR p_status NOT IN ('sent','delivered','read','failed') OR p_at IS NULL THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_wamid, 0));
  -- Prune unmatched receipts after seven days on subsequent receipt activity.
  DELETE FROM public.whatsapp_pending_statuses WHERE received_at < now() - interval '7 days';
  IF NOT EXISTS (SELECT FROM public.messages WHERE wamid = p_wamid AND direction = 'outbound')
     AND NOT EXISTS (SELECT FROM public.campaign_logs WHERE wamid = p_wamid) THEN
    INSERT INTO public.whatsapp_pending_statuses(wamid, status, event_at)
    VALUES (p_wamid, p_status, p_at)
    ON CONFLICT (wamid, status) DO UPDATE SET event_at = least(whatsapp_pending_statuses.event_at, excluded.event_at);
    RETURN;
  END IF;
  PERFORM public.apply_whatsapp_status_internal(p_wamid, p_status, p_at);
  PERFORM public.flush_whatsapp_pending_statuses(p_wamid);
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_whatsapp_message_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.direction = 'outbound' AND NEW.wamid IS NOT NULL THEN
    PERFORM public.flush_whatsapp_pending_statuses(NEW.wamid);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS messages_reconcile_whatsapp_status ON public.messages;
CREATE TRIGGER messages_reconcile_whatsapp_status AFTER INSERT ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.reconcile_whatsapp_message_status();

CREATE OR REPLACE FUNCTION public.record_whatsapp_outbound(
  p_phone text, p_wamid text, p_content text, p_sent_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_contact uuid;
  v_inserted boolean;
  v_existing public.messages%ROWTYPE;
BEGIN
  IF p_phone IS NULL OR p_phone !~ '^\+[0-9]{6,15}$' OR nullif(p_wamid, '') IS NULL
     OR p_content IS NULL OR p_sent_at IS NULL THEN RAISE EXCEPTION 'Invalid outgoing message'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_wamid, 0));
  INSERT INTO public.contacts(phone) VALUES (p_phone)
  ON CONFLICT (phone) DO UPDATE SET phone = excluded.phone
  RETURNING id INTO v_contact;
  INSERT INTO public.messages(contact_id, wamid, direction, content, status, sent_at)
  VALUES (v_contact, p_wamid, 'outbound', p_content, 'sent', p_sent_at)
  ON CONFLICT (wamid) DO NOTHING;
  v_inserted := FOUND;
  IF v_inserted THEN
    UPDATE public.contacts SET message_count = message_count + 1,
      last_message_at = greatest(last_message_at, p_sent_at) WHERE id = v_contact;
  ELSE
    SELECT * INTO v_existing FROM public.messages WHERE wamid = p_wamid;
    IF v_existing.contact_id IS DISTINCT FROM v_contact OR v_existing.direction <> 'outbound'
       OR v_existing.content IS DISTINCT FROM p_content THEN RAISE EXCEPTION 'Outgoing message ID conflict'; END IF;
  END IF;
  RETURN jsonb_build_object('inserted', v_inserted);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_whatsapp_status_internal(text,text,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.flush_whatsapp_pending_statuses(text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.reconcile_whatsapp_message_status() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.record_whatsapp_status(text,text,timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.record_whatsapp_outbound(text,text,text,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_whatsapp_status(text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_whatsapp_outbound(text,text,text,timestamptz) TO service_role;
COMMIT;
