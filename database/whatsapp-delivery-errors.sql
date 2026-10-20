-- Apply AFTER webhook-sync.sql and hermes-outbound-sync.sql, BEFORE deploying
-- the delivery-errors application patch. Additive; safe to run more than once.
BEGIN;

ALTER TABLE public.whatsapp_pending_statuses ADD COLUMN IF NOT EXISTS error_message text;
COMMENT ON TABLE public.whatsapp_pending_statuses IS
  'Short-lived receipt ledger: retain applied receipts so later message/log inserts can reconcile. Pruned after 7 days on receipt activity.';

CREATE OR REPLACE FUNCTION public.flush_whatsapp_pending_statuses(p_wamid text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_receipt record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_wamid, 0));
  FOR v_receipt IN SELECT * FROM public.whatsapp_pending_statuses
      WHERE wamid = p_wamid ORDER BY event_at, status LOOP
    PERFORM public.apply_whatsapp_status_internal(p_wamid, v_receipt.status, v_receipt.event_at);
    UPDATE public.campaign_logs
    SET error_message = CASE
      WHEN status <> 'failed' THEN NULL
      WHEN v_receipt.status = 'failed' THEN coalesce(nullif(v_receipt.error_message, ''), error_message)
      ELSE error_message END
    WHERE wamid = p_wamid;
  END LOOP;
  -- Keep the receipt: campaign_logs and messages are inserted separately.
  -- Deleting here would lose errors/status for whichever row arrives second.
END;
$$;

CREATE OR REPLACE FUNCTION public.record_whatsapp_status_with_error(
  p_wamid text, p_status text, p_at timestamptz, p_error_message text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF nullif(p_wamid, '') IS NULL OR length(p_wamid) > 512
     OR p_status IS NULL OR p_status NOT IN ('sent','delivered','read','failed') OR p_at IS NULL THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_wamid, 0));
  DELETE FROM public.whatsapp_pending_statuses WHERE received_at < now() - interval '7 days';
  INSERT INTO public.whatsapp_pending_statuses(wamid, status, event_at, error_message)
  VALUES (p_wamid, p_status, p_at,
    CASE WHEN p_status = 'failed' THEN left(nullif(btrim(p_error_message), ''), 2000) ELSE NULL END)
  ON CONFLICT (wamid, status) DO UPDATE
  SET event_at = least(whatsapp_pending_statuses.event_at, excluded.event_at),
      error_message = coalesce(whatsapp_pending_statuses.error_message, excluded.error_message);
  PERFORM public.flush_whatsapp_pending_statuses(p_wamid);
END;
$$;

-- The old deployment and integrations keep working while the new one rolls out.
-- Use a distinct RPC name above to avoid ambiguous PostgREST overloads.
CREATE OR REPLACE FUNCTION public.record_whatsapp_status(p_wamid text, p_status text, p_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.record_whatsapp_status_with_error(p_wamid, p_status, p_at, NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_whatsapp_campaign_log_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.wamid IS NOT NULL THEN PERFORM public.flush_whatsapp_pending_statuses(NEW.wamid); END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS campaign_logs_reconcile_whatsapp_status ON public.campaign_logs;
CREATE TRIGGER campaign_logs_reconcile_whatsapp_status AFTER INSERT ON public.campaign_logs
FOR EACH ROW EXECUTE FUNCTION public.reconcile_whatsapp_campaign_log_status();

CREATE OR REPLACE FUNCTION public.finish_whatsapp_campaign(p_campaign_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_campaign public.campaigns%ROWTYPE;
  v_total integer; v_sent integer; v_delivered integer; v_read integer; v_failed integer;
BEGIN
  -- Lock before reading the logs. A concurrent receipt either commits first,
  -- or increments these counters after finalization releases this lock.
  SELECT * INTO v_campaign FROM public.campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Campaign not found'; END IF;
  SELECT count(*), count(*) FILTER (WHERE wamid IS NOT NULL),
    count(*) FILTER (WHERE delivered_at IS NOT NULL OR status IN ('delivered','read')),
    count(*) FILTER (WHERE read_at IS NOT NULL OR status = 'read'),
    count(*) FILTER (WHERE status = 'failed')
  INTO v_total, v_sent, v_delivered, v_read, v_failed
  FROM public.campaign_logs WHERE campaign_id = p_campaign_id;
  UPDATE public.campaigns SET total_contacts = v_total, sent_count = v_sent,
    delivered_count = v_delivered, read_count = v_read, failed_count = v_failed,
    status = CASE WHEN v_total > 0 AND v_failed = v_total THEN 'failed' ELSE 'completed' END,
    completed_at = coalesce(completed_at, now())
  WHERE id = p_campaign_id;
  RETURN jsonb_build_object('total',v_total,'accepted',v_sent,'delivered',v_delivered,'read',v_read,'failed',v_failed);
END;
$$;

CREATE OR REPLACE FUNCTION public.whatsapp_delivery_sync_version()
RETURNS integer LANGUAGE sql SET search_path = public, pg_temp AS $$ SELECT 1; $$;

REVOKE ALL ON FUNCTION public.flush_whatsapp_pending_statuses(text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.reconcile_whatsapp_campaign_log_status() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.record_whatsapp_status_with_error(text,text,timestamptz,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.record_whatsapp_status(text,text,timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.finish_whatsapp_campaign(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.whatsapp_delivery_sync_version() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_whatsapp_status_with_error(text,text,timestamptz,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_whatsapp_status(text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_whatsapp_campaign(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.whatsapp_delivery_sync_version() TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
