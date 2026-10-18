-- Apply once in Supabase SQL Editor after schema.sql. Safe to run again.
BEGIN;

CREATE OR REPLACE FUNCTION public.record_whatsapp_inbound(
  p_phone text, p_name text, p_wamid text, p_content text, p_sent_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_contact public.contacts%ROWTYPE;
  v_inserted boolean;
  v_message_contact uuid;
BEGIN
  IF p_phone !~ '^\+[0-9]{6,15}$' OR nullif(p_wamid, '') IS NULL
     OR p_content IS NULL OR p_sent_at IS NULL THEN
    RAISE EXCEPTION 'Invalid incoming message';
  END IF;

  -- Upsert locks this contact until commit; preserve custom names and status.
  INSERT INTO public.contacts (phone, name)
  VALUES (p_phone, nullif(p_name, ''))
  ON CONFLICT (phone) DO UPDATE
    SET name = coalesce(nullif(contacts.name, ''), excluded.name)
  RETURNING * INTO v_contact;

  INSERT INTO public.messages (contact_id, wamid, direction, content, sent_at)
  VALUES (v_contact.id, p_wamid, 'inbound', p_content, p_sent_at)
  ON CONFLICT (wamid) DO NOTHING;
  v_inserted := FOUND;

  IF v_inserted THEN
    UPDATE public.contacts
    SET message_count = message_count + 1,
        last_message_at = greatest(last_message_at, p_sent_at),
        status = CASE WHEN lower(btrim(p_content)) IN ('stop', 'unsubscribe')
                      THEN 'blocked' ELSE status END
    WHERE id = v_contact.id
    RETURNING * INTO v_contact;
  ELSE
    SELECT contact_id INTO v_message_contact FROM public.messages WHERE wamid = p_wamid;
    IF v_message_contact IS DISTINCT FROM v_contact.id THEN
      RAISE EXCEPTION 'Message belongs to a different contact';
    END IF;
  END IF;

  RETURN jsonb_build_object('inserted', v_inserted, 'forward_allowed', v_contact.status = 'active');
END;
$$;

CREATE OR REPLACE FUNCTION public.record_whatsapp_status(
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
  -- Unknown IDs (including Hermes replies) have no body to reconstruct here.
END;
$$;

REVOKE ALL ON FUNCTION public.record_whatsapp_inbound(text, text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_whatsapp_status(text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_whatsapp_inbound(text, text, text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_whatsapp_status(text, text, timestamptz) TO service_role;

DO $$
DECLARE v_table text;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE EXCEPTION 'Supabase Realtime publication is missing';
  END IF;
  FOREACH v_table IN ARRAY ARRAY['messages', 'contacts', 'campaigns'] LOOP
    IF NOT EXISTS (SELECT FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = v_table) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_table);
    END IF;
  END LOOP;
END;
$$;
COMMIT;
